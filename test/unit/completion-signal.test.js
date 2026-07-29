'use strict';
/**
 * The hook → app handoff that drives the completion toast.
 *
 * The whole risk in this feature is notification volume, and moving the trigger to
 * the `Stop` hook changed *where* that risk lives rather than removing it:
 *
 *   - `fs.watch` fires more than once for a single write on Windows, so without a
 *     dedupe one finished prompt becomes two or three toasts.
 *   - The signal file outlives the app, so a restart would otherwise open by
 *     announcing whatever finished last — possibly hours ago.
 *
 * Both are what `isFresh` exists for, and both are tested here. Every test redirects
 * LIFELINE_HOME to a scratch directory, so nothing touches the real signal file and a
 * run cannot toast at whoever is using the machine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.LIFELINE_HOME;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `lifeline-signal-${process.pid}-`));
process.env.LIFELINE_HOME = sandbox;

// Required *after* the redirect: paths reads the variable per call, but requiring in
// the wrong order is the kind of mistake that silently tests the real home.
const signal = require('../../src/shared/completion-signal');
const { completionSignalFile } = require('../../src/shared/paths');

test.after(() => {
  if (HOME === undefined) delete process.env.LIFELINE_HOME;
  else process.env.LIFELINE_HOME = HOME;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/* ============================== write and read ============================== */

test('what the hook writes is what the app reads', () => {
  signal.write({ sessionId: 's-1', cwd: 'C:/work/payments-api', at: 1000 });
  const rec = signal.read();
  assert.equal(rec.sessionId, 's-1');
  assert.equal(rec.cwd, 'C:/work/payments-api');
  assert.equal(rec.at, 1000);
});

test('each turn replaces the last, so the file cannot grow', () => {
  /**
   * Only the most recent completion is ever interesting. Appending would make this
   * unbounded on a machine that runs hundreds of prompts a day, and the hook writes
   * it on Claude Code's critical path.
   */
  signal.write({ sessionId: 's-1', cwd: 'C:/a', at: 1000 });
  signal.write({ sessionId: 's-2', cwd: 'C:/b', at: 2000 });
  assert.equal(signal.read().sessionId, 's-2');
  const raw = fs.readFileSync(completionSignalFile(), 'utf8');
  assert.equal(raw.trim().split('\n').length, 1);
});

test('a missing, empty, or half-written file reads as nothing rather than throwing', () => {
  /**
   * All three are expected states, not corruption: the file does not exist on a fresh
   * install, and the watcher can fire *during* the write, so a partial read is normal.
   * This runs inside the app's notification path, where a throw would be an unhandled
   * exception in main.
   */
  fs.rmSync(completionSignalFile(), { force: true });
  assert.equal(signal.read(), null);

  fs.writeFileSync(completionSignalFile(), '', 'utf8');
  assert.equal(signal.read(), null);

  fs.writeFileSync(completionSignalFile(), '{"sessionId":"s-1","at":10', 'utf8');
  assert.equal(signal.read(), null);
});

test('a record without a usable timestamp is refused', () => {
  // `at` is the only thing that distinguishes one completion from the next, so a
  // record without it cannot be deduped and must not be acted on.
  for (const bad of ['{}', '{"at":"soon"}', '{"at":null}', 'null', '"a string"', '[]']) {
    fs.writeFileSync(completionSignalFile(), bad, 'utf8');
    assert.equal(signal.read(), null, `should refuse ${bad}`);
  }
});

test('writing somewhere unwritable reports failure instead of throwing', () => {
  // The hook runs inside Claude Code. A read-only or missing data dir must cost a
  // toast, never the turn.
  const real = process.env.LIFELINE_HOME;
  try {
    // A path under a *file* can never be created, on any platform.
    const blocker = path.join(sandbox, 'blocker');
    fs.writeFileSync(blocker, 'x', 'utf8');
    process.env.LIFELINE_HOME = path.join(blocker, 'nope');
    assert.equal(signal.write({ sessionId: 's-1', cwd: 'C:/a', at: 1 }), false);
  } finally {
    process.env.LIFELINE_HOME = real;
  }
});

/* ============================== isFresh ============================== */

test('the same completion is announced once, however often the watcher fires', () => {
  // The actual Windows behaviour this guards: one write, several change events.
  const rec = { at: 5000 };
  assert.equal(signal.isFresh(rec, { lastAt: 0, now: 5000 }), true);
  assert.equal(signal.isFresh(rec, { lastAt: 5000, now: 5000 }), false);
  assert.equal(signal.isFresh(rec, { lastAt: 5000, now: 5001 }), false);
});

test('a stale signal left over from a previous run is not announced', () => {
  /**
   * The file survives a restart, and the watcher fires on startup on some setups. The
   * app must not open by announcing a prompt that finished hours ago — same reasoning
   * as never announcing an already-idle session.
   */
  const now = 1_000_000;
  assert.equal(signal.isFresh({ at: now - 5_000 }, { now }), true);
  assert.equal(signal.isFresh({ at: now - 3_600_000 }, { now }), false);
  // Exactly at the boundary counts: the cutoff is "no older than", not "younger than".
  assert.equal(signal.isFresh({ at: now - 60_000 }, { now }), true);
  assert.equal(signal.isFresh({ at: now - 60_001 }, { now }), false);
});

test('a timestamp from the future is not evidence that something just finished', () => {
  // A clock change, or a file copied from another machine. Without this, one bad
  // record suppresses every later completion, because nothing beats its `at`.
  const now = 1_000_000;
  assert.equal(signal.isFresh({ at: now + 60_000 }, { now }), false);
  // A little skew is tolerated: the hook and the app read the clock moments apart.
  assert.equal(signal.isFresh({ at: now + 1_000 }, { now }), true);
});

test('nothing to announce is not an error', () => {
  assert.equal(signal.isFresh(null), false);
  assert.equal(signal.isFresh(undefined), false);
});
