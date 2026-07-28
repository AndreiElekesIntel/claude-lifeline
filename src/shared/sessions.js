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
 */

const fs = require('fs');
const path = require('path');
const { sessionsDir } = require('./paths');

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
        idleMs: updatedAt ? now - updatedAt : null,
        alive,
        stale: !alive,
        file,
      });
    } catch {
      /* skip unreadable record */
    }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * A session is "stalled" when it claims to be busy but has not updated for
 * longer than the threshold. `busy` is the meaningful case: an idle session
 * sitting untouched is normal and must not be reported.
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

module.exports = { listSessions, pidAlive, findStalled, findDead, summarise };
