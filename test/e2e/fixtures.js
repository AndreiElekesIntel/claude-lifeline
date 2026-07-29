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
 * Write a transcript shaped like the ones Claude Code appends, so analytics has
 * something real to scan.
 *
 * Messages are spaced 5 minutes apart, comfortably inside the 15-minute idle gap,
 * so the whole span counts as active time rather than being split into intervals.
 */
function writeTranscript(sandbox, { slug = 'demo', id = 'sess-1', title = null, cwd = 'C:/work/demo', model = 'claude-opus-4-8', messages = 6, startedAt = null } = {}) {
  const dir = path.join(sandbox.claudeHome, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });

  // Anchored a couple of hours back so the session lands in "today" for every
  // range the UI offers, whatever time the suite runs at.
  const start = startedAt || Date.now() - 2 * 3_600_000;
  const lines = [];
  if (title) lines.push(JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: id }));
  for (let i = 0; i < messages; i++) {
    const isUser = i % 2 === 0;
    lines.push(
      JSON.stringify({
        type: isUser ? 'user' : 'assistant',
        timestamp: new Date(start + i * 5 * 60_000).toISOString(),
        cwd,
        sessionId: id,
        message: isUser
          ? { role: 'user', content: 'Please continue.' }
          : {
              model,
              usage: {
                input_tokens: 1_200,
                output_tokens: 800,
                cache_creation_input_tokens: 2_000,
                cache_read_input_tokens: 40_000,
              },
            },
      })
    );
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

/**
 * Write a `stats-cache.json` the way Claude Code's `/usage` does.
 *
 * Defaults are a plausible v4 file; overrides let a test supply a bad version or
 * a specific model mix. `costUSD: 0` is not an oversight — that is what the real
 * file contains on a subscription plan, and the reason Lifeline prices tokens
 * itself.
 */
function writeClaudeStats(sandbox, overrides = {}) {
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const yesterday = new Date(today.getTime() - 86_400_000);

  const stats = {
    version: 4,
    lastComputedDate: iso(today),
    firstSessionDate: new Date(today.getTime() - 30 * 86_400_000).toISOString(),
    totalSessions: 12,
    totalMessages: 480,
    modelUsage: {
      'claude-opus-4-8': {
        inputTokens: 1_000_000,
        outputTokens: 2_000_000,
        cacheCreationInputTokens: 3_000_000,
        cacheReadInputTokens: 500_000_000,
        costUSD: 0,
      },
    },
    dailyActivity: [
      { date: iso(yesterday), messageCount: 120, sessionCount: 3, toolCallCount: 40 },
      { date: iso(today), messageCount: 360, sessionCount: 9, toolCallCount: 110 },
    ],
    dailyModelTokens: [
      { date: iso(yesterday), tokensByModel: { 'claude-opus-4-8': 120_000 } },
      { date: iso(today), tokensByModel: { 'claude-opus-4-8': 380_000 } },
    ],
    hourCounts: { 9: 4, 10: 6, 14: 2 },
    longestSession: {
      sessionId: 'longest-one',
      duration: 7_200_000,
      messageCount: 88,
      timestamp: new Date(today.getTime() - 3 * 86_400_000).toISOString(),
    },
    ...overrides,
  };

  fs.mkdirSync(sandbox.claudeHome, { recursive: true });
  fs.writeFileSync(path.join(sandbox.claudeHome, 'stats-cache.json'), JSON.stringify(stats), 'utf8');
  return stats;
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
    // --user-data-dir is not optional here. The app takes a single-instance lock,
    // and that lock is keyed on Electron's userData directory — so without this,
    // a test launch loses the race against the user's real tray instance (or a
    // leftover from an earlier run) and exits before the window ever opens, which
    // shows up as "Target page, context or browser has been closed" in every
    // single test rather than as the collision it actually is.
    args: [`--user-data-dir=${path.join(sandbox.root, 'electron')}`, REPO_ROOT],
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
  writeTranscript,
  writeClaudeStats,
  readConfig,
  savedValue,
  readClaudeSettings,
  launch,
  close,
};
