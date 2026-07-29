'use strict';
/**
 * Reads Claude Code's own usage statistics — the data behind `/usage`.
 *
 * The CLI keeps a precomputed summary at `~/.claude/stats-cache.json`: per-model
 * token totals for the whole install, daily message and session counts, tokens
 * per model per day, hour-of-day activity, and the longest session it has seen.
 * Reusing it beats recomputing the same figures, for two reasons:
 *
 *   1. It covers history that transcripts no longer do. Transcripts get pruned;
 *      these totals do not, so `firstSessionDate` reaches further back than any
 *      file still on disk.
 *   2. It is Claude Code's own arithmetic. Where both sources can answer a
 *      question, agreeing with `/usage` is more useful than being independently
 *      right.
 *
 * What it cannot answer, and why analytics.js still exists alongside it:
 *
 *   - No cost. `modelUsage[*].costUSD` is present but reads 0 for every model on
 *     a subscription plan, so money still has to be derived from tokens (see
 *     pricing.js).
 *   - No per-project or per-session breakdown, beyond one "longest session".
 *   - No active-vs-idle time. `dailyActivity` counts messages, not minutes, so
 *     "hours worked" is not derivable from it.
 *   - It is a cache the CLI refreshes on its own schedule; `lastComputedDate`
 *     here was a day behind the live transcripts when this was written.
 *
 * So the two are complementary: this file supplies breadth and authority, and
 * analytics.js supplies time, cost, and per-session detail. Read-only, and
 * entirely optional — everything degrades to null if the file is absent.
 */

const fs = require('fs');

const { claudeStatsFile } = require('./paths');
const { costOf } = require('./pricing');

/**
 * Shapes this module knows how to read.
 *
 * Checked rather than assumed: the file is Claude Code's internal cache, not a
 * published contract, so a format change must degrade to "no data" instead of
 * silently misreporting. Add a version here only after confirming the fields
 * below still mean the same thing.
 */
const SUPPORTED_VERSIONS = new Set([4]);

/** Raw file contents, or null when missing, unreadable, or an unknown version. */
function readRaw() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(claudeStatsFile(), 'utf8'));
  } catch {
    return null; // absent until `/usage` has run at least once
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!SUPPORTED_VERSIONS.has(parsed.version)) return null;
  return parsed;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Per-model totals, priced.
 *
 * Sorted by cost rather than tokens: cache reads dominate token counts by an
 * order of magnitude while costing a tenth as much, so a token-ordered list puts
 * the cheapest model first and reads as nonsense.
 */
function modelBreakdown(raw, pricingOverrides) {
  const out = [];
  for (const [model, u] of Object.entries(raw.modelUsage || {})) {
    const tokens = {
      input: num(u.inputTokens),
      output: num(u.outputTokens),
      cacheWrite: num(u.cacheCreationInputTokens),
      cacheRead: num(u.cacheReadInputTokens),
    };
    const { usd, known } = costOf(
      {
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        cache_creation_input_tokens: tokens.cacheWrite,
        cache_read_input_tokens: tokens.cacheRead,
      },
      model,
      pricingOverrides
    );
    out.push({
      model,
      tokens,
      total: tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead,
      // Claude Code records costUSD but leaves it 0 on subscription plans, so the
      // figure shown is ours. Both are carried so the UI can say which it used.
      costUsd: usd,
      reportedCostUsd: num(u.costUSD),
      estimatedRates: !known,
      webSearchRequests: num(u.webSearchRequests),
    });
  }
  return out.sort((a, b) => b.costUsd - a.costUsd);
}

/** Daily message/session/tool counts, oldest first, with tokens joined in. */
function dailyBreakdown(raw) {
  const tokensByDate = new Map();
  for (const row of raw.dailyModelTokens || []) {
    if (row && row.date) tokensByDate.set(row.date, row.tokensByModel || {});
  }

  return (raw.dailyActivity || [])
    .filter((d) => d && d.date)
    .map((d) => {
      const byModel = tokensByDate.get(d.date) || {};
      let tokens = 0;
      for (const v of Object.values(byModel)) tokens += num(v);
      return {
        date: d.date,
        messages: num(d.messageCount),
        sessions: num(d.sessionCount),
        toolCalls: num(d.toolCallCount),
        tokens,
        tokensByModel: byModel,
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Activity by hour of local day, 0–23, with every hour present.
 *
 * Gaps are filled with zeroes: the file omits hours with no activity, and a
 * 24-slot array is what makes "when do I actually work" readable as a shape.
 */
function hourlyBreakdown(raw) {
  const counts = raw.hourCounts || {};
  const out = [];
  for (let h = 0; h < 24; h++) out.push({ hour: h, sessions: num(counts[h]) });
  return out;
}

/**
 * Everything Lifeline shows from Claude Code's own stats.
 *
 * Returns `{ available: false }` rather than throwing when the file is missing —
 * a fresh install has never run `/usage`, and that is not an error state.
 */
function report({ pricingOverrides = null } = {}) {
  const raw = readRaw();
  if (!raw) return { available: false, reason: 'Claude Code has not written usage statistics yet.' };

  const models = modelBreakdown(raw, pricingOverrides);
  const daily = dailyBreakdown(raw);

  const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let costUsd = 0;
  let estimatedRates = false;
  for (const m of models) {
    totals.input += m.tokens.input;
    totals.output += m.tokens.output;
    totals.cacheWrite += m.tokens.cacheWrite;
    totals.cacheRead += m.tokens.cacheRead;
    costUsd += m.costUsd;
    if (m.estimatedRates) estimatedRates = true;
  }

  const longest = raw.longestSession || null;

  return {
    available: true,
    version: raw.version,
    /** The day the CLI last recomputed this. Shown because it can lag live work. */
    computedFor: raw.lastComputedDate || null,
    firstSessionAt: raw.firstSessionDate ? Date.parse(raw.firstSessionDate) : null,
    totalSessions: num(raw.totalSessions),
    totalMessages: num(raw.totalMessages),
    totalToolCalls: daily.reduce((sum, d) => sum + d.toolCalls, 0),
    tokens: totals,
    totalTokens: totals.input + totals.output + totals.cacheWrite + totals.cacheRead,
    costUsd,
    estimatedRates,
    models,
    daily,
    hourly: hourlyBreakdown(raw),
    longestSession: longest
      ? {
          sessionId: longest.sessionId || null,
          durationMs: num(longest.duration),
          messageCount: num(longest.messageCount),
          at: longest.timestamp ? Date.parse(longest.timestamp) : null,
        }
      : null,
  };
}

module.exports = { SUPPORTED_VERSIONS, readRaw, modelBreakdown, dailyBreakdown, hourlyBreakdown, report };
