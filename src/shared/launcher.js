'use strict';
/**
 * Starting Claude Code sessions from Lifeline.
 *
 * Two callers, one mechanism: History resumes an existing session, and the
 * Launchpad starts a new one from a saved preset. Both end up as an argv for the
 * `claude` CLI plus a terminal window to host it.
 *
 * ## Why this is not simply `spawn('claude', args)`
 *
 * The obvious implementation — hand the argv to a terminal on its command line —
 * cannot be made correct on Windows. Every one of these was measured, not assumed:
 *
 *   - **`wt.exe` rewrites the arguments it forwards.** It expands `%PATH%` in the
 *     middle of an argument, strips `"` characters, and collapses backslash runs.
 *   - **`cmd.exe` ends a quoted region at the first `"` it sees**, even one the C
 *     runtime would treat as escaped (`\"`). So a pre-prompt containing a quote can
 *     break out of its quoting — `" & calc.exe & echo "` really did execute in a
 *     test of the previous implementation.
 *   - **PowerShell re-splits arguments** containing quotes, turning one argument
 *     into several.
 *   - **`wt -- claude` fails outright** with 0x80070002, because wt resolves via
 *     CreateProcess, which does not apply PATHEXT — and `claude` on an npm install
 *     is `claude.cmd`.
 *   - **A batch `set` cannot hold a newline**, and a preset's prompt is multi-line
 *     by construction (skills are joined with blank lines).
 *
 * A pre-prompt is arbitrary user prose: it *will* contain quotes, and it may
 * contain a `%`. Silently corrupting what the user wrote is worse than failing
 * visibly, and executing part of it is worse still.
 *
 * ## What is done instead
 *
 * **The argv travels as JSON on disk, and no shell ever sees it.** Two generated
 * files sit between Lifeline and the session:
 *
 *   1. `<stamp>.json` — the exact argv, as JSON. JSON has no shell semantics, so
 *      there is no escaping to get wrong.
 *   2. `<stamp>.cmd` — a batch file naming only *fixed paths*: the Node binary, the
 *      runner, and the JSON file. Nothing the user typed appears on any command
 *      line, so there is nothing for wt or cmd to mangle or execute.
 *
 * The batch file runs `runner.js`, which reads the JSON and spawns `claude` with an
 * exact argv and `stdio: 'inherit'` — handing over the console it was given, so the
 * session is properly interactive. Being a batch file, it also runs inside cmd,
 * which is what lets PATHEXT resolve `claude.cmd` from the bare word `claude`.
 *
 * The round trip is verified byte-for-byte by the unit tests, through a real shell,
 * including quotes, `%VAR%`, backslash paths, newlines, and injection payloads.
 *
 * ## And the spawn is detached
 *
 * Lifeline is a tray app the user quits without thinking about it; a child in the
 * same process group would be killed with it, taking a working session down.
 * `detached` plus `unref()` means a launched session outlives the launcher, which
 * is the only acceptable behaviour for a tool whose whole purpose is not disturbing
 * sessions.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Permission modes the CLI accepts, as an allowlist.
 *
 * Verified against `claude --help`. Checked rather than passed through because an
 * unrecognised mode makes `claude` exit with a usage error — in a window that then
 * closes, so the user sees a flash and no explanation.
 */
const PERMISSION_MODES = ['manual', 'auto', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions'];

/** Model aliases offered in the preset editor. A full model id is also accepted. */
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

/** A session id is a uuid — anything else did not come from a transcript filename. */
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/;

/** Skill names are a slug; the leading slash is added when the prompt is built. */
const SKILL_RE = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,80}$/;

/** Where the generated launch pairs live. Left in TEMP, which Windows cleans. */
const LAUNCH_PREFIX = 'claude-lifeline-launch';

/* ============================== the prompt ============================== */

/**
 * Turn a preset's skills and pre-prompt into the single string handed to `claude`.
 *
 * Skills lead, one per line, because a skill's instructions have to be loaded
 * before the request that depends on them; a `/skill` buried under a paragraph of
 * prose reads as a mention rather than an invocation.
 *
 * Skills are prompt text, not a flag: the CLI has no `--skills`, and a skill
 * resolves when the prompt says `/skill-name` — the same thing the user would type.
 */
function buildPrompt({ skills = [], prePrompt = '' } = {}) {
  const lines = [];
  for (const raw of skills) {
    const name = String(raw || '').trim().replace(/^\//, '');
    if (SKILL_RE.test(name)) lines.push(`/${name}`);
  }
  const body = String(prePrompt || '').trim();
  if (body) lines.push(body);
  return lines.join('\n\n');
}

/* =============================== the argv =============================== */

/**
 * The `claude` arguments for a preset, without the terminal wrapper.
 *
 * Empty and unrecognised fields are omitted rather than passed as blanks, since
 * `--model ""` is an error where a missing `--model` is the default.
 *
 * Note there is no `--name`: the CLI has no such flag (checked against `--help`),
 * and passing one made `claude` exit with a usage error.
 */
function claudeArgs(preset = {}) {
  const args = [];

  if (preset.resumeId) {
    const id = String(preset.resumeId);
    // The id reaches an argv, so a leading dash would become a *flag*. Validated
    // rather than quoted, because there is no shape of `--dangerously-skip-...`
    // that is a safe session id.
    if (!SESSION_ID_RE.test(id)) throw new Error('That session id is not in a shape Lifeline will pass to a command line.');
    args.push('--resume', id);
  }

  const model = String(preset.model || '').trim();
  // Any non-empty value is allowed through: the CLI takes aliases *and* full model
  // ids, so an allowlist here would reject every model released after this build.
  if (model) args.push('--model', model);

  const mode = String(preset.permissionMode || '').trim();
  if (mode && PERMISSION_MODES.includes(mode)) args.push('--permission-mode', mode);

  /**
   * Skip the permission prompts, unless a preset opts out.
   *
   * Default-on because of what these sessions *are*: launched from a button, into
   * a window the user may not be watching, often with a pre-prompt that is meant to
   * run unattended. A session that opens and then silently waits on a permission
   * dialog is a session that did not start, and the failure is invisible until the
   * user goes looking.
   *
   * Combining this with `--permission-mode` is fine — checked, not assumed: the CLI
   * accepts both together and the skip wins.
   */
  if (preset.skipPermissions !== false) args.push('--dangerously-skip-permissions');

  /**
   * Ignore MCP servers configured elsewhere, unless a preset opts out.
   *
   * Without this, a first launch in any project with an `.mcp.json` in scope stops
   * on "New MCP server found in this project" and waits for a choice — the same
   * blocking-on-a-prompt problem as above, and one the user hits repeatedly because
   * the answer is remembered per project. `--strict-mcp-config` is the per-launch
   * equivalent of choosing "continue without", and it changes nothing on disk, so
   * it cannot disturb how those servers behave in sessions the user starts himself.
   */
  if (preset.strictMcpConfig !== false) args.push('--strict-mcp-config');

  for (const dir of preset.addDirs || []) {
    const d = String(dir || '').trim();
    if (d) args.push('--add-dir', d);
  }

  const prompt = buildPrompt(preset);
  // Positional, and last: this is the opening message, not a flag value. An
  // interactive session starts with it already submitted.
  if (prompt) args.push(prompt);

  return args;
}

/* ============================ the generated pair ========================= */

/**
 * Path to the runner that turns the JSON spec back into a process.
 *
 * A committed file rather than one generated per launch, so it can be read and
 * reviewed like any other source, and so a launch writes only data.
 */
function runnerPath() {
  return path.join(__dirname, 'launch-runner.js');
}

/**
 * Write the JSON spec and the batch file that runs it, and return both paths.
 *
 * The split is the security property: `spec` holds everything the user authored and
 * is never parsed by a shell, while `script` contains only paths this file
 * generated. See the header for what happens when that is not true.
 *
 * `node` is the Node binary to use. In the packaged app there is no `node.exe` on
 * PATH to rely on, so main passes Electron's own executable and the runner is
 * invoked with ELECTRON_RUN_AS_NODE — which is why the batch file sets it.
 *
 * The files are left behind deliberately. Deleting them races the shell that is
 * about to read them, and two small files in TEMP are a much smaller problem than a
 * session that intermittently fails to start; TEMP is cleaned by Windows, and the
 * `label` line in the batch file makes a stray one identifiable.
 */
function writeLaunchFiles(preset = {}, { dir = os.tmpdir(), stamp = Date.now(), exe = 'claude', node = process.execPath } = {}) {
  const args = claudeArgs(preset);
  const cwd = String(preset.cwd || '').trim() || null;
  const base = path.join(dir, `${LAUNCH_PREFIX}-${stamp}`);
  const spec = `${base}.json`;
  const script = `${base}.cmd`;

  fs.writeFileSync(
    spec,
    JSON.stringify(
      {
        file: exe,
        args,
        cwd,
        // Recorded for the human who finds this file, not read by the runner.
        label: preset.label || null,
      },
      null,
      1
    ),
    'utf8'
  );

  const lines = [
    '@echo off',
    // A comment rather than `title`: the title command would need the label on a
    // command line, and the whole point is that nothing user-authored goes there.
    `rem Claude Lifeline launch. Argv is in ${path.basename(spec)}.`,
    // Electron's binary only behaves as Node with this set; harmless for real node.
    'set ELECTRON_RUN_AS_NODE=1',
    // Only fixed paths on this line — see the header.
    `"${node}" "${runnerPath()}" "${spec}"`,
  ];
  // CRLF: cmd.exe parses a bare-LF batch file inconsistently.
  fs.writeFileSync(script, `${lines.join('\r\n')}\r\n`, 'utf8');

  return { spec, script };
}

/* ============================== the terminal ============================= */

/**
 * Windows Terminal, if this machine has it.
 *
 * Detected with `accessSync`, not `existsSync`, and that distinction is the whole
 * reason this has a comment. The WindowsApps entries are *execution aliases* —
 * zero-byte reparse points into `C:\Program Files\WindowsApps`, which is
 * ACL-restricted. `existsSync` follows the link, cannot stat the target, and
 * reports **false for a `wt.exe` that launches perfectly**; `statSync` throws
 * EACCES for the same reason. `accessSync(F_OK)` checks the alias itself.
 *
 * The symptom of getting this wrong is not an error — it is every launch quietly
 * taking the cmd.exe fallback on a machine that has Windows Terminal installed.
 */
function windowsTerminal() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const wt = path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe');
  try {
    fs.accessSync(wt, fs.constants.F_OK);
    return wt;
  } catch {
    return null;
  }
}

/**
 * The command that opens a window running `script`.
 *
 * Windows Terminal is preferred because it is where a modern Windows user's shell
 * lives; cmd.exe is the fallback and is always present. Either way the payload is
 * the batch file, so the two paths differ only in the window they open.
 *
 * Exported separately from launch() so the argv can be asserted in tests without
 * spawning a terminal on the developer's desktop.
 */
function resolveCommand(script, { wt = windowsTerminal() } = {}) {
  if (wt) {
    // `--` separates wt's own options from the command it hosts, so a path
    // beginning with a dash cannot be read as a wt flag. The path is passed bare:
    // wrapping it in quotes yields `""C:\...""`, which wt rejects with 0x80070057.
    return { file: wt, args: ['--', 'cmd', '/k', script], shell: false, via: 'wt' };
  }

  // `start` opens a new window rather than borrowing Lifeline's (there isn't one),
  // and `/k` keeps it open after the session ends so the user can read the tail.
  // The empty "" is start's title argument: without it, start treats the first
  // quoted token as the title and never runs the command.
  return {
    file: process.env.COMSPEC || 'cmd.exe',
    args: ['/c', 'start', '""', 'cmd', '/k', script],
    shell: false,
    via: 'cmd',
  };
}

/**
 * Launch a session and return immediately.
 *
 * stdio is ignored rather than piped, because a pipe nobody reads fills its buffer
 * and blocks the child once it has written 64KB. The console the session actually
 * uses comes from the terminal window, not from here.
 */
function launch(preset = {}, opts = {}) {
  const { spec, script } = writeLaunchFiles(preset, opts);
  const cmd = resolveCommand(script, opts);
  const child = spawn(cmd.file, cmd.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  });
  child.unref();
  return { pid: child.pid || null, via: cmd.via, script, spec };
}

module.exports = {
  PERMISSION_MODES,
  MODEL_ALIASES,
  SESSION_ID_RE,
  SKILL_RE,
  LAUNCH_PREFIX,
  buildPrompt,
  claudeArgs,
  runnerPath,
  writeLaunchFiles,
  windowsTerminal,
  resolveCommand,
  launch,
};
