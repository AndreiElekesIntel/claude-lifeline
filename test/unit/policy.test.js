'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { ERROR_CLASSES, policyFor, effectivePolicy } = require('../../src/shared/policy');
const { defaultConfig } = require('../../src/shared/config');

test('every error class Claude Code can report has a policy', () => {
  for (const cls of ERROR_CLASSES) {
    const p = policyFor(cls);
    assert.ok(p, `missing policy for ${cls}`);
    assert.equal(typeof p.resume, 'boolean');
    assert.equal(typeof p.label, 'string');
    assert.ok(['resume', 'compact', 'notify'].includes(p.strategy));
  }
});

test('transient failures resume', () => {
  for (const cls of ['rate_limit', 'overloaded', 'server_error', 'unknown', 'max_output_tokens']) {
    assert.equal(policyFor(cls).resume, true, `${cls} should resume`);
  }
});

test('failures a retry cannot fix are never auto-resumed', () => {
  // The whole point of the split: retrying these burns budget and hides the
  // message telling the user what to fix.
  for (const cls of ['authentication_failed', 'billing_error', 'oauth_org_not_allowed', 'model_not_found']) {
    const p = policyFor(cls);
    assert.equal(p.resume, false, `${cls} must not auto-resume`);
    assert.equal(p.strategy, 'notify');
    assert.equal(p.message, null, `${cls} must not carry a resume message`);
  }
});

test('context overflow compacts instead of retrying unchanged', () => {
  const p = policyFor('invalid_request');
  assert.equal(p.strategy, 'compact');
  assert.match(p.message, /\/compact/);
});

test('unknown classes fall back to the connection-loss policy', () => {
  assert.deepEqual(policyFor('something_new_from_a_future_release'), policyFor('unknown'));
});

test('rate limit waits longer than a plain server error', () => {
  assert.ok(policyFor('rate_limit').backoffMs > policyFor('server_error').backoffMs);
});

test('a user override can disable a retryable class', () => {
  const cfg = defaultConfig();
  cfg.policies.rate_limit = { resume: false };
  const p = effectivePolicy('rate_limit', cfg);
  assert.equal(p.resume, false);
  assert.equal(p.strategy, 'notify', 'disabling must collapse to notify, not a silent drop');
});

test('a user override cannot be ignored when tightening attempts', () => {
  const cfg = defaultConfig();
  cfg.policies.overloaded = { maxAttempts: 1 };
  assert.equal(effectivePolicy('overloaded', cfg).maxAttempts, 1);
});

test('resume messages tell the model not to redo finished work', () => {
  for (const cls of ERROR_CLASSES) {
    const p = policyFor(cls);
    if (!p.resume) continue;
    assert.match(p.message, /where you left off|Continue from|do not repeat|not restart/i, `${cls} message should preserve prior work`);
  }
});
