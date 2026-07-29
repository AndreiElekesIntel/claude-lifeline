'use strict';
/**
 * The handoff that tells the app a prompt just finished.
 *
 * ## Why a file, and why not just poll the session records
 *
 * The first version of this feature derived "finished" from a busy → idle change
 * in Claude Code's session files, spotted on the app's five-second poll. That works
 * — but it is late and it is imprecise, in ways that are the whole point here:
 *
 *   - **Late.** A five-second poll means the toast lands up to five seconds after
 *     the turn ended, which on a short prompt arrives after you have already looked
 *     back at the terminal. The notification is only useful if it beats you to it.
 *   - **Imprecise.** A session's status also stops being `busy` for reasons that are
 *     not "your prompt is done" — the turn ending to wait on a background task, for
 *     one. The status field cannot distinguish those; the `Stop` hook can, because
 *     Claude Code hands it the background-task list.
 *
 * `Stop` fires exactly when a turn ends cleanly — the same moment the CLI prints
 * its `✻ Baked for 42s` line. That is the event the user actually means, so it is
 * the event this feature listens to.
 *
 * ## Why the hook does not post the toast itself
 *
 * It runs inside Claude Code, on the critical path, as a bare Node process with no
 * Electron — so it has no notification API. It could shell out to PowerShell, which
 * is what the standalone script this replaces did, but that costs the better part of
 * a second of process startup on every single turn and it happens *before* the CLI
 * hands control back. Writing one small file is microseconds, so the hook stays
 * fast and the app — which already has a notification API and is already running —
 * does the presenting.
 *
 * ## Why fs.watch and not another poll
 *
 * The app watches this file for changes rather than reading it on its normal
 * five-second tick. `fs.watch` fires as soon as the write lands, so the toast is
 * effectively immediate; polling it would reintroduce the exact latency this
 * module exists to remove.
 *
 * The file is a single line of JSON, rewritten (not appended) on every turn: only
 * the most recent completion is ever interesting, so this cannot grow without
 * bound. Written to Lifeline's own data dir, which both sides already agree on
 * through `paths`, and which tests redirect — so a test run signals into its own
 * sandbox rather than toasting at whoever is using the machine.
 */

const fs = require('fs');

const { completionSignalFile } = require('./paths');

/**
 * Record that a session just finished a turn.
 *
 * Called from the hook, so it must never throw and never block for long: a failure
 * to write a notification hint is not a reason to disturb a session that has just
 * finished working normally. `writeFileSync` with a whole-file replace is atomic
 * enough for the purpose — a torn read is handled by `read` returning null, and the
 * next turn overwrites it anyway.
 */
function write({ sessionId, cwd, name = null, at = Date.now(), durationMs = null }) {
  try {
    const line = JSON.stringify({ sessionId: sessionId || null, cwd: cwd || null, name, at, durationMs });
    fs.writeFileSync(completionSignalFile(), line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * The most recent completion, or null if there is nothing readable.
 *
 * Returns null rather than throwing on a missing, empty, or half-written file: this
 * is read from a watcher that fires *during* the write on some filesystems, so a
 * partial read is an expected event and not an error.
 */
function read() {
  try {
    const raw = fs.readFileSync(completionSignalFile(), 'utf8').trim();
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || typeof rec !== 'object') return null;
    // `at` is what dedupes one completion from the next, so a record without a
    // usable one cannot be acted on safely.
    if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * Whether a freshly-read signal is worth announcing.
 *
 * Two guards, and both exist because of how the watcher behaves rather than how the
 * hook does:
 *
 *   - `lastAt` — fs.watch fires more than once for a single write on Windows, so
 *     the same completion is read several times in a row. Announcing per event
 *     would mean two or three toasts per prompt.
 *   - `maxAgeMs` — the file survives a restart, so the app would otherwise open by
 *     announcing whatever finished last, possibly hours ago. Same reasoning as the
 *     silent first poll in completion.js: at startup, old and new are
 *     indistinguishable, and the honest choice is to say nothing.
 */
function isFresh(rec, { lastAt = 0, now = Date.now(), maxAgeMs = 60_000 } = {}) {
  if (!rec) return false;
  if (rec.at <= lastAt) return false;
  // A clock that has gone backwards, or a signal from the future, is not evidence
  // that something just finished.
  if (rec.at > now + 5_000) return false;
  return now - rec.at <= maxAgeMs;
}

module.exports = { write, read, isFresh };
