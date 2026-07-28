'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point Lifeline at a scratch dir before anything reads paths, so tests never
// touch the real ledger.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-ledger-'));
process.env.LIFELINE_HOME = scratch;

const ledger = require('../../src/shared/ledger');
const { defaultConfig } = require('../../src/shared/config');

function freshLedger() {
  try {
    fs.rmSync(path.join(scratch, 'ledger.json'));
  } catch {}
}

test('a first failure is allowed', () => {
  freshLedger();
  const v = ledger.checkLimits({ sessionId: 's1', promptId: 'p1', errorClass: 'rate_limit', config: defaultConfig() });
  assert.equal(v.allowed, true);
  assert.equal(v.attemptNumber, 0);
});

test('per-prompt cap stops a retry loop', () => {
  freshLedger();
  const cfg = defaultConfig();
  cfg.limits.maxAttemptsPerPrompt = 3;
  cfg.limits.cooldownMs = 0;

  for (let i = 0; i < 3; i++) {
    const v = ledger.checkLimits({ sessionId: 's1', promptId: 'p1', errorClass: 'server_error', config: cfg });
    assert.equal(v.allowed, true, `attempt ${i + 1} should be allowed`);
    ledger.recordAttempt({ sessionId: 's1', promptId: 'p1', errorClass: 'server_error', strategy: 'resume' });
  }

  const blocked = ledger.checkLimits({ sessionId: 's1', promptId: 'p1', errorClass: 'server_error', config: cfg });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'prompt_limit');
});

test('a new prompt gets a fresh budget', () => {
  freshLedger();
  const cfg = defaultConfig();
  cfg.limits.maxAttemptsPerPrompt = 2;
  cfg.limits.cooldownMs = 0;

  for (let i = 0; i < 2; i++) {
    ledger.recordAttempt({ sessionId: 's1', promptId: 'p1', errorClass: 'server_error', strategy: 'resume' });
  }
  assert.equal(ledger.checkLimits({ sessionId: 's1', promptId: 'p1', errorClass: 'server_error', config: cfg }).allowed, false);
  // Same session, different prompt: the user moved on, so the budget resets.
  assert.equal(ledger.checkLimits({ sessionId: 's1', promptId: 'p2', errorClass: 'server_error', config: cfg }).allowed, true);
});

test('cooldown collapses duplicate fires for one failure', () => {
  freshLedger();
  const cfg = defaultConfig();
  cfg.limits.cooldownMs = 60_000;
  ledger.recordAttempt({ sessionId: 's1', promptId: 'p1', errorClass: 'server_error', strategy: 'resume' });
  const v = ledger.checkLimits({ sessionId: 's1', promptId: 'p1', errorClass: 'server_error', config: cfg });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'cooldown');
});

test('daily cap bounds machine-wide spend across sessions', () => {
  freshLedger();
  const cfg = defaultConfig();
  cfg.limits.maxAttemptsPerDay = 4;
  cfg.limits.cooldownMs = 0;
  cfg.limits.maxAttemptsPerPrompt = 99;
  for (let i = 0; i < 4; i++) {
    ledger.recordAttempt({ sessionId: `s${i}`, promptId: `p${i}`, errorClass: 'overloaded', strategy: 'resume' });
  }
  const v = ledger.checkLimits({ sessionId: 'sNew', promptId: 'pNew', errorClass: 'overloaded', config: cfg });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'day_limit');
});

test('hourly cap is per session, not global', () => {
  freshLedger();
  const cfg = defaultConfig();
  cfg.limits.maxAttemptsPerHour = 2;
  cfg.limits.cooldownMs = 0;
  cfg.limits.maxAttemptsPerPrompt = 99;
  ledger.recordAttempt({ sessionId: 'busy', promptId: 'a', errorClass: 'overloaded', strategy: 'resume' });
  ledger.recordAttempt({ sessionId: 'busy', promptId: 'b', errorClass: 'overloaded', strategy: 'resume' });

  assert.equal(ledger.checkLimits({ sessionId: 'busy', promptId: 'c', errorClass: 'overloaded', config: cfg }).reason, 'hour_limit');
  // A different session is unaffected — one bad session must not block the rest.
  assert.equal(ledger.checkLimits({ sessionId: 'other', promptId: 'c', errorClass: 'overloaded', config: cfg }).allowed, true);
});

test('old attempts age out of the hourly window', () => {
  freshLedger();
  const cfg = defaultConfig();
  cfg.limits.maxAttemptsPerHour = 1;
  cfg.limits.cooldownMs = 0;
  const twoHoursAgo = Date.now() - 2 * ledger.HOUR_MS;
  ledger.recordAttempt({ sessionId: 's1', promptId: 'old', errorClass: 'overloaded', strategy: 'resume', now: twoHoursAgo });
  const v = ledger.checkLimits({ sessionId: 's1', promptId: 'new', errorClass: 'overloaded', config: cfg });
  assert.equal(v.allowed, true, 'an attempt from two hours ago should not count');
});

test('backoff grows exponentially but is capped', () => {
  const cfg = defaultConfig();
  cfg.limits.maxBackoffMs = 100_000;
  const policy = { backoffMs: 10_000 };
  assert.equal(ledger.backoffFor(policy, 0, cfg), 10_000);
  assert.equal(ledger.backoffFor(policy, 1, cfg), 20_000);
  assert.equal(ledger.backoffFor(policy, 2, cfg), 40_000);
  assert.equal(ledger.backoffFor(policy, 10, cfg), 100_000, 'must clamp to the cap');
});

test('a corrupt ledger degrades to empty instead of throwing', () => {
  fs.writeFileSync(path.join(scratch, 'ledger.json'), '{not json at all', 'utf8');
  const led = ledger.readLedger();
  assert.deepEqual(led.attempts, []);
  const v = ledger.checkLimits({ sessionId: 's1', promptId: 'p1', errorClass: 'rate_limit', config: defaultConfig() });
  assert.equal(v.allowed, true, 'a broken ledger must not stop recovery');
});

test('stats report today/hour counters', () => {
  freshLedger();
  ledger.recordAttempt({ sessionId: 's1', promptId: 'p1', errorClass: 'rate_limit', strategy: 'resume' });
  const s = ledger.stats();
  assert.equal(s.today, 1);
  assert.equal(s.lastHour, 1);
  assert.ok(s.lastAttemptAt);
});
