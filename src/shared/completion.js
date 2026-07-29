'use strict';
/**
 * How a finished session is described in a notification.
 *
 * ## Why the detection is not in here any more
 *
 * The first version of this feature derived "a prompt finished" from a busy → idle
 * change in Claude Code's session records, compared across the app's five-second
 * poll. It worked, but it was the wrong signal on two counts, and both were
 * user-visible:
 *
 *   - It was **up to five seconds late**, which on a short prompt means the toast
 *     arrives after you have already looked back at the terminal.
 *   - A session stops being `busy` for reasons that are not "your work is done" — a
 *     turn ending to wait on a background task, for one. The status field cannot
 *     tell those apart, so some toasts were announcing a pause as a completion.
 *
 * Claude Code's `Stop` hook fires exactly when a turn ends cleanly — the same moment
 * the CLI prints its `✻ Baked for 42s` line — and it is handed the background-task
 * list, so it *can* tell them apart. Detection therefore moved to the hook, which
 * signals the app through a file it watches. See completion-signal.js.
 *
 * The edge-detection code that used to live here was deleted rather than kept: it had
 * no callers left, and a second, unused implementation of "did a prompt finish" is
 * exactly the kind of thing a later reader wires back up by mistake.
 */

/**
 * What to call a finished session in a notification.
 *
 * The name if it has one, else the last segment of its working directory, because
 * "payments-api" is what someone recognises and a full path does not fit a toast.
 *
 * Takes anything carrying `name` and `cwd`, which covers both a live session record
 * and the much smaller signal the hook writes.
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
 * The `Stop` payload does not carry when the turn began, and nothing on disk records
 * it either: `updatedAt` is written when a status *changes*, so on a session that has
 * just gone idle it dates the end of the work rather than the start (see the
 * sessions.js header). Any duration here would be a guess formatted to look like a
 * measurement, so the toast says what it knows and stops there.
 */

module.exports = { sessionLabel };
