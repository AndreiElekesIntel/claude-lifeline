#!/usr/bin/env node
'use strict';
/**
 * The recovery hook — this is the part that actually resumes your session.
 *
 * How the resume works (verified against Claude Code 2.1.220):
 *
 *   Claude Code fires `StopFailure` instead of `Stop` when an API error ends a
 *   turn. Registered with `"asyncRewake": true`, a hook that exits with code 2
 *   has its stderr injected into the session as a system-reminder AND wakes the
 *   model — so the turn continues on its own. Exit 0 means "nothing to do".
 *
 *   That gate is why exit code 2 is load-bearing here: it is the difference
 *   between logging a failure and actually rescuing the session.
 *
 * Design rules for this file:
 *   - No dependencies. It runs on Claude Code's critical path.
 *   - Never throw. A crash here would turn one failed turn into a broken
 *     session, so every path is wrapped and the fallback is exit 0.
 *   - Fast. Backoff is the only deliberate wait.
 */

const fs = require('fs');

const { loadConfig, projectAllowed } = require('../shared/config');
const { effectivePolicy } = require('../shared/policy');
const ledger = require('../shared/ledger');
const eventlog = require('../shared/eventlog');
const { hookLogFile } = require('../shared/paths');

/** Exit 0: observed, nothing injected. */
const EXIT_NOOP = 0;
/** Exit 2: inject stderr into the session and wake the model. */
const EXIT_REWAKE = 2;

function debug(cfg, msg) {
  if (!cfg || !cfg.advanced || !cfg.advanced.debugLogging) return;
  try {
    fs.appendFileSync(hookLogFile(), `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The text injected back into the session.
 *
 * It states what failed and that work already done should not be repeated —
 * without that, a resumed model tends to start the task over.
 */
function buildResumeMessage({ policy, errorClass, attemptNumber, lastAssistantMessage, waitedMs }) {
  const lines = [];
  lines.push(policy.message || 'The previous turn ended because of an API error. Continue exactly where you left off.');
  lines.push('');
  lines.push('--- Claude Lifeline recovery context ---');
  lines.push(`Failure class: ${errorClass}`);
  lines.push(`Recovery attempt: ${attemptNumber}${policy.maxAttempts ? ` of ${policy.maxAttempts}` : ''}`);
  if (waitedMs > 0) lines.push(`Waited ${Math.round(waitedMs / 1000)}s before resuming.`);
  if (policy.strategy === 'compact') {
    lines.push('Required first step: run /compact, then resume the task.');
  }
  if (lastAssistantMessage) {
    const tail = String(lastAssistantMessage).replace(/\s+/g, ' ').trim().slice(0, 400);
    if (tail) lines.push(`Your last output before the failure: "${tail}"`);
  }
  lines.push('This was an infrastructure failure, not a problem with your work. Resume the task; do not apologise or summarise.');
  return lines.join('\n');
}

async function main() {
  const cfg = loadConfig();
  const raw = readStdin();

  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    debug(cfg, `unparseable stdin (${raw.length} bytes)`);
    return EXIT_NOOP;
  }

  const event = payload.hook_event_name || 'unknown';
  const sessionId = payload.session_id || 'unknown';
  const promptId = payload.prompt_id || null;
  const cwd = payload.cwd || null;
  const errorClass = payload.error || 'unknown';
  const lastAssistantMessage = payload.last_assistant_message || null;

  debug(cfg, `event=${event} class=${errorClass} session=${sessionId}`);

  if (!cfg.enabled) {
    eventlog.append({ kind: eventlog.KINDS.SKIPPED, sessionId, cwd, errorClass, reason: 'disabled', detail: 'Lifeline is turned off.' });
    return EXIT_NOOP;
  }

  // Route by event. StopFailure is the API-error path; Stop carries the
  // background-task case; PostToolUseFailure is the optional tool nudge.
  if (event === 'Stop') return handleStop(payload, cfg);
  if (event === 'PostToolUseFailure') return handleToolFailure(payload, cfg);
  if (event !== 'StopFailure') return EXIT_NOOP;

  if (!cfg.features.apiErrorRecovery) {
    eventlog.append({ kind: eventlog.KINDS.SKIPPED, sessionId, cwd, errorClass, reason: 'feature_off', detail: 'API error recovery is disabled.' });
    return EXIT_NOOP;
  }

  if (!projectAllowed(cwd, cfg)) {
    eventlog.append({ kind: eventlog.KINDS.SKIPPED, sessionId, cwd, errorClass, reason: 'project_filtered', detail: 'This project is excluded by the allow/deny list.' });
    return EXIT_NOOP;
  }

  const policy = effectivePolicy(errorClass, cfg);

  // Context overflow has its own toggle: /compact rewrites history, which some
  // users would rather trigger themselves.
  if (policy.strategy === 'compact' && !cfg.features.contextOverflowRecovery) {
    eventlog.append({ kind: eventlog.KINDS.SKIPPED, sessionId, cwd, errorClass, reason: 'compact_off', detail: 'Context-overflow recovery is disabled.' });
    return EXIT_NOOP;
  }

  // Non-retryable: surface it, never retry it. A wrong key or an exhausted
  // balance fails the same way every time, and a retry loop would bury the one
  // message that tells the user what to fix.
  if (!policy.resume || policy.strategy === 'notify') {
    eventlog.append({
      kind: eventlog.KINDS.NOTIFIED,
      sessionId,
      cwd,
      errorClass,
      label: policy.label,
      reason: 'non_retryable',
      detail: policy.reason,
      needsAttention: true,
      lastAssistantMessage,
    });
    return EXIT_NOOP;
  }

  const verdict = ledger.checkLimits({ sessionId, promptId, errorClass, config: cfg });
  if (!verdict.allowed) {
    eventlog.append({
      kind: eventlog.KINDS.BLOCKED,
      sessionId,
      cwd,
      errorClass,
      label: policy.label,
      reason: verdict.reason,
      detail: verdict.detail,
      needsAttention: verdict.reason !== 'cooldown',
    });
    return EXIT_NOOP;
  }

  const attemptNumber = verdict.attemptNumber + 1;
  if (policy.maxAttempts && attemptNumber > policy.maxAttempts) {
    eventlog.append({
      kind: eventlog.KINDS.BLOCKED,
      sessionId,
      cwd,
      errorClass,
      label: policy.label,
      reason: 'class_limit',
      detail: `${errorClass} allows ${policy.maxAttempts} attempts; this would be ${attemptNumber}.`,
      needsAttention: true,
    });
    return EXIT_NOOP;
  }

  // Wait before resuming. For rate limits and overload this delay is the fix,
  // not politeness — resuming instantly just reproduces the error.
  const waitedMs = ledger.backoffFor(policy, verdict.priorForPrompt, cfg);
  if (waitedMs > 0) {
    debug(cfg, `backoff ${waitedMs}ms before resume (attempt ${attemptNumber})`);
    await sleep(waitedMs);
  }

  ledger.recordAttempt({ sessionId, promptId, errorClass, cwd, strategy: policy.strategy });
  eventlog.append({
    kind: eventlog.KINDS.RECOVERED,
    sessionId,
    cwd,
    errorClass,
    label: policy.label,
    strategy: policy.strategy,
    attemptNumber,
    waitedMs,
    detail: `Resumed after ${policy.label.toLowerCase()} (attempt ${attemptNumber}).`,
  });

  // stderr is what Claude Code injects; exit 2 is what wakes the model.
  process.stderr.write(buildResumeMessage({ policy, errorClass, attemptNumber, lastAssistantMessage, waitedMs }));
  return EXIT_REWAKE;
}

/**
 * Stop: the turn ended cleanly. Only act when background work is still in
 * flight — Claude Code reports it on the payload, so "done" and "paused waiting
 * on a task" are distinguishable without guessing.
 */
function handleStop(payload, cfg) {
  if (!cfg.features.backgroundTaskRecovery) return EXIT_NOOP;
  if (payload.stop_hook_active) return EXIT_NOOP; // already resumed once; don't chain

  const tasks = Array.isArray(payload.background_tasks) ? payload.background_tasks : [];
  const crons = Array.isArray(payload.session_crons) ? payload.session_crons : [];
  const pending = tasks.filter((t) => t && (t.status === 'running' || t.status === 'pending'));
  // A scheduled cron will wake the session by itself; nudging would duplicate work.
  if (pending.length === 0 || crons.length > 0) return EXIT_NOOP;

  const sessionId = payload.session_id || 'unknown';
  const verdict = ledger.checkLimits({ sessionId, promptId: payload.prompt_id, errorClass: 'background_tasks', config: cfg });
  if (!verdict.allowed) return EXIT_NOOP;

  ledger.recordAttempt({ sessionId, promptId: payload.prompt_id, errorClass: 'background_tasks', cwd: payload.cwd, strategy: 'resume' });
  eventlog.append({
    kind: eventlog.KINDS.RECOVERED,
    sessionId,
    cwd: payload.cwd,
    errorClass: 'background_tasks',
    label: 'Background work pending',
    strategy: 'resume',
    attemptNumber: verdict.attemptNumber + 1,
    detail: `Turn ended with ${pending.length} background task(s) still in flight.`,
  });

  process.stderr.write(
    `The turn ended while ${pending.length} background task(s) were still running: ` +
      `${pending.map((t) => t.description || t.type || t.id).join(', ')}. ` +
      'Check their results and finish the work.'
  );
  return EXIT_REWAKE;
}

/**
 * PostToolUseFailure: opt-in, and only for interrupts/timeouts. Ordinary tool
 * errors are already visible to the model, which handles them well; nudging
 * those would add noise on the busiest hook path in the CLI.
 */
function handleToolFailure(payload, cfg) {
  if (!cfg.features.toolFailureRecovery) return EXIT_NOOP;
  if (!payload.is_timeout && !payload.is_interrupt) return EXIT_NOOP;

  eventlog.append({
    kind: eventlog.KINDS.INFO,
    sessionId: payload.session_id,
    cwd: payload.cwd,
    errorClass: payload.is_timeout ? 'tool_timeout' : 'tool_interrupt',
    label: payload.is_timeout ? 'Tool timed out' : 'Tool interrupted',
    detail: `${payload.tool_name || 'A tool'} did not complete: ${String(payload.error || '').slice(0, 200)}`,
  });

  process.stderr.write(
    `The ${payload.tool_name || 'tool'} call did not complete (${payload.is_timeout ? 'timeout' : 'interrupted'}). ` +
      'Decide whether to retry it with a longer timeout, split the work, or take another route.'
  );
  return EXIT_REWAKE;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Last resort: log and exit clean. Lifeline must never be the reason a
    // session breaks.
    try {
      eventlog.append({ kind: eventlog.KINDS.ERROR, detail: `Hook crashed: ${err && err.message}`, stack: err && err.stack });
    } catch {
      /* ignore */
    }
    process.exit(EXIT_NOOP);
  });
