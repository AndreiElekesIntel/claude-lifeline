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

/* ------------- telling apart the failures a 403 hides ---------------- *
 * Claude Code prints "Please run /login" for several unrelated faults and
 * attaches a 403 to most of them. Logging in again fixes exactly one, so the
 * distinction is the whole value Lifeline adds here.
 */

/** The real Bedrock refusal, verbatim from Claude Code 2.1.220. */
const BEDROCK_403 =
  'Please run /login · API Error: 403 {"Message":"User: arn:aws:iam::372075448100:user/BedrockUser_aelekes ' +
  'is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: ' +
  'arn:aws:bedrock:us-east-2:372075448100:inference-profile/us.anthropic.claude-opus-5 ' +
  'with an explicit deny in an identity-based policy"}';

test('an IAM explicit deny is access denied, not bad credentials', () => {
  // The regression this class exists for: the credentials authenticated fine, so
  // reporting an authentication failure sends the user to re-run /login, which
  // cannot lift a policy denial.
  for (const input of [BEDROCK_403, { status: 403, message: BEDROCK_403 }, { Message: BEDROCK_403 }]) {
    assert.equal(classify(input), 'access_denied');
  }
  assert.equal(policyFor('access_denied').resume, false, 'a denial is identical on every retry');
});

test('AWS capitalises Message, and a nested SDK error hides one level down', () => {
  // Both shapes were previously invisible to classification, so the prose that
  // identifies the fault was never read at all.
  assert.equal(classify({ status: 403, Message: 'not authorized to perform: bedrock:InvokeModel' }), 'access_denied');
  assert.equal(classify({ status: 403, error: { message: 'explicit deny in an identity-based policy' } }), 'access_denied');
});

test('a spent usage limit is not treated as a rate limit', () => {
  // The dangerous confusion: a rate limit clears in a minute, so waiting works. A
  // weekly cap clears in hours, which no backoff can cover — retrying just spends
  // the attempt budget and still fails.
  for (const msg of [
    'Claude usage limit reached. Your limit will reset at 3pm.',
    'You have reached your weekly usage limit',
    'Session limit reached — resets in 2 hours',
    'Monthly token quota exhausted',
  ]) {
    assert.equal(classify({ message: msg }), 'usage_limit', msg);
  }
  assert.equal(policyFor('usage_limit').resume, false);
});

test('quota prose outranks the status attached to it', () => {
  // A usage limit arrives with a 429 or a 403 depending on the provider, and the
  // status alone would file it as something a wait can fix.
  assert.equal(classify({ status: 429, message: 'You have reached your weekly usage limit. Resets at 9am.' }), 'usage_limit');
  assert.equal(classify({ status: 403, message: 'Plan limit reached, upgrade for a higher usage limit' }), 'usage_limit');
});

test('an ordinary rate limit still resumes, and still waits', () => {
  // The guard on the change above: making quota messages non-retryable must not
  // catch the throttling case, which is the most common recoverable failure there is.
  for (const input of [{ status: 429 }, { status: 429, message: 'Rate limit exceeded, try again later' }, { message: 'rate_limit_error' }]) {
    assert.equal(classify(input), 'rate_limit');
  }
  assert.equal(policyFor('rate_limit').resume, true);
  // "limit" alone must not read as a spent quota.
  assert.equal(classify({ message: 'max_tokens: 8192 exceeds the limit' }), 'max_output_tokens');
});

test("Anthropic's own org-policy refusal keeps its own class", () => {
  // Narrower than access_denied and with a different fix — an admin has to permit
  // the client — so it must not be flattened into the generic denial.
  assert.equal(classify({ status: 403, message: 'This organization is not allowed to use OAuth' }), 'oauth_org_not_allowed');
});

test('a bare 403 reports a denial rather than naming a cause it cannot know', () => {
  // With no body to read, "you were refused" is all that is true. Claiming an
  // organisation policy specifically was a guess, and wrong for every cloud user.
  assert.equal(classify({ status: 403 }), 'access_denied');
});

test('spent credits stay a billing problem, since money can fix them', () => {
  // The line between billing_error and usage_limit: a balance can be topped up, a
  // quota window cannot be bought out of.
  for (const msg of ['Your credit balance is too low', 'You are out of credits']) {
    assert.equal(classify({ message: msg }), 'billing_error', msg);
  }
});

test('every class that will not auto-resume says what to do instead', () => {
  // A notify with no next step leaves the user where the CLI already left them.
  for (const cls of ERROR_CLASSES) {
    const p = policyFor(cls);
    if (p.resume) continue;
    assert.equal(typeof p.fix, 'string', `${cls} needs a fix`);
    assert.ok(p.fix.length > 20, `${cls}'s fix should be actionable`);
  }
});

test('the access-denied fix contradicts the CLI, on purpose', () => {
  // Claude Code prints "Please run /login" for this. Following that advice wastes
  // the user's time, so the text has to say the sign-in was not the problem.
  assert.match(policyFor('access_denied').fix, /not your login|sign-in worked/i);
  assert.match(policyFor('usage_limit').fix, /Signing in again will not help/i);
});

test('resolveClass and classify agree, so config lookups use the same key', () => {
  // The ledger keys attempts by class and config overrides key by class; if
  // these two disagreed, a per-class limit would silently not apply.
  for (const input of ['rate_limit', { status: 429 }, { message: 'overloaded' }, null]) {
    assert.equal(resolveClass(input), classify(input));
  }
});
