'use strict';
/**
 * Decides whether the machine may be shut down because all work is genuinely
 * finished.
 *
 * The requirement this implements is "shut down at 5am if everything is done",
 * and the dangerous half of it is the word *done*. A session that died to an API
 * error also looks quiet: no process activity, no new transcript lines, nothing
 * on screen. Shutting down on that loses the recovery Lifeline exists to
 * perform, and — worse — loses it silently, overnight, with no one watching.
 *
 * So this module is written as a veto, not a score. It starts from "shut down"
 * and collects blockers; anything unexpected is a blocker. Concretely, every one
 * of these must hold:
 *
 *   1. No session's process is still running work (status `busy`).
 *   2. Every transcript's last assistant turn ended with `end_turn` — the CLI's
 *      own marker for "the model chose to stop". A trailing `tool_use` means the
 *      turn was cut off mid-tool, which is what a crash looks like.
 *   3. No transcript has been appended to within the quiet period. A session can
 *      report `idle` a beat before it writes its next line.
 *   4. No recovery is pending or recently attempted. If Lifeline resumed
 *      something twenty minutes ago, that session is mid-recovery, and the
 *      backoff for a rate limit alone can be minutes long.
 *   5. Nothing in the event log needs attention. A notify-only failure (bad key,
 *      billing) is unfinished work that a human has to see.
 *   6. No session is flagged stalled or dead.
 *
 * The asymmetry is deliberate and load-bearing: a false "not done" costs one
 * wasted night of an idle laptop, while a false "done" throws away work. Where
 * the two conflict, this stays on.
 *
 * Nothing here shuts anything down. It reports a decision; the caller acts. That
 * keeps the risky part testable — and it is tested, including the case where a
 * transcript ends mid-tool-call.
 */

const fs = require('fs');
const path = require('path');

const { projectsDir } = require('./paths');
const sessions = require('./sessions');
const eventlog = require('./eventlog');
const ledger = require('./ledger');

/**
 * How long a transcript must be untouched before its session counts as settled.
 *
 * 20 minutes, which is deliberately longer than the 15-minute stall threshold:
 * by the time a session has been quiet this long, Lifeline has already had a
 * chance to notice and flag it, so check 6 has something to see.
 */
const QUIET_MS = 20 * 60_000;

/**
 * How recently a recovery attempt blocks shutdown.
 *
 * Longer than any single backoff (rate limit waits 60s and retries up to 5
 * times) plus room for the resumed turn itself to get going.
 */
const RECOVERY_WINDOW_MS = 30 * 60_000;

/** Attention-worthy events that count as unfinished business. */
const BLOCKING_KINDS = [eventlog.KINDS.NOTIFIED, eventlog.KINDS.BLOCKED, eventlog.KINDS.STALLED, eventlog.KINDS.DEAD];

/**
 * Read the tail of a transcript to find how its last assistant turn ended.
 *
 * Only the tail: transcripts run to hundreds of megabytes, and the answer is
 * always within the last few records. Read backwards in chunks, and if the
 * marker is not found within the cap, say so rather than guessing — an
 * inconclusive read has to block, not pass.
 */
function tailStopReason(file, { maxBytes = 512 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return { stopReason: null, reason: 'empty transcript' };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    // Drop the first line when the window began mid-file: it is almost certainly
    // truncated, and a half-line parses as nothing useful.
    const lines = text.split('\n').filter(Boolean);
    if (start > 0) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        continue; // torn or partial line
      }
      if (rec.type !== 'assistant') continue;
      const msg = rec.message || {};
      if (msg.role !== 'assistant') continue;
      return { stopReason: msg.stop_reason || null, at: rec.timestamp || null, reason: null };
    }
    // No assistant turn in the window. On a large file that means the tail is
    // all tool results, which is itself a sign of work in progress.
    return { stopReason: null, reason: size > maxBytes ? 'no assistant turn in the last 512KB' : 'no assistant turn recorded' };
  } catch (err) {
    return { stopReason: null, reason: `unreadable transcript: ${err.message}` };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Transcripts touched recently enough to be worth inspecting.
 *
 * Anything older than the lookback belongs to a session that finished long ago;
 * re-reading every transcript on the machine to confirm that would make this
 * check cost more than the shutdown saves. Subagent transcripts are included —
 * a subagent still writing is work in flight.
 */
function recentTranscripts(now, lookbackMs) {
  const root = projectsDir();
  const out = [];
  const consider = (file) => {
    try {
      const st = fs.statSync(file);
      if (st.isFile() && now - st.mtimeMs <= lookbackMs) out.push({ file, mtimeMs: st.mtimeMs });
    } catch {
      /* vanished between readdir and stat */
    }
  };

  let slugs = [];
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out; // no projects dir — nothing has ever run here
  }

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
        consider(path.join(dir, entry.name));
      } else if (entry.isDirectory()) {
        const subDir = path.join(dir, entry.name, 'subagents');
        let subs = [];
        try {
          subs = fs.readdirSync(subDir);
        } catch {
          continue;
        }
        for (const name of subs) if (name.endsWith('.jsonl')) consider(path.join(subDir, name));
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const mins = (ms) => Math.round(ms / 60_000);

/**
 * Is every session genuinely finished?
 *
 * Returns `{ safe, blockers, checks, ... }`. `safe` is true only when
 * `blockers` is empty, and every blocker carries a human-readable `detail` —
 * the caller logs these, because "we did not shut down" is only useful with a
 * reason attached.
 */
function assess({ now = Date.now(), quietMs = QUIET_MS, recoveryWindowMs = RECOVERY_WINDOW_MS, stalledAfterMs = 900_000 } = {}) {
  const blockers = [];
  const block = (code, detail) => blockers.push({ code, detail });

  // --- 1 & 6. Live process state. ---
  const live = sessions.listSessions(now);
  const summary = sessions.summarise(live, stalledAfterMs);
  const busy = live.filter((s) => s.alive && s.status === 'busy');
  if (busy.length) {
    block(
      'session_busy',
      `${busy.length} session(s) still working: ${busy.map((s) => s.name || s.sessionId || s.pid).join(', ')}.`
    );
  }
  const stalled = sessions.findStalled(live, stalledAfterMs);
  if (stalled.length) {
    // A stall is unresolved, not finished: it is exactly the case where a session
    // is waiting on something and shutting down would abandon it.
    block('session_stalled', `${stalled.length} session(s) appear stalled: ${stalled.map((s) => s.name || s.sessionId).join(', ')}.`);
  }
  const dead = sessions.findDead(live);
  if (dead.length) {
    block('session_died', `${dead.length} session(s) died mid-task and were never recovered.`);
  }

  // --- 2 & 3. Transcript evidence. ---
  // Looked at over a window wider than the quiet period so a session that went
  // quiet just before the cutoff is still examined rather than skipped.
  const transcripts = recentTranscripts(now, Math.max(quietMs, recoveryWindowMs) * 3);
  const unfinished = [];
  for (const t of transcripts) {
    const age = now - t.mtimeMs;
    const name = path.basename(t.file, '.jsonl').slice(0, 8);
    if (age < quietMs) {
      block('recent_activity', `${name} was written ${mins(age)} min ago; waiting for ${mins(quietMs)} min of quiet.`);
      continue;
    }
    // Quiet for long enough — but quiet is not the same as finished.
    const { stopReason, reason } = tailStopReason(t.file);
    if (stopReason === 'end_turn') continue;
    unfinished.push({ name, stopReason, reason, ageMs: age });
  }
  for (const u of unfinished) {
    block(
      'turn_incomplete',
      u.stopReason
        ? `${u.name} last stopped at "${u.stopReason}", not end_turn — the turn was cut off mid-work ${mins(u.ageMs)} min ago.`
        : `${u.name} has no completed assistant turn to confirm (${u.reason}).`
    );
  }

  // --- 4. Recovery in flight. ---
  const attempts = (ledger.readLedger().attempts || []).filter((a) => now - a.at <= recoveryWindowMs);
  if (attempts.length) {
    const newest = Math.min(...attempts.map((a) => now - a.at));
    block(
      'recovery_recent',
      `${attempts.length} recovery attempt(s) in the last ${mins(recoveryWindowMs)} min (most recent ${mins(newest)} min ago) — those sessions may still be resuming.`
    );
  }

  // --- 5. Anything a human needs to see. ---
  const attention = eventlog
    .read(300)
    .filter((e) => now - (e.at || 0) <= 24 * 3_600_000)
    .filter((e) => e.needsAttention || BLOCKING_KINDS.includes(e.kind));
  // An acknowledgement clears everything older than it, matching the UI's badge.
  const ackAt = Math.max(0, ...eventlog.read(300).map((e) => e.acknowledgesUntil || 0));
  const openAttention = attention.filter((e) => (e.at || 0) > ackAt);
  if (openAttention.length) {
    block(
      'needs_attention',
      `${openAttention.length} unacknowledged item(s) need attention: ${openAttention
        .slice(0, 3)
        .map((e) => e.label || e.errorClass || e.kind)
        .join(', ')}.`
    );
  }

  return {
    safe: blockers.length === 0,
    at: now,
    blockers,
    summary,
    checks: {
      sessionsAlive: summary.alive,
      sessionsBusy: busy.length,
      transcriptsExamined: transcripts.length,
      transcriptsUnfinished: unfinished.length,
      recoveriesInWindow: attempts.length,
      openAttention: openAttention.length,
    },
    quietMs,
    recoveryWindowMs,
  };
}

module.exports = { assess, tailStopReason, recentTranscripts, QUIET_MS, RECOVERY_WINDOW_MS, BLOCKING_KINDS };
