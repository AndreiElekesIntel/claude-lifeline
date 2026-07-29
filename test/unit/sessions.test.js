'use strict';
/**
 * Tests for reading live-session state.
 *
 * The bug these exist for was reported from real use: a session that was visibly
 * working showed up as stalled. The cause was that `updatedAt` in the session
 * record changes when the *status* changes, not when the session does something —
 * so a session that went busy and then worked for twenty minutes carried a
 * twenty-minute-old timestamp, and anything comparing that against a threshold
 * concluded it had hung. The harder it worked, the more certainly it was reported
 * broken.
 *
 * So the tests below are built around timestamps that disagree: a stale status
 * record next to a freshly written transcript. That is the shape of a working
 * session on disk, and the suite fails if it is ever read as a stalled one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * A scratch CLAUDE_CONFIG_DIR, applied via env because that is how paths.js
 * resolves. Every test gets its own — and, more to the point, this suite must
 * never read the real ~/.claude, which has the developer's own sessions in it.
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-sessions-'));
  const claude = path.join(dir, 'claude');
  fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claude;
  return { dir, claude };
}

/** Fresh module instances, so nothing caches a path from a previous sandbox. */
function load() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}shared${path.sep}`)) delete require.cache[key];
  }
  return require('../../src/shared/sessions');
}

/**
 * Write a session record and, optionally, a transcript with a chosen mtime.
 *
 * The pid defaults to this process's own, because liveness is a signal-0 probe and
 * the only pid a test can be certain is alive is its own.
 */
function writeSession(claude, { pid = process.pid, sessionId = 'a1b2c3d4-0000-4000-8000-000000000001', cwd = 'C:\\work\\api', status = 'busy', updatedAt, transcriptAt } = {}) {
  fs.writeFileSync(
    path.join(claude, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, status, updatedAt, startedAt: updatedAt })
  );
  if (transcriptAt !== undefined) {
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const dir = path.join(claude, 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, '{"type":"user"}\n');
    fs.utimesSync(file, transcriptAt / 1000, transcriptAt / 1000);
  }
  return { pid, sessionId, cwd };
}

/* ========================= the reported bug ========================= */

test('a session working for longer than the stall threshold is not stalled', () => {
  // The exact reported shape: status went busy 40 minutes ago and has not changed
  // since, because the session has been working the whole time. Two live sessions
  // were measured in this state, with `updatedAt` 19 and 20 minutes stale and
  // transcripts written seconds earlier.
  const { claude } = sandbox();
  const now = Date.now();
  writeSession(claude, { status: 'busy', updatedAt: now - 40 * 60_000, transcriptAt: now - 3_000 });

  const sessions = load();
  const list = sessions.listSessions(now);
  assert.equal(list.length, 1);
  assert.ok(list[0].idleMs < 60_000, `idle should be seconds, was ${Math.round(list[0].idleMs / 1000)}s`);
  assert.deepEqual(sessions.findStalled(list, 900_000), []);
});

test('a genuinely hung session is still reported', () => {
  // The other half of the fix: making working sessions look active must not make
  // stuck ones look active too. Nothing has been written for an hour here.
  const { claude } = sandbox();
  const now = Date.now();
  writeSession(claude, { status: 'busy', updatedAt: now - 60 * 60_000, transcriptAt: now - 60 * 60_000 });

  const sessions = load();
  const stalled = sessions.findStalled(sessions.listSessions(now), 900_000);
  assert.equal(stalled.length, 1);
});

test('an idle session is never stalled, however long it has sat there', () => {
  // Waiting for its user is what idle *is*. Reporting it would make the warning
  // meaningless, since most sessions are idle most of the time.
  const { claude } = sandbox();
  const now = Date.now();
  writeSession(claude, { status: 'idle', updatedAt: now - 6 * 3_600_000, transcriptAt: now - 6 * 3_600_000 });

  const sessions = load();
  assert.deepEqual(sessions.findStalled(sessions.listSessions(now), 900_000), []);
});

/* ===================== the transcript lookup ======================== */

test('the project slug is the one Claude Code actually uses', () => {
  // Verified against the real projects tree when this was written: every
  // non-alphanumeric character becomes a dash, including the dots and spaces in a
  // OneDrive path. If this rule ever changes, the transcript is simply not found.
  const sessions = load();
  assert.equal(sessions.projectSlug('C:\\Users\\aelekes'), 'C--Users-aelekes');
  assert.equal(
    sessions.projectSlug('C:\\Users\\aelekes\\OneDrive - Intel Corporation\\Documents\\frameworks.devops.lab'),
    'C--Users-aelekes-OneDrive---Intel-Corporation-Documents-frameworks-devops-lab'
  );
});

test('a missing transcript falls back to the status timestamp, not to nothing', () => {
  // Transcripts get pruned, and the slug rule could change under us. Either way the
  // session must keep the behaviour it had before transcripts were consulted,
  // rather than losing its timestamp and becoming un-assessable.
  const { claude } = sandbox();
  const now = Date.now();
  writeSession(claude, { status: 'busy', updatedAt: now - 30 * 60_000 }); // no transcript

  const sessions = load();
  const [s] = sessions.listSessions(now);
  assert.equal(s.touchedAt, null);
  assert.ok(s.idleMs >= 30 * 60_000, 'the status timestamp should still be used');
  assert.equal(sessions.findStalled([s], 900_000).length, 1);
});

test('the newer of the two timestamps wins, so the signal can only add liveness', () => {
  // Math.max rather than preferring the transcript outright: a status change is
  // itself activity, so a session whose transcript is older than its status record
  // must not be aged backwards by this.
  const { claude } = sandbox();
  const now = Date.now();
  writeSession(claude, { status: 'busy', updatedAt: now - 2_000, transcriptAt: now - 45 * 60_000 });

  const sessions = load();
  const [s] = sessions.listSessions(now);
  assert.ok(s.idleMs < 60_000, 'the fresher status timestamp should win');
});

test('a session id that could escape the projects tree is not turned into a path', () => {
  // The id comes out of a JSON file on disk, so it is data, not something trusted.
  // A traversal attempt gets no transcript rather than a stat outside the tree.
  const sessions = load();
  for (const bad of ['../../../etc/passwd', '..', 'a/b', 'a\\b', '']) {
    assert.equal(sessions.transcriptTouchedAt('C:\\work', bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

/* ========================== the rest of it ========================== */

test('a session whose process is gone mid-work is dead, not stalled', () => {
  // A stalled session can be waited for or interrupted; a dead one had its work
  // lost, which is a different thing to tell the user about.
  const { claude } = sandbox();
  const now = Date.now();
  // pid 1 does not exist on Windows, so the signal-0 probe reports it gone.
  writeSession(claude, { pid: 1, status: 'busy', updatedAt: now - 5_000, transcriptAt: now - 5_000 });

  const sessions = load();
  const list = sessions.listSessions(now);
  assert.equal(list[0].alive, false);
  assert.equal(sessions.findDead(list).length, 1);
  assert.deepEqual(sessions.findStalled(list, 900_000), []);
});

test('an unreadable record is skipped rather than taking the whole list down', () => {
  // The CLI writes these files while we read them, so a half-written one is normal
  // and must not cost the user every other session's status.
  const { claude } = sandbox();
  const now = Date.now();
  writeSession(claude, { status: 'busy', updatedAt: now - 1_000, transcriptAt: now - 1_000 });
  fs.writeFileSync(path.join(claude, 'sessions', '99999.json'), '{ truncated');

  const sessions = load();
  assert.equal(sessions.listSessions(now).length, 1);
});

test('sessions are ordered by real activity, newest first', () => {
  const { claude } = sandbox();
  const now = Date.now();
  writeSession(claude, { pid: process.pid, sessionId: 'older-0000-4000-8000-000000000001', cwd: 'C:\\a', updatedAt: now - 60_000, transcriptAt: now - 60_000 });
  writeSession(claude, { pid: 1, sessionId: 'newer-0000-4000-8000-000000000002', cwd: 'C:\\b', updatedAt: now - 90 * 60_000, transcriptAt: now - 1_000 });

  const sessions = load();
  const list = sessions.listSessions(now);
  // The second one has a much older status record but a much fresher transcript,
  // which is the ordering the user cares about.
  assert.equal(list[0].sessionId, 'newer-0000-4000-8000-000000000002');
});

test('no sessions directory is an empty list, not a crash', () => {
  // True on a machine where Claude Code has never run.
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'lifeline-definitely-absent-xyz');
  const sessions = load();
  assert.deepEqual(sessions.listSessions(), []);
});
