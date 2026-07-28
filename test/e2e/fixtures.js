'use strict';
/**
 * Launch helper for the Electron tests.
 *
 * Every test gets a fresh, disposable LIFELINE_HOME and CLAUDE_CONFIG_DIR. That
 * isolation is not a nicety: without it a test run would read the developer's
 * real sessions and — worse — the hook-install tests would rewrite the real
 * ~/.claude/settings.json out from under live Claude Code sessions.
 */

const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let counter = 0;

function makeSandbox(label = 'e2e') {
  // process.pid + a counter keeps parallel-safe uniqueness without a clock.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lifeline-${label}-${process.pid}-${counter++}-`));
  const lifelineHome = path.join(root, 'lifeline');
  const claudeHome = path.join(root, 'claude');
  fs.mkdirSync(lifelineHome, { recursive: true });
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  return { root, lifelineHome, claudeHome };
}

/** Write a session record shaped exactly like the ones the CLI writes. */
function writeSession(sandbox, rec) {
  const now = Date.now();
  const full = {
    pid: rec.pid,
    sessionId: rec.sessionId || `sess-${rec.pid}`,
    cwd: rec.cwd || 'C:/work/demo',
    startedAt: rec.startedAt || now - 3_600_000,
    version: '2.1.0',
    kind: rec.kind || 'interactive',
    entrypoint: 'cli',
    name: rec.name || null,
    status: rec.status || 'idle',
    updatedAt: rec.updatedAt !== undefined ? rec.updatedAt : now,
    statusUpdatedAt: rec.updatedAt !== undefined ? rec.updatedAt : now,
  };
  fs.writeFileSync(path.join(sandbox.claudeHome, 'sessions', `${rec.pid}.json`), JSON.stringify(full, null, 2), 'utf8');
  return full;
}

/** Append an event the way the hook does, so the UI renders real shapes. */
function writeEvents(sandbox, events) {
  const lines = events.map((e) => JSON.stringify({ at: Date.now(), ...e })).join('\n');
  fs.appendFileSync(path.join(sandbox.lifelineHome, 'events.jsonl'), lines + '\n', 'utf8');
}

function writeConfig(sandbox, cfg) {
  fs.writeFileSync(path.join(sandbox.lifelineHome, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * The saved config, or null when nothing has been saved yet.
 *
 * Absence is a real and meaningful state: the app only writes config.json when
 * a setting actually changes, so a rejected edit correctly leaves no file.
 */
function readConfig(sandbox) {
  const file = path.join(sandbox.lifelineHome, 'config.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** A saved setting by dotted path, or undefined if it was never persisted. */
function savedValue(sandbox, dotted) {
  let cur = readConfig(sandbox);
  for (const part of dotted.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function readClaudeSettings(sandbox) {
  const file = path.join(sandbox.claudeHome, 'settings.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Launch the app against a sandbox and return { app, page, sandbox }.
 * Resolves once the renderer has painted real state rather than placeholders.
 */
async function launch(sandbox, extraEnv = {}) {
  const app = await electron.launch({
    args: [REPO_ROOT],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LIFELINE_HOME: sandbox.lifelineHome,
      CLAUDE_CONFIG_DIR: sandbox.claudeHome,
      // Keeps the window visible and skips the start-minimised path.
      LIFELINE_E2E: '1',
      ...extraEnv,
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // The status pill only gets a data-status once the first state has applied.
  await page.waitForSelector('#statusPill[data-status]');
  return { app, page, sandbox };
}

async function close(ctx) {
  if (ctx && ctx.app) {
    try {
      await ctx.app.close();
    } catch {
      /* already gone */
    }
  }
}

module.exports = {
  REPO_ROOT,
  makeSandbox,
  writeSession,
  writeEvents,
  writeConfig,
  readConfig,
  savedValue,
  readClaudeSettings,
  launch,
  close,
};
