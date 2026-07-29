'use strict';
/**
 * Renaming a session, by appending a `custom-title` line to its transcript.
 *
 * This is the one place Lifeline writes into Claude Code's own directories, and it
 * is deliberate: a name stored in Lifeline's config would only ever be visible in
 * Lifeline, whereas a `custom-title` record is the format Claude Code itself reads,
 * so the new name also shows up in its `/resume` picker. analytics.js already
 * prefers `customTitle` over the generated `ai-title` (see summariseTranscript),
 * which is what makes an appended line take effect.
 *
 * Because it is a write, the safety rules matter more than the feature:
 *
 *   - **Never while the session is alive.** Claude Code appends to the same file
 *     with its own handle. Two appenders do not corrupt each other's bytes on
 *     Windows, but they do interleave *records* — our line can land in the middle
 *     of a line the CLI is part-way through writing, tearing it. A torn line is
 *     tolerated by our own reader and by Claude Code's, but the record is lost, and
 *     losing a message out of somebody's live session is not a trade worth making
 *     for a rename. So a live pid is refused, with a reason the UI shows.
 *
 *   - **Append only.** The file is never rewritten, truncated, or re-serialised.
 *     The worst case for a failed append is a trailing partial line, which every
 *     reader of this format already tolerates; the worst case for a rewrite is
 *     losing a session's entire history.
 *
 *   - **Trailing newline first.** A transcript being appended to can end
 *     mid-line. Writing our record straight onto that would splice two JSON
 *     objects into one unparseable line *and* destroy the original. So a newline
 *     is prepended whenever the file does not already end with one.
 */

const fs = require('fs');
const path = require('path');

const { projectsDir } = require('./paths');
const { pidAlive } = require('./sessions');

/** Longest name accepted. Long enough for a sentence, short enough to render. */
const MAX_NAME = 120;

/**
 * Clean a user-typed name into one line of text.
 *
 * Newlines are the important part: this value becomes a JSON string on a
 * line-delimited record, so an embedded newline would split one record into two
 * and corrupt the transcript. Control characters go for the same reason.
 */
function normaliseName(input) {
  return String(input == null ? '' : input)
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

/**
 * Locate a session's transcript by id.
 *
 * Searched rather than accepted as a path: the id arrives from the renderer, and a
 * path would let any string through to a filesystem write. Resolving it against
 * the projects tree means only files Claude Code created can ever be targets.
 *
 * Subagent transcripts (`<slug>/<id>/subagents/*.jsonl`) are deliberately not
 * searched — they are not sessions the user opens, and naming one would attach a
 * title to something the picker never shows.
 */
function findTranscript(sessionId) {
  const id = String(sessionId || '');
  // Reject anything that could escape the projects tree before touching the disk.
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(id) || id.includes('..')) return null;

  const root = projectsDir();
  let slugs = [];
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const file = path.join(root, slug.name, `${id}.jsonl`);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* not in this project */
    }
  }
  return null;
}

/** True when the file's last byte is a newline, so an append starts a fresh line. */
function endsWithNewline(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return true; // an empty file needs no separator
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } catch {
    // Unknown: assume it does not, since a spurious blank line is harmless and a
    // missing one splices two records together.
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Whether this session can be renamed right now, and why not if it cannot.
 *
 * Split out from rename() so the UI can disable the control and explain itself
 * *before* the user types a name, rather than rejecting the work afterwards.
 */
function canRename(sessionId, liveSessions = []) {
  const live = liveSessions.find((s) => s && s.sessionId === sessionId && s.alive !== false);
  if (live && pidAlive(live.pid)) {
    return {
      ok: false,
      reason: 'This session is still running. Renaming appends to the transcript Claude Code is writing to, so Lifeline waits until the session ends.',
    };
  }
  const file = findTranscript(sessionId);
  if (!file) return { ok: false, reason: 'No transcript on disk for this session — it may have been pruned.' };
  return { ok: true, file };
}

/**
 * Append a `custom-title` record. Returns the stored name.
 *
 * An empty name is a valid request and means "go back to the generated title": the
 * record is written with an empty string, which summariseTranscript() treats as
 * absent (it checks truthiness), so the `ai-title` wins again. Nothing is deleted
 * to achieve that, which keeps this function append-only.
 */
function rename(sessionId, rawName, { liveSessions = [], now = Date.now() } = {}) {
  const check = canRename(sessionId, liveSessions);
  if (!check.ok) return { ok: false, reason: check.reason };

  const name = normaliseName(rawName);
  const record = { type: 'custom-title', customTitle: name, timestamp: new Date(now).toISOString(), source: 'claude-lifeline' };
  const prefix = endsWithNewline(check.file) ? '' : '\n';

  try {
    // 'a' is O_APPEND: every write lands at the current end of file, so a session
    // that somehow starts writing between the check and here still cannot have its
    // bytes overwritten by ours.
    fs.appendFileSync(check.file, `${prefix}${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, reason: `Could not write the new name: ${err.message}` };
  }
  return { ok: true, name, file: check.file };
}

module.exports = { MAX_NAME, normaliseName, findTranscript, endsWithNewline, canRename, rename };
