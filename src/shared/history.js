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

const { unionMs } = require('./analytics');

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

/**
 * Group sessions into days, newest first.
 *
 * A session is filed under the day it was *last* worked in, not the day it
 * started: an overnight run belongs to the morning you found it finished, which is
 * where you would look for it.
 */
function groupByDay(sessions, { query = '', now = Date.now() } = {}) {
  const byDay = new Map();

  for (const s of sessions || []) {
    if (!s || !s.lastAt) continue; // never worked in; nothing to file
    if (!matches(s, query)) continue;
    const key = dayKey(s.lastAt);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(s);
  }

  const groups = [];
  for (const [key, rows] of byDay) {
    rows.sort((a, b) => b.lastAt - a.lastAt);

    // Unioned, not summed. Concurrent sessions share wall-clock time, so summing
    // `activeMs` across a day can exceed 24 hours — and does, routinely, for
    // anyone who runs several agents at once.
    const spans = [];
    for (const s of rows) {
      for (const iv of s.intervals || []) spans.push(iv);
    }
    // `intervals` are dropped from the IPC payload for size, so fall back to the
    // per-session sum when they are absent. It over-reports overlap, which is why
    // `overlapping` says which figure this is.
    const activeMs = spans.length ? unionMs(spans) : rows.reduce((sum, s) => sum + (s.activeMs || 0), 0);

    groups.push({
      key,
      label: dayLabel(key, now),
      sessions: rows,
      count: rows.length,
      activeMs,
      /** True when the day's time is a sum of overlapping sessions, not a union. */
      overlapping: spans.length === 0 && rows.length > 1,
      costUsd: rows.reduce((sum, s) => sum + (s.costUsd || 0), 0),
      tokens: rows.reduce((sum, s) => {
        const t = s.tokens || {};
        return sum + (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0) + (t.cacheRead || 0);
      }, 0),
    });
  }

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
