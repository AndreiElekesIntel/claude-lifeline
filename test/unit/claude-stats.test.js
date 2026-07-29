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

/* -------------------------------- windows ------------------------------- */

/**
 * The fixture's dated rows sit on 2026-07-25 and 26, so every window test pins
 * `now` to the 27th. Real `Date.now()` would put them outside a 7-day window
 * within a fortnight of this being written.
 */
const NOW = Date.parse('2026-07-27T12:00:00.000Z');

test('a window sums the dated rows rather than reusing the install-wide totals', () => {
  write(fixture());
  const w = stats.report({ now: NOW }).windows.week;
  // 3 + 8 sessions and 100 + 400 messages, from dailyActivity — not the 267 and
  // 107842 the cache reports for the whole install.
  assert.equal(w.totalSessions, 11);
  assert.equal(w.totalMessages, 500);
  assert.equal(w.totalToolCalls, 150);
  // 5,000 + 10,000 + 2,000 as the dated rows literally record it. This is the
  // *measured* figure and it excludes cache traffic, because `dailyModelTokens`
  // does — which is why it is reported separately from `totalTokens` below rather
  // than being passed off as a token count comparable to the all-time one.
  assert.equal(w.uncachedTokens, 17_000);
  // The scaled total, which is what sits next to the window's cost in the UI. It is
  // ~150x larger than the rows above because those omit cache reads entirely; a
  // token count 150x below the cost beside it is what this figure exists to avoid.
  assert.equal(w.totalTokens, 2_592_000);
  assert.equal(w.daysWithData, 2);
  assert.equal(w.days, 7);
});

test('all time returns the unwindowed figures, and is not marked apportioned', () => {
  write(fixture());
  const r = stats.report({ now: NOW });
  const all = r.windows.all;
  assert.equal(all.days, null);
  assert.equal(all.from, null);
  assert.equal(all.apportioned, false, 'nothing is estimated when nothing is sliced');
  // The per-model figures are the measured ones, straight from modelUsage.
  assert.equal(all.costUsd, r.costUsd);
  assert.equal(all.models.length, 2);
  assert.deepEqual(all.models[0].tokens, r.models[0].tokens);
  assert.equal(all.models[0].apportioned, false);
});

test('all time uses the install-wide counters, not the prunable daily rows', () => {
  write(fixture());
  const r = stats.report({ now: NOW });
  const all = r.windows.all;
  // The fixture keeps only two dated rows but remembers 267 sessions and 107,842
  // messages for the whole install. Summing the rows would report 11 and 500 —
  // and would silently disagree with what `/usage` prints.
  assert.equal(all.totalSessions, 267);
  assert.equal(all.totalMessages, 107_842);
  assert.equal(all.totalSessions, r.totalSessions, 'and with the rest of the report');
  assert.equal(all.totalMessages, r.totalMessages);
  assert.equal(all.totalTokens, r.totalTokens);
});

test('a window keeps only the models that actually appear in it', () => {
  write(fixture());
  const w = stats.report({ now: NOW }).windows.week;
  // Haiku has 900M all-time cache-read tokens but only 2,000 in the dated rows,
  // so it belongs in the window at that size — while a model absent from those
  // rows must not be carried in at its all-time size at all.
  assert.deepEqual(w.models.map((m) => m.model).sort(), ['claude-haiku-4-5-20251001', 'claude-opus-4-8']);
  const haiku = w.models.find((m) => m.model === 'claude-haiku-4-5-20251001');
  // 2,000 of haiku's 30,000,000 uncached tokens is a 1/15,000 share, which scales
  // its 930M all-time total to 62,000 — cache reads included, as the cost is.
  assert.equal(haiku.uncachedTokens, 2_000);
  assert.equal(haiku.total, 62_000);
  assert.ok(haiku.total < 900_000_000, 'and nowhere near its all-time size');
});

test('a model with no tokens in the window is dropped, not zero-filled', () => {
  write(fixture({ dailyModelTokens: [{ date: '2026-07-26', tokensByModel: { 'claude-opus-4-8': 10_000 } }] }));
  const w = stats.report({ now: NOW }).windows.week;
  assert.deepEqual(w.models.map((m) => m.model), ['claude-opus-4-8']);
});

test('windowed cost is apportioned by token share, and says that it is', () => {
  write(fixture());
  const r = stats.report({ now: NOW });
  const w = r.windows.week;
  assert.equal(w.apportioned, true, 'the UI prints a caveat off this flag');
  const opusAll = r.models.find((m) => m.model === 'claude-opus-4-8');
  const opusWk = w.models.find((m) => m.model === 'claude-opus-4-8');
  assert.equal(opusWk.apportioned, true);
  // 15,000 of the model's 3,000,000 *uncached* tokens fall in the window, so its
  // cost is scaled by exactly that share. The denominator is input+output and not
  // `total`, because that is what the numerator counts: `dailyModelTokens` records
  // no cache traffic at all. This is still an assumption about a steady token mix,
  // which is why the flag above exists.
  const share = 15_000 / (opusAll.tokens.input + opusAll.tokens.output);
  assert.ok(Math.abs(opusWk.costUsd - opusAll.costUsd * share) < 1e-9);
  // The split is scaled by the same factor, so the four buckets still add to `total`.
  const sum = opusWk.tokens.input + opusWk.tokens.output + opusWk.tokens.cacheWrite + opusWk.tokens.cacheRead;
  assert.ok(Math.abs(sum - opusWk.total) <= 4, 'within rounding of the four buckets');
});

test('the apportionment denominator excludes cache, as its numerator does', () => {
  // The regression this pins down: dividing the cache-*excluding* daily rows by the
  // cache-*including* `m.total` shrinks every window by the cache-hit ratio. On the
  // machine that surfaced it that was ~200x — a week whose transcripts said ~$2,500
  // was reported as $10.77. The fixture reproduces the same shape: opus has
  // 3,000,000 uncached tokens against a 506,000,000 total, so the wrong denominator
  // reads ~169x low.
  write(fixture());
  const r = stats.report({ now: NOW });
  const opusAll = r.models.find((m) => m.model === 'claude-opus-4-8');
  const opusWk = r.windows.week.models.find((m) => m.model === 'claude-opus-4-8');

  const wrong = opusAll.costUsd * (15_000 / opusAll.total);
  assert.ok(opusWk.costUsd > wrong * 100, 'the old arithmetic was two orders of magnitude low');

  // A window can never cost more than all time, which is the sanity bound the
  // Math.min(1, ...) clamp protects when a model's rows outrun its uncached total.
  assert.ok(opusWk.costUsd <= opusAll.costUsd + 1e-9);
});

test('a window that outruns its uncached total is clamped, not extrapolated', () => {
  // A cache the CLI recomputed mid-window can hold daily rows summing above the
  // model's recorded input+output. The share must cap at 1 rather than scaling the
  // all-time cost *upwards* and reporting a week as more expensive than all time.
  write(fixture({ dailyModelTokens: [{ date: '2026-07-26', tokensByModel: { 'claude-opus-4-8': 99_000_000 } }] }));
  const r = stats.report({ now: NOW });
  const opusAll = r.models.find((m) => m.model === 'claude-opus-4-8');
  const opusWk = r.windows.week.models.find((m) => m.model === 'claude-opus-4-8');
  assert.equal(opusWk.costUsd, opusAll.costUsd);
  assert.equal(opusWk.total, opusAll.total);
  assert.equal(opusWk.uncachedTokens, 99_000_000, 'while still reporting what was measured');
});

test('the cutoff is inclusive of today, matching the transcript analytics window', () => {
  write(fixture());
  // `days: 2` from the 27th reaches back to the 26th, so the 25th is excluded.
  const raw = stats.readRaw();
  const models = stats.modelBreakdown(raw, null);
  const daily = stats.dailyBreakdown(raw);
  const w = stats.windowStats(raw, models, daily, 2, NOW);
  assert.equal(w.from, '2026-07-26');
  assert.deepEqual(w.daily.map((d) => d.date), ['2026-07-26']);
  assert.equal(w.totalSessions, 8, 'the 25th\'s 3 sessions are outside it');
});

test('every range the picker offers is present, and each is no smaller than the last', () => {
  write(fixture());
  const wins = stats.report({ now: NOW }).windows;
  assert.deepEqual(Object.keys(wins), ['week', 'month', 'quarter', 'half', 'year', 'all']);
  const order = ['week', 'month', 'quarter', 'half', 'year'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      wins[order[i]].totalSessions >= wins[order[i - 1]].totalSessions,
      `${order[i]} cannot contain fewer sessions than ${order[i - 1]}`
    );
  }
});

test('a window over an empty cache is zeroed rather than absent', () => {
  write({ version: 4 });
  const w = stats.report({ now: NOW }).windows.month;
  assert.deepEqual(w.models, []);
  assert.equal(w.totalSessions, 0);
  assert.equal(w.totalTokens, 0);
  assert.equal(w.costUsd, 0);
  assert.equal(w.daysWithData, 0);
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
