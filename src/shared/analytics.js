'use strict';
/**
 * Work analytics: what you worked on, for how long, and roughly what it cost.
 *
 * Source of truth is Claude Code's own transcripts — `projects/<slug>/<id>.jsonl`,
 * one JSON object per line. Everything here is read-only; nothing is written back
 * into Claude's directories, so analytics cannot disturb a live session.
 *
 * Three things in here are less obvious than they look:
 *
 * 1. **Active time, not elapsed time.** A session opened at 09:00 and answered
 *    once at 23:00 is not fourteen hours of work. So duration is the sum of gaps
 *    between consecutive messages, and any gap longer than IDLE_GAP_MS is treated
 *    as "walked away" and excluded. Elapsed span is reported separately, because
 *    the two answer different questions.
 *
 * 2. **Cost is derived, never read.** Transcripts carry token counts but no
 *    dollar amount (see pricing.js). Cost is therefore an estimate and is
 *    labelled as one in the UI.
 *
 * 3. **Scanning is incremental.** The transcript tree here is ~456MB across 427
 *    files; a full parse takes seconds, which is far too slow for a 5s poll. Per
 *    file results are cached against (size, mtime), so a steady state re-reads
 *    only the transcript currently being appended to.
 */

const fs = require('fs');
const path = require('path');

const { projectsDir, analyticsCacheFile } = require('./paths');
const { costOf } = require('./pricing');

/**
 * A gap longer than this means the human left, not that they were thinking.
 * 15 minutes: long enough to cover reading a diff or a build finishing, short
 * enough that lunch does not get billed as work.
 */
const IDLE_GAP_MS = 15 * 60_000;

/** Cache format version. A bump invalidates every entry rather than misreading it. */
const CACHE_VERSION = 4;

/* ============================== transcripts ============================= */

/**
 * Every transcript file, newest first.
 *
 * The tree is two shapes, not one:
 *
 *   projects/<slug>/<session-id>.jsonl                     — the session itself
 *   projects/<slug>/<session-id>/subagents/agent-*.jsonl   — its subagents
 *
 * Subagent transcripts are real, billed API usage (they carry their own model and
 * token counts, often a cheaper model than the parent), so skipping them would
 * under-report spend — in this repo's own history they are a third of all
 * transcript files. Each is tagged with `parentId` so its tokens roll up into the
 * session that spawned it instead of appearing as a phantom extra session.
 */
function transcriptFiles() {
  const root = projectsDir();
  const out = [];
  let slugs = [];
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out; // no projects dir yet — a fresh install, not an error
  }

  const push = (full, id, parentId) => {
    try {
      const st = fs.statSync(full);
      if (st.isFile()) out.push({ file: full, size: st.size, mtimeMs: st.mtimeMs, id, parentId });
    } catch {
      /* vanished between readdir and stat — skip */
    }
  };

  for (const slug of slugs) {
    const dir = path.join(root, slug.name);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        push(path.join(dir, entry.name), entry.name.replace(/\.jsonl$/, ''), null);
        continue;
      }
      if (!entry.isDirectory()) continue;
      // A directory named after a session id holds that session's subagents.
      const subDir = path.join(dir, entry.name, 'subagents');
      let subs = [];
      try {
        subs = fs.readdirSync(subDir);
      } catch {
        continue;
      }
      for (const name of subs) {
        if (name.endsWith('.jsonl')) push(path.join(subDir, name), name.replace(/\.jsonl$/, ''), entry.name);
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Reduce one transcript to its totals.
 *
 * Tolerates torn and non-JSON lines: a transcript being appended to right now
 * routinely ends mid-line, and one bad line must not lose the whole session.
 */
function summariseTranscript(entry, pricingOverrides) {
  const out = {
    sessionId: entry.id,
    parentId: entry.parentId || null,
    file: entry.file,
    title: null,
    customTitle: null,
    cwd: null,
    gitBranch: null,
    model: null,
    firstAt: null,
    lastAt: null,
    activeMs: 0,
    /**
     * The [start, end] spans this session was actively worked in.
     *
     * Kept alongside `activeMs` because sessions overlap: you run several at
     * once, so adding up their durations reports more hours in a day than the
     * day contains. Day and week totals union these intervals instead.
     */
    intervals: [],
    userMessages: 0,
    assistantMessages: 0,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    costUsd: 0,
    estimatedRates: false,
    lastPrompt: null,
  };

  let raw;
  try {
    raw = fs.readFileSync(entry.file, 'utf8');
  } catch {
    return null;
  }

  let prevAt = null;
  for (const line of raw.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // torn final line while Claude Code is mid-write
    }

    const type = d.type;

    // Titles: a name the user set wins over the generated one.
    if (type === 'custom-title' && d.customTitle) out.customTitle = String(d.customTitle);
    else if (type === 'ai-title' && d.aiTitle) out.title = String(d.aiTitle);
    else if (type === 'last-prompt' && d.lastPrompt) out.lastPrompt = String(d.lastPrompt).slice(0, 300);

    if (d.cwd && !out.cwd) out.cwd = String(d.cwd);
    if (d.gitBranch && !out.gitBranch) out.gitBranch = String(d.gitBranch);

    if (type !== 'user' && type !== 'assistant') continue;

    // Sidechain entries are subagent traffic. Their tokens are real spend, so
    // they are counted, but they must not drive the human's active-time clock.
    const isSidechain = d.isSidechain === true;

    const at = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (Number.isFinite(at)) {
      if (out.firstAt === null || at < out.firstAt) out.firstAt = at;
      if (out.lastAt === null || at > out.lastAt) out.lastAt = at;
      if (!isSidechain) {
        if (prevAt !== null) {
          const gap = at - prevAt;
          if (gap > 0 && gap <= IDLE_GAP_MS) {
            out.activeMs += gap;
            // Extend the open interval when contiguous, otherwise start a new
            // one — the break is where the user walked away.
            const last = out.intervals[out.intervals.length - 1];
            if (last && last[1] === prevAt) last[1] = at;
            else out.intervals.push([prevAt, at]);
          }
        }
        prevAt = at;
      }
    }

    if (type === 'user') {
      if (!isSidechain) out.userMessages += 1;
      continue;
    }

    out.assistantMessages += 1;
    const msg = d.message;
    if (!msg || typeof msg !== 'object') continue;
    if (msg.model) out.model = String(msg.model);

    const u = msg.usage;
    if (!u) continue;
    out.tokens.input += Number(u.input_tokens) || 0;
    out.tokens.output += Number(u.output_tokens) || 0;
    out.tokens.cacheWrite += Number(u.cache_creation_input_tokens) || 0;
    out.tokens.cacheRead += Number(u.cache_read_input_tokens) || 0;

    const { usd, known } = costOf(u, msg.model, pricingOverrides);
    out.costUsd += usd;
    if (!known) out.estimatedRates = true;
  }

  // A transcript with no messages carries no information worth showing.
  if (out.firstAt === null) return null;
  return out;
}

/* ================================ cache ================================= */

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(analyticsCacheFile(), 'utf8'));
    if (raw && raw.version === CACHE_VERSION && raw.entries) return raw;
  } catch {
    /* missing or corrupt — rebuilt below */
  }
  return { version: CACHE_VERSION, ratesKey: '', entries: {} };
}

function writeCache(cache) {
  try {
    const file = analyticsCacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // A cache we cannot persist only costs time on the next scan.
  }
}

/**
 * Every session, newest first — cached per file against (size, mtime).
 *
 * Changing the pricing table invalidates the whole cache, since stored costs
 * were computed with the old rates and would otherwise never be recalculated.
 */
function scanSessions(pricingOverrides) {
  const cache = readCache();
  const ratesKey = JSON.stringify(pricingOverrides || {});
  if (cache.ratesKey !== ratesKey) {
    cache.entries = {};
    cache.ratesKey = ratesKey;
  }

  const files = transcriptFiles();
  const entries = {};
  const all = [];
  let rescanned = 0;

  for (const entry of files) {
    const hit = cache.entries[entry.file];
    let summary;
    if (hit && hit.size === entry.size && hit.mtimeMs === entry.mtimeMs) {
      summary = hit.summary;
    } else {
      summary = summariseTranscript(entry, pricingOverrides);
      rescanned += 1;
    }
    entries[entry.file] = { size: entry.size, mtimeMs: entry.mtimeMs, summary };
    if (summary) all.push(summary);
  }

  // Rebuilt rather than merged, so transcripts the user deleted drop out.
  cache.entries = entries;
  writeCache(cache);

  const sessions = mergeSubagents(all);
  sessions.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  return { sessions, rescanned, fileCount: files.length };
}

/**
 * Fold subagent totals into the session that spawned them.
 *
 * Tokens and cost are added — that work was really billed. Active time is not:
 * subagents run concurrently with each other and with the parent, so summing
 * their spans would report more hours than actually elapsed. The parent's own
 * message timeline already covers the wall-clock time the user spent.
 *
 * An orphan (parent transcript deleted, subagents left behind) is kept as its own
 * entry rather than dropped, so its spend still shows up somewhere.
 */
function mergeSubagents(summaries) {
  const byId = new Map();
  for (const s of summaries) if (!s.parentId) byId.set(s.sessionId, s);

  const out = [];
  for (const s of summaries) {
    if (!s.parentId) {
      out.push(s);
      continue;
    }
    const parent = byId.get(s.parentId);
    if (!parent) {
      out.push(s);
      continue;
    }
    parent.costUsd += s.costUsd;
    parent.tokens.input += s.tokens.input;
    parent.tokens.output += s.tokens.output;
    parent.tokens.cacheWrite += s.tokens.cacheWrite;
    parent.tokens.cacheRead += s.tokens.cacheRead;
    parent.assistantMessages += s.assistantMessages;
    parent.subagents = (parent.subagents || 0) + 1;
    if (s.estimatedRates) parent.estimatedRates = true;
  }
  return out;
}

/* =============================== rollups ================================ */

const DAY_MS = 86_400_000;

/**
 * Total time covered by a set of possibly-overlapping [start, end] spans.
 *
 * This is what makes "hours worked" honest. Claude Code sessions run
 * concurrently — in this machine's own history, 22 sessions in one day summed to
 * 21.96 hours of "work" because overlapping spans were counted once per session.
 * Union first, then measure: two sessions worked in the same hour are one hour.
 */
function unionMs(spans) {
  if (!spans.length) return 0;
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s > end) {
      total += end - start;
      start = s;
      end = e;
    } else if (e > end) {
      end = e;
    }
  }
  return total + (end - start);
}

/** Spans clipped to [from, to) — a session crossing midnight counts in both days. */
function clipSpans(intervals, from, to) {
  const out = [];
  for (const [s, e] of intervals || []) {
    const a = Math.max(s, from);
    const b = Math.min(e, to);
    if (b > a) out.push([a, b]);
  }
  return out;
}

/**
 * A session's work split across the local days it actually spans.
 *
 * Returns `[{key, at, ms, share, spans}]`, one entry per day touched, where
 * `share` is that day's fraction of the session's measured time and sums to 1
 * across the result.
 *
 * ## Why this exists
 *
 * Time was already clipped per day, but cost was not: it was added whole to a
 * single day. Which day depended on who was asking — `dailySeries` used the day
 * work *started*, `history.groupByDay` used the day it was *last touched* — so the
 * same session's spend appeared on two different dates in two different views of
 * the same data. Measured on this machine's own history, 2026-07-24 read $492.83
 * in History against $68.39 in Analytics, and 2026-07-30 read $33.28 against
 * $0.00. Both were wrong: an overnight run does not spend all its money at
 * whichever end of the night you happen to key on.
 *
 * Time is the only proxy available for *when* the money went. Claude Code records
 * per-session token totals, not per-message ones, so there is no way to know which
 * hour a token was spent in — apportioning by measured active time is the closest
 * honest answer, and it has the property that matters: the days sum back to the
 * session total exactly, so no money is invented or lost.
 *
 * A session with no usable intervals returns a single entry for `fallbackAt`,
 * because the alternative — dropping it — would make the day totals stop adding up
 * to the grand total.
 */
function splitByDay(session, { fallbackAt = null } = {}) {
  const spansByDay = new Map();

  for (const [spanStart, spanEnd] of session.intervals || []) {
    if (!(spanEnd > spanStart)) continue;
    // Walk only the days this span touches. Starting at local midnight of the
    // span's first day keeps the arithmetic in local time, which is where the day
    // boundaries the user cares about are.
    const cursor = new Date(spanStart);
    cursor.setHours(0, 0, 0, 0);
    for (let at = cursor.getTime(); at < spanEnd; at += DAY_MS) {
      const a = Math.max(spanStart, at);
      const z = Math.min(spanEnd, at + DAY_MS);
      if (!(z > a)) continue;
      const key = dayKey(a);
      if (!spansByDay.has(key)) spansByDay.set(key, { key, at: startOfDay(a), spans: [] });
      spansByDay.get(key).spans.push([a, z]);
    }
  }

  const days = Array.from(spansByDay.values()).map((d) => ({
    ...d,
    // Unioned within the day: a session's own spans should not overlap, but a
    // union costs nothing and makes a malformed transcript harmless.
    ms: unionMs(d.spans),
  }));

  const totalMs = days.reduce((n, d) => n + d.ms, 0);

  if (!days.length || totalMs <= 0) {
    const at = fallbackAt || session.lastAt || session.firstAt;
    if (!at) return [];
    // No measurable time: the whole session lands on one day. `share: 1` keeps the
    // caller's arithmetic uniform — every path apportions by share.
    return [{ key: dayKey(at), at: startOfDay(at), ms: 0, share: 1, spans: [], estimated: true }];
  }

  for (const d of days) d.share = d.ms / totalMs;
  days.sort((a, b) => a.at - b.at);
  return days;
}

/** Local midnight of the day containing `ts`. */
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local-time day key, so "today" means the user's today, not UTC's. */
function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function emptyBucket(key, at) {
  return {
    key,
    at,
    sessions: 0,
    activeMs: 0,
    costUsd: 0,
    tokens: 0,
    userMessages: 0,
    assistantMessages: 0,
    /** Collected during accumulation, unioned into activeMs by sealBucket(). */
    _spans: [],
  };
}

/**
 * Add a session's totals to a bucket.
 *
 * `spans` are collected rather than summed — see unionMs(). Everything else is
 * additive: tokens spent by two concurrent sessions really is the sum, even
 * though the time they took is not.
 */
function addToBucket(bucket, s, spans) {
  bucket.sessions += 1;
  bucket.costUsd += s.costUsd;
  bucket.tokens += s.tokens.input + s.tokens.output + s.tokens.cacheWrite + s.tokens.cacheRead;
  bucket.userMessages += s.userMessages;
  bucket.assistantMessages += s.assistantMessages;
  for (const span of spans || s.intervals || []) bucket._spans.push(span);
}

/** Resolve collected spans into a single honest duration and drop the scratch. */
function sealBucket(bucket) {
  bucket.activeMs = unionMs(bucket._spans);
  /**
   * Tokens are a count, so the apportioned fractions are rounded away here.
   *
   * Cost is deliberately *not* rounded: it is a derived decimal that gets summed
   * and formatted downstream, and rounding each bucket would make the buckets stop
   * adding up to the total. A token, though, is a discrete thing, and
   * "3,037,072,263.997 tokens" is a display bug.
   */
  bucket.tokens = Math.round(bucket.tokens);
  delete bucket._spans;
  return bucket;
}

/**
 * Per-day buckets covering the last `days`, including days with no work.
 *
 * Empty days are kept because a chart that silently drops them would compress
 * a gap and misrepresent the shape of the week.
 */
function dailySeries(sessions, days, now = Date.now()) {
  const buckets = new Map();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const at = start.getTime() - i * DAY_MS;
    const key = dayKey(at);
    buckets.set(key, emptyBucket(key, at));
  }

  /**
   * Counts land on the day work started; usage is apportioned across the days it
   * spanned.
   *
   * The split is intentional. A *session* is one thing that began on one day, and
   * "I started four sessions on Tuesday" is how people describe their own week —
   * so the count, and the message counts that describe the same event, go to the
   * start day whole. Time and money are quantities that accumulate while the
   * session runs, so they are divided by measured time per day: an overnight run
   * shows hours *and* spend on both sides of midnight.
   *
   * Cost previously went to the start day whole, which put an overnight session's
   * entire spend before midnight and disagreed with the History tab — which keyed
   * the same session on its *last* day. See splitByDay().
   */
  for (const s of sessions) {
    if (!s.firstAt) continue;
    const startBucket = buckets.get(dayKey(s.firstAt));
    if (startBucket) {
      startBucket.sessions += 1;
      startBucket.userMessages += s.userMessages;
      startBucket.assistantMessages += s.assistantMessages;
    }

    const tokens = s.tokens.input + s.tokens.output + s.tokens.cacheWrite + s.tokens.cacheRead;
    for (const part of splitByDay(s, { fallbackAt: s.firstAt })) {
      const b = buckets.get(part.key);
      // Outside the window being charted — the session ran, but not in view.
      if (!b) continue;
      b.costUsd += s.costUsd * part.share;
      b.tokens += tokens * part.share;
      for (const span of part.spans) b._spans.push(span);
    }
  }
  return Array.from(buckets.values()).map(sealBucket);
}

/** Local-time month key. Same reasoning as dayKey: months are the user's, not UTC's. */
function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Per-month buckets covering the last `months`, including empty ones.
 *
 * A year at day resolution is 365 bars, which reads as noise. Months are the
 * useful grain for "how has this year gone", and clipping spans to month
 * boundaries keeps the same no-double-counting property as dailySeries().
 */
function monthlySeries(sessions, months, now = Date.now()) {
  const buckets = new Map();
  const cursor = new Date(now);
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  const bounds = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1).getTime();
    const end = new Date(cursor.getFullYear(), cursor.getMonth() - i + 1, 1).getTime();
    const key = monthKey(start);
    buckets.set(key, emptyBucket(key, start));
    bounds.push([key, start, end]);
  }

  // Same rule as dailySeries: the session count belongs to the month it started
  // in, while time and money are apportioned by measured time per month. A session
  // running across the 1st is rare, but "rare" is not a reason for the two charts
  // to attribute it differently.
  for (const s of sessions) {
    if (!s.firstAt) continue;
    const startBucket = buckets.get(monthKey(s.firstAt));
    if (startBucket) {
      startBucket.sessions += 1;
      startBucket.userMessages += s.userMessages;
      startBucket.assistantMessages += s.assistantMessages;
    }

    const tokens = s.tokens.input + s.tokens.output + s.tokens.cacheWrite + s.tokens.cacheRead;
    /** Per-month measured time, used as the apportioning weight. */
    const perMonth = [];
    let measured = 0;
    for (const [key, from, to] of bounds) {
      const clipped = clipSpans(s.intervals, from, to);
      if (!clipped.length) continue;
      const ms = unionMs(clipped);
      perMonth.push([key, clipped, ms]);
      measured += ms;
    }

    if (measured > 0) {
      for (const [key, clipped, ms] of perMonth) {
        const b = buckets.get(key);
        b._spans.push(...clipped);
        b.costUsd += s.costUsd * (ms / measured);
        b.tokens += tokens * (ms / measured);
      }
    } else if (startBucket) {
      // No measurable time inside the window: keep the totals whole on the start
      // month rather than losing them.
      startBucket.costUsd += s.costUsd;
      startBucket.tokens += tokens;
    }
  }
  return Array.from(buckets.values()).map(sealBucket);
}

/** Totals for sessions started within the last `ms`. */
function windowTotals(sessions, ms, now = Date.now()) {
  // Guard the all-time case: now - MAX_SAFE_INTEGER underflows past any real
  // timestamp, but doing the subtraction on a huge number is still needless.
  const from = ms >= now ? 0 : now - ms;
  const t = emptyBucket('window', from);
  const projects = new Set();
  for (const s of sessions) {
    if (!s.firstAt || s.firstAt < from) continue;
    addToBucket(t, s, clipSpans(s.intervals, from, now));
    if (s.cwd) projects.add(s.cwd);
  }
  sealBucket(t);
  t.projects = projects.size;
  return t;
}

/** Busiest projects in a window, by active time. */
function topProjects(sessions, ms, now = Date.now(), limit = 6) {
  const from = ms >= now ? 0 : now - ms;
  const byCwd = new Map();
  for (const s of sessions) {
    if (!s.firstAt || s.firstAt < from) continue;
    const key = s.cwd || 'unknown';
    if (!byCwd.has(key)) byCwd.set(key, { cwd: key, ...emptyBucket(key, from) });
    addToBucket(byCwd.get(key), s, clipSpans(s.intervals, from, now));
  }
  return Array.from(byCwd.values())
    .map(sealBucket)
    .sort((a, b) => b.activeMs - a.activeMs)
    .slice(0, limit);
}

/**
 * The full analytics payload the UI renders.
 *
 * `year` uses 365 days rather than a calendar year so the number always means
 * "the last twelve months", which is comparable week to week.
 */
function report({ now = Date.now(), pricingOverrides = null, sessionLimit = 50 } = {}) {
  const { sessions, rescanned, fileCount } = scanSessions(pricingOverrides);

  return {
    generatedAt: now,
    fileCount,
    rescanned,
    /** True when any usage was priced with the fallback rate — the UI says so. */
    estimatedRates: sessions.some((s) => s.estimatedRates),
    totals: {
      week: windowTotals(sessions, 7 * DAY_MS, now),
      month: windowTotals(sessions, 30 * DAY_MS, now),
      quarter: windowTotals(sessions, 90 * DAY_MS, now),
      half: windowTotals(sessions, 180 * DAY_MS, now),
      year: windowTotals(sessions, 365 * DAY_MS, now),
      all: windowTotals(sessions, Number.MAX_SAFE_INTEGER, now),
    },
    daily: {
      week: dailySeries(sessions, 7, now),
      month: dailySeries(sessions, 30, now),
    },
    // Months for the long ranges: 90 daily bars is already too dense to read at
    // this width, 365 is noise, and "all time" has no fixed length to chart at
    // all — so everything from a quarter up is charted monthly, and all-time
    // reuses the year's shape.
    monthly: {
      quarter: monthlySeries(sessions, 3, now),
      half: monthlySeries(sessions, 6, now),
      year: monthlySeries(sessions, 12, now),
    },
    projects: topProjects(sessions, 30 * DAY_MS, now),
    /** Busiest projects per range, so the bars agree with the figures above them. */
    projectsByRange: {
      week: topProjects(sessions, 7 * DAY_MS, now),
      month: topProjects(sessions, 30 * DAY_MS, now),
      quarter: topProjects(sessions, 90 * DAY_MS, now),
      half: topProjects(sessions, 180 * DAY_MS, now),
      year: topProjects(sessions, 365 * DAY_MS, now),
      all: topProjects(sessions, Number.MAX_SAFE_INTEGER, now),
    },
    /** Busiest projects over the whole history, for the all-time view. */
    projectsAllTime: topProjects(sessions, Number.MAX_SAFE_INTEGER, now),
    recent: sessions.slice(0, sessionLimit).map((s) => ({
      sessionId: s.sessionId,
      title: s.customTitle || s.title || null,
      lastPrompt: s.lastPrompt,
      cwd: s.cwd,
      gitBranch: s.gitBranch,
      model: s.model,
      firstAt: s.firstAt,
      lastAt: s.lastAt,
      activeMs: s.activeMs,
      elapsedMs: s.lastAt && s.firstAt ? s.lastAt - s.firstAt : 0,
      userMessages: s.userMessages,
      assistantMessages: s.assistantMessages,
      tokens: s.tokens,
      costUsd: s.costUsd,
      /**
       * The worked spans, so a consumer can union them.
       *
       * Carried because the History tab totals a day across the sessions in it,
       * and sessions overlap: adding up `activeMs` for three agents run at once
       * reports three hours for one hour of wall clock. Only the intervals can
       * answer "how long was I actually working that day".
       *
       * Rounded to whole seconds, which shrinks the JSON without changing any
       * figure the UI renders — nothing here is displayed below minute precision.
       */
      intervals: (s.intervals || []).map(([a, b]) => [Math.round(a / 1000) * 1000, Math.round(b / 1000) * 1000]),
    })),
  };
}

module.exports = {
  IDLE_GAP_MS,
  CACHE_VERSION,
  transcriptFiles,
  summariseTranscript,
  scanSessions,
  mergeSubagents,
  unionMs,
  clipSpans,
  splitByDay,
  startOfDay,
  dailySeries,
  monthlySeries,
  windowTotals,
  topProjects,
  dayKey,
  monthKey,
  report,
};
