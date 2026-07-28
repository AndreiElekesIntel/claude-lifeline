'use strict';
/**
 * The installer edits the user's real settings.json, so these tests are mostly
 * about what it must NOT do: lose existing hooks, stack duplicates, or leave a
 * half-written file behind.
 *
 * Every test redirects CLAUDE_CONFIG_DIR to a scratch dir. Nothing here can
 * reach the live configuration.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function scratchEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-inst-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, '.claude');
  process.env.LIFELINE_HOME = path.join(dir, 'lifeline');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  return dir;
}

function loadInstaller() {
  // Paths are resolved per call, but clear the cache so each test gets a clean
  // module state alongside its fresh scratch dir.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('claude-lifeline') && k.includes('src')) delete require.cache[k];
  }
  return require('../../src/shared/installer');
}

const settingsPath = () => path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));

test('installing into a machine with no settings file creates one', () => {
  scratchEnv();
  const installer = loadInstaller();
  const res = installer.install();
  assert.equal(res.ok, true);
  assert.ok(res.installed.includes('StopFailure'), 'StopFailure is the whole point');

  const s = readSettings();
  assert.ok(s.hooks.StopFailure);
  const hook = s.hooks.StopFailure[0].hooks[0];
  assert.equal(hook.asyncRewake, true, 'without asyncRewake the session is never resumed');
  assert.match(hook.command, /lifeline-hook/);
});

test('an existing unrelated hook survives installation', () => {
  scratchEnv();
  const existing = {
    model: 'us.anthropic.claude-opus-5',
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo user-hook', shell: 'bash' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    },
  };
  fs.writeFileSync(settingsPath(), JSON.stringify(existing, null, 2), 'utf8');

  loadInstaller().install();
  const s = readSettings();

  assert.equal(s.model, 'us.anthropic.claude-opus-5', 'unrelated settings must be preserved');
  assert.ok(
    s.hooks.Stop[0].hooks.some((h) => h.command === 'echo user-hook'),
    "the user's own Stop hook must survive"
  );
  assert.ok(s.hooks.PreToolUse[0].hooks.some((h) => h.command === 'echo pre'));
  assert.ok(s.hooks.Stop[0].hooks.some((h) => /lifeline-hook/.test(h.command)));
});

test('installing twice does not stack duplicate hooks', () => {
  scratchEnv();
  const installer = loadInstaller();
  installer.install();
  installer.install();
  installer.install();

  const ours = readSettings().hooks.StopFailure.flatMap((g) => g.hooks).filter((h) => /lifeline-hook/.test(h.command));
  assert.equal(ours.length, 1, 're-installing should upgrade in place');
});

test('a backup is written before the first change', () => {
  scratchEnv();
  fs.writeFileSync(settingsPath(), JSON.stringify({ model: 'keep-me' }), 'utf8');
  const res = loadInstaller().install();
  assert.ok(res.backup, 'a backup path should be reported');
  assert.match(fs.readFileSync(res.backup, 'utf8'), /keep-me/);
});

test('uninstall removes our hooks and leaves the rest intact', () => {
  scratchEnv();
  fs.writeFileSync(
    settingsPath(),
    JSON.stringify({
      model: 'keep',
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    }),
    'utf8'
  );

  const installer = loadInstaller();
  installer.install();
  installer.uninstall();

  const s = readSettings();
  assert.equal(s.model, 'keep');
  assert.ok(s.hooks.Stop[0].hooks.some((h) => h.command === 'echo mine'), "the user's hook must remain");
  const leftovers = JSON.stringify(s).match(/lifeline-hook/g);
  assert.equal(leftovers, null, 'no Lifeline hooks should remain');
});

test('uninstall drops an event key it emptied rather than leaving a husk', () => {
  scratchEnv();
  const installer = loadInstaller();
  installer.install();
  installer.uninstall();
  const s = readSettings();
  assert.ok(!s.hooks || !s.hooks.StopFailure, 'an empty StopFailure array should not linger');
});

test('status reports installed state accurately', () => {
  scratchEnv();
  const installer = loadInstaller();

  const before = installer.status();
  assert.equal(before.installed, false);

  installer.install();
  const after = installer.status();
  assert.equal(after.installed, true);
  assert.equal(after.complete, true);
  assert.ok(after.events.includes('StopFailure'));
});

test('a malformed settings.json aborts the install instead of overwriting it', () => {
  scratchEnv();
  fs.writeFileSync(settingsPath(), '{ this is not valid json', 'utf8');
  const installer = loadInstaller();
  assert.throws(() => installer.install(), /Cannot parse/, 'destroying an unparseable config would lose user data');
  assert.match(fs.readFileSync(settingsPath(), 'utf8'), /not valid json/, 'the original file must be untouched');
});

test('the installed command quotes the hook path for spaces', () => {
  scratchEnv();
  loadInstaller().install();
  const cmd = readSettings().hooks.StopFailure[0].hooks[0].command;
  assert.match(cmd, /^node "/, 'the repo path can contain spaces (OneDrive), so it must be quoted');
});

test('the StopFailure hook gets a long timeout for backoff waits', () => {
  scratchEnv();
  loadInstaller().install();
  const hook = readSettings().hooks.StopFailure[0].hooks[0];
  assert.ok(hook.timeout >= 600, 'a rate-limit backoff can exceed the default hook timeout');
});
