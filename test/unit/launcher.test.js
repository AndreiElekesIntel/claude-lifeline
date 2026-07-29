'use strict';
/**
 * Launching Claude Code sessions.
 *
 * The centre of this file is the round-trip test: a launch pair is generated, the
 * batch file is *actually executed*, and the argv a real process received is
 * compared against what went in.
 *
 * That is deliberate. Reasoning about Windows quoting is how three separate bugs
 * got written here before a shell was involved in the checking: `^&` arriving as a
 * literal caret, `%PATH%` expanding inside a user's prompt, and — worst — a
 * pre-prompt of `" & calc.exe & echo "` breaking out of its quotes and *executing*.
 * A multi-line prompt was silently truncated at line one by every cmd-based route.
 * So the quoting is verified by running it, not by reading it.
 *
 * No test here spawns a terminal or a real `claude`: the round trip substitutes
 * `node` for the CLI and reads back the argv it saw.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const launcher = require('../../src/shared/launcher');

/* ============================== the prompt ============================== */

test('skills become leading slash-lines above the pre-prompt', () => {
  const prompt = launcher.buildPrompt({ skills: ['lab-infra-jira', '/purchasing-jira'], prePrompt: 'File the HVAC ticket.' });
  assert.equal(prompt, '/lab-infra-jira\n\n/purchasing-jira\n\nFile the HVAC ticket.');
});

test('a skill name that is not a slug is dropped rather than passed through', () => {
  // These would become prompt text that reads as an instruction, so they are
  // rejected outright instead of being sanitised into something else.
  assert.equal(launcher.buildPrompt({ skills: ['ok-skill', 'rm -rf /', 'has space', ''] }), '/ok-skill');
});

test('an empty preset produces an empty prompt, not whitespace', () => {
  assert.equal(launcher.buildPrompt({}), '');
  assert.equal(launcher.buildPrompt({ prePrompt: '   \n  ' }), '');
});

/* =============================== the argv =============================== */

test('a resume preset asks for that session, plus the unattended defaults', () => {
  assert.deepEqual(launcher.claudeArgs({ resumeId: 'a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60' }), [
    '--resume',
    'a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60',
    '--dangerously-skip-permissions',
    '--strict-mcp-config',
  ]);
});

test('launched sessions do not stop on a permission or MCP prompt', () => {
  // These sessions open in a window the user may not be watching, so one that sits
  // waiting on a dialog is indistinguishable from one that failed to start.
  const args = launcher.claudeArgs({ prePrompt: 'go' });
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--strict-mcp-config'));
});

test('a preset can opt out of both unattended defaults', () => {
  // Explicit `false` only — an absent field keeps the default, so a preset saved
  // before these existed does not silently become interactive.
  assert.deepEqual(launcher.claudeArgs({ skipPermissions: false, strictMcpConfig: false }), []);
});

test('a session id that could be a command-line flag is refused', () => {
  // The id becomes an argv element, so a leading dash would become a *flag*. There
  // is no quoting that makes `--dangerously-skip-permissions` a safe session id.
  for (const bad of ['--dangerously-skip-permissions', '-r', 'a b', 'a"b', '../../etc', '.hidden']) {
    assert.throws(() => launcher.claudeArgs({ resumeId: bad }), /session id/i, `accepted ${JSON.stringify(bad)}`);
  }
});

test('no resume id means a fresh session, not a rejected one', () => {
  // Distinct from a *bad* id: the Launchpad omits the field entirely, and an empty
  // string arrives from a cleared form field. Neither is an error.
  for (const absent of ['', null, undefined]) {
    assert.deepEqual(launcher.claudeArgs({ resumeId: absent, skipPermissions: false, strictMcpConfig: false }), []);
  }
});

test('the prompt is positional and last, after every flag', () => {
  assert.deepEqual(
    launcher.claudeArgs({ model: 'opus', permissionMode: 'plan', addDirs: ['C:/work/shared'], prePrompt: 'Review the diff.' }),
    [
      '--model', 'opus',
      '--permission-mode', 'plan',
      '--dangerously-skip-permissions',
      '--strict-mcp-config',
      '--add-dir', 'C:/work/shared',
      'Review the diff.',
    ]
  );
});

test('an unrecognised permission mode is dropped, not forwarded', () => {
  // `claude` exits with a usage error on an unknown mode, in a window that then
  // closes — so the user would see a flash and no explanation.
  const bare = { skipPermissions: false, strictMcpConfig: false };
  assert.deepEqual(launcher.claudeArgs({ ...bare, permissionMode: 'yolo' }), []);
  assert.deepEqual(launcher.claudeArgs({ ...bare, permissionMode: 'bypassPermissions' }), ['--permission-mode', 'bypassPermissions']);
});

test('every advertised permission mode is one the CLI accepts', () => {
  // Checked against `claude --help` when this was written. If the CLI drops one,
  // this list is where the UI would keep offering it.
  assert.deepEqual([...launcher.PERMISSION_MODES].sort(), ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'manual', 'plan']);
});

test('a full model id is passed through, not just the aliases', () => {
  // An allowlist here would reject every model released after this build.
  assert.deepEqual(launcher.claudeArgs({ model: 'claude-opus-5', skipPermissions: false, strictMcpConfig: false }), [
    '--model',
    'claude-opus-5',
  ]);
});

test('empty fields are omitted rather than sent as blanks', () => {
  // `--model ""` is an error where a missing `--model` is the default.
  assert.deepEqual(
    launcher.claudeArgs({ model: '   ', permissionMode: '', addDirs: ['', '  '], skipPermissions: false, strictMcpConfig: false }),
    []
  );
});

/* ====================== the round trip (the real test) ================== */

/**
 * Generate a launch pair whose "claude" is a script that records its argv, run the
 * batch file for real, and return the arguments the process actually received.
 *
 * This puts the values through every layer a real launch does — the JSON spec, the
 * batch file, cmd.exe, and the runner — which is the only honest way to test them.
 */
function roundTrip(args, { preset = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-launch-'));
  const out = path.join(dir, 'argv.json');
  const fake = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fake, 'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));');

  // The runner resolves a bare name to a real executable, so it is handed one:
  // node, with the recorder and the output path ahead of the arguments under test.
  const { script } = launcher.writeLaunchFiles(
    { ...preset, prePrompt: '' },
    { dir, stamp: 'test', exe: process.execPath, node: process.execPath }
  );
  // Splice the recorder in front of the argv the launcher built.
  const spec = path.join(dir, 'claude-lifeline-launch-test.json');
  const parsed = JSON.parse(fs.readFileSync(spec, 'utf8'));
  parsed.args = [fake, out, ...args];
  fs.writeFileSync(spec, JSON.stringify(parsed), 'utf8');

  execFileSync(process.env.COMSPEC || 'cmd.exe', ['/c', script], { stdio: 'pipe' });
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return seen;
}

test('every argument survives a real launch byte-for-byte', () => {
  const values = [
    'plain',
    'has spaces in it',
    'say "hi" to me',
    'ampersand & pipe | redirect > and < it',
    'caret ^ and parens ( ) and semicolon ;',
    '%PATH% and %%ALREADY%% stay literal',
    'C:\\Users\\aelekes\\path\\with\\backslashes',
    'trailing backslash\\',
    'quote at end "',
    "single 'quotes' and `backticks`",
    '100% done, 50%% left',
    'unicode — em dash, ümlaut, 日本語',
    '!bang! and $dollar and @at',
    'tab\tseparated',
  ];
  assert.deepEqual(roundTrip(values), values);
});

test('a multi-line prompt survives, which every cmd-based route truncated', () => {
  // This is the shape buildPrompt() produces — skills joined by blank lines. cmd
  // ends an argument at a newline, so any shell in the chain loses everything from
  // line two onward, silently.
  const prompt = launcher.buildPrompt({
    skills: ['lab-infra-jira', 'purchasing-jira'],
    prePrompt: 'File the ticket and say "done".\nSecond line.\n\nFourth line.',
  });
  assert.ok(prompt.includes('\n'), 'the fixture must actually be multi-line');
  assert.deepEqual(roundTrip([prompt]), [prompt]);
});

test('a prompt that looks like a shell injection arrives as text', () => {
  // The pre-prompt is arbitrary user prose and transcripts carry untrusted model
  // output. An earlier implementation really did execute the first of these.
  const values = [
    '" & calc.exe & echo "',
    '"; shutdown /s /t 0; "',
    '$(whoami)',
    '`whoami`',
    '&& del /q /s C:\\',
    '| findstr .',
    '^& echo escaped',
  ];
  assert.deepEqual(roundTrip(values), values);
});

/* ============================ the generated pair ========================= */

test('the batch file names only generated paths, never user text', () => {
  // The whole security argument: wt expands %VAR% and strips quotes from what it
  // forwards, and cmd can be broken out of. So nothing authored reaches either.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-isolate-'));
  const { script, spec } = launcher.writeLaunchFiles(
    {
      cwd: 'C:\\work\\payments api',
      label: 'Ship it & del /q C:\\',
      prePrompt: 'expand %PATH% and strip "quotes"',
      resumeId: 'abc-123',
    },
    { dir, stamp: 7 }
  );
  const text = fs.readFileSync(script, 'utf8');

  assert.ok(!text.includes('%PATH%'), 'a variable reference must not reach the batch file');
  assert.ok(!text.includes('quotes'), 'prompt text must not reach the batch file');
  assert.ok(!text.includes('del /q'), 'a label must not reach the batch file');
  assert.ok(!text.includes('payments api'), 'even the cwd goes in the JSON, not the script');
  // CRLF throughout: cmd.exe parses a bare-LF batch file inconsistently.
  assert.ok(!/[^\r]\n/.test(text), 'the script must use CRLF line endings');

  // And it all really is in the spec, which no shell parses.
  const parsed = JSON.parse(fs.readFileSync(spec, 'utf8'));
  assert.equal(parsed.cwd, 'C:\\work\\payments api');
  assert.deepEqual(parsed.args, [
    '--resume',
    'abc-123',
    '--dangerously-skip-permissions',
    '--strict-mcp-config',
    'expand %PATH% and strip "quotes"',
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the batch file runs the committed runner as Node', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-runner-'));
  const { script } = launcher.writeLaunchFiles({}, { dir, stamp: 8, node: 'C:\\app\\electron.exe' });
  const text = fs.readFileSync(script, 'utf8');
  // Electron's binary only behaves as Node with this set, and the packaged app has
  // no node.exe to fall back on.
  assert.match(text, /set ELECTRON_RUN_AS_NODE=1/);
  assert.match(text, /"C:\\app\\electron\.exe" ".*launch-runner\.js" ".*\.json"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the runner the batch file points at actually exists', () => {
  // A path assembled from __dirname, so a file move would break launching silently.
  assert.ok(fs.statSync(launcher.runnerPath()).isFile());
});

/* ============================== the terminal ============================= */

test('Windows Terminal hosts cmd, so PATHEXT can resolve the claude shim', () => {
  // `wt -- claude` fails with 0x80070002: wt resolves via CreateProcess, which has
  // no notion of PATHEXT, and `claude` is a .cmd on an npm install.
  const cmd = launcher.resolveCommand('C:\\tmp\\launch.cmd', { wt: 'C:\\wt.exe' });
  assert.equal(cmd.file, 'C:\\wt.exe');
  assert.deepEqual(cmd.args, ['--', 'cmd', '/k', 'C:\\tmp\\launch.cmd']);
  assert.equal(cmd.via, 'wt');
});

test('the script path reaches wt unwrapped, because doubled quotes break it', () => {
  // Wrapping produces `""C:\...""`, which wt rejects with 0x80070057.
  const cmd = launcher.resolveCommand('C:\\tmp\\launch.cmd', { wt: 'C:\\wt.exe' });
  assert.ok(!cmd.args.some((a) => a.startsWith('""')), 'wt must not receive a doubly-quoted path');
});

test('Windows Terminal is detected through its execution alias', () => {
  // The regression this guards: WindowsApps entries are zero-byte reparse points
  // into an ACL-restricted directory, so `existsSync` follows the link, fails to
  // stat the target, and reports false for a wt.exe that launches perfectly. The
  // symptom was silent — every launch took the cmd fallback on a machine that has
  // Windows Terminal. Skipped where there is genuinely no wt to find.
  const local = process.env.LOCALAPPDATA;
  if (!local) return;
  const alias = path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe');
  let present = false;
  try {
    present = fs.lstatSync(alias).isSymbolicLink() || fs.lstatSync(alias).isFile();
  } catch {
    return; // Windows Terminal is not installed here
  }
  if (!present) return;
  assert.equal(launcher.windowsTerminal(), alias, 'wt.exe is installed but was not detected');
});

test('without Windows Terminal it falls back to a new cmd window', () => {
  const cmd = launcher.resolveCommand('C:\\tmp\\launch.cmd', { wt: null });
  // The empty "" is start's title argument: without it, start treats the first
  // quoted token as the title and never runs the command.
  assert.deepEqual(cmd.args, ['/c', 'start', '""', 'cmd', '/k', 'C:\\tmp\\launch.cmd']);
  assert.equal(cmd.via, 'cmd');
});

/* ================================ the runner ============================= */

test('the runner explains itself when the CLI cannot be found', () => {
  // A window that opens and closes with an ENOENT is the worst outcome here, so the
  // message has to name the thing to try.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-missing-'));
  const spec = path.join(dir, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ file: 'definitely-not-installed-xyz', args: [] }));

  let stderr = '';
  let status = 0;
  try {
    execFileSync(process.execPath, [launcher.runnerPath(), spec], { stdio: 'pipe' });
  } catch (err) {
    status = err.status;
    stderr = String(err.stderr);
  }
  assert.equal(status, 1);
  assert.match(stderr, /could not start this session/i);
  assert.match(stderr, /definitely-not-installed-xyz --version/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the runner reports the session exit code rather than always zero', () => {
  // The window stays open after the session ends, so the code is information.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-exit-'));
  const spec = path.join(dir, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ file: process.execPath, args: ['-e', 'process.exit(3)'] }));

  let status = 0;
  try {
    execFileSync(process.execPath, [launcher.runnerPath(), spec], { stdio: 'pipe' });
  } catch (err) {
    status = err.status;
  }
  assert.equal(status, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a malformed spec fails with an explanation, not a stack trace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-bad-'));
  const spec = path.join(dir, 'spec.json');
  fs.writeFileSync(spec, '{ not json');

  let stderr = '';
  try {
    execFileSync(process.execPath, [launcher.runnerPath(), spec], { stdio: 'pipe' });
  } catch (err) {
    stderr = String(err.stderr);
  }
  assert.match(stderr, /could not be read/i);
  assert.ok(!stderr.includes('at Object.'), 'a stack trace is not an explanation');
  fs.rmSync(dir, { recursive: true, force: true });
});
