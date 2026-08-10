'use strict';
/**
 * Every filesystem location Lifeline touches, resolved in one place.
 *
 * Both the hook (hot path, plain Node) and the Electron app import this, so it
 * stays dependency-free. Tests point LIFELINE_HOME / CLAUDE_CONFIG_DIR at a
 * scratch directory to keep real sessions untouched.
 *
 * **Everything stays on this machine.** Lifeline writes only under %APPDATA%,
 * which is deliberately a local path and not a synced one: config, the attempt
 * ledger, and the analytics cache all describe one machine's sessions, and
 * syncing them through OneDrive would both leak transcript-derived data off the
 * box and let two machines fight over the same ledger. Nothing here is uploaded
 * anywhere, and the app makes no network requests at all.
 */

const os = require('os');
const path = require('path');

/** Lifeline's own data dir: config, ledger, event log. */
function lifelineHome() {
  if (process.env.LIFELINE_HOME) return path.resolve(process.env.LIFELINE_HOME);
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'claude-lifeline');
}

/** Claude Code's config dir. Honours CLAUDE_CONFIG_DIR the same way the CLI does. */
function claudeHome() {
  if (process.env.CLAUDE_CONFIG_DIR) return path.resolve(process.env.CLAUDE_CONFIG_DIR);
  return path.join(os.homedir(), '.claude');
}

const configFile = () => path.join(lifelineHome(), 'config.json');
const ledgerFile = () => path.join(lifelineHome(), 'ledger.json');
const eventLogFile = () => path.join(lifelineHome(), 'events.jsonl');
const hookLogFile = () => path.join(lifelineHome(), 'hook.log');

/**
 * Cached per-transcript analytics totals.
 *
 * Derived data, safe to delete: it only exists so the app does not re-read
 * hundreds of megabytes of transcripts on every launch.
 */
const analyticsCacheFile = () => path.join(lifelineHome(), 'analytics-cache.json');

/**
 * Where the hook tells the app a turn just finished.
 *
 * One line of JSON, overwritten every turn — see completion-signal.js for why the
 * notification is driven by this rather than by the app's own poll.
 */
const completionSignalFile = () => path.join(lifelineHome(), 'last-completion.json');

/** Claude Code's user settings — where the StopFailure hook gets installed. */
const claudeSettingsFile = () => path.join(claudeHome(), 'settings.json');

/**
 * Claude Code's top-level config, which holds the per-project record of the
 * workspace trust dialog as `projects["<dir>"].hasTrustDialogAccepted`.
 *
 * Note it is a *sibling* of the config directory rather than a file inside it: the
 * CLI writes `~/.claude.json` next to `~/.claude/`. When CLAUDE_CONFIG_DIR is set
 * the whole config moves, so it is resolved from claudeHome() in that case — which
 * is also what lets the tests point it at a scratch file.
 */
const claudeConfigFile = () =>
  process.env.CLAUDE_CONFIG_DIR ? path.join(claudeHome(), '.claude.json') : path.join(os.homedir(), '.claude.json');

/** One JSON file per live CLI process, written by Claude Code itself. */
const sessionsDir = () => path.join(claudeHome(), 'sessions');

/** Per-project transcript directories (`projects/<slug>/<session-id>.jsonl`). */
const projectsDir = () => path.join(claudeHome(), 'projects');

/**
 * Claude Code's own precomputed usage statistics — what `/usage` reads.
 *
 * Worth using rather than recomputing: it already holds per-model token totals,
 * daily activity, and hour-of-day counts across the whole install, computed by
 * the CLI itself. Read-only, and treated as optional — the file only exists once
 * `/usage` has run, and its `version` field is checked before trusting the shape.
 */
const claudeStatsFile = () => path.join(claudeHome(), 'stats-cache.json');

/**
 * Absolute path to the hook entrypoint, so settings.json can reference it.
 * Resolved (not just joined) because the literal '..' would end up inside the
 * command string Claude Code executes.
 */
const hookEntry = () => path.resolve(__dirname, '..', 'hook', 'lifeline-hook.js');

/** Absolute path to the statusline command, for the same reason as `hookEntry`. */
const statuslineEntry = () => path.resolve(__dirname, '..', 'statusline', 'cli.js');

module.exports = {
  lifelineHome,
  claudeHome,
  configFile,
  ledgerFile,
  eventLogFile,
  hookLogFile,
  analyticsCacheFile,
  completionSignalFile,
  claudeSettingsFile,
  claudeConfigFile,
  sessionsDir,
  projectsDir,
  claudeStatsFile,
  hookEntry,
  statuslineEntry,
};
