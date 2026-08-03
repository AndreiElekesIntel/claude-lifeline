'use strict';
/**
 * The published build cost.
 *
 * A one-constant module barely needs a test, except that this constant is the one
 * thing in the repo whose whole job is to be edited by hand at the end of every
 * working session. What can go wrong is not the arithmetic — it is a typo in a
 * hand-edit landing in a released build: a string instead of a number, a lost
 * decimal point, a value that walked backwards.
 *
 * The lower bound is the load-bearing assertion. It is the figure as of
 * 2026-08-03; bumping the total upward will always pass, and only a *decrease*
 * fails — which is what a fat-fingered edit looks like, since the number is a
 * cumulative total and cannot legitimately shrink.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { BUILD_COST_USD } = require('../../src/shared/build-cost');

test('the build cost is a number the UI can format', () => {
  assert.equal(typeof BUILD_COST_USD, 'number');
  assert.ok(Number.isFinite(BUILD_COST_USD), 'not NaN or Infinity');
  assert.ok(BUILD_COST_USD > 0, 'a total of zero would mean the figure was cleared, not that the app was free');
});

test('the running total only ever goes up', () => {
  // The figure at the time this test was written. A cumulative spend cannot
  // decrease, so anything below this is an editing mistake rather than a bump.
  assert.ok(
    BUILD_COST_USD >= 110.2495,
    `the build cost went down to ${BUILD_COST_USD} — a cumulative total cannot shrink, so this is a bad edit`
  );
});

test('the figure keeps the precision a per-million-token rate produces', () => {
  // Rounding at the source would make a session's increment vanish: several
  // sessions are worth less than a cent each at these rates, and a whole-cent
  // constant would swallow them. Four decimal places is the honest resolution.
  const decimals = (String(BUILD_COST_USD).split('.')[1] || '').length;
  assert.ok(decimals >= 2, `only ${decimals} decimal place(s) — the total has been rounded at the source`);
  // Not a float-precision artefact either: a value with fifteen decimals means
  // someone added two numbers in a REPL and pasted the result.
  assert.ok(decimals <= 4, `${decimals} decimal places — round to 4 before committing`);
});
