'use strict';
/**
 * Reading Claude Code's `/usage` cache.
 *
 * This file parses somebody else's internal format, so the tests are mostly
 * about *not trusting it*: a missing file, a bumped version, or a renamed field
 * has to degrade to "no data" rather than to a wrong number on screen. The rest
 * cover the two places the raw data is misleading if passed straight through —
 * `costUSD` is 0 on subscription plans, and token counts rank models in the
 * wrong order because cache reads dominate them.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point CLAUDE_CONFIG_DIR at scratch before paths.js resolves anything, so this
// never reads the developer's real stats-cache.json.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-stats-'));
process.env.CLAUDE_CONFIG_DIR = path.join(scratch, 'claude');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const stats = require('../../src/shared/claude-stats');
const { claudeStatsFile } = require('../../src/shared/paths');

/* ------------------------------ fixtures ------------------------------- */

/** A minimal but realistically shaped v4 cache. */
function fixture(overrides = {}) {
  return {
    version: 4,
    lastComputedDate: '2026-07-27',
    firstSessionDate: '2026-06-29T08:18:45.924Z',
    totalSessions: 267,
    totalMessages: 107842,
    modelUsage: {
      'claude-opus-4-8': {
        inputTokens: 1_000_000,
        outputTokens: 2_000_000,
        cacheCreationInputTokens: 3_000_000,
        // Cache reads dwarf everything else, which is exactly why token order is
        // the wrong order.
        cacheReadInputTokens: 500_000_000,
        costUSD: 0,
        webSearchRequests: 4,
      },
      'claude-haiku-4-5-20251001': {
        inputTokens: 10_000_000,
        outputTokens: 20_000_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 900_000_000,
        costUSD: 0,
      },
    },
    dailyActivity: [
      { date: '2026-07-26', messageCount: 400, sessionCount: 8, toolCallCount: 120 },
      { date: '2026-07-25', messageCount: 100, sessionCount: 3, toolCallCount: 30 },
    ],
    dailyModelTokens: [
      { date: '2026-07-25', tokensByModel: { 'claude-opus-4-8': 5_000 } },
      { date: '2026-07-26', tokensByModel: { 'claude-opus-4-8': 10_000, 'claude-haiku-4-5-20251001': 2_000 } },
    ],
    hourCounts: { 9: 12, 10: 33, 22: 1 },
    longestSession: {
      sessionId: '269c8f33',
      duration: 3_600_000,
      messageCount: 244,
      timestamp: '2026-07-20T10:00:00.000Z',
    },
    ...overrides,
  };
}

function write(obj) {
  fs.writeFileSync(claudeStatsFile(), typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
}

function clear() {
  fs.rmSync(claudeStatsFile(), { force: true });
}

/* ------------------------------ degrading ------------------------------- */

test('a missing file is not an error — a fresh install has never run /usage', () => {
  clear();
  assert.equal(stats.readRaw(), null);
  const r = stats.report();
  assert.equal(r.available, false);
  assert.ok(r.reason, 'and says why, so the UI can explain itself');
});

test('unparseable contents degrade to no data rather than throwing', () => {
  write('{ this is not json');
  assert.equal(stats.readRaw(), null);
  assert.equal(stats.report().available, false);
});

test('an unknown version is refused instead of read hopefully', () => {
  // The real risk: a future Claude Code renames a field, the old reader still
  // finds *something*, and Lifeline shows a confidently wrong total.
  write(fixture({ version: 99 }));
  assert.equal(stats.readRaw(), null);
  assert.equal(stats.report().available, false);
  assert.ok(!stats.SUPPORTED_VERSIONS.has(99));
  assert.ok(stats.SUPPORTED_VERSIONS.has(4), 'v4 is the shape this module was written against');
});

/* ------------------------------- models -------------------------------- */

test('models are ordered by cost, not by token count', () => {
  write(fixture());
  const r = stats.report();
  assert.equal(r.available, true);
  // Haiku has nearly twice the tokens and a fraction of the price. Ordering by
  // tokens would put it first and make the table read backwards.
  assert.equal(r.models[0].model, 'claude-opus-4-8');
  assert.ok(r.models[0].total < r.models[1].total, 'the costliest model is not the biggest one here');
  assert.ok(r.models[0].costUsd > r.models[1].costUsd);
});

test('cost is derived from tokens, because /usage reports zero on a subscription', () => {
  write(fixture());
  const r = stats.report();
  for (const m of r.models) {
    assert.equal(m.reportedCostUsd, 0, 'what Claude Code recorded');
    assert.ok(m.costUsd > 0, 'what Lifeline computed');
  }
  assert.ok(r.costUsd > 0);
  assert.equal(r.estimatedRates, false, 'both fixture models have published rates');
});

test('a model with no published rate is flagged rather than silently priced', () => {
  write(fixture({ modelUsage: { 'some-unreleased-model': { inputTokens: 1000, outputTokens: 1000 } } }));
  const r = stats.report();
  assert.equal(r.models[0].estimatedRates, true);
  assert.equal(r.estimatedRates, true, 'and the flag reaches the top level, where the UI reads it');
});

test('a rate override changes the cost', () => {
  write(fixture());
  const base = stats.report().costUsd;
  const dearer = stats.report({
    pricingOverrides: { 'claude-opus-4-8': { input: 100, output: 500, cacheWrite: 125, cacheRead: 10 } },
  }).costUsd;
  assert.ok(dearer > base, 'editing a rate in settings has to move the number');
});

/* -------------------------------- totals -------------------------------- */

test('totals sum the per-model token buckets', () => {
  write(fixture());
  const r = stats.report();
  assert.equal(r.tokens.input, 11_000_000);
  assert.equal(r.tokens.output, 22_000_000);
  assert.equal(r.tokens.cacheWrite, 3_000_000);
  assert.equal(r.tokens.cacheRead, 1_400_000_000);
  assert.equal(r.totalTokens, 11_000_000 + 22_000_000 + 3_000_000 + 1_400_000_000);
  assert.equal(r.totalSessions, 267);
  assert.equal(r.totalMessages, 107842);
  assert.equal(r.totalToolCalls, 150, 'summed across the daily rows');
});

test('the computed-for date is carried through, because the cache can lag live work', () => {
  write(fixture());
  const r = stats.report();
  assert.equal(r.computedFor, '2026-07-27');
  assert.equal(r.firstSessionAt, Date.parse('2026-06-29T08:18:45.924Z'));
});

/* --------------------------------- daily -------------------------------- */

test('daily rows are sorted oldest first, with tokens joined in by date', () => {
  write(fixture());
  const r = stats.report();
  assert.deepEqual(r.daily.map((d) => d.date), ['2026-07-25', '2026-07-26']);
  assert.equal(r.daily[0].tokens, 5_000);
  assert.equal(r.daily[1].tokens, 12_000, 'every model on that day, added together');
  assert.equal(r.daily[1].messages, 400);
});

test('a day with activity but no token record still appears', () => {
  write(fixture({ dailyModelTokens: [] }));
  const r = stats.report();
  assert.equal(r.daily.length, 2);
  assert.equal(r.daily[0].tokens, 0, 'zero tokens rather than a dropped day');
});

/* -------------------------------- hourly -------------------------------- */

test('hourly is 24 slots, so the chart keeps its shape', () => {
  write(fixture());
  const hours = stats.report().hourly;
  assert.equal(hours.length, 24);
  assert.deepEqual(hours[0], { hour: 0, sessions: 0 }, 'quiet hours are present, not missing');
  assert.equal(hours[10].sessions, 33);
  assert.equal(hours[22].sessions, 1);
  assert.equal(hours.reduce((n, h) => n + h.sessions, 0), 46);
});

/* ------------------------------- records -------------------------------- */

test('the longest session is normalised into the shape the UI expects', () => {
  write(fixture());
  const l = stats.report().longestSession;
  assert.equal(l.sessionId, '269c8f33');
  assert.equal(l.durationMs, 3_600_000, 'renamed from `duration`');
  assert.equal(l.messageCount, 244);
  assert.equal(l.at, Date.parse('2026-07-20T10:00:00.000Z'));
});

test('an install with no longest session yet reports null, not a fake record', () => {
  write(fixture({ longestSession: undefined }));
  assert.equal(stats.report().longestSession, null);
});

test('missing collections degrade to empty rather than throwing', () => {
  // A brand-new cache can be version-correct and almost entirely empty.
  write({ version: 4 });
  const r = stats.report();
  assert.equal(r.available, true);
  assert.deepEqual(r.models, []);
  assert.deepEqual(r.daily, []);
  assert.equal(r.hourly.length, 24);
  assert.equal(r.totalTokens, 0);
  assert.equal(r.costUsd, 0);
  assert.equal(r.firstSessionAt, null);
});
