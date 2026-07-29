'use strict';
/**
 * Noticing when a session has finished working.
 *
 * "Your prompt is done" is a busy → idle transition in Claude Code's own session
 * records, which `sessions.listSessions()` already reads on every poll. So this
 * needs no new hook: the signal is on disk, and deriving it in the app rather than
 * on Claude Code's critical path means a bug here can never delay a real session.
 *
 * ## Why it is a diff and not a status check
 *
 * A session sitting idle is idle on every poll. Notifying on `status === 'idle'`
 * would re-announce the same finished prompt every five seconds for as long as the
 * window stayed open. What matters is the *edge* — the poll where a session that
 * was busy stopped being busy — so this compares against the previous poll and
 * reports only what changed.
 *
 * That makes the first poll a special case. At startup every session is seen for
 * the first time, and an idle one is indistinguishable from one that just
 * finished; announcing them would mean a fistful of toasts for prompts that
 * completed while the app was closed, possibly hours ago. So the first observation
 * of a session only records its state.
 *
 * ## Why a completed prompt is not the same as a dead one
 *
 * A session whose process has exited also stops being busy, and that is a
 * different event with its own detection (`findDead`). Only a session that is
 * still alive can have *finished* — a vanished one crashed, and calling that
 * "finished" would report a failure as a success.
 */

/**
 * Sessions that stopped working since the last poll.
 *
 * `previous` is a Map of sessionId → status, as returned in `next`; pass the value
 * from the last call and store the one that comes back. Pure: the caller owns the
 * state, so a test can drive any sequence of polls it likes.
 *
 * Keyed by `sessionId` rather than `pid`, because a pid is recycled by the OS and
 * a resumed session keeps its id — the id is what "the same conversation" means.
 */
function findCompleted(sessions, previous) {
  const before = previous instanceof Map ? previous : new Map();
  const next = new Map();
  const completed = [];

  for (const session of sessions || []) {
    if (!session || !session.sessionId) continue;
    const was = before.get(session.sessionId);
    next.set(session.sessionId, session.status);

    // Alive, was working, is no longer working. `was === undefined` is a session
    // seen for the first time — recorded above, never announced.
    if (was === 'busy' && session.status !== 'busy' && session.alive) completed.push(session);
  }

  return { completed, next };
}

/**
 * What to call a finished session in a notification.
 *
 * The name if it has one, else the last segment of its working directory, because
 * "payments-api" is what someone recognises and the full path does not fit a toast.
 */
function sessionLabel(session) {
  if (!session) return 'A session';
  if (session.name) return session.name;
  const cwd = String(session.cwd || '').replace(/[\\/]+$/, '');
  const leaf = cwd.split(/[\\/]/).filter(Boolean).pop();
  return leaf || 'A session';
}

/**
 * There is deliberately no "worked for 4m" in the toast.
 *
 * It would be the obvious thing to add and there is no honest source for it:
 * `updatedAt` is written when the status *changes*, so on a session that has just
 * gone idle it dates the end of the work, not the start (see the sessions.js
 * header). Nothing on disk records when the prompt began, so any duration here
 * would be a guess formatted to look like a measurement.
 */

module.exports = { findCompleted, sessionLabel };
