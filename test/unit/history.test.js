'use strict';
/**
 * Grouping and searching past sessions.
 *
 * Every test pins `now`. "Yesterday" is a function of the wall clock, so a test
 * that used the real one would pass all day and fail at midnight.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const history = require('../../src/shared/history');

/** A Thursday at noon, local. Fixed so the weekday labels are predictable. */
const NOW = new Date(2026, 6, 30, 12, 0, 0).getTime();
const H = 3_600_000;
const D = 86_400_000;

function session(over = {}) {
  return {
    sessionId: 'a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60',
    title: 'Refactor the billing service',
    cwd: 'C:/work/payments-api',
    gitBranch: 'main',
    model: 'claude-opus-4-8',
    lastPrompt: 'split the invoice writer out of the service',
    firstAt: NOW - 3 * H,
    lastAt: NOW - 2 * H,
    activeMs: H,
    intervals: [[NOW - 3 * H, NOW - 2 * H]],
    tokens: { input: 1000, output: 2000, cacheWrite: 0, cacheRead: 500 },
    costUsd: 1.25,
    ...over,
  };
}

/* ============================ day labels ============================ */

test('today and yesterday are named, not dated', () => {
  assert.equal(history.dayLabel(history.dayKey(NOW), NOW), 'Today');
  assert.equal(history.dayLabel(history.dayKey(NOW - D), NOW), 'Yesterday');
});

test('a day within the last week keeps its weekday, which is how it is remembered', () => {
  // Three days before Thursday the 30th is Monday the 27th.
  const label = history.dayLabel(history.dayKey(NOW - 3 * D), NOW);
  assert.match(label, /Monday/);
  assert.match(label, /27/);
});

test('an older day drops the weekday, and a different year gains one', () => {
  const older = history.dayLabel(history.dayKey(NOW - 20 * D), NOW);
  assert.doesNotMatch(older, /day/i, 'a weekday 20 days back locates nothing');
  const lastYear = history.dayLabel('2025-03-04', NOW);
  assert.match(lastYear, /2025/, 'the year matters once it is not this one');
});

test('a day key is local, so a session after midnight files under that morning', () => {
  // 00:30 local. Parsed as UTC this would fall on the previous day for anyone
  // west of Greenwich, putting late-night work under the wrong header.
  const oneAm = new Date(2026, 6, 30, 0, 30, 0).getTime();
  assert.equal(history.dayKey(oneAm), '2026-07-30');
  assert.equal(history.dayLabel(history.dayKey(oneAm), NOW), 'Today');
});

/* ============================= grouping ============================= */

test('sessions group by the day they were last worked in, newest day first', () => {
  const groups = history.groupByDay(
    [
      session({ sessionId: 'today-1', lastAt: NOW - H, intervals: [[NOW - 2 * H, NOW - H]] }),
      session({ sessionId: 'yesterday-1', lastAt: NOW - D, intervals: [[NOW - D - H, NOW - D]] }),
      session({ sessionId: 'today-2', lastAt: NOW - 3 * H, intervals: [[NOW - 4 * H, NOW - 3 * H]] }),
    ],
    { now: NOW }
  );

  assert.deepEqual(groups.map((g) => g.label), ['Today', 'Yesterday']);
  assert.equal(groups[0].count, 2);
  // Newest session first within the day, so the top row is the most recent work.
  assert.deepEqual(groups[0].sessions.map((s) => s.sessionId), ['today-1', 'today-2']);
});

test('an overnight session is listed under the day it finished, not the day it began', () => {
  // Started 23:00 yesterday, last touched 02:00 today. You look for the *row* under
  // today, because today is when you found it done.
  const start = new Date(2026, 6, 29, 23, 0, 0).getTime();
  const end = new Date(2026, 6, 30, 2, 0, 0).getTime();
  const groups = history.groupByDay([session({ firstAt: start, lastAt: end, intervals: [[start, end]] })], { now: NOW });

  const today = groups.find((g) => g.label === 'Today');
  assert.equal(today.count, 1, 'the session is listed once, under the day it finished');
  assert.equal(
    groups.find((g) => g.label === 'Yesterday').count,
    0,
    'and is not listed a second time under the day it started'
  );
});

test('an overnight session spends its money on both sides of midnight', () => {
  // 23:00–02:00 is one hour before midnight and two after, so the spend divides
  // 1:2. Filing it all on either day would be a claim about when the money went
  // that the timestamps contradict — and it is what made History and Analytics
  // disagree about the same session.
  const start = new Date(2026, 6, 29, 23, 0, 0).getTime();
  const end = new Date(2026, 6, 30, 2, 0, 0).getTime();
  const groups = history.groupByDay([session({ firstAt: start, lastAt: end, intervals: [[start, end]], costUsd: 3 })], { now: NOW });

  const yesterday = groups.find((g) => g.label === 'Yesterday');
  const today = groups.find((g) => g.label === 'Today');
  assert.ok(Math.abs(yesterday.costUsd - 1) < 1e-9, 'one hour of three, before midnight');
  assert.ok(Math.abs(today.costUsd - 2) < 1e-9, 'two hours of three, after');
  assert.equal(yesterday.split, true, 'and the day says its total is shared');
  assert.equal(today.split, true);
});

test('apportioning cost across days never invents or loses money', () => {
  // The property that makes proration safe: whatever the split, the days must sum
  // back to what the sessions actually cost.
  const overnight = new Date(2026, 6, 29, 22, 30, 0).getTime();
  const sessions = [
    session({ sessionId: 'a', costUsd: 3, firstAt: overnight, lastAt: overnight + 4 * H, intervals: [[overnight, overnight + 4 * H]] }),
    session({ sessionId: 'b', costUsd: 1.25 }),
    // No intervals at all: must still contribute its full cost somewhere.
    session({ sessionId: 'c', costUsd: 7.5, intervals: [], activeMs: 0 }),
  ];
  const groups = history.groupByDay(sessions, { now: NOW });
  const total = groups.reduce((n, g) => n + g.costUsd, 0);
  assert.ok(Math.abs(total - (3 + 1.25 + 7.5)) < 1e-9, `days summed to ${total}`);
  assert.equal(history.summarise(groups).sessions, 3, 'and each session is counted once');
});

test("a session with no measurable time keeps its cost rather than dropping it", () => {
  // A session Claude Code recorded a cost for but no usable intervals. Proration
  // has nothing to weight by, so the whole amount lands on its one day.
  const groups = history.groupByDay([session({ costUsd: 4, intervals: [], activeMs: 0 })], { now: NOW });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].costUsd, 4);
});

test('a day never reports more time than it contains, because overlap is unioned', () => {
  // Three sessions, all worked through the same hour. Summing activeMs says three
  // hours; the day contained one. This is the whole reason intervals are carried.
  const from = NOW - 5 * H;
  const to = NOW - 4 * H;
  const groups = history.groupByDay(
    [
      session({ sessionId: 'a', lastAt: to, activeMs: H, intervals: [[from, to]] }),
      session({ sessionId: 'b', lastAt: to, activeMs: H, intervals: [[from, to]] }),
      session({ sessionId: 'c', lastAt: to, activeMs: H, intervals: [[from, to]] }),
    ],
    { now: NOW }
  );
  assert.equal(groups[0].activeMs, H, 'one hour of wall clock, not three');
  assert.equal(groups[0].overlapping, false, 'and it is a measured union, not a sum');
});

test('cost and tokens are summed, because those do not overlap', () => {
  // Money spent concurrently is still money spent twice — unlike time.
  const groups = history.groupByDay(
    [
      session({ sessionId: 'a', costUsd: 1.5, tokens: { input: 100, output: 200, cacheWrite: 0, cacheRead: 700 } }),
      session({ sessionId: 'b', costUsd: 2.25, tokens: { input: 10, output: 20, cacheWrite: 5, cacheRead: 65 } }),
    ],
    { now: NOW }
  );
  assert.equal(groups[0].costUsd, 3.75);
  assert.equal(groups[0].tokens, 1000 + 100);
});

test('without intervals the day falls back to a sum, and says that it did', () => {
  // The IPC payload could drop intervals; the total must still appear rather than
  // reading zero, but it must not silently claim to be a union.
  const groups = history.groupByDay(
    [
      session({ sessionId: 'a', activeMs: H, intervals: [] }),
      session({ sessionId: 'b', activeMs: H, intervals: [] }),
    ],
    { now: NOW }
  );
  assert.equal(groups[0].activeMs, 2 * H);
  assert.equal(groups[0].overlapping, true);
});

test('a session that was never worked in is skipped rather than grouped under epoch', () => {
  const groups = history.groupByDay([session({ lastAt: null }), session({ lastAt: 0 })], { now: NOW });
  assert.deepEqual(groups, []);
});

test('grouping an empty list is an empty list, not a crash', () => {
  assert.deepEqual(history.groupByDay([], { now: NOW }), []);
  assert.deepEqual(history.groupByDay(null, { now: NOW }), []);
  assert.deepEqual(history.groupByDay([null, undefined], { now: NOW }), []);
});

/* ============================== search ============================== */

test('search matches the project, the branch, the model and the prompt', () => {
  const s = session();
  for (const q of ['payments', 'billing', 'main', 'opus', 'invoice writer']) {
    assert.equal(history.matches(s, q), true, `"${q}" should match`);
  }
  assert.equal(history.matches(s, 'telemetry'), false);
});

test('every term must match, in any order and any field', () => {
  const s = session();
  // One word from the project, one from the prompt — the normal way a
  // half-remembered session gets described.
  assert.equal(history.matches(s, 'payments invoice'), true);
  assert.equal(history.matches(s, 'invoice payments'), true, 'order is irrelevant');
  assert.equal(history.matches(s, 'payments telemetry'), false, 'not an OR');
});

test('search is case-insensitive and matches mid-word', () => {
  const s = session();
  assert.equal(history.matches(s, 'BILLING'), true);
  assert.equal(history.matches(s, 'ymen'), true, 'half-remembered middles are normal');
});

test('an empty or whitespace query matches everything', () => {
  const s = session();
  for (const q of ['', '   ', null, undefined]) assert.equal(history.matches(s, q), true);
});

test('a day whose sessions all fail the search disappears, rather than showing empty', () => {
  const groups = history.groupByDay(
    [
      session({ sessionId: 'keep', cwd: 'C:/work/payments-api', lastAt: NOW - H }),
      session({ sessionId: 'drop', cwd: 'C:/work/telemetry', title: 'Charts', lastPrompt: null, lastAt: NOW - D }),
    ],
    { now: NOW, query: 'payments' }
  );
  assert.deepEqual(groups.map((g) => g.label), ['Today'], 'yesterday held only a non-match');
  assert.equal(groups[0].count, 1);
});

test('a filtered day recounts its totals over the matches only', () => {
  const groups = history.groupByDay(
    [
      session({ sessionId: 'a', cwd: 'C:/work/payments-api', costUsd: 1, lastAt: NOW - H, intervals: [[NOW - 2 * H, NOW - H]] }),
      session({ sessionId: 'b', cwd: 'C:/work/telemetry', title: 'x', lastPrompt: null, costUsd: 9, lastAt: NOW - 3 * H, intervals: [[NOW - 4 * H, NOW - 3 * H]] }),
    ],
    { now: NOW, query: 'payments' }
  );
  assert.equal(groups[0].count, 1);
  assert.equal(groups[0].costUsd, 1, 'the excluded session must not be in the header total');
  assert.equal(groups[0].activeMs, H);
});

test('a session with sparse fields is searchable on what it does have', () => {
  const bare = { sessionId: 'ab12', lastAt: NOW, title: null, cwd: null, gitBranch: null, model: null, lastPrompt: null };
  assert.equal(history.matches(bare, 'ab12'), true);
  assert.equal(history.matches(bare, 'anything'), false);
  // And it still groups, rather than throwing on the missing fields.
  assert.equal(history.groupByDay([bare], { now: NOW }).length, 1);
});

/* ============================= summary ============================= */

test('the summary totals the groups it is given', () => {
  const groups = history.groupByDay(
    [
      session({ sessionId: 'a', costUsd: 1, lastAt: NOW - H, intervals: [[NOW - 2 * H, NOW - H]] }),
      session({ sessionId: 'b', costUsd: 2, lastAt: NOW - D, intervals: [[NOW - D - H, NOW - D]] }),
    ],
    { now: NOW }
  );
  const sum = history.summarise(groups);
  assert.equal(sum.days, 2);
  assert.equal(sum.sessions, 2);
  assert.equal(sum.costUsd, 3);
  assert.equal(sum.activeMs, 2 * H);
});
