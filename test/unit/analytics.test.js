'use strict';
/**
 * Analytics correctness.
 *
 * The interesting cases here are all about *not* over-reporting: sessions run
 * concurrently, subagents bill separately, and cost is derived rather than read.
 * Each of those is a way the numbers could quietly inflate, so each has a test.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect both homes before anything resolves paths: without this the scan
// would read the developer's real transcripts.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-analytics-'));
process.env.LIFELINE_HOME = path.join(scratch, 'lifeline');
process.env.CLAUDE_CONFIG_DIR = path.join(scratch, 'claude');

const analytics = require('../../src/shared/analytics');
const pricing = require('../../src/shared/pricing');
const { projectsDir, analyticsCacheFile } = require('../../src/shared/paths');

/* ------------------------------ fixtures ------------------------------- */

const MIN = 60_000;

/** Write a transcript from a compact spec. */
function writeTranscript({ slug = 'proj-a', id = 'sess-1', parentOf = null, title = null, cwd = 'C:\\work\\proj-a', model = 'claude-opus-5', messages = [] }) {
  const dir = parentOf
    ? path.join(projectsDir(), slug, parentOf, 'subagents')
    : path.join(projectsDir(), slug);
  fs.mkdirSync(dir, { recursive: true });

  const lines = [];
  if (title) lines.push(JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: id }));
  for (const m of messages) {
    lines.push(
      JSON.stringify({
        type: m.role,
        timestamp: new Date(m.at).toISOString(),
        cwd,
        isSidechain: Boolean(parentOf),
        message:
          m.role === 'assistant'
            ? { model, usage: { input_tokens: m.in || 0, output_tokens: m.out || 0, cache_creation_input_tokens: m.cw || 0, cache_read_input_tokens: m.cr || 0 } }
            : { role: 'user', content: 'x' },
      })
    );
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

function reset() {
  fs.rmSync(projectsDir(), { recursive: true, force: true });
  fs.rmSync(analyticsCacheFile(), { force: true });
}

/** A chat of `n` messages, one every `stepMin` minutes from `startAt`. */
function chat(startAt, n, stepMin = 1, tokens = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? 'user' : 'assistant', at: startAt + i * stepMin * MIN, ...tokens });
  }
  return out;
}

/* ------------------------------ unionMs -------------------------------- */

test('unionMs merges overlapping spans instead of adding them', () => {
  assert.equal(analytics.unionMs([[0, 10]]), 10);
  assert.equal(analytics.unionMs([[0, 10], [5, 15]]), 15, 'overlap counted once');
  assert.equal(analytics.unionMs([[0, 10], [20, 30]]), 20, 'disjoint spans add');
  assert.equal(analytics.unionMs([[0, 100], [10, 20]]), 100, 'contained span adds nothing');
  assert.equal(analytics.unionMs([[20, 30], [0, 10], [5, 25]]), 30, 'unsorted input still merges');
  assert.equal(analytics.unionMs([]), 0);
});

test('clipSpans trims to the window and drops what falls outside', () => {
  assert.deepEqual(analytics.clipSpans([[0, 100]], 25, 75), [[25, 75]]);
  assert.deepEqual(analytics.clipSpans([[0, 10]], 50, 100), [], 'span before the window is dropped');
  assert.deepEqual(analytics.clipSpans([[10, 20]], 0, 100), [[10, 20]], 'contained span is untouched');
});

/* --------------------------- active vs elapsed -------------------------- */

test('a long silence is not counted as work', () => {
  reset();
  const start = Date.parse('2026-03-10T09:00:00Z');
  // Two messages 5 minutes apart, then one 6 hours later.
  writeTranscript({
    id: 'gap',
    messages: [
      { role: 'user', at: start },
      { role: 'assistant', at: start + 5 * MIN, out: 100 },
      { role: 'user', at: start + 360 * MIN },
      { role: 'assistant', at: start + 365 * MIN, out: 100 },
    ],
  });

  const { sessions } = analytics.scanSessions(null);
  const s = sessions.find((x) => x.sessionId === 'gap');
  // 5 + 5 minutes of activity, not the 6h05m elapsed span.
  assert.equal(s.activeMs, 10 * MIN, 'idle gap excluded from active time');
  assert.equal(s.lastAt - s.firstAt, 365 * MIN, 'elapsed span still reported in full');
});

test('concurrent sessions do not inflate a day beyond the time that passed', () => {
  reset();
  const start = Date.parse('2026-03-11T08:00:00Z');
  // Three sessions worked in the same two-hour block.
  for (let i = 0; i < 3; i++) {
    writeTranscript({ id: `concurrent-${i}`, messages: chat(start, 21, 6, { out: 50 }) });
  }

  const { sessions } = analytics.scanSessions(null);
  const naive = sessions.reduce((sum, s) => sum + s.activeMs, 0);
  const totals = analytics.windowTotals(sessions, 30 * 86_400_000, start + 3 * 86_400_000);

  assert.equal(naive, 6 * 60 * MIN, 'summing per session would report 6h');
  assert.equal(totals.activeMs, 2 * 60 * MIN, 'the union reports the 2h that actually elapsed');
});

test('an overnight session credits both days, not just the one it started in', () => {
  reset();
  // 22:00 to 02:00 local, so the span straddles midnight wherever this runs.
  const startLocal = new Date(2026, 2, 12, 22, 0, 0, 0).getTime();
  writeTranscript({ id: 'overnight', messages: chat(startLocal, 41, 6, { out: 10 }) });

  const { sessions } = analytics.scanSessions(null);
  const days = analytics.dailySeries(sessions, 3, new Date(2026, 2, 13, 12, 0, 0, 0).getTime());
  const byKey = new Map(days.map((d) => [d.key, d]));

  const first = byKey.get(analytics.dayKey(startLocal));
  const second = byKey.get(analytics.dayKey(startLocal + 4 * 60 * MIN));
  assert.ok(first.activeMs > 0, 'evening hours land on the first day');
  assert.ok(second.activeMs > 0, 'after-midnight hours land on the second day');
  assert.equal(first.activeMs + second.activeMs, 4 * 60 * MIN, 'and together they are the whole session');
  assert.equal(first.sessions, 1, 'the session itself is counted once, on the day it began');
  assert.equal(second.sessions, 0);
});

test('no day can report more hours than a day holds', () => {
  reset();
  const base = new Date(2026, 2, 14, 0, 30, 0, 0).getTime();
  // 12 sessions blanketing the same day.
  for (let i = 0; i < 12; i++) {
    writeTranscript({ id: `flood-${i}`, messages: chat(base + i * 30 * MIN, 61, 2, { out: 10 }) });
  }
  const { sessions } = analytics.scanSessions(null);
  for (const d of analytics.dailySeries(sessions, 3, new Date(2026, 2, 15, 6, 0, 0, 0).getTime())) {
    assert.ok(d.activeMs <= 86_400_000, `${d.key} reports ${d.activeMs}ms, more than a day`);
  }
});

/* ------------------------------ subagents ------------------------------ */

test('subagent spend rolls into its parent instead of becoming a phantom session', () => {
  reset();
  const start = Date.parse('2026-03-15T10:00:00Z');
  writeTranscript({ id: 'parent', title: 'Parent work', messages: chat(start, 5, 2, { out: 1000 }) });
  writeTranscript({ id: 'agent-a', parentOf: 'parent', model: 'claude-haiku-4-5', messages: chat(start + MIN, 5, 1, { out: 500 }) });
  writeTranscript({ id: 'agent-b', parentOf: 'parent', model: 'claude-haiku-4-5', messages: chat(start + MIN, 5, 1, { out: 500 }) });

  const { sessions } = analytics.scanSessions(null);
  assert.equal(sessions.length, 1, 'subagents are not separate sessions');

  const parent = sessions[0];
  assert.equal(parent.sessionId, 'parent');
  assert.equal(parent.subagents, 2);
  // Parent output 2×1000, each subagent 2×500 → 4000 total.
  assert.equal(parent.tokens.output, 4000, 'subagent tokens are real spend and are counted');
  assert.ok(parent.costUsd > 0);
});

test('a subagent whose parent transcript is gone still reports its spend', () => {
  reset();
  const start = Date.parse('2026-03-16T10:00:00Z');
  writeTranscript({ id: 'agent-orphan', parentOf: 'vanished-parent', model: 'claude-haiku-4-5', messages: chat(start, 5, 1, { out: 700 }) });

  const { sessions } = analytics.scanSessions(null);
  assert.equal(sessions.length, 1, 'the orphan is kept rather than silently dropped');
  assert.equal(sessions[0].tokens.output, 1400);
});

/* -------------------------------- cost --------------------------------- */

test('cache reads are priced far below fresh input', () => {
  // The distinction that makes the estimate meaningful: Claude Code sends mostly
  // cache reads, so pricing them as input would overstate spend enormously.
  const asInput = pricing.costOf({ input_tokens: 1_000_000 }, 'claude-opus-5').usd;
  const asCacheRead = pricing.costOf({ cache_read_input_tokens: 1_000_000 }, 'claude-opus-5').usd;
  assert.equal(asInput, 5);
  assert.equal(asCacheRead, 0.5);
  assert.ok(asCacheRead * 5 < asInput, 'cache reads must be much cheaper than input');
});

test('model ids match on longest prefix, so a dated id is not mispriced', () => {
  // 'claude-opus-4' must not swallow 'claude-opus-4-8': the rate halved at 4.5.
  assert.equal(pricing.ratesFor('claude-opus-4-8').rates.output, 25);
  assert.equal(pricing.ratesFor('claude-opus-4-20250514').rates.output, 75);
  assert.equal(pricing.ratesFor('claude-haiku-4-5-20251001').rates.output, 5);
});

test('locally generated messages are free, and unknown models fall back rather than to zero', () => {
  const synthetic = pricing.costOf({ output_tokens: 1_000_000 }, '<synthetic>');
  assert.equal(synthetic.usd, 0, 'synthetic messages were never billed');

  const future = pricing.costOf({ output_tokens: 1_000_000 }, 'claude-nonexistent-9');
  assert.ok(future.usd > 0, 'an unknown model must not read as free spend');
  assert.equal(future.known, false, 'and the estimate is flagged as a guess');
});

test('a user rate override replaces the built-in price', () => {
  const base = pricing.costOf({ output_tokens: 1_000_000 }, 'claude-opus-5').usd;
  const overridden = pricing.costOf({ output_tokens: 1_000_000 }, 'claude-opus-5', {
    'claude-opus-5': { input: 1, output: 2, cacheWrite: 1, cacheRead: 1 },
  }).usd;
  assert.equal(base, 25);
  assert.equal(overridden, 2);
});

/* ------------------------------- caching -------------------------------- */

test('a second scan reuses the cache and returns identical totals', () => {
  reset();
  const start = Date.parse('2026-03-17T10:00:00Z');
  writeTranscript({ id: 'cached', messages: chat(start, 9, 2, { out: 200, cr: 5000 }) });

  const first = analytics.scanSessions(null);
  const second = analytics.scanSessions(null);
  assert.equal(first.rescanned, 1, 'first pass reads the file');
  assert.equal(second.rescanned, 0, 'second pass is served from cache');
  // Double counting on re-scan is the specific bug this guards: subagent merging
  // mutates parent totals, so a cached parent must not be merged into twice.
  assert.equal(second.sessions[0].costUsd, first.sessions[0].costUsd);
  assert.equal(second.sessions[0].tokens.output, first.sessions[0].tokens.output);
});

test('repeated scans with subagents stay stable', () => {
  reset();
  const start = Date.parse('2026-03-18T10:00:00Z');
  writeTranscript({ id: 'p2', messages: chat(start, 5, 2, { out: 100 }) });
  writeTranscript({ id: 'agent-x', parentOf: 'p2', model: 'claude-haiku-4-5', messages: chat(start, 5, 1, { out: 300 }) });

  const a = analytics.scanSessions(null).sessions[0];
  const outA = a.tokens.output;
  const b = analytics.scanSessions(null).sessions[0];
  const c = analytics.scanSessions(null).sessions[0];
  assert.equal(b.tokens.output, outA, 'no double counting on the second scan');
  assert.equal(c.tokens.output, outA, 'nor the third');
});

test('changing pricing invalidates cached costs', () => {
  reset();
  const start = Date.parse('2026-03-19T10:00:00Z');
  writeTranscript({ id: 'repriced', messages: chat(start, 5, 2, { out: 1_000_000 }) });

  const before = analytics.scanSessions(null).sessions[0].costUsd;
  const after = analytics.scanSessions({ 'claude-opus-5': { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }).sessions[0].costUsd;
  assert.ok(before > 0);
  assert.equal(after, 0, 'a rate change must not be masked by a stale cache');
});

/* ----------------------------- robustness ------------------------------ */

test('a torn final line does not lose the session', () => {
  reset();
  const start = Date.parse('2026-03-20T10:00:00Z');
  writeTranscript({ id: 'torn', messages: chat(start, 5, 2, { out: 100 }) });
  const file = path.join(projectsDir(), 'proj-a', 'torn.jsonl');
  // Claude Code appends live, so a half-written final line is normal.
  fs.appendFileSync(file, '{"type":"assistant","timestamp":"2026-03-20T10:1', 'utf8');

  const { sessions } = analytics.scanSessions(null);
  const s = sessions.find((x) => x.sessionId === 'torn');
  assert.ok(s, 'the readable lines are still summarised');
  assert.equal(s.tokens.output, 200);
});

test('a corrupt cache file is rebuilt rather than fatal', () => {
  reset();
  const start = Date.parse('2026-03-21T10:00:00Z');
  writeTranscript({ id: 'recover', messages: chat(start, 5, 2, { out: 100 }) });
  fs.mkdirSync(path.dirname(analyticsCacheFile()), { recursive: true });
  fs.writeFileSync(analyticsCacheFile(), '{not json', 'utf8');

  const { sessions } = analytics.scanSessions(null);
  assert.equal(sessions.length, 1);
});

test('an empty transcript is skipped, not reported as a zero-length session', () => {
  reset();
  fs.mkdirSync(path.join(projectsDir(), 'proj-a'), { recursive: true });
  fs.writeFileSync(path.join(projectsDir(), 'proj-a', 'empty.jsonl'), '', 'utf8');

  const { sessions } = analytics.scanSessions(null);
  assert.equal(sessions.length, 0);
});

test('no transcripts at all yields an empty report rather than an error', () => {
  reset();
  const r = analytics.report({ now: Date.now() });
  assert.equal(r.totals.week.sessions, 0);
  assert.equal(r.totals.week.activeMs, 0);
  assert.deepEqual(r.recent, []);
  assert.equal(r.daily.week.length, 7, 'empty days are still present so the chart keeps its shape');
});

test('a user-set title wins over the generated one', () => {
  reset();
  const start = Date.parse('2026-03-22T10:00:00Z');
  writeTranscript({ id: 'titled', title: 'Generated title', messages: chat(start, 3, 2, { out: 10 }) });
  fs.appendFileSync(
    path.join(projectsDir(), 'proj-a', 'titled.jsonl'),
    `${JSON.stringify({ type: 'custom-title', customTitle: 'My name for it', sessionId: 'titled' })}\n`,
    'utf8'
  );

  const r = analytics.report({ now: Date.parse('2026-03-23T10:00:00Z') });
  assert.equal(r.recent[0].title, 'My name for it');
});

/* --------------------------- monthly series ----------------------------- */

test('monthlySeries covers every month in the window, including empty ones', () => {
  const now = Date.parse('2026-03-15T12:00:00Z');
  const rows = analytics.monthlySeries([], 12, now);
  assert.equal(rows.length, 12);
  assert.equal(rows[11].key, '2026-03', 'newest month last, so the chart reads left to right');
  assert.equal(rows[0].key, '2025-04', 'window is 12 months back inclusive');
  assert.equal(rows[0].activeMs, 0, 'a month with no work is present rather than missing');
});

test('monthlySeries attributes a session to the month it started', () => {
  reset();
  const start = Date.parse('2026-02-10T09:00:00Z');
  writeTranscript({ id: 'feb', messages: chat(start, 4, 5, { out: 100 }) });

  const { sessions } = analytics.scanSessions(null);
  const rows = analytics.monthlySeries(sessions, 12, Date.parse('2026-03-15T12:00:00Z'));
  const feb = rows.find((r) => r.key === '2026-02');
  const mar = rows.find((r) => r.key === '2026-03');
  assert.equal(feb.sessions, 1);
  assert.equal(mar.sessions, 0);
  assert.ok(feb.activeMs > 0, 'time lands in the month it happened');
});

test('a session spanning a month boundary splits its time, not its count', () => {
  reset();
  // 23:30 on 31 Jan through 00:10 on 1 Feb. Local time, so the boundary is a real
  // one, and steps stay under IDLE_GAP_MS so every gap counts as work.
  const start = new Date(2026, 0, 31, 23, 30, 0).getTime();
  writeTranscript({ id: 'crossing', messages: chat(start, 5, 10, { out: 100 }) });

  const { sessions } = analytics.scanSessions(null);
  const rows = analytics.monthlySeries(sessions, 12, new Date(2026, 2, 15).getTime());
  const jan = rows.find((r) => r.key === '2026-01');
  const feb = rows.find((r) => r.key === '2026-02');
  assert.equal(jan.sessions + feb.sessions, 1, 'counted once overall');
  assert.equal(jan.sessions, 1, 'counted where it started');
  assert.equal(jan.activeMs, 30 * MIN, '23:30 to midnight lands in January');
  assert.equal(feb.activeMs, 10 * MIN, 'and the rest in February');
  assert.equal(jan.activeMs + feb.activeMs, 40 * MIN, 'adding back up to the whole session');
});

test('report exposes a monthly series for the long ranges', () => {
  reset();
  const now = Date.parse('2026-03-15T12:00:00Z');
  writeTranscript({ id: 'recent', messages: chat(now - 2 * 86_400_000, 4, 5, { out: 100 }) });

  const r = analytics.report({ now });
  assert.equal(r.monthly.year.length, 12);
  assert.ok(Array.isArray(r.projectsAllTime), 'all-time view has its own project ranking');
});
