'use strict';
/**
 * The statusline command Claude Code runs.
 *
 * Reads the JSON payload on stdin, prints one line on stdout. Claude Code spawns
 * this on every statusline update and waits for it, so two rules govern everything
 * here:
 *
 *   1. It must always print something. A crash means the user's statusline is
 *      replaced by an error on every refresh, so the top-level catch prints the
 *      plain line without dots rather than letting anything escape.
 *   2. It must be quick. One readdir of the session records, no transcript scan, no
 *      config read, no Electron.
 *
 * Registered by `lifeline statusline install`, which preserves whatever statusLine
 * command was already configured.
 */

const path = require('path');

/** ~200ms of stdin at most; a statusline that hangs is worse than one without dots. */
const STDIN_TIMEOUT_MS = 2_000;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    // Claude Code always closes stdin, but a hung pipe must not hang the terminal.
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

/**
 * The session records, or an empty list.
 *
 * Required lazily and inside a try: if `sessions.js` cannot be loaded — a half-synced
 * OneDrive checkout, a moved repo — the statusline should lose its dots, not break.
 */
function loadSessions() {
  try {
    // eslint-disable-next-line global-require
    const { listSessions } = require(path.join(__dirname, '..', 'shared', 'sessions'));
    return listSessions();
  } catch {
    return [];
  }
}

/**
 * Whether to emit colour.
 *
 * NO_COLOR is honoured because it is the convention, and because the glyphs already
 * carry the state — a ring for working, a filled circle for finished — so a colourless
 * line loses no information.
 */
function wantsColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.LIFELINE_STATUSLINE_NO_COLOR === '1') return false;
  return true;
}

async function main() {
  const raw = await readStdin();

  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // A malformed payload still deserves a line; it just cannot be a specific one.
    payload = {};
  }

  // eslint-disable-next-line global-require
  const statusline = require(path.join(__dirname, 'statusline'));

  try {
    process.stdout.write(statusline.render(payload, loadSessions(), { color: wantsColor() }));
  } catch {
    // Last resort: the details without any dots. Never an error string, and never
    // an empty line — either would read as Claude Code having lost the statusline.
    try {
      process.stdout.write(statusline.details(payload));
    } catch {
      process.stdout.write('');
    }
  }
}

main();
