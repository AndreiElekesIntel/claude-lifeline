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
 * Message patterns mapped back to a class, for payloads that carry prose.
 *
 * Claude Code's documented contract is a bare class string, and that path needs
 * none of this. But `StopFailure.error` is also observed carrying an object with
 * a `message` — an SDK error passed through verbatim — and a machine that only
 * understands the documented shape files every one of those under `unknown`.
 * That is not a cosmetic loss: a 429 handled as `unknown` waits 20s instead of
 * 60s and gets 4 attempts instead of 5, so it retries too early, too often, and
 * reports the wrong cause in the log.
 *
 * Ordered, and matched in order: `overloaded_error` also contains the substring
 * `error`, and 529 must not be read as a generic 5xx.
 */
const MESSAGE_PATTERNS = [
  [/rate[_\s-]?limit|too many requests|\b429\b/i, 'rate_limit'],
  [/overloaded|\b529\b/i, 'overloaded'],
  [/prompt is too long|context.{0,20}(too long|length exceeded)|maximum context/i, 'invalid_request'],
  [/max[_\s-]?(output[_\s-]?)?tokens|max_tokens/i, 'max_output_tokens'],
  // `api[_\s-]?key` rather than `invalid api key`: the real message names the
  // header, "invalid x-api-key", so anchoring to the word "invalid" missed it.
  [/authentication|api[_\s-]?key|unauthorized|\b401\b/i, 'authentication_failed'],
  [/credit balance|billing|payment|quota exceeded|\b402\b/i, 'billing_error'],
  [/not[_\s-]allowed|organization.{0,20}(policy|not allowed)|\b403\b/i, 'oauth_org_not_allowed'],
  [/model[_\s-]not[_\s-]found|unknown model|\b404\b/i, 'model_not_found'],
  [/invalid[_\s-]request|\b400\b|\b422\b/i, 'invalid_request'],
  [/\b5\d\d\b|server[_\s-]error|internal|bad gateway|service unavailable/i, 'server_error'],
];

/**
 * Whatever Claude Code handed us, reduced to a class name.
 *
 * Deliberately total: a string, an object, null, or a number all come out as
 * something `POLICIES` has an entry for. The fallback is `unknown`, which is a
 * resume policy — an unrecognised failure is treated as transient, because the
 * overwhelmingly common unrecognised failure is a dropped connection.
 *
 * A class name is never inferred from prose when the payload already states one:
 * `{ class: 'billing_error', message: 'retry later' }` must not be talked into a
 * retry by its own message text.
 */
function classify(error) {
  if (typeof error === 'string' && POLICIES[error]) return error;

  if (error && typeof error === 'object') {
    // Any of these being a known class is authoritative and ends the search.
    for (const field of ['class', 'errorClass', 'error_class', 'type', 'code']) {
      const v = error[field];
      if (typeof v === 'string' && POLICIES[v]) return v;
    }
    const text = [error.message, error.error, error.detail, error.type, error.code]
      .filter((v) => typeof v === 'string')
      .join(' ');
    // An HTTP status is stronger evidence than prose, so it is consulted first.
    const byStatus = fromStatus(error.status || error.statusCode || error.http_status);
    if (byStatus) return byStatus;
    return fromText(text);
  }

  return fromText(typeof error === 'string' ? error : '');
}

function fromStatus(status) {
  const n = Number(status);
  if (!Number.isFinite(n)) return null;
  if (n === 429) return 'rate_limit';
  if (n === 529) return 'overloaded';
  if (n === 401) return 'authentication_failed';
  if (n === 402) return 'billing_error';
  if (n === 403) return 'oauth_org_not_allowed';
  if (n === 404) return 'model_not_found';
  if (n === 400 || n === 422) return 'invalid_request';
  if (n >= 500) return 'server_error';
  return null;
}

function fromText(text) {
  if (!text) return 'unknown';
  for (const [re, cls] of MESSAGE_PATTERNS) if (re.test(text)) return cls;
  return 'unknown';
}

/**
 * The policy key actually used for a class.
 *
 * A class we do not recognise resolves to `unknown` — including for config
 * lookups, so that tightening the `unknown` policy also governs error classes
 * introduced by a future Claude Code release.
 */
function resolveClass(errorClass) {
  if (typeof errorClass === 'string' && POLICIES[errorClass]) return errorClass;
  return classify(errorClass);
}

/** Fall back to the `unknown` policy for any class we do not recognise. */
function policyFor(errorClass) {
  return POLICIES[resolveClass(errorClass)];
}

/**
 * Merge a policy with the user's config overrides.
 *
 * Turning a class off always wins — a disabled class collapses to notify-only,
 * never to a silent drop.
 *
 * Turning a *non-retryable* class on is the guarded direction. By default
 * `features.respectNonRetryable` keeps auth, billing, org-policy, and
 * model-not-found on notify regardless of the per-class switch, because retrying
 * them cannot succeed. Forcing a retry is possible, but it takes two deliberate
 * steps: enable the class and clear that safety feature. Without this the switch
 * in the UI silently did nothing, which is worse than not offering it.
 */
function effectivePolicy(errorClass, config) {
  const key = resolveClass(errorClass);
  const base = POLICIES[key];
  const override = (config && config.policies && config.policies[key]) || {};
  const merged = { ...base, ...override };

  if (override.resume === false) {
    merged.strategy = 'notify';
    return merged;
  }

  // Re-enabling a class the table marks hopeless: honoured only when the user has
  // also cleared the guard, and the strategy has to come from somewhere, since a
  // notify-only entry has none of its own.
  if (override.resume === true && !base.resume) {
    const guarded = !config || !config.features || config.features.respectNonRetryable !== false;
    if (guarded) {
      merged.resume = false;
      merged.strategy = 'notify';
      merged.blockedBy = 'respectNonRetryable';
    } else {
      merged.strategy = 'resume';
      // A notify-only class carries no message; without one the resumed model is
      // told nothing about why its turn died.
      merged.message =
        merged.message ||
        `The previous turn ended with a ${key.replace(/_/g, ' ')} error, which normally requires a human. A retry was forced by configuration. Continue exactly where you left off — do not restart work you already finished.`;
      if (!merged.maxAttempts) merged.maxAttempts = 1;
    }
  }

  return merged;
}

module.exports = { ERROR_CLASSES, POLICIES, policyFor, effectivePolicy, resolveClass, classify };
