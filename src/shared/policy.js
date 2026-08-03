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

/**
 * Error classes Claude Code can report on StopFailure, plus the two Lifeline
 * synthesises itself.
 *
 * `access_denied` and `usage_limit` are not in Claude Code's own set. They exist
 * because the CLI collapses several very different failures into a 403 and a
 * "Please run /login" prompt, and `/login` is the wrong advice for most of them —
 * see DISTINCTIVE_PATTERNS. Adding a class is purely additive: config.js seeds
 * `policies` from this list, so both get a row in Coverage and a config entry
 * with no migration step.
 */
const ERROR_CLASSES = [
  'rate_limit',
  'usage_limit',
  'overloaded',
  'authentication_failed',
  'access_denied',
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
  /**
   * A quota that is spent rather than a rate that is too high.
   *
   * Split out from `rate_limit` because the two need opposite handling despite
   * reading almost identically. A rate limit clears in a minute, so waiting is
   * the fix. A weekly or 5-hour usage cap clears when the window rolls over,
   * which is hours away — and `limits.maxBackoffMs` caps backoff at five
   * minutes, so "wait and resume" here means five attempts that all fail and an
   * exhausted attempt budget. Telling the user which of the two happened is the
   * only useful thing Lifeline can do, so it says so and stops.
   */
  usage_limit: {
    resume: false,
    strategy: 'notify',
    backoffMs: 0,
    maxAttempts: 0,
    label: 'Usage limit reached',
    reason:
      'Your plan or quota limit is spent, not merely throttled. It resets on its own schedule — hours away, not the seconds a backoff can cover — so retrying now only burns the attempt budget.',
    fix: 'Wait for the reset time in the message, switch to a smaller model, or raise the quota on your plan. Signing in again will not help — your credentials are fine.',
    message: null,
  },
  authentication_failed: {
    resume: false,
    strategy: 'notify',
    backoffMs: 0,
    maxAttempts: 0,
    label: 'Authentication failed',
    reason:
      'Credentials are wrong or expired. Retrying fails identically and hides the message that says so.',
    fix: 'Run /login in Claude Code, or refresh the key or cloud credentials your setup uses.',
    message: null,
  },
  /**
   * Authenticated fine, but not permitted to call this specific thing.
   *
   * The class that a bare 403 used to be forced into. `oauth_org_not_allowed` is
   * specifically an Anthropic org-policy refusal; an IAM explicit deny on a
   * Bedrock inference profile is a different fault with a different fix, and
   * labelling it "Org not allowed" sent people to the wrong console.
   */
  access_denied: {
    resume: false,
    strategy: 'notify',
    backoffMs: 0,
    maxAttempts: 0,
    label: 'Access denied',
    reason:
      'The credentials worked but are not permitted to call this model or endpoint — typically an IAM policy, a region without access, or a model that was never enabled. A retry is refused identically.',
    // Says the quiet part out loud, because the CLI's own advice here is wrong:
    // it prints "Please run /login" for this, and logging in again cannot lift a
    // permission denial.
    fix: 'Check the permissions on the identity you are using, not your login — the sign-in worked. On Bedrock or Vertex, confirm the model is enabled in that region and that no policy denies it.',
    message: null,
  },
  oauth_org_not_allowed: {
    resume: false,
    strategy: 'notify',
    backoffMs: 0,
    maxAttempts: 0,
    label: 'Org not allowed',
    reason: 'An organisation policy decision; no retry can satisfy it.',
    fix: 'Your organisation has to permit this client or model. An admin change is the only fix.',
    message: null,
  },
  billing_error: {
    resume: false,
    strategy: 'notify',
    backoffMs: 0,
    maxAttempts: 0,
    label: 'Billing problem',
    reason: 'Needs a billing change. Retrying only burns attempts.',
    fix: 'Top up your credit balance or fix the payment method on the account.',
    message: null,
  },
  model_not_found: {
    resume: false,
    strategy: 'notify',
    backoffMs: 0,
    maxAttempts: 0,
    label: 'Model not found',
    reason: 'A bad model id is a config error, identical on every retry.',
    fix: 'Correct the model name in your Claude Code settings or --model flag.',
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
/**
 * Prose shapes specific enough to outrank the HTTP status next to them.
 *
 * The general rule is that a status beats prose — a 429 body saying "try again"
 * carries no information the status does not. These are the exceptions: text so
 * specific that it identifies the fault more precisely than the status can.
 *
 * The case that forced this, verbatim from Claude Code 2.1.220 on Bedrock:
 *
 *     Please run /login · API Error: 403 {"Message":"User: arn:aws:iam::…:user/
 *     BedrockUser_x is not authorized to perform:
 *     bedrock:InvokeModelWithResponseStream on resource: …inference-profile/
 *     us.anthropic.claude-opus-5 with an explicit deny in an identity-based policy"}
 *
 * Three things are wrong with the old handling of that. `fromStatus(403)` returned
 * `oauth_org_not_allowed`, so it was labelled "Org not allowed" — an Anthropic
 * org-policy refusal, which this is not. The prose was never examined, so the
 * words "explicit deny in an identity-based policy" were discarded. And the CLI's
 * own "Please run /login" is misleading: the credentials authenticated correctly,
 * they are simply denied this call, and re-logging-in changes nothing.
 *
 * Ordered, and matched in order. Usage limits come first because a quota message
 * frequently arrives *with* a 403 or 429 attached, and which of the two it is
 * decides whether waiting can possibly help.
 */
const DISTINCTIVE_PATTERNS = [
  /**
   * A spent quota. Anthropic's phrasing ("usage limit reached", "your limit will
   * reset at 3pm"), a plan cap, and the cloud resellers' quota/budget wording all
   * land here. Requires an explicit reset/exhaustion word rather than the bare
   * token "limit", so "rate limit" and "max_tokens limit" are not swept up.
   */
  [/(usage|weekly|monthly|daily|session|plan|spend|budget|token)[\s_-]*(limit|quota|cap)[^.]{0,40}(reach|reset|exceed|exhaust|hit|spent|consum|remaining|used up)/i, 'usage_limit'],
  // The same statement with the verb first — "you have reached your weekly usage
  // limit" — which is how Anthropic actually phrases it.
  [/(reach|exceed|exhaust|hit|us(e|ed) up)[^.]{0,40}(usage|weekly|monthly|daily|session|plan|spend|budget|token)[\s_-]*(limit|quota|cap)/i, 'usage_limit'],
  [/(limit|quota)[^.]{0,30}(will\s+)?reset(s|ting)?\s+(at|in|on)\b/i, 'usage_limit'],
  // Credits are deliberately absent here: buying more is a billing action, and
  // `billing_error` gives that advice. A spent *quota* cannot be bought out of.
  [/(out of|exhausted|used up|no remaining)[\s_-]*(tokens?|quota|usage|capacity)/i, 'usage_limit'],
  [/upgrade[^.]{0,30}(plan|tier)[^.]{0,30}(higher|more)[^.]{0,20}(limit|usage)/i, 'usage_limit'],

  /**
   * Anthropic's own org-policy refusal, kept ahead of the generic IAM patterns
   * below so that "this organization is not allowed…" is recognised for what it
   * is rather than falling through to the bare-403 reading.
   */
  [/(organization|organisation)[^.]{0,30}(not allowed|not permitted|policy)|oauth[^.]{0,30}not allowed/i, 'oauth_org_not_allowed'],

  /**
   * An IAM/permission refusal. AWS's canonical "is not authorized to perform"
   * and "explicit deny", Azure/Vertex's permission-denied wording, and a model
   * that exists but was never enabled for the account.
   */
  [/explicit deny|not authoriz|not authoris|accessdenied|access[\s_-]denied|permission[\s_-]denied|forbidden/i, 'access_denied'],
  [/(don'?t|do not|does not|no)\s+have\s+access\s+to[^.]{0,40}(model|profile|resource|region)/i, 'access_denied'],
  [/(model|inference profile)[^.]{0,30}(not enabled|not available|access[^.]{0,10}not granted)/i, 'access_denied'],
];

const MESSAGE_PATTERNS = [
  [/rate[_\s-]?limit|too many requests|\b429\b/i, 'rate_limit'],
  [/overloaded|\b529\b/i, 'overloaded'],
  [/prompt is too long|context.{0,20}(too long|length exceeded)|maximum context/i, 'invalid_request'],
  [/max[_\s-]?(output[_\s-]?)?tokens|max_tokens/i, 'max_output_tokens'],
  // `api[_\s-]?key` rather than `invalid api key`: the real message names the
  // header, "invalid x-api-key", so anchoring to the word "invalid" missed it.
  [/authentication|api[_\s-]?key|unauthorized|\b401\b/i, 'authentication_failed'],
  [/credit balance|credits?\b|billing|payment|quota exceeded|\b402\b/i, 'billing_error'],
  // Anthropic's own org-policy refusal keeps this class; it is specifically about
  // an organisation disallowing the OAuth client.
  [/oauth|organization.{0,20}(policy|not allowed)|organisation.{0,20}(policy|not allowed)/i, 'oauth_org_not_allowed'],
  // A bare 403 with nothing else to go on. `access_denied` rather than
  // oauth_org_not_allowed: "you are not permitted to make this call" is what a
  // 403 actually means, and it is true of every provider, whereas an Anthropic
  // org-policy decision is one narrow cause among many.
  [/not[_\s-]allowed|\b403\b/i, 'access_denied'],
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
    /**
     * `Message` as well as `message`: AWS capitalises it, and the Bedrock 403
     * body is the exact payload this needs to read. Nested `error.error.message`
     * too, which is how the Anthropic SDK wraps an API error.
     */
    const inner = error.error && typeof error.error === 'object' ? error.error : null;
    const text = [
      error.message,
      error.Message,
      typeof error.error === 'string' ? error.error : null,
      inner && (inner.message || inner.Message),
      error.detail,
      error.type,
      error.code,
      error.body && typeof error.body === 'string' ? error.body : null,
    ]
      .filter((v) => typeof v === 'string')
      .join(' ');

    // Prose this specific outranks the status: a 403 tells you the call was
    // refused, but only the body says whether that was a spent quota or an IAM
    // deny, and those have different fixes.
    const distinctive = fromDistinctiveText(text);
    if (distinctive) return distinctive;

    // Otherwise an HTTP status is stronger evidence than prose.
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
  // `access_denied`, not `oauth_org_not_allowed`: a 403 on its own says the call
  // was refused, not why. An Anthropic org-policy refusal is one cause among
  // many, and naming it as the cause sent Bedrock and Vertex users to a console
  // that has nothing to do with their problem. When the body *does* identify an
  // org policy, DISTINCTIVE/MESSAGE_PATTERNS still pick that up.
  if (n === 403) return 'access_denied';
  if (n === 404) return 'model_not_found';
  if (n === 400 || n === 422) return 'invalid_request';
  if (n >= 500) return 'server_error';
  return null;
}

/** A class only when the text is specific enough to be sure; null otherwise. */
function fromDistinctiveText(text) {
  if (!text) return null;
  for (const [re, cls] of DISTINCTIVE_PATTERNS) if (re.test(text)) return cls;
  return null;
}

function fromText(text) {
  if (!text) return 'unknown';
  // Checked here too, so a plain-string error — the whole CLI line pasted through
  // verbatim — is read the same way as a structured one.
  const distinctive = fromDistinctiveText(text);
  if (distinctive) return distinctive;
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

module.exports = {
  ERROR_CLASSES,
  POLICIES,
  MESSAGE_PATTERNS,
  DISTINCTIVE_PATTERNS,
  policyFor,
  effectivePolicy,
  resolveClass,
  classify,
  fromDistinctiveText,
};
