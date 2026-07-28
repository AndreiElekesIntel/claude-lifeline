'use strict';
/**
 * Every filesystem location Lifeline touches, resolved in one place.
 *
 * Both the hook (hot path, plain Node) and the Electron app import this, so it
 * stays dependency-free. Tests point LIFELINE_HOME / CLAUDE_CONFIG_DIR at a
 * scratch directory to keep real sessions untouched.
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

/** Claude Code's user settings — where the StopFailure hook gets installed. */
const claudeSettingsFile = () => path.join(claudeHome(), 'settings.json');

/** One JSON file per live CLI process, written by Claude Code itself. */
const sessionsDir = () => path.join(claudeHome(), 'sessions');

/** Per-project transcript directories (`projects/<slug>/<session-id>.jsonl`). */
const projectsDir = () => path.join(claudeHome(), 'projects');

/**
 * Absolute path to the hook entrypoint, so settings.json can reference it.
 * Resolved (not just joined) because the literal '..' would end up inside the
 * command string Claude Code executes.
 */
const hookEntry = () => path.resolve(__dirname, '..', 'hook', 'lifeline-hook.js');

module.exports = {
  lifelineHome,
  claudeHome,
  configFile,
  ledgerFile,
  eventLogFile,
  hookLogFile,
  claudeSettingsFile,
  sessionsDir,
  projectsDir,
  hookEntry,
};
