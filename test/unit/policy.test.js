'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { ERROR_CLASSES, POLICIES, policyFor, effectivePolicy, resolveClass, classify } = require('../../src/shared/policy');
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

/* ------------------------- classify() -------------------------------- *
 * Claude Code documents StopFailure.error as one of ERROR_CLASSES, and that
 * path needs no help. These tests exist for the shape it also sends in
 * practice — an SDK error object — which previously fell through to `unknown`
 * and produced a literal "[object Object]" in the resumed session.
 */

test('a documented class string passes through untouched', () => {
  for (const cls of ERROR_CLASSES) assert.equal(classify(cls), cls);
});

test('an error object is classified by its message', () => {
  assert.equal(classify({ message: 'API Error: 429 rate_limit_error' }), 'rate_limit');
  assert.equal(classify({ message: 'Overloaded' }), 'overloaded');
  assert.equal(classify({ message: 'prompt is too long: 210000 tokens > 200000' }), 'invalid_request');
  assert.equal(classify({ message: 'invalid x-api-key' }), 'authentication_failed');
  assert.equal(classify({ message: 'Your credit balance is too low' }), 'billing_error');
});

test('an HTTP status outranks the prose next to it', () => {
  // A 429 body often reads "please try again later", which matches nothing in
  // particular. The status is the reliable signal, so it is consulted first.
  assert.equal(classify({ status: 429, message: 'please try again later' }), 'rate_limit');
  assert.equal(classify({ statusCode: 529, message: 'try again' }), 'overloaded');
  assert.equal(classify({ status: 503, message: 'try again' }), 'server_error');
});

test('a stated class is never overridden by its own message text', () => {
  // The dangerous direction: a billing failure whose body says "retry later"
  // must not be talked into the retry path.
  const p = classify({ class: 'billing_error', message: 'rate limit, retry later' });
  assert.equal(p, 'billing_error');
  assert.equal(policyFor(p).resume, false);
});

test('529 is read as overload, not as a generic 5xx', () => {
  // Ordering matters: 529 also satisfies the \b5\d\d\b server-error pattern,
  // and the two have different backoffs.
  assert.equal(classify({ message: 'Error 529 overloaded_error' }), 'overloaded');
});

test('anything unrecognisable resolves to a retryable unknown', () => {
  // The common unrecognised failure is a dropped connection, so the fallback
  // has to be the resume policy — not a silent no-op.
  for (const input of [null, undefined, {}, '', 'not_a_class', 42, { message: 'socket hang up' }]) {
    assert.equal(classify(input), 'unknown', `${JSON.stringify(input)} should be unknown`);
  }
  assert.equal(policyFor(classify(null)).resume, true);
});

test('classify never throws, whatever it is handed', () => {
  // It runs on Claude Code's critical path; a throw here would break a session
  // that was only having an API problem.
  const circular = { message: 'x' };
  circular.self = circular;
  for (const input of [circular, [], [1, 2], new Error('boom'), Symbol('s'), () => {}]) {
    assert.doesNotThrow(() => classify(input));
    assert.ok(POLICIES[classify(input)], 'must resolve to a real policy key');
  }
});

test('resolveClass and classify agree, so config lookups use the same key', () => {
  // The ledger keys attempts by class and config overrides key by class; if
  // these two disagreed, a per-class limit would silently not apply.
  for (const input of ['rate_limit', { status: 429 }, { message: 'overloaded' }, null]) {
    assert.equal(resolveClass(input), classify(input));
  }
});
