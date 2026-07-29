'use strict';
/**
 * Token pricing, kept separate because it is the one part of analytics that
 * goes stale on its own.
 *
 * Claude Code records token counts in its transcripts but **no cost**, so every
 * dollar figure in this app is derived: tokens × rate. That makes it an estimate,
 * and it is labelled as one everywhere it appears. Two things stop the estimate
 * from being misleading:
 *
 *   1. Cache tokens are priced separately. In Claude Code usage cache reads
 *      dominate — a sampled message showed 16,788 cache-read tokens against 2
 *      plain input tokens — and cache reads cost a fraction of fresh input. A
 *      model that ignored the distinction would overstate spend by an order of
 *      magnitude, which is worse than showing nothing.
 *   2. Rates are user-editable (Settings → Analytics). Published prices change
 *      and subscription plans do not bill per token at all, so a hardcoded table
 *      would silently drift from reality with no way to correct it.
 *
 * Rates are USD per million tokens.
 */

/**
 * Rates for models this project has seen in real transcripts.
 *
 * Previous generations are listed too: transcript history outlives a model
 * release, so a year-long report reads models that are no longer current.
 */
const RATES = {
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // Opus dropped from $15/$75 to $5/$25 at 4.5. Longest-prefix matching is what
  // keeps that split correct: 'claude-opus-4' must not swallow 'claude-opus-4-8'
  // and price a recent model at the old premium rate.
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

/**
 * Model ids that are not billable API usage.
 *
 * Claude Code writes `<synthetic>` for messages it generates locally (interrupt
 * notices and the like). Pricing those would invent spend that was never
 * charged, so they are zeroed rather than sent to the fallback rate.
 */
const NON_BILLABLE = new Set(['<synthetic>']);

/**
 * Fallback for an unrecognised model.
 *
 * Deliberately the mid-tier rate rather than zero: a new model id showing up as
 * free spend would quietly under-report, and under-reporting cost is the failure
 * that matters here. The UI flags when any usage fell back to this.
 */
const FALLBACK = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

/** Used for locally-generated messages that were never billed. */
const ZERO = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

/**
 * Rates for a model id, matched by longest known prefix.
 *
 * Prefix matching because ids carry date suffixes (`claude-haiku-4-5-20251001`)
 * that would otherwise miss the table on every dated release.
 */
function ratesFor(model, overrides) {
  const table = { ...RATES, ...(overrides || {}) };
  const id = String(model || '');
  if (NON_BILLABLE.has(id)) return { rates: ZERO, known: true, billable: false };
  if (table[id]) return { rates: table[id], known: true };

  let best = null;
  for (const key of Object.keys(table)) {
    if (id.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  if (best) return { rates: table[best], known: true };
  return { rates: FALLBACK, known: false };
}

/**
 * Cost in USD for one usage record.
 *
 * `cache_creation_input_tokens` is billed at the write rate and
 * `cache_read_input_tokens` at the (much lower) read rate — see the note above
 * on why collapsing them is not an option.
 */
function costOf(usage, model, overrides) {
  if (!usage) return { usd: 0, known: true };
  const { rates, known } = ratesFor(model, overrides);
  const per = (tokens, rate) => ((Number(tokens) || 0) / 1_000_000) * rate;
  const usd =
    per(usage.input_tokens, rates.input) +
    per(usage.output_tokens, rates.output) +
    per(usage.cache_creation_input_tokens, rates.cacheWrite) +
    per(usage.cache_read_input_tokens, rates.cacheRead);
  return { usd, known };
}

module.exports = { RATES, FALLBACK, NON_BILLABLE, ratesFor, costOf };
