'use strict';
/**
 * The loop guard.
 *
 * Auto-resume has one serious failure mode: a permanent error that Lifeline
 * keeps retrying forever, spending tokens on every pass. The ledger is what
 * makes that impossible. Every attempt is recorded, and four independent limits
 * must all pass before another resume is allowed:
 *
 *   1. per-prompt   — the same stuck prompt cannot be retried without end
 *   2. per-hour     — bounds one session's burst rate
 *   3. per-day      — machine-wide backstop against runaway spend
 *   4. cooldown     — collapses duplicate fires for one failure
 *
 * Writes are atomic and tolerate concurrent hook processes: several sessions
 * can fail at the same moment, and last-writer-wins on a rewritten file is
 * acceptable here (a lost attempt record only ever makes Lifeline *more*
 * conservative on the next read, never less).
 */

const fs = require('fs');
const path = require('path');
const { ledgerFile, lifelineHome } = require('./paths');

const EMPTY = { version: 1, attempts: [], sessions: {} };
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Attempts older than this are pruned; nothing reads past 24h. */
const RETENTION_MS = 2 * DAY_MS;

function readLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
    return {
      version: 1,
      attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    };
  } catch {
    return JSON.parse(JSON.stringify(EMPTY));
  }
}

function writeLedger(ledger, now = Date.now()) {
  const dir = lifelineHome();
  fs.mkdirSync(dir, { recursive: true });
  const pruned = {
    ...ledger,
    attempts: (ledger.attempts || []).filter((a) => now - a.at < RETENTION_MS),
  };
  const tmp = path.join(dir, `.ledger.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(pruned), 'utf8');
  fs.renameSync(tmp, ledgerFile());
  return pruned;
}

/**
 * Decide whether one more resume is allowed.
 *
 * `promptId` scopes the per-prompt count. Claude Code supplies it on the hook
 * payload and keeps it stable across a turn's retries, which is exactly the
 * grain we want: a new user prompt earns a fresh attempt budget, while the same
 * stuck prompt cannot spin.
 */
function checkLimits({ sessionId, promptId, errorClass, config, now = Date.now(), ledger = null }) {
  const led = ledger || readLedger();
  const limits = (config && config.limits) || {};
  const maxPrompt = limits.maxAttemptsPerPrompt ?? 5;
  const maxHour = limits.maxAttemptsPerHour ?? 20;
  const maxDay = limits.maxAttemptsPerDay ?? 100;
  const cooldown = limits.cooldownMs ?? 5_000;

  const attempts = led.attempts || [];
  const key = promptId || `${sessionId}:nopid`;

  const forPrompt = attempts.filter((a) => a.key === key);
  const forSessionHour = attempts.filter((a) => a.sessionId === sessionId && now - a.at < HOUR_MS);
  const forDay = attempts.filter((a) => now - a.at < DAY_MS);

  // Cooldown: one failure can surface as several events; treat the repeat as noise.
  const last = forPrompt.length ? forPrompt[forPrompt.length - 1] : null;
  if (last && now - last.at < cooldown) {
    return { allowed: false, reason: 'cooldown', detail: `Another attempt for this prompt landed ${now - last.at}ms ago (cooldown ${cooldown}ms).`, attemptNumber: forPrompt.length };
  }
  if (forPrompt.length >= maxPrompt) {
    return { allowed: false, reason: 'prompt_limit', detail: `This prompt already used ${forPrompt.length}/${maxPrompt} resume attempts.`, attemptNumber: forPrompt.length };
  }
  if (forSessionHour.length >= maxHour) {
    return { allowed: false, reason: 'hour_limit', detail: `This session used ${forSessionHour.length}/${maxHour} attempts in the last hour.`, attemptNumber: forPrompt.length };
  }
  if (forDay.length >= maxDay) {
    return { allowed: false, reason: 'day_limit', detail: `Machine-wide daily cap reached (${forDay.length}/${maxDay}).`, attemptNumber: forPrompt.length };
  }

  return {
    allowed: true,
    reason: 'ok',
    detail: null,
    attemptNumber: forPrompt.length,
    priorForPrompt: forPrompt.length,
  };
}

/** Record an attempt. Call only when a resume is actually issued. */
function recordAttempt({ sessionId, promptId, errorClass, cwd, strategy, now = Date.now() }) {
  const led = readLedger();
  led.attempts.push({
    at: now,
    key: promptId || `${sessionId}:nopid`,
    sessionId,
    promptId: promptId || null,
    errorClass,
    strategy,
    cwd: cwd || null,
  });
  led.sessions[sessionId] = {
    lastAttemptAt: now,
    lastErrorClass: errorClass,
    cwd: cwd || null,
    totalAttempts: ((led.sessions[sessionId] && led.sessions[sessionId].totalAttempts) || 0) + 1,
  };
  return writeLedger(led, now);
}

/** Exponential backoff on repeat failures, capped so a wait never runs away. */
function backoffFor(policy, priorAttempts, config) {
  const base = policy.backoffMs ?? 15_000;
  const cap = (config && config.limits && config.limits.maxBackoffMs) || 300_000;
  return Math.min(base * Math.pow(2, Math.max(0, priorAttempts)), cap);
}

/** Counters for the tray tooltip and the dashboard. */
function stats(now = Date.now(), ledger = null) {
  const led = ledger || readLedger();
  const attempts = led.attempts || [];
  return {
    today: attempts.filter((a) => now - a.at < DAY_MS).length,
    lastHour: attempts.filter((a) => now - a.at < HOUR_MS).length,
    total: attempts.length,
    lastAttemptAt: attempts.length ? attempts[attempts.length - 1].at : null,
    sessions: Object.keys(led.sessions || {}).length,
  };
}

module.exports = { readLedger, writeLedger, checkLimits, recordAttempt, backoffFor, stats, DAY_MS, HOUR_MS };
