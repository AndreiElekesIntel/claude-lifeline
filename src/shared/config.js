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
const { SCHEMA_VERSION, migrateConfig } = require('./migrate');

const DEFAULTS = {
  /**
   * Schema version, owned by migrate.js. A config written by an older Lifeline is
   * upgraded on load rather than replaced, so settings survive a v2 or v3.
   */
  version: SCHEMA_VERSION,

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

  analytics: {
    /** Read transcripts to report time, tokens, and estimated cost. */
    enabled: true,
    /**
     * Per-model rate overrides, USD per million tokens, shaped like pricing.js's
     * table. Editable because published prices change and subscription plans do
     * not bill per token at all — a hardcoded table would drift with no recourse.
     */
    rates: {},
    /** Currency symbol shown next to estimated cost. Display only. */
    currencySymbol: '$',
  },

  /** Per-error-class overrides on top of policy.js. */
  policies: {},

  /**
   * Hook installation into Claude Code's settings.json.
   *
   * On by default: Lifeline cannot recover anything without its hooks registered,
   * so an app that sits there asking to be set up is an app that silently does
   * nothing. The install is idempotent, backs up settings.json first, and merges
   * rather than replaces (see installer.js).
   */
  hooks: {
    /** Register missing hooks at startup instead of waiting to be asked. */
    autoInstall: true,
    /**
     * Set when the user removes the hooks themselves.
     *
     * Without this, auto-install and a deliberate uninstall would fight each
     * other on every launch. An explicit removal is a decision, and it outranks
     * the default.
     */
    optedOut: false,
  },

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

/**
 * Load config, upgrading an older file on the way in.
 *
 * The migration is applied to the parsed file *before* the defaults merge, so a
 * step that renames a key sees the old name rather than a default that has
 * already filled in the new one. Layering over the defaults afterwards means
 * unknown keys — including ones a newer Lifeline wrote — are preserved instead of
 * dropped, which is what makes a downgrade non-destructive.
 *
 * `loadConfig.lastMigration` records what happened, for the app to log once at
 * startup. Deliberately not a callback or an event: this runs in the hook's hot
 * path on every failure, and it must stay a synchronous read with no side effects
 * beyond the one-off backup that migrateConfig takes.
 */
function loadConfig() {
  const file = configFile();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = migrateConfig(raw);
    loadConfig.lastMigration = result.migrated || result.newer ? result : null;
    return deepMerge(defaultConfig(), result.config);
  } catch {
    // Missing or corrupt: defaults keep recovery working.
    loadConfig.lastMigration = null;
    return defaultConfig();
  }
}

/** Set by the most recent loadConfig() call; null when nothing notable happened. */
loadConfig.lastMigration = null;

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
