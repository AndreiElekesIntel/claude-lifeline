'use strict';
/**
 * Reads the live-session state Claude Code maintains on disk.
 *
 * `~/.claude/sessions/<pid>.json` is written by the CLI itself and holds
 * {pid, sessionId, cwd, status, name, updatedAt, ...}. Reading it is how
 * Lifeline sees sessions without attaching to any process — the tray shows
 * real state, and monitoring can never disturb a running session.
 *
 * Liveness is checked with a signal-0 probe: it tests for the process without
 * affecting it.
 *
 * ## Why `updatedAt` is not the activity signal
 *
 * The obvious reading of these records is that `updatedAt` says when the session
 * last did something. It does not: it is written when the status *changes*, so a
 * session that goes busy and then works for an hour keeps an `updatedAt` an hour
 * old the whole time. Measured on two genuinely working sessions — both reported
 * `status: "busy"` with `updatedAt` 19 and 20 minutes stale, while their
 * transcripts had been written 0 and 136 seconds earlier.
 *
 * That is not a cosmetic difference. Anything comparing `updatedAt` against a
 * threshold calls a working session stalled the moment it works longer than the
 * threshold, which is precisely backwards: the harder a session is working, the
 * more certainly it gets reported as hung. So the transcript's mtime is used
 * instead — it advances on every message written, which is what "still working"
 * actually looks like on disk.
 */

const fs = require('fs');
const path = require('path');
const { sessionsDir, projectsDir } = require('./paths');

/** True when a process with this pid exists and we may signal it. */
function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is owned by someone else — still alive.
    return err.code === 'EPERM';
  }
}

/**
 * Claude Code's directory name for a working directory.
 *
 * Every non-alphanumeric character becomes a dash, which is why
 * `C:\Users\aelekes` becomes `C--Users-aelekes`. Verified against the real
 * projects tree rather than inferred: both live sessions' transcripts were found
 * this way, including one under a path containing spaces and dots.
 */
function projectSlug(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * When a session's transcript was last written, or null if it cannot be found.
 *
 * The slug is computed rather than searched, because this runs on every poll and
 * scanning a few hundred project directories per session would turn a cheap status
 * read into a directory walk. If the slug rule ever changes, the fallback is not a
 * wrong answer but *no* answer — the caller keeps using `updatedAt`, which is the
 * behaviour that existed before this function.
 */
function transcriptTouchedAt(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  // The id lands in a path, so a traversal attempt is refused rather than resolved.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(String(sessionId))) return null;
  try {
    return fs.statSync(path.join(projectsDir(), projectSlug(cwd), `${sessionId}.jsonl`)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * All sessions Claude Code has registered.
 * `stale` records (process gone) are kept and flagged rather than hidden, since
 * a vanished session is exactly what dead-session detection looks for.
 */
function listSessions(now = Date.now()) {
  const dir = sessionsDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const out = [];
  for (const file of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const alive = pidAlive(rec.pid);
      const updatedAt = rec.updatedAt || rec.statusUpdatedAt || rec.startedAt || 0;

      /**
       * The last sign of life, preferring the transcript over the status record.
       *
       * `Math.max` rather than the transcript alone: a session whose transcript is
       * missing or unreadable still has its status timestamp, and a status change is
       * itself activity. Taking the later of the two means adding this signal can
       * only ever make a session look *more* alive, never less — so the worst case
       * is the old behaviour, not a new false alarm.
       */
      const touchedAt = transcriptTouchedAt(rec.cwd, rec.sessionId);
      const activeAt = Math.max(updatedAt || 0, touchedAt || 0);

      out.push({
        pid: rec.pid,
        sessionId: rec.sessionId,
        cwd: rec.cwd,
        name: rec.name || null,
        status: rec.status || 'unknown',
        kind: rec.kind || 'interactive',
        version: rec.version || null,
        startedAt: rec.startedAt || null,
        updatedAt,
        /** Transcript mtime, when one was found. Exposed for the UI's "last seen". */
        touchedAt: touchedAt || null,
        activeAt: activeAt || null,
        // Measured from the transcript, so a long-running task no longer reads as idle.
        idleMs: activeAt ? now - activeAt : null,
        alive,
        stale: !alive,
        file,
      });
    } catch {
      /* skip unreadable record */
    }
  }
  return out.sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0));
}

/**
 * A session is "stalled" when it claims to be busy but nothing has been written
 * for longer than the threshold. `busy` is the meaningful case: an idle session
 * sitting untouched is normal and must not be reported.
 *
 * `idleMs` here is time since the *transcript* was last written — see the header
 * for why the status record's own timestamp cannot answer this.
 */
function findStalled(sessions, thresholdMs) {
  return sessions.filter((s) => s.alive && s.status === 'busy' && s.idleMs !== null && s.idleMs > thresholdMs);
}

/** Sessions whose process is gone but that were mid-work when they vanished. */
function findDead(sessions) {
  return sessions.filter((s) => s.stale && s.status === 'busy');
}

/** Counts for the tray tooltip. */
function summarise(sessions, thresholdMs = 900_000) {
  const alive = sessions.filter((s) => s.alive);
  return {
    total: sessions.length,
    alive: alive.length,
    busy: alive.filter((s) => s.status === 'busy').length,
    idle: alive.filter((s) => s.status === 'idle').length,
    stalled: findStalled(sessions, thresholdMs).length,
    dead: findDead(sessions).length,
  };
}

module.exports = { listSessions, pidAlive, projectSlug, transcriptTouchedAt, findStalled, findDead, summarise };
