'use strict';
/**
 * Append-only event log shared by the hook and the UI.
 *
 * JSONL because the hook appends from short-lived processes while the app tails
 * the file: one line per write is atomic enough for concurrent appends, and a
 * partially-written trailing line is skipped on read instead of corrupting the
 * whole log.
 */

const fs = require('fs');
const path = require('path');
const { eventLogFile, lifelineHome } = require('./paths');

const KINDS = {
  RECOVERED: 'recovered',
  SKIPPED: 'skipped',
  BLOCKED: 'blocked',
  NOTIFIED: 'notified',
  STALLED: 'stalled',
  DEAD: 'dead',
  INFO: 'info',
  ERROR: 'error',
};

function append(event) {
  try {
    fs.mkdirSync(lifelineHome(), { recursive: true });
    const line = JSON.stringify({ at: Date.now(), ...event });
    fs.appendFileSync(eventLogFile(), line + '\n', 'utf8');
  } catch {
    // The log is diagnostics. Losing a line must never break recovery.
  }
}

/** Most recent events first. Tolerates a torn last line. */
function read(limit = 200) {
  try {
    const lines = fs.readFileSync(eventLogFile(), 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        /* torn line — skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Trim to the newest `keep` lines. Called on app start, not in the hot path. */
function rotate(keep = 2000) {
  try {
    const file = eventLogFile();
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= keep) return;
    const tmp = path.join(lifelineHome(), `.events.${process.pid}.tmp`);
    fs.writeFileSync(tmp, lines.slice(-keep).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* non-fatal */
  }
}

module.exports = { append, read, rotate, KINDS };
