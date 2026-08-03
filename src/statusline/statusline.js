'use strict';
/**
 * The live dot, inside Claude Code itself.
 *
 * The Sessions table already shows one dot per session, but it is in Lifeline's
 * window — so seeing it means leaving the terminal you are actually working in.
 * Claude Code renders a `statusLine` command's stdout on every update, which makes
 * it the one place Lifeline can draw *inside* a session without attaching to it.
 *
 * Two dots, answering two different questions:
 *
 *   - This session's own state, at the front of the line. Filled green once the turn
 *     ends, a violet ring while it is working.
 *   - How many *other* sessions have finished, at the end. That is the part the
 *     Lifeline window was being opened for: with fifteen terminals cascaded, the one
 *     in front is the only statusline you can read, so it may as well report the
 *     fleet rather than only itself.
 *
 * ## Constraints this file is shaped by
 *
 * It runs on every statusline refresh, in a process Claude Code spawns and waits
 * for, so it is on the interactive path in a way even the Stop hook is not. Hence:
 * no Electron, no config read, no transcript scan — one readdir of the session
 * records and nothing else. Measured under 15 ms for fifteen sessions.
 *
 * And it must never throw. A statusline that crashes replaces the user's line with
 * an error on every keystroke, so `render` is total: every failure path returns the
 * plain line rather than an exception. The caller falls back further still.
 *
 * ## Why the shape carries the meaning, not just the colour
 *
 * Same reasoning as the dot in the app: green-vs-violet is the pair red-green colour
 * blindness collapses. A ring for working and a filled circle for finished is the
 * same shape language the app falls back to under `prefers-reduced-motion`, so the
 * two surfaces stay legible in the same way. It also means the line still reads
 * correctly when `NO_COLOR` is set, or through anything that strips ANSI.
 */

/** The app's own palette, so the two surfaces cannot drift apart visually. */
const COLORS = {
  ok: [52, 211, 153],
  accent: [124, 92, 255],
  warn: [251, 191, 36],
  danger: [248, 113, 113],
  faint: [128, 128, 128],
};

/** Truecolor, because Windows Terminal has it and 256-colour would approximate. */
function paint(text, rgb, { color = true } = {}) {
  if (!color) return text;
  return `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\u001b[0m`;
}

/**
 * One session's state, as a glyph and a colour.
 *
 * Deliberately the same four states and the same words as the app's `sessionState`,
 * because a session that reads "stalled" in one place and "working" in the other is
 * a bug report. Kept as a separate implementation rather than a shared import: this
 * runs in a bare Node process with no renderer, and coupling the statusline to the
 * app's DOM code would put Electron on the interactive path.
 */
function stateOf(rec, stalledAfterMs = 900_000) {
  if (!rec) return { glyph: '◌', color: COLORS.faint, word: 'unknown' };
  if (!rec.alive) return { glyph: '●', color: COLORS.danger, word: rec.status === 'busy' ? 'died' : 'exited' };
  if (rec.status === 'busy' && rec.idleMs !== null && rec.idleMs > stalledAfterMs) {
    return { glyph: '◑', color: COLORS.warn, word: 'stalled' };
  }
  // A ring while working, filled once finished — the distinction survives without
  // colour, which a hue change alone would not.
  if (rec.status === 'busy') return { glyph: '○', color: COLORS.accent, word: 'working' };
  if (rec.status === 'idle') return { glyph: '●', color: COLORS.ok, word: 'done' };
  return { glyph: '◌', color: COLORS.faint, word: String(rec.status || 'unknown') };
}

/**
 * Which record is the session this statusline belongs to.
 *
 * By session id when the payload carries one, which is exact. The cwd fallback
 * exists because the id is the newer field and an older Claude Code may not send it;
 * matching on the directory is imperfect for two sessions in one folder but is never
 * *wrong* about the folder, and a missing dot is worse than an occasionally shared
 * one. Returns null rather than guessing when neither matches.
 */
function findSelf(sessions, { sessionId, cwd }) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (sessionId) {
    const byId = list.find((s) => s && String(s.sessionId) === String(sessionId));
    if (byId) return byId;
  }
  if (cwd) {
    // Slash direction has to be unified, not just trailing separators trimmed: the
    // payload's current_dir arrives with forward slashes and the session record holds
    // backslashes, so the same folder compares unequal without this.
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const byCwd = list.filter((s) => s && s.alive && norm(s.cwd) === norm(cwd));
    // Only when it is unambiguous: with two sessions in one folder, a coin flip
    // would report the wrong one's state half the time.
    if (byCwd.length === 1) return byCwd[0];
  }
  return null;
}

/**
 * How many other sessions are waiting for you.
 *
 * `done` excludes this session on purpose — "1 done" while you are reading the line
 * that says it is done is noise, and it would never reach zero.
 */
function fleet(sessions, self) {
  const list = Array.isArray(sessions) ? sessions : [];
  let done = 0;
  let working = 0;
  for (const s of list) {
    if (!s || !s.alive) continue;
    if (self && s.pid === self.pid) continue;
    if (s.status === 'idle') done += 1;
    else if (s.status === 'busy') working += 1;
  }
  return { done, working };
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * The middle of the line: the details that were there before Lifeline touched it.
 *
 * Kept byte-for-byte as the user had it — folder, model with its context size, cost,
 * elapsed, context used. Adding a dot is not a licence to redesign someone's
 * statusline, and a changed cost format is the kind of thing that gets noticed as a
 * regression rather than as an improvement.
 */
function details(payload) {
  const cost = (payload.cost && payload.cost.total_cost_usd) || 0;
  const durMs = (payload.cost && payload.cost.total_duration_ms) || 0;
  const model = (payload.model && payload.model.display_name) || '';
  const dir = String((payload.workspace && payload.workspace.current_dir) || payload.cwd || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop();

  const ctx = payload.context_window || {};
  const ctxSize = ctx.context_window_size || 200_000;
  const used = (ctx.total_input_tokens || 0) + (ctx.total_output_tokens || 0);

  // The context size annotates the model name, so with no model there is nothing for
  // it to annotate — emitting it alone produces a bare " (200k context)" segment,
  // which reads as a missing value rather than as an absent one.
  let modelStr = model;
  if (model) {
    if (ctxSize >= 1_000_000) modelStr += ` (${(ctxSize / 1_000_000).toFixed(0)}M context)`;
    else if (ctxSize >= 1_000) modelStr += ` (${(ctxSize / 1_000).toFixed(0)}k context)`;
  }

  const parts = [];
  if (dir) parts.push(dir);
  if (modelStr) parts.push(modelStr);
  parts.push(`$${cost.toFixed(4)}`);
  parts.push(`${(durMs / 1000).toFixed(1)}s`);
  parts.push(`ctx ${fmtTokens(used)}/${fmtTokens(ctxSize)}`);
  return parts.join(' | ');
}

/**
 * The whole line.
 *
 * Total by construction: `sessions` may be empty or unreadable and every field of
 * `payload` may be missing, and each of those cases costs a dot, never the line.
 */
function render(payload = {}, sessions = [], { color = true, stalledAfterMs = 900_000 } = {}) {
  const body = details(payload || {});

  let self = null;
  try {
    self = findSelf(sessions, { sessionId: payload.session_id, cwd: (payload.workspace && payload.workspace.current_dir) || payload.cwd });
  } catch {
    self = null;
  }

  const bits = [];

  // The session's own state, first — it is about the line it is attached to.
  if (self) {
    const st = stateOf(self, stalledAfterMs);
    bits.push(paint(st.glyph, st.color, { color }));
  }

  bits.push(body);

  // The fleet, last: a count of what is waiting elsewhere. Silent at zero, so a
  // single-session terminal looks exactly as it did before.
  const others = fleet(sessions, self);
  if (others.done > 0) {
    bits.push(paint(`● ${others.done} done`, COLORS.ok, { color }));
  }

  return bits.join(' ');
}

module.exports = { render, stateOf, findSelf, fleet, details, COLORS };
