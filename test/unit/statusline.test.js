'use strict';
/**
 * The statusline runs on Claude Code's interactive path — spawned and waited on for
 * every refresh — so these tests are mostly about failure, not about features.
 *
 * Two things must hold no matter what:
 *   - it always prints a line, because a crash replaces the user's statusline with
 *     an error message on every keystroke;
 *   - the dot never contradicts the app's Sessions table, because a green dot beside
 *     a "stalled" row is worse than no dot at all — the dot is the one believed.
 *
 * The CLI tests spawn the real command with a sandboxed CLAUDE_CONFIG_DIR, so
 * nothing here can read or disturb a live session.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const statusline = require('../../src/statusline/statusline');
const CLI = path.join(__dirname, '..', '..', 'src', 'statusline', 'cli.js');

/** ANSI-free, because the assertions are about content, not colour. */
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

const rec = (over = {}) => ({ sessionId: 'sess-1', pid: 1234, alive: true, status: 'idle', idleMs: 0, cwd: 'C:/work/one', ...over });

const payload = (over = {}) => ({
  session_id: 'sess-1',
  workspace: { current_dir: 'C:/work/one' },
  model: { display_name: 'Opus 5' },
  cost: { total_cost_usd: 0.4213, total_duration_ms: 91_200 },
  context_window: { context_window_size: 200_000, total_input_tokens: 150_000, total_output_tokens: 8_000 },
  ...over,
});

/* ---------------------------------------------------------------- state ------ */

test('the four states get four distinct glyphs, and the words match the app', () => {
  assert.equal(statusline.stateOf(rec({ status: 'idle' })).word, 'done');
  assert.equal(statusline.stateOf(rec({ status: 'busy', idleMs: 1_000 })).word, 'working');
  assert.equal(statusline.stateOf(rec({ status: 'busy', idleMs: 3_600_000 })).word, 'stalled');
  assert.equal(statusline.stateOf(rec({ alive: false, status: 'busy' })).word, 'died');
  assert.equal(statusline.stateOf(rec({ alive: false, status: 'idle' })).word, 'exited');

  const glyphs = ['idle', 'busy'].map((s) => statusline.stateOf(rec({ status: s })).glyph);
  assert.notEqual(glyphs[0], glyphs[1], 'done and working must differ in shape, not only in colour');
});

test('working reads as a ring and done as filled, so colour is never the only channel', () => {
  // This is the point of choosing glyphs at all: green-vs-violet is exactly the pair
  // red-green colour blindness collapses, and NO_COLOR strips the hue entirely.
  assert.equal(statusline.stateOf(rec({ status: 'busy' })).glyph, '○');
  assert.equal(statusline.stateOf(rec({ status: 'idle' })).glyph, '●');
});

test('a missing record is unknown rather than an assumption', () => {
  assert.equal(statusline.stateOf(null).word, 'unknown');
  assert.equal(statusline.stateOf(undefined).word, 'unknown');
});

test('a busy session with no idle reading is working, not stalled', () => {
  // idleMs is null when the record has no timestamp to measure from. Treating that
  // as "quiet for a long time" would flag healthy sessions as stalled.
  assert.equal(statusline.stateOf(rec({ status: 'busy', idleMs: null })).word, 'working');
});

/* ---------------------------------------------------------------- findSelf --- */

test('the session id wins over the directory', () => {
  const list = [rec({ sessionId: 'other', pid: 1 }), rec({ sessionId: 'mine', pid: 2 })];
  assert.equal(statusline.findSelf(list, { sessionId: 'mine', cwd: 'C:/work/one' }).pid, 2);
});

test('two sessions in one folder produce no dot rather than a coin flip', () => {
  const list = [rec({ sessionId: 'a', pid: 1 }), rec({ sessionId: 'b', pid: 2 })];
  assert.equal(statusline.findSelf(list, { cwd: 'C:/work/one' }), null);
});

test('one session in a folder is matched by directory when no id is sent', () => {
  const list = [rec({ sessionId: 'a', pid: 1, cwd: 'C:/work/one' }), rec({ sessionId: 'b', pid: 2, cwd: 'C:/work/two' })];
  assert.equal(statusline.findSelf(list, { cwd: 'C:/work/two' }).pid, 2);
});

test('directory matching survives slash direction, case, and a trailing separator', () => {
  const list = [rec({ cwd: 'C:\\Work\\One' })];
  assert.ok(statusline.findSelf(list, { cwd: 'c:/work/one/' }), 'Windows paths reach us in both forms');
});

test('a dead session is not matched by directory', () => {
  // Its record lingers after exit; matching it would show a red dot in a session
  // that is plainly running, since it is the one rendering the line.
  const list = [rec({ alive: false, cwd: 'C:/work/one' })];
  assert.equal(statusline.findSelf(list, { cwd: 'C:/work/one' }), null);
});

/* ---------------------------------------------------------------- fleet ------ */

test('the fleet count excludes this session', () => {
  const self = rec({ pid: 10, status: 'idle' });
  const list = [self, rec({ pid: 11, status: 'idle' }), rec({ pid: 12, status: 'busy' })];
  const f = statusline.fleet(list, self);
  assert.equal(f.done, 1, '"1 done" describing the line you are reading is noise');
  assert.equal(f.working, 1);
});

test('dead sessions count as neither done nor working', () => {
  const list = [rec({ pid: 1, alive: false, status: 'idle' }), rec({ pid: 2, alive: false, status: 'busy' })];
  const f = statusline.fleet(list, null);
  assert.deepEqual(f, { done: 0, working: 0 });
});

/* ---------------------------------------------------------------- details ---- */

test('the details keep the format they had before Lifeline touched them', () => {
  assert.equal(statusline.details(payload()), 'one | Opus 5 (200k context) | $0.4213 | 91.2s | ctx 158.0k/200.0k');
});

test('no model means no orphaned context annotation', () => {
  // The size annotates the model name; alone it renders as " (200k context)", which
  // reads as a value that failed to load rather than one that is absent.
  const out = statusline.details(payload({ model: {} }));
  assert.ok(!out.includes('(200k context)'), out);
  assert.ok(out.includes('$0.4213'), 'the rest of the line must survive');
});

test('an empty payload still produces a line', () => {
  const out = statusline.details({});
  assert.ok(out.includes('$0.0000'));
  assert.ok(out.includes('ctx 0/200.0k'));
});

/* ---------------------------------------------------------------- render ----- */

test('render puts this session first and the fleet last', () => {
  const self = rec({ sessionId: 'sess-1', pid: 10, status: 'busy' });
  const list = [self, rec({ pid: 11, status: 'idle' }), rec({ pid: 12, status: 'idle' })];
  const out = strip(statusline.render(payload(), list, { color: false }));
  assert.match(out, /^○ /, "the leading glyph is about the line it is attached to");
  assert.match(out, /● 2 done$/, 'the trailing count is about everything else');
});

test('the fleet segment is silent at zero', () => {
  const self = rec({ pid: 10 });
  const out = strip(statusline.render(payload(), [self], { color: false }));
  assert.ok(!/done/.test(out), 'a single-session terminal should look exactly as it did before');
});

test('the dot agrees with the state the app would show', () => {
  // Same input, both surfaces: a stalled session must not read as working here.
  const self = rec({ pid: 10, status: 'busy', idleMs: 3_600_000 });
  const out = strip(statusline.render(payload(), [self], { color: false }));
  assert.match(out, /^◑ /);
  assert.equal(statusline.stateOf(self).word, 'stalled');
});

test('render is total: no session records, unreadable list, or missing fields', () => {
  for (const sessions of [[], null, undefined, 'not-a-list', [null, undefined, {}]]) {
    const out = statusline.render(payload(), sessions, { color: false });
    assert.ok(out.length > 0, `empty output for ${JSON.stringify(sessions)}`);
  }
  assert.ok(statusline.render(undefined, undefined, { color: false }).length > 0);
  assert.ok(statusline.render({}, [], {}).length > 0);
});

test('colour is emitted by default and suppressed on request', () => {
  const list = [rec({ pid: 10, status: 'idle' }), rec({ pid: 11, status: 'idle' })];
  const painted = statusline.render(payload(), list, { color: true });
  assert.ok(painted.includes('\u001b['), 'truecolor escapes expected');
  const plainOut = statusline.render(payload(), list, { color: false });
  assert.ok(!plainOut.includes('\u001b['), plainOut);
  assert.equal(strip(painted), plainOut, 'stripping colour must not change the text');
});

/* ---------------------------------------------------------------- cli -------- */

function runCli(input, env = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-sl-'));
  const res = spawnSync(process.execPath, [CLI], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      // Sandboxed: the CLI reads session records, and this suite must not see live ones.
      CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude'),
      LIFELINE_HOME: path.join(sandbox, 'lifeline'),
      ...env,
    },
  });
  return { ...res, out: strip(res.stdout || '') };
}

test('the command prints the line and exits cleanly', () => {
  const res = runCli(payload());
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.out, /Opus 5 \(200k context\)/);
  assert.match(res.out, /\$0\.4213/);
});

test('malformed and empty stdin still produce a line, never an error', () => {
  for (const input of ['', 'not json at all', '{"broken":']) {
    const res = runCli(input);
    assert.equal(res.status, 0, `exit ${res.status} for ${JSON.stringify(input)}: ${res.stderr}`);
    assert.equal(res.stderr, '', 'stderr would surface in the terminal');
    assert.ok(res.out.length > 0, 'an empty statusline reads as Claude Code having lost it');
  }
});

test('NO_COLOR is honoured', () => {
  const res = runCli(payload(), { NO_COLOR: '1' });
  assert.ok(!(res.stdout || '').includes('\u001b['), res.stdout);
});

test('no session records at all costs the dots, not the line', () => {
  // The sandbox has no sessions dir, which is the same shape as an unreadable one.
  const res = runCli(payload());
  assert.equal(res.status, 0);
  assert.match(res.out, /\$0\.4213/);
  assert.ok(!/done/.test(res.out));
});
