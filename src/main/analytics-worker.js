'use strict';
/**
 * Runs one analytics report and exits.
 *
 * This exists as a separate thread purely because of timing: a cold scan reads
 * every transcript on disk (~456MB / 427 files here, ~2.4s), and doing that on
 * the main thread would freeze the tray and the window for the duration. Warm
 * scans are ~30ms, but the first one after launch is always cold.
 *
 * It is deliberately trivial — no state, no polling, no lifecycle. The parent
 * owns caching and scheduling; this just answers a single question.
 */

const { parentPort, workerData } = require('worker_threads');
const { report } = require('../shared/analytics');
const claudeStats = require('../shared/claude-stats');

try {
  const opts = workerData || {};
  const out = report(opts);
  // Claude Code's own /usage figures, folded into the same payload. Read here
  // rather than in the main process so a slow disk cannot stall the tray, and
  // kept as a separate key because the two sources answer different questions
  // (see claude-stats.js).
  out.claudeStats = claudeStats.report({ pricingOverrides: opts.pricingOverrides || null });
  parentPort.postMessage({ ok: true, report: out });
} catch (err) {
  // Reported rather than thrown so the parent can show a message instead of
  // treating a missing transcript tree as a crash.
  parentPort.postMessage({ ok: false, error: (err && err.message) || String(err) });
}
