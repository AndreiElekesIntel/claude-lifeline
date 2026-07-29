'use strict';
/**
 * How a finished session is labelled in the toast.
 *
 * The edge detection that used to be tested here is gone: the `Stop` hook is the
 * signal now, so the interesting cases moved to completion-signal.test.js. What is
 * left is the naming, which still matters — a toast that says only "a session
 * finished" is useless with three of them running.
 *
 * Pure — no Electron, no filesystem, no config.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const completion = require('../../src/shared/completion');

test('a name wins, then the folder it was working in', () => {
  assert.equal(completion.sessionLabel({ name: 'refactor-billing', cwd: 'C:/work/other' }), 'refactor-billing');
  assert.equal(completion.sessionLabel({ cwd: 'C:/work/payments-api' }), 'payments-api');
});

test('a trailing separator does not become an empty label', () => {
  // Session records are written by another program; a trailing slash is its choice.
  assert.equal(completion.sessionLabel({ cwd: 'C:/work/telemetry/' }), 'telemetry');
  assert.equal(completion.sessionLabel({ cwd: 'C:\\work\\win-style\\' }), 'win-style');
});

test('both separators work, since these paths come from Windows', () => {
  assert.equal(completion.sessionLabel({ cwd: 'C:\\work\\win-style' }), 'win-style');
});

test('a session at a drive root is labelled by the drive', () => {
  // Not a fallback: "C:" is where it is actually working, and it still tells two
  // sessions apart. The generic label is reserved for having genuinely nothing.
  assert.equal(completion.sessionLabel({ cwd: 'C:/' }), 'C:');
  assert.equal(completion.sessionLabel({ cwd: 'D:\\' }), 'D:');
});

test('there is always something to show', () => {
  /**
   * The label goes straight into a toast, so an empty string would render as a
   * notification with a blank subject rather than as an obvious bug. Every one of
   * these is a shape the signal file can legitimately hold — it is written by the
   * hook from a payload Lifeline does not control.
   */
  assert.equal(completion.sessionLabel({ cwd: null }), 'A session');
  assert.equal(completion.sessionLabel({ cwd: '' }), 'A session');
  assert.equal(completion.sessionLabel(null), 'A session');
  assert.equal(completion.sessionLabel(undefined), 'A session');
  assert.equal(completion.sessionLabel({}), 'A session');
});

test('the poll-based detector is gone, not merely unused', () => {
  // Two implementations of "did a prompt finish" is how a later change accidentally
  // reintroduces the five-second lag this feature was rewritten to remove.
  assert.equal(completion.findCompleted, undefined);
});
