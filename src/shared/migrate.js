'use strict';
/**
 * Carrying data forward across major versions.
 *
 * Lifeline keeps four files under %APPDATA%\claude-lifeline, and a v2 or v3 of
 * this app has to be able to open all of them. The rules below are the contract;
 * they exist because the alternative — "bump a version constant and start over" —
 * silently throws away someone's history and settings on upgrade day.
 *
 * ## config.json — migrated, never reset
 *
 * Carries `version`. On load, a file older than SCHEMA_VERSION is walked forward
 * through MIGRATIONS one step at a time, and a timestamped `.bak` copy is left
 * behind first, so a bad migration is recoverable rather than terminal.
 *
 * Three properties make this work in both directions:
 *
 *   1. **Unknown keys survive.** deepMerge layers the file over the defaults and
 *      keeps anything it does not recognise, and saveConfig writes the merged
 *      result. So a v1 app opening a v2 config preserves the v2 keys instead of
 *      stripping them, and downgrading is not a data-loss event.
 *   2. **A newer file is never migrated.** There is no downgrade path — v1 cannot
 *      know what v2 meant — so a future `version` is left exactly as written and
 *      flagged, not rewritten to look like the current shape.
 *   3. **Additive changes need no migration at all.** A new setting with a default
 *      appears automatically. A migration is only required when a key *moves*,
 *      is *renamed*, or *changes meaning* — those are the cases where reading the
 *      old value as if it were the new one would be wrong.
 *
 * ## ledger.json — versioned, disposable
 *
 * The loop guard, pruned to 48 hours. Nothing reads past 24h, so a future version
 * that cannot understand it may safely start fresh: the only consequence is that
 * the next few resumes are budgeted from zero. It carries `version` so a reader
 * can tell, and readLedger already tolerates any shape by validating field by
 * field.
 *
 * ## analytics-cache.json — derived, safe to delete
 *
 * Per-transcript totals keyed by (size, mtime). Purely a speed optimisation over
 * the transcripts, which are the real source and belong to Claude Code, not to
 * Lifeline. A CACHE_VERSION bump discards it deliberately: recomputing costs one
 * slow scan, whereas misreading a stale entry produces wrong numbers forever.
 * This is the one file where a hard reset is the correct behaviour.
 *
 * ## events.jsonl — append-only, forward-compatible by shape
 *
 * One JSON object per line, every one carrying `at` and `kind`. New event kinds
 * and new fields are additive by construction, and a reader that meets a `kind`
 * it does not know must render it generically rather than drop the line — the
 * log is the user's own history and must stay readable by every version.
 */

const fs = require('fs');
const path = require('path');

const { configFile, lifelineHome } = require('./paths');

/**
 * Current config schema version.
 *
 * Bump this **only** alongside an entry in MIGRATIONS. A bump with no migration
 * means older files are stamped as current without their contents being adjusted,
 * which is exactly the silent-misread this module exists to prevent.
 */
const SCHEMA_VERSION = 1;

/**
 * One entry per upgrade step, keyed by the version it reads.
 *
 * `MIGRATIONS[n]` takes a version-n config and returns a version-(n+1) one. Steps
 * are applied in sequence, so a v1 file on a v3 app runs 1→2 then 2→3 and no step
 * ever has to know about more than its own neighbour.
 *
 * Each function must be pure and total: it gets whatever was on disk, including
 * a partially-hand-edited file, and has to return something usable rather than
 * throw. Mutating the input is fine — it is already a private copy.
 *
 * Example of the shape a real step takes:
 *
 *     MIGRATIONS[1] = (cfg) => {
 *       // v2 split one switch into two; the old value seeds both so behaviour
 *       // is unchanged on upgrade.
 *       if (cfg.features && cfg.features.apiErrorRecovery !== undefined) {
 *         cfg.features.rateLimitRecovery ??= cfg.features.apiErrorRecovery;
 *       }
 *       return cfg;
 *     };
 */
const MIGRATIONS = {};

/** The version a file claims. Absent means the first shipped shape, not "new". */
function versionOf(raw) {
  const v = raw && Number(raw.version);
  return Number.isInteger(v) && v > 0 ? v : 1;
}

/**
 * Keep a copy of the file about to be upgraded.
 *
 * Named after the version it holds rather than timestamped, so repeated launches
 * cannot fill the folder, and never overwritten: the value of a backup is that it
 * predates the migration that might have broken something.
 */
function backupConfig(fromVersion) {
  try {
    const src = configFile();
    const dest = path.join(lifelineHome(), `config.v${fromVersion}.bak.json`);
    if (fs.existsSync(dest)) return dest;
    fs.copyFileSync(src, dest);
    return dest;
  } catch {
    // A missing backup is not a reason to refuse the upgrade — the migration
    // itself is the thing the user needs.
    return null;
  }
}

/**
 * Walk a raw config forward to `to`, which defaults to SCHEMA_VERSION.
 *
 * Returns the config alongside what happened, so callers can log an upgrade and
 * warn about a file from the future instead of guessing.
 *
 * `to` is an explicit argument rather than the constant read directly, so the
 * chain can be exercised at a target this version has not shipped yet. Proving
 * the machinery before there is a real step to run is the whole point of having
 * it at v1.
 *
 * @returns {{config: object, from: number, to: number, migrated: boolean, newer: boolean, backup: string|null, steps: number[]}}
 */
function migrateConfig(raw, { backup = true, to = SCHEMA_VERSION } = {}) {
  const from = versionOf(raw);
  const config = raw && typeof raw === 'object' ? { ...raw } : {};

  // From the future: keep it verbatim. Rewriting `version` down would make the
  // next run of the newer app treat an unmigrated file as already migrated.
  if (from > to) {
    return { config, from, to: from, migrated: false, newer: true, backup: null, steps: [] };
  }

  if (from === to) {
    config.version = to;
    return { config, from, to, migrated: false, newer: false, backup: null, steps: [] };
  }

  const saved = backup ? backupConfig(from) : null;
  const steps = [];
  let cur = config;
  for (let v = from; v < to; v++) {
    const step = MIGRATIONS[v];
    // A gap in the chain is a packaging mistake, not user data being wrong. Stamp
    // the version and move on: the defaults merge will fill anything missing, and
    // stopping here would leave the app unusable.
    if (typeof step === 'function') {
      cur = step(cur) || cur;
      steps.push(v);
    }
    cur.version = v + 1;
  }
  cur.version = to;

  return { config: cur, from, to, migrated: true, newer: false, backup: saved, steps };
}

module.exports = { SCHEMA_VERSION, MIGRATIONS, versionOf, migrateConfig, backupConfig };
