'use strict';
/**
 * Tests for the "is everything actually finished?" decision.
 *
 * The bias under test is the important part. A wrong "not finished" wastes a
 * night of idle laptop; a wrong "finished" powers off a machine with unrecovered
 * work on it. So most of these assert that something *blocks*, and the one test
 * that asserts `safe` is true sets up the fully-quiet world explicitly — if a
 * future change makes shutdown easier to reach, that test is the only one that
 * keeps passing, and the rest fail loudly.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * A scratch CLAUDE_CONFIG_DIR + LIFELINE_HOME, applied via env because that is
 * how paths.js resolves. Set before requiring the module under test, and each
 * test gets its own so nothing leaks between them — and, more importantly, so
 * this suite never reads the real ~/.claude while sessions are running.
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-idle-'));
  const claude = path.join(dir, 'claude');
  const home = path.join(dir, 'lifeline');
  fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.LIFELINE_HOME = home;
  return { dir, claude, home };
}

/** Fresh module instances, so nothing caches a path from a previous sandbox. */
function load() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}shared${path.sep}`)) delete require.cache[key];
  }
  return require('../../src/shared/idle-shutdown');
}

const MIN = 60_000;

/** A session record shaped like the ones Claude Code writes. */
function writeSession(box, { pid, status = 'idle', name = 'sess', updatedAt = Date.now() }) {
  fs.writeFileSync(
    path.join(box.claude, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId: `id-${pid}`, cwd: 'C:\\work', name, status, updatedAt, startedAt: updatedAt - 60_000 }),
    'utf8'
  );
}

/**
 * A transcript whose final assistant turn ends with `stopReason`.
 *
 * `ageMs` sets the file mtime, since transcript silence is one of the checks.
 */
function writeTranscript(box, { slug = 'proj', id = 'sess-1', stopReason = 'end_turn', ageMs = 60 * MIN, lines = null } = {}) {
  const dir = path.join(box.claude, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const body =
    lines ||
    [
      { type: 'user', message: { role: 'user', content: 'do the thing' }, timestamp: new Date().toISOString() },
      {
        type: 'assistant',
        message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text: 'done' }] },
        timestamp: new Date().toISOString(),
      },
    ];
  fs.writeFileSync(file, body.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return file;
}

const codes = (result) => result.blockers.map((b) => b.code);

/**
 * The baseline: one session, idle, whose transcript ended cleanly an hour ago.
 * A live pid would make the process check fire, so the recorded pid is one that
 * cannot exist.
 */
function settled(box) {
  writeSession(box, { pid: 0x7ffffff0, status: 'idle', updatedAt: Date.now() - 60 * MIN });
  writeTranscript(box, { stopReason: 'end_turn', ageMs: 60 * MIN });
}

test('a fully settled machine is safe to shut down', () => {
  const box = sandbox();
  const idle = load();
  settled(box);
  const r = idle.assess();
  assert.equal(r.safe, true, `expected safe, blocked by: ${JSON.stringify(r.blockers)}`);
  assert.deepEqual(r.blockers, []);
});

test('a session still marked busy blocks shutdown', () => {
  const box = sandbox();
  const idle = load();
  settled(box);
  // Its own pid: guaranteed alive, so the liveness probe cannot be fooled.
  writeSession(box, { pid: process.pid, status: 'busy', name: 'working-session' });
  const r = idle.assess();
  assert.equal(r.safe, false);
  assert.ok(codes(r).includes('session_busy'));
  assert.match(r.blockers.find((b) => b.code === 'session_busy').detail, /working-session/);
});

test('a turn that ended mid-tool-call blocks shutdown', () => {
  // The case this whole module exists for: an API failure cuts the turn while a
  // tool is in flight. Nothing is running, nothing is being written, and the
  // session looks idle — but the work is not done.
  const box = sandbox();
  const idle = load();
  writeSession(box, { pid: 0x7ffffff0, status: 'idle', updatedAt: Date.now() - 60 * MIN });
  writeTranscript(box, { stopReason: 'tool_use', ageMs: 60 * MIN });
  const r = idle.assess();
  assert.equal(r.safe, false);
  assert.ok(codes(r).includes('turn_incomplete'));
  assert.match(r.blockers.find((b) => b.code === 'turn_incomplete').detail, /tool_use/);
});

test('a max_tokens stop is not treated as a finished turn', () => {
  // Truncated output is resumable work, and Lifeline has a policy for it. Only
  // end_turn means the model chose to stop.
  const box = sandbox();
  const idle = load();
  writeSession(box, { pid: 0x7ffffff0, status: 'idle', updatedAt: Date.now() - 60 * MIN });
  writeTranscript(box, { stopReason: 'max_tokens', ageMs: 60 * MIN });
  assert.ok(codes(idle.assess()).includes('turn_incomplete'));
});

test('a transcript written moments ago blocks shutdown', () => {
  const box = sandbox();
  const idle = load();
  writeSession(box, { pid: 0x7ffffff0, status: 'idle', updatedAt: Date.now() - 60 * MIN });
  writeTranscript(box, { stopReason: 'end_turn', ageMs: 2 * MIN });
  const r = idle.assess();
  assert.equal(r.safe, false);
  assert.ok(codes(r).includes('recent_activity'), 'a clean stop_reason is not enough if the file is still moving');
});

test('a recent recovery attempt blocks shutdown', () => {
  // A resumed session may be seconds from writing its next line, and a rate-limit
  // backoff alone can run minutes.
  const box = sandbox();
  const idle = load();
  settled(box);
  fs.writeFileSync(
    path.join(box.home, 'ledger.json'),
    JSON.stringify({ version: 1, attempts: [{ at: Date.now() - 3 * MIN, sessionId: 'id-1', errorClass: 'rate_limit' }], sessions: {} }),
    'utf8'
  );
  const r = idle.assess();
  assert.equal(r.safe, false);
  assert.ok(codes(r).includes('recovery_recent'));
});

test('an old recovery attempt does not block forever', () => {
  const box = sandbox();
  const idle = load();
  settled(box);
  fs.writeFileSync(
    path.join(box.home, 'ledger.json'),
    JSON.stringify({ version: 1, attempts: [{ at: Date.now() - 5 * 60 * MIN, sessionId: 'id-1', errorClass: 'rate_limit' }], sessions: {} }),
    'utf8'
  );
  assert.equal(idle.assess().safe, true);
});

test('an unacknowledged notify blocks shutdown', () => {
  // A billing or auth failure is unfinished work that only a human can clear,
  // and it must not be powered off into silence.
  const box = sandbox();
  const idle = load();
  settled(box);
  fs.writeFileSync(
    path.join(box.home, 'events.jsonl'),
    JSON.stringify({ at: Date.now() - 30 * MIN, kind: 'notified', label: 'Billing problem', needsAttention: true }) + '\n',
    'utf8'
  );
  const r = idle.assess();
  assert.equal(r.safe, false);
  assert.ok(codes(r).includes('needs_attention'));
  assert.match(r.blockers.find((b) => b.code === 'needs_attention').detail, /Billing problem/);
});

test('acknowledging an attention item clears the block', () => {
  const box = sandbox();
  const idle = load();
  settled(box);
  const then = Date.now() - 30 * MIN;
  fs.writeFileSync(
    path.join(box.home, 'events.jsonl'),
    [
      JSON.stringify({ at: then, kind: 'notified', label: 'Billing problem', needsAttention: true }),
      JSON.stringify({ at: then + MIN, kind: 'info', acknowledgesUntil: then + MIN }),
    ].join('\n') + '\n',
    'utf8'
  );
  assert.equal(idle.assess().safe, true, 'an acknowledged item is handled, not pending');
});

test('a session whose process died mid-task blocks shutdown', () => {
  const box = sandbox();
  const idle = load();
  settled(box);
  // A pid that cannot be alive, recorded as busy: the dead-session signature.
  writeSession(box, { pid: 0x7fffffee, status: 'busy', name: 'crashed-session' });
  const r = idle.assess();
  assert.equal(r.safe, false);
  assert.ok(codes(r).includes('session_died'));
});

test('a transcript with no assistant turn at all blocks shutdown', () => {
  // Inconclusive is not the same as finished. Anything this module cannot read a
  // clean ending from has to block.
  const box = sandbox();
  const idle = load();
  writeSession(box, { pid: 0x7ffffff0, status: 'idle', updatedAt: Date.now() - 60 * MIN });
  writeTranscript(box, {
    ageMs: 60 * MIN,
    lines: [{ type: 'system', subtype: 'init', timestamp: new Date().toISOString() }],
  });
  assert.ok(codes(idle.assess()).includes('turn_incomplete'));
});

test('a torn final line does not hide the completed turn before it', () => {
  // Transcripts are appended to live, so the last line is routinely half-written.
  // That must not be read as "no clean ending".
  const box = sandbox();
  const idle = load();
  writeSession(box, { pid: 0x7ffffff0, status: 'idle', updatedAt: Date.now() - 60 * MIN });
  const file = writeTranscript(box, { stopReason: 'end_turn', ageMs: 60 * MIN });
  fs.appendFileSync(file, '{"type":"assistant","message":{"role":"assis', 'utf8');
  const when = new Date(Date.now() - 60 * MIN);
  fs.utimesSync(file, when, when);
  const r = idle.assess();
  assert.equal(r.safe, true, `torn line should be skipped, blocked by: ${JSON.stringify(r.blockers)}`);
});

test('a subagent transcript still being written blocks shutdown', () => {
  // A subagent mid-run is work in flight even when the parent session looks idle.
  const box = sandbox();
  const idle = load();
  settled(box);
  const subDir = path.join(box.claude, 'projects', 'proj', 'sess-1', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const file = path.join(subDir, 'agent-1.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use' } }) + '\n', 'utf8');
  const r = idle.assess();
  assert.equal(r.safe, false);
  assert.ok(codes(r).includes('recent_activity') || codes(r).includes('turn_incomplete'));
});

test('a stalled session blocks shutdown', () => {
  const box = sandbox();
  const idle = load();
  settled(box);
  // Alive, claims to be busy, but has not moved in an hour.
  writeSession(box, { pid: process.pid, status: 'busy', name: 'stalled-session', updatedAt: Date.now() - 60 * MIN });
  const r = idle.assess();
  assert.equal(r.safe, false);
  assert.ok(codes(r).includes('session_stalled'));
});

test('every blocker carries a human-readable reason', () => {
  // The morning-after requirement: "we did not shut down" is only useful with a
  // reason attached.
  const box = sandbox();
  const idle = load();
  writeSession(box, { pid: process.pid, status: 'busy', name: 'x' });
  writeTranscript(box, { stopReason: 'tool_use', ageMs: 1 * MIN });
  const r = idle.assess();
  assert.ok(r.blockers.length > 0);
  for (const b of r.blockers) {
    assert.equal(typeof b.code, 'string');
    assert.ok(b.detail && b.detail.length > 10, `blocker ${b.code} needs a usable detail`);
  }
});

test('an empty machine with no sessions and no transcripts is safe', () => {
  // A fresh install, or a laptop where Claude Code has not run: nothing to lose.
  sandbox();
  const idle = load();
  const r = idle.assess();
  assert.equal(r.safe, true);
  assert.equal(r.checks.transcriptsExamined, 0);
});

test('assess never throws on a missing or unreadable claude dir', () => {
  const box = sandbox();
  fs.rmSync(box.claude, { recursive: true, force: true });
  const idle = load();
  assert.doesNotThrow(() => idle.assess());
});

test('a longer --quiet window makes the check stricter, not looser', () => {
  const box = sandbox();
  const idle = load();
  writeSession(box, { pid: 0x7ffffff0, status: 'idle', updatedAt: Date.now() - 60 * MIN });
  writeTranscript(box, { stopReason: 'end_turn', ageMs: 30 * MIN });
  assert.equal(idle.assess({ quietMs: 20 * MIN }).safe, true);
  assert.equal(idle.assess({ quietMs: 45 * MIN }).safe, false, 'a 30-min-old file is not quiet enough for a 45-min window');
});
