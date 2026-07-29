'use strict';
/**
 * Detecting that a prompt has finished.
 *
 * The whole risk in this feature is notification volume. "Session is idle" is true
 * on every poll for as long as the window is open, so the naive version toasts every
 * five seconds forever; and at startup every session looks newly-idle, so the other
 * naive version greets the user with a toast per prompt that finished while the app
 * was closed. Both of those are the kind of bug that gets notifications switched off
 * permanently, so they are what these tests are about.
 *
 * Pure — no Electron, no filesystem, no config.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const completion = require('../../src/shared/completion');

/** A session record shaped like sessions.listSessions() returns. */
function session(sessionId, status, { alive = true, name = null, cwd = 'C:/work/payments-api' } = {}) {
  return { sessionId, status, alive, stale: !alive, name, cwd };
}

/** Run a sequence of polls, returning what was announced at each step. */
function polls(...rounds) {
  let state = new Map();
  return rounds.map((sessions) => {
    const res = completion.findCompleted(sessions, state);
    state = res.next;
    return res.completed.map((s) => s.sessionId);
  });
}

test('a session that stops working is announced exactly once', () => {
  const announced = polls(
    [session('a', 'busy')],
    [session('a', 'idle')],
    [session('a', 'idle')],
    [session('a', 'idle')]
  );
  assert.deepEqual(announced, [[], ['a'], [], []]);
});

test('a session already idle at startup is not announced', () => {
  /**
   * The first poll sees every session for the first time, and an idle one is
   * indistinguishable from one that just finished. Announcing them would mean a
   * fistful of toasts for prompts that completed while the app was closed —
   * possibly hours ago, possibly overnight.
   */
  assert.deepEqual(polls([session('a', 'idle'), session('b', 'idle')]), [[]]);
});

test('a session that keeps working is not announced', () => {
  assert.deepEqual(polls([session('a', 'busy')], [session('a', 'busy')], [session('a', 'busy')]), [[], [], []]);
});

test('a second prompt in the same session is announced again', () => {
  // The user asks another question; that finishing is a new event, not a repeat.
  const announced = polls(
    [session('a', 'busy')],
    [session('a', 'idle')],
    [session('a', 'busy')],
    [session('a', 'idle')]
  );
  assert.deepEqual(announced, [[], ['a'], [], ['a']]);
});

test('a session whose process vanished is not called finished', () => {
  /**
   * A crashed session also stops being busy. Reporting that as "finished and
   * waiting for you" would announce a failure as a success — and dead sessions
   * have their own detection, which says something accurate about them.
   */
  const announced = polls([session('a', 'busy')], [session('a', 'busy', { alive: false })]);
  assert.deepEqual(announced, [[], []]);
});

test('each session is tracked separately', () => {
  const announced = polls(
    [session('a', 'busy'), session('b', 'busy')],
    [session('a', 'idle'), session('b', 'busy')],
    [session('a', 'idle'), session('b', 'idle')]
  );
  assert.deepEqual(announced, [[], ['a'], ['b']]);
});

test('a session that disappears entirely is forgotten, not announced', () => {
  // Its record is gone from disk, so there is nothing to notify about — and the
  // state map must not keep it, or the id coming back would compare against a
  // status from another run.
  const first = completion.findCompleted([session('a', 'busy')], new Map());
  const second = completion.findCompleted([], first.next);
  assert.deepEqual(second.completed, []);
  assert.equal(second.next.has('a'), false);
});

test('a record with no session id is ignored rather than tracked as undefined', () => {
  // Every such record would otherwise share one map key and shadow each other.
  const res = completion.findCompleted([{ status: 'idle', alive: true }, null], new Map());
  assert.deepEqual(res.completed, []);
  assert.equal(res.next.size, 0);
});

test('a missing or malformed previous state is treated as a first poll', () => {
  // Defensive: the caller owns the map, and a fresh start must not announce.
  for (const prev of [undefined, null, {}, 'nope']) {
    assert.deepEqual(completion.findCompleted([session('a', 'idle')], prev).completed, []);
  }
});

test('an empty or missing session list does not throw', () => {
  for (const list of [[], null, undefined]) {
    assert.deepEqual(completion.findCompleted(list, new Map()).completed, []);
  }
});

/* ============================== sessionLabel ============================== */

test('the label prefers the name, then the project folder', () => {
  assert.equal(completion.sessionLabel(session('a', 'idle', { name: 'refactor-billing' })), 'refactor-billing');
  assert.equal(completion.sessionLabel(session('a', 'idle', { cwd: 'C:/work/payments-api' })), 'payments-api');
  // A trailing separator must not produce an empty label.
  assert.equal(completion.sessionLabel(session('a', 'idle', { cwd: 'C:/work/telemetry/' })), 'telemetry');
  assert.equal(completion.sessionLabel(session('a', 'idle', { cwd: 'C:\\work\\win-style' })), 'win-style');
});

test('the label never comes back empty, whatever the record holds', () => {
  // It goes straight into a toast body, where "undefined has finished working"
  // would be the visible result.
  assert.equal(completion.sessionLabel(session('a', 'idle', { cwd: null })), 'A session');
  assert.equal(completion.sessionLabel(session('a', 'idle', { cwd: '' })), 'A session');
  assert.equal(completion.sessionLabel(null), 'A session');
  assert.equal(completion.sessionLabel({}), 'A session');
});
