'use strict';
/**
 * Config load/save with a schema-checked merge.
 *
 * Read by the hook on every fire, so it stays synchronous and dependency-free.
 * A corrupt or partial file must never break recovery: unreadable config falls
 * back to defaults rather than throwing, because a broken config file is not a
 * reason to stop rescuing sessions.
 */

const fs = require('fs');
const path = require('path');
const { configFile, lifelineHome } = require('./paths');
const { ERROR_CLASSES, POLICIES } = require('./policy');

const DEFAULTS = {
  version: 1,

  /** Master switch. Off means the hook exits 0 and does nothing. */
  enabled: true,

  /** Feature toggles, surfaced one-to-one in the config UI. */
  features: {
    /** Resume after a turn-ending API error. The core feature. */
    apiErrorRecovery: true,
    /** Ask for a /compact when the failure was context overflow. */
    contextOverflowRecovery: true,
    /** Nudge the model when a tool call fails or times out. */
    toolFailureRecovery: false,
    /** Resume when a turn ends while background tasks are still in flight. */
    backgroundTaskRecovery: true,
    /** Flag sessions that sat idle far longer than expected. */
    stalledSessionDetection: true,
    /** Watch for CLI processes that vanished without ending cleanly. */
    deadSessionDetection: true,
    /** Relaunch a dead session with --resume. Off by default: it starts processes. */
    deadSessionRelaunch: false,
    /** Windows toast on every recovery. */
    desktopNotifications: true,
    /** Sound on recovery. */
    soundAlerts: false,
    /** Never auto-resume classes a retry cannot fix (auth, billing, ...). */
    respectNonRetryable: true,
  },

  limits: {
    /** Resume attempts for one prompt before giving up. Stops retry loops. */
    maxAttemptsPerPrompt: 5,
    /** Resume attempts per session per rolling hour. */
    maxAttemptsPerHour: 20,
    /** Resumes machine-wide per day — the backstop against runaway spend. */
    maxAttemptsPerDay: 100,
    /** Ignore a repeat failure that lands within this window (ms). */
    cooldownMs: 5_000,
    /** Cap on backoff after exponential growth (ms). */
    maxBackoffMs: 300_000,
    /** Idle time before a session counts as stalled (ms). */
    stalledAfterMs: 900_000,
  },

  ui: {
    /** 'system' | 'dark' | 'light' */
    theme: 'system',
    accent: 'violet',
    startMinimised: true,
    showInTray: true,
  },

  /** Per-error-class overrides on top of policy.js. */
  policies: {},

  advanced: {
    /** Keep this many events in events.jsonl. */
    eventLogLimit: 2000,
    /** Verbose hook logging to hook.log. */
    debugLogging: false,
    /** Only recover sessions whose cwd starts with one of these. Empty = all. */
    projectAllowlist: [],
    /** Never recover sessions whose cwd starts with one of these. */
    projectDenylist: [],
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** Defaults with every known error class present, so the UI can render them all. */
function defaultConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.policies = {};
  for (const cls of ERROR_CLASSES) {
    const p = POLICIES[cls];
    cfg.policies[cls] = {
      resume: p.resume,
      backoffMs: p.backoffMs,
      maxAttempts: p.maxAttempts,
    };
  }
  return cfg;
}

function loadConfig() {
  const file = configFile();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return deepMerge(defaultConfig(), JSON.parse(raw));
  } catch {
    // Missing or corrupt: defaults keep recovery working.
    return defaultConfig();
  }
}

/** Atomic write — a crash mid-save must not leave a truncated config. */
function saveConfig(cfg) {
  const dir = lifelineHome();
  fs.mkdirSync(dir, { recursive: true });
  const file = configFile();
  const tmp = path.join(dir, `.config.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return cfg;
}

/** True when `cwd` passes the allow/deny lists. Deny wins over allow. */
function projectAllowed(cwd, cfg) {
  const adv = (cfg && cfg.advanced) || {};
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const target = norm(cwd);
  const deny = adv.projectDenylist || [];
  const allow = adv.projectAllowlist || [];
  if (deny.some((d) => target.startsWith(norm(d)))) return false;
  if (allow.length === 0) return true;
  return allow.some((a) => target.startsWith(norm(a)));
}

module.exports = { DEFAULTS, defaultConfig, loadConfig, saveConfig, deepMerge, projectAllowed };
