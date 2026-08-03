'use strict';
/**
 * Grouping and searching past sessions for the History tab.
 *
 * The data is already computed — `analytics.report().recent` carries a title,
 * project, active time and cost per session. What this adds is the two things a
 * history view needs that a flat list does not give you:
 *
 *   - **Days as first-class rows.** "What did I do on Tuesday" is the question a
 *     history answers, and it needs a per-day total to answer it. Those totals
 *     cannot be summed off the sessions, because sessions overlap: run three at
 *     once for an hour and adding their durations reports three hours in an hour.
 *     So time is unioned over intervals, the same way the daily chart does it.
 *
 *   - **Search that matches what people remember.** Nobody remembers a session id.
 *     They remember the project, the branch, or a phrase from what they asked for,
 *     so all of those are searched, and a day that ends up with no matches
 *     disappears rather than lingering as an empty header.
 *
 * Kept out of the renderer so it can be unit-tested against fixed timestamps —
 * "yesterday" is a function of `now`, and a test that depends on the wall clock
 * fails at midnight.
 */

const { unionMs, splitByDay } = require('./analytics');

/** Local-date key. Local, not UTC: a session at 01:00 belongs to that morning. */
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A human label for a day, relative to `now`.
 *
 * Today and Yesterday are named because that is how they are referred to; beyond
 * that a date is clearer than "6 days ago", which nobody converts in their head.
 * The weekday is included within the last week because "Tuesday" locates a day
 * better than "Jul 22" does when it is still in recent memory.
 */
function dayLabel(key, now = Date.now()) {
  const today = dayKey(now);
  if (key === today) return 'Today';
  const yesterday = dayKey(now - 86_400_000);
  if (key === yesterday) return 'Yesterday';

  // Parsed as local midnight. `new Date('2026-07-22')` would parse as UTC and
  // land on the previous day for anyone west of Greenwich.
  const [y, m, d] = key.split('-').map(Number);
  const at = new Date(y, m - 1, d);
  const ageDays = Math.round((new Date(now).setHours(0, 0, 0, 0) - at.getTime()) / 86_400_000);
  const opts = ageDays < 7
    ? { weekday: 'long', month: 'short', day: 'numeric' }
    : at.getFullYear() === new Date(now).getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
  return at.toLocaleDateString(undefined, opts);
}

/** Lowercased haystack of everything about a session worth remembering it by. */
function searchText(s) {
  return [s.title, s.cwd, s.gitBranch, s.model, s.lastPrompt, s.sessionId]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Whether a session matches a query.
 *
 * Every whitespace-separated term must appear somewhere, in any order — so
 * "payments billing" finds the billing work in the payments repo without the user
 * having to remember which field each word came from. Substring rather than
 * prefix matching, because half-remembered middles are the normal case.
 */
function matches(session, query) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = searchText(session);
  return terms.every((t) => hay.includes(t));
}

/** Every token class a session records, added up. */
function totalTokens(s) {
  const t = s.tokens || {};
  return (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0) + (t.cacheRead || 0);
}

/**
 * Group sessions into days, newest first.
 *
 * A session is *listed* under the day it was last worked in — an overnight run
 * belongs to the morning you found it finished, which is where you would look for
 * it. But its **cost and tokens are apportioned across every day it actually
 * spanned**, in proportion to the time measured in each.
 *
 * Those two rules being different is deliberate, and the reason is that they
 * answer different questions. "Where do I click to find that session again?" wants
 * one row in one place. "What did Tuesday cost me?" wants Tuesday's share of the
 * spend, and a session that ran from Tuesday evening to Wednesday morning did not
 * spend all its money on either side of midnight.
 *
 * Previously the day header summed each listed session's full cost, which made the
 * figure wrong in a way that was easy to miss: it double-reported nothing, but it
 * moved money between days, and it disagreed with the Analytics tab — which keyed
 * on the start day instead — for the same session. See splitByDay() for the
 * measured divergence and why time is the proxy used.
 *
 * `attributedCostUsd` on each row is that session's share for the day it appears
 * under, so the rows and the header add up to the same number.
 */
function groupByDay(sessions, { query = '', now = Date.now() } = {}) {
  /** key -> {rows, spans, costUsd, tokens, split} */
  const byDay = new Map();
  const dayOf = (key) => {
    if (!byDay.has(key)) byDay.set(key, { rows: [], spans: [], costUsd: 0, tokens: 0, split: false });
    return byDay.get(key);
  };

  for (const s of sessions || []) {
    if (!s || !s.lastAt) continue; // never worked in; nothing to file
    if (!matches(s, query)) continue;

    const homeKey = dayKey(s.lastAt);
    const parts = splitByDay(s, { fallbackAt: s.lastAt });
    const cost = s.costUsd || 0;
    const tokens = totalTokens(s);

    for (const part of parts) {
      const bucket = dayOf(part.key);
      bucket.costUsd += cost * part.share;
      bucket.tokens += tokens * part.share;
      for (const span of part.spans) bucket.spans.push(span);
      // Flagged on every day a multi-day session touches, so the UI can explain a
      // header total that is smaller than the row beneath it.
      if (parts.length > 1) bucket.split = true;
    }

    /**
     * The row itself is listed once, under `lastAt`.
     *
     * Repeating it on each spanned day would make the same work look like several
     * sessions, and the count above the list would stop matching the number of
     * sessions that exist.
     */
    const home = dayOf(homeKey);
    const homePart = parts.find((p) => p.key === homeKey);
    home.rows.push({
      ...s,
      /** This day's share of the session's spend — what the header counted. */
      attributedCostUsd: cost * (homePart ? homePart.share : 1),
      /** True when some of this session's spend is counted on other days. */
      spansDays: parts.length > 1,
    });
  }

  const groups = [];
  for (const [key, bucket] of byDay) {
    const rows = bucket.rows;
    rows.sort((a, b) => b.lastAt - a.lastAt);

    // Unioned, not summed. Concurrent sessions share wall-clock time, so summing
    // `activeMs` across a day can exceed 24 hours — and does, routinely, for
    // anyone who runs several agents at once.
    //
    // `intervals` are dropped from the IPC payload for size, so fall back to the
    // per-session sum when they are absent. It over-reports overlap, which is why
    // `overlapping` says which figure this is.
    const activeMs = bucket.spans.length
      ? unionMs(bucket.spans)
      : rows.reduce((sum, s) => sum + (s.activeMs || 0), 0);

    groups.push({
      key,
      label: dayLabel(key, now),
      sessions: rows,
      count: rows.length,
      activeMs,
      /** True when the day's time is a sum of overlapping sessions, not a union. */
      overlapping: bucket.spans.length === 0 && rows.length > 1,
      costUsd: bucket.costUsd,
      tokens: Math.round(bucket.tokens),
      /**
       * True when at least one session's spend is shared with another day, so the
       * header can say why it does not equal the sum of the rows shown.
       */
      split: bucket.split,
    });
  }

  /**
   * A day that only received apportioned cost — no session is *listed* there —
   * still belongs in the output, because its money was really spent then. Dropping
   * it would make the day totals stop summing to the grand total, which is the
   * exact class of bug this function was fixed for.
   */

  // Newest day first. Sorting the keys as strings works because `YYYY-MM-DD` is
  // lexicographically ordered, which is the whole reason for that format.
  groups.sort((a, b) => (a.key < b.key ? 1 : -1));
  return groups;
}

/** Totals across the groups, for the summary line above them. */
function summarise(groups) {
  return {
    days: groups.length,
    sessions: groups.reduce((n, g) => n + g.count, 0),
    activeMs: groups.reduce((n, g) => n + g.activeMs, 0),
    costUsd: groups.reduce((n, g) => n + g.costUsd, 0),
  };
}

module.exports = { dayKey, dayLabel, searchText, matches, groupByDay, summarise };
