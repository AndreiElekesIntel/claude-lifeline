'use strict';
/**
 * What it cost to build this app.
 *
 * Every line of Lifeline was written with Claude Opus 5 inside Claude Code, and
 * that has a price. The About page states it because the app's whole subject is
 * the cost of long Claude Code runs — reporting everyone else's spend while
 * staying quiet about its own would be the one number missing from the page.
 *
 * It is a hand-maintained figure, not a measurement, and that is deliberate. It
 * cannot be derived: the sessions that built Lifeline ran in this repository
 * alongside unrelated work, some of them before the analytics scanner existed,
 * and a few on a different machine. Summing the local transcripts would produce
 * a number that looks computed and is wrong. So it is written down instead, and
 * bumped by hand at the end of each working session — one line, right here.
 *
 * Keep the full precision. The published rates are per million tokens, so the
 * honest total lands four decimal places out; rounding it at the source would
 * make each session's increment vanish into the rounding. The UI is what
 * shortens it for display.
 */

/** Total Claude Code API spend across every session that built this app, USD. */
const BUILD_COST_USD = 110.2495;

module.exports = { BUILD_COST_USD };
