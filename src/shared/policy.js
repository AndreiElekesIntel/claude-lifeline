'use strict';
/**
 * What Lifeline does for each way a turn can die.
 *
 * The error classes are Claude Code's own `StopFailure.error` values (the CLI
 * validates against exactly this set), so this table is keyed to the real
 * contract rather than to error-message text.
 *
 * The important asymmetry: not every failure should be retried. A rate limit
 * clears on its own, so waiting and resuming is right. A bad API key or an
 * exhausted balance will fail identically forever — retrying it burns the
 * attempt budget and buries the one message that would tell the user what to
 * fix. Those classes are `resume: false` on purpose.
 */

/** Error classes Claude Code can report on StopFailure. */
const ERROR_CLASSES = [
  'rate_limit',
  'overloaded',
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'unknown',
];

/**
 * strategy:
 *   'resume'  — inject a continue message and let the model pick up
 *   'compact' — context overflowed; ask for a compact, then continue
 *   'notify'  — human intervention required; never auto-retry
 */
const POLICIES = {
  rate_limit: {
    resume: true,
    strategy: 'resume',
    backoffMs: 60_000,
    maxAttempts: 5,
    label: 'Rate limited',
    reason: 'The limit clears with time, so waiting and resuming is the fix.',
    message:
      'The previous turn ended because of an API rate limit. The limit has had time to clear. Continue exactly where you left off — do not restart work you already finished.',
  },
  overloaded: {
    resume: true,
    strategy: 'resume',
    backoffMs: 30_000,
    maxAttempts: 6,
    label: 'API overloaded',
    reason: 'Server-side capacity, transient by nature.',
    message:
      'The previous turn ended because the API was overloaded. Continue exactly where you left off — do not restart work you already finished.',
  },
  server_error: {
    resume: true,
    strategy: 'resume',
    backoffMs: 15_000,
    maxAttempts: 6,
    label: 'Server error',
    reason: 'A 5xx is transient; the same request usually succeeds on retry.',
    message:
      'The previous turn ended because of a server-side API error. Continue exactly where you left off — do not restart work you already finished.',
  },
  unknown: {
    resume: true,
    strategy: 'resume',
    backoffMs: 20_000,
    maxAttempts: 4,
    label: 'Connection lost',
    reason:
      'Covers dropped connections and timeouts — the common overnight-failure case.',
    message:
      'The previous turn ended because of an interrupted API connection (timeout or dropped stream). Continue exactly where you left off — do not restart work you already finished. If your last action may have been cut off mid-write, verify it before continuing.',
  },
  max_output_tokens: {
    resume: true,
    strategy: 'resume',
    backoffMs: 2_000,
    maxAttempts: 3,
    label: 'Output truncated',
    reason: 'The turn hit the output ceiling; continuing from the cut is valid.',
    message:
      'The previous turn was cut off at the maximum output length. Continue from exactly where the output stopped. Do not repeat what you already produced.',
  },
  invalid_request: {
    resume: true,
    strategy: 'compact',
    backoffMs: 5_000,
    maxAttempts: 2,
    label: 'Context overflow',
    reason:
      'Usually "prompt is too long". Retrying unchanged repeats the failure, so free context first.',
    message:
      'The previous turn failed because the conversation context is too long. Run /compact to condense the history, then continue exactly where you left off.',
  },
  // --- Deliberately not auto-retried: a retry cannot change the outcome. ---
  authentication_failed: {
    resume: false,
    strategy: 'notify',
    backoffMs: 0,
    maxAttempts: 0,
    label: 'Authentication failed',
    reason:
      'Credentials are wrong or expired. Retrying fails identically and hides the message that says so.',
    message: null,
  },
  oauth_org_not_allowed: {
    resume: false,
    strategy: 'notify',
    backoffMs: 0,
    maxAttempts: 0,
    label: 'Org not allowed',
    reason: 'An organisation policy decision; no retry can satisfy it.',
    message: null,
  },
  billing_error: {
    resume: false,
    strategy: 'notify',
    backoffMs: 0,
    maxAttempts: 0,
    label: 'Billing problem',
    reason: 'Needs a billing change. Retrying only burns attempts.',
    message: null,
  },
  model_not_found: {
    resume: false,
    strategy: 'notify',
    backoffMs: 0,
    maxAttempts: 0,
    label: 'Model not found',
    reason: 'A bad model id is a config error, identical on every retry.',
    message: null,
  },
};

/**
 * The policy key actually used for a class.
 *
 * A class we do not recognise resolves to `unknown` — including for config
 * lookups, so that tightening the `unknown` policy also governs error classes
 * introduced by a future Claude Code release.
 */
function resolveClass(errorClass) {
  return POLICIES[errorClass] ? errorClass : 'unknown';
}

/** Fall back to the `unknown` policy for any class we do not recognise. */
function policyFor(errorClass) {
  return POLICIES[resolveClass(errorClass)];
}

/**
 * Merge a policy with the user's config overrides.
 * A disabled class collapses to notify-only, never to a silent drop.
 */
function effectivePolicy(errorClass, config) {
  const key = resolveClass(errorClass);
  const base = POLICIES[key];
  const override = (config && config.policies && config.policies[key]) || {};
  const merged = { ...base, ...override };
  if (override.resume === false) merged.strategy = 'notify';
  return merged;
}

module.exports = { ERROR_CLASSES, POLICIES, policyFor, effectivePolicy, resolveClass };
