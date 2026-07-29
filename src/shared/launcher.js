'use strict';
/**
 * Starting Claude Code sessions from Lifeline.
 *
 * Two callers, one mechanism: History resumes an existing session, and the
 * Launchpad starts a new one from a saved preset. Both end up as an argv for the
 * `claude` CLI plus a terminal to host it.
 *
 * Three things here are less obvious than they look:
 *
 * 1. **The spawn is detached and unref'd.** Lifeline is a tray app the user
 *    quits without thinking about it; a child in the same process group would be
 *    killed with it, taking a working session down. Detaching means a launched
 *    session outlives the launcher, which is the only acceptable behaviour for a
 *    tool whose whole purpose is not disturbing sessions.
 *
 * 2. **Nothing is interpolated into a shell string.** Presets carry a
 *    user-written pre-prompt and transcripts carry untrusted model output, so
 *    building `cmd /c ...` by concatenation would make either one a command
 *    injection. Every value travels as its own argv element, and the one place a
 *    shell is unavoidable (`cmd /k`, to keep the window open) gets an explicit
 *    quoting pass — see cmdQuote().
 *
 * 3. **Skills are prompt text, not a flag.** The CLI has no `--skills`; skills
 *    resolve when the prompt says `/skill-name`. So a preset's skills become
 *    leading `/skill` lines in its prompt, which is the same thing the user would
 *    type by hand.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Permission modes the CLI accepts, as an allowlist.
 *
 * Checked rather than passed through because this value reaches a command line:
 * an unrecognised mode should be dropped here, where it is a no-op, rather than
 * making `claude` exit with a usage error in a window that then closes.
 */
const PERMISSION_MODES = ['manual', 'auto', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions'];

/** Model aliases offered in the preset editor. A full model id is also accepted. */
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

/** A session id is a uuid — anything else did not come from a transcript filename. */
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/;

/** Skill names are a slug; the leading slash is added when the prompt is built. */
const SKILL_RE = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,80}$/;

/* ============================== the prompt ============================== */

/**
 * Turn a preset's skills and pre-prompt into the single string handed to `claude`.
 *
 * Skills lead, one per line, because a skill's instructions have to be loaded
 * before the request that depends on them; a `/skill` buried under a paragraph of
 * prose reads as a mention rather than an invocation.
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
 * Returned as an array for the same reason it is built as one: these values are
 * user-authored and must never be re-parsed by a shell. Empty and unrecognised
 * fields are omitted rather than passed as blanks, since `--model ""` is an error
 * where a missing `--model` is the default.
 */
function claudeArgs(preset = {}) {
  const args = [];

  if (preset.resumeId) {
    const id = String(preset.resumeId);
    if (!SESSION_ID_RE.test(id)) throw new Error('That session id is not in a shape Lifeline will pass to a command line.');
    args.push('--resume', id);
  }

  const model = String(preset.model || '').trim();
  // Any non-empty value is allowed through: the CLI takes aliases *and* full model
  // ids, so an allowlist here would reject every model released after this build.
  if (model) args.push('--model', model);

  const mode = String(preset.permissionMode || '').trim();
  if (mode && PERMISSION_MODES.includes(mode)) args.push('--permission-mode', mode);

  for (const dir of preset.addDirs || []) {
    const d = String(dir || '').trim();
    if (d) args.push('--add-dir', d);
  }

  const name = String(preset.sessionName || '').trim();
  if (name) args.push('--name', name);

  const prompt = buildPrompt(preset);
  // Positional, and last: this is the opening message, not a flag value. An
  // interactive session starts with it already submitted.
  if (prompt) args.push(prompt);

  return args;
}

/* ============================== the terminal ============================= */

/**
 * Quote one argument for cmd.exe.
 *
 * Needed because the fallback path is `cmd /k <command line>`, which takes a
 * command *line* rather than an argv — so this is the one place a string has to be
 * assembled, and the one place quoting is load-bearing. A pre-prompt containing a
 * quote, an ampersand, or a percent sign must stay text and not become syntax.
 *
 * Both layers are handled: backslash-escaping for the C runtime's parser (which is
 * what turns the line back into an argv), and `^`-escaping for cmd's own parser,
 * which runs first and would otherwise act on the metacharacters. Percent is not
 * escapable this way — `^%` is not special to cmd — so `%` is dropped instead,
 * since a stray `%VAR%` expansion is silent and confusing where a missing sign is
 * merely visible.
 */
function cmdQuote(value) {
  const text = String(value).replace(/%/g, '');
  // Double any backslashes that precede the closing quote, else the quote escapes.
  const escaped = text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`.replace(/[&|<>^()]/g, (c) => `^${c}`);
}

/** Windows Terminal, if this machine has it. */
function windowsTerminal() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const wt = path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe');
  try {
    // The WindowsApps entries are execution aliases — zero-byte reparse points —
    // so existsSync is the only check that means anything here.
    return fs.existsSync(wt) ? wt : null;
  } catch {
    return null;
  }
}

/**
 * The command to run, resolved against what is actually installed.
 *
 * Windows Terminal is preferred because `-d` sets the working directory without a
 * `cd`, and because it is where a modern Windows user's shell lives. cmd.exe is
 * the fallback and is always present.
 *
 * Exported separately from launch() so the argv can be asserted in tests without
 * spawning a terminal on the developer's desktop.
 */
function resolveCommand(preset = {}, { wt = windowsTerminal() } = {}) {
  const args = claudeArgs(preset);
  const cwd = String(preset.cwd || '').trim() || null;

  if (wt) {
    // `--` separates wt's own options from the command it hosts, so a prompt
    // beginning with a dash cannot be read as a wt flag.
    const wtArgs = [];
    if (cwd) wtArgs.push('-d', cwd);
    wtArgs.push('--', 'claude', ...args);
    return { file: wt, args: wtArgs, shell: false, cwd, via: 'wt' };
  }

  // `start` opens a new window rather than borrowing Lifeline's (there isn't one),
  // and `/k` keeps it open after the session ends so the user can read the tail.
  // The empty "" is start's title argument: without it, start treats the first
  // quoted token as the title and never runs the command.
  const line = ['claude', ...args].map(cmdQuote).join(' ');
  return {
    file: process.env.COMSPEC || 'cmd.exe',
    args: ['/c', 'start', '""', 'cmd', '/k', line],
    shell: false,
    cwd,
    via: 'cmd',
  };
}

/**
 * Launch a session and return immediately.
 *
 * `detached` plus `unref` is the whole point: see the note at the top of the file.
 * stdio is ignored rather than piped, because a pipe nobody reads fills its buffer
 * and blocks the child once it has written 64KB.
 */
function launch(preset = {}, opts = {}) {
  const cmd = resolveCommand(preset, opts);
  const child = spawn(cmd.file, cmd.args, {
    cwd: cmd.cwd || undefined,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  });
  child.unref();
  return { pid: child.pid || null, via: cmd.via };
}

module.exports = {
  PERMISSION_MODES,
  MODEL_ALIASES,
  SESSION_ID_RE,
  SKILL_RE,
  buildPrompt,
  claudeArgs,
  cmdQuote,
  windowsTerminal,
  resolveCommand,
  launch,
};
