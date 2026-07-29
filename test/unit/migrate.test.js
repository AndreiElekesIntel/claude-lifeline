'use strict';
/**
 * The upgrade path.
 *
 * These tests are the contract a future v2 or v3 has to keep: an old config is
 * carried forward rather than reset, a config from a newer version is left alone
 * rather than mangled, and in every case the user's settings survive.
 *
 * The chain is exercised with injected steps and an explicit `to` target: the
 * real MIGRATIONS table is empty at v1, and machinery that has never run is
 * machinery nobody should trust on the day it finally matters.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-migrate-'));
process.env.LIFELINE_HOME = path.join(scratch, 'lifeline');
process.env.CLAUDE_CONFIG_DIR = path.join(scratch, 'claude');

const migrate = require('../../src/shared/migrate');
const { loadConfig, saveConfig, defaultConfig, deepMerge } = require('../../src/shared/config');
const { configFile, lifelineHome } = require('../../src/shared/paths');

function reset() {
  fs.rmSync(lifelineHome(), { recursive: true, force: true });
  fs.mkdirSync(lifelineHome(), { recursive: true });
  for (const k of Object.keys(migrate.MIGRATIONS)) delete migrate.MIGRATIONS[k];
}

function writeRaw(obj) {
  fs.mkdirSync(lifelineHome(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(obj, null, 2), 'utf8');
}

/* ----------------------------- versionOf -------------------------------- */

test('a config with no version is treated as the first shipped shape', () => {
  // Not as "brand new": an unversioned file is one written before versioning,
  // and assuming it is current would skip every migration it needs.
  assert.equal(migrate.versionOf({}), 1);
  assert.equal(migrate.versionOf(null), 1);
  assert.equal(migrate.versionOf({ version: 'two' }), 1);
  assert.equal(migrate.versionOf({ version: 0 }), 1);
  assert.equal(migrate.versionOf({ version: 3 }), 3);
});

/* ------------------------------ no-op case ------------------------------ */

test('a current config is returned untouched and no backup is written', () => {
  reset();
  const r = migrate.migrateConfig({ version: migrate.SCHEMA_VERSION, enabled: false });
  assert.equal(r.migrated, false);
  assert.equal(r.newer, false);
  assert.equal(r.backup, null);
  assert.equal(r.config.enabled, false);
  assert.deepEqual(fs.readdirSync(lifelineHome()).filter((f) => f.includes('.bak')), []);
});

/* ------------------------------ upgrading ------------------------------- */

test('an old config is walked forward one step at a time', () => {
  reset();
  const seen = [];
  migrate.MIGRATIONS[1] = (cfg) => {
    seen.push(cfg.version ?? 1);
    cfg.addedInV2 = true;
    return cfg;
  };
  migrate.MIGRATIONS[2] = (cfg) => {
    seen.push(cfg.version);
    // Proves the ordering: v2's field is already there when 2→3 runs.
    cfg.sawV2 = cfg.addedInV2 === true;
    return cfg;
  };

  const r = migrate.migrateConfig({ version: 1, enabled: false }, { backup: false, to: 3 });
  assert.deepEqual(seen, [1, 2], 'each step reads the version it was written for');
  assert.deepEqual(r.steps, [1, 2]);
  assert.equal(r.config.version, 3);
  assert.equal(r.config.sawV2, true);
  assert.equal(r.config.enabled, false, 'and the user\'s own settings come along');
  assert.equal(r.migrated, true);
});

test('a step that renames a key can read the old name, because migration runs before defaults', () => {
  reset();
  migrate.MIGRATIONS[1] = (cfg) => {
    cfg.limits = cfg.limits || {};
    cfg.limits.maxAttemptsPerTurn = cfg.limits.maxAttemptsPerPrompt;
    delete cfg.limits.maxAttemptsPerPrompt;
    return cfg;
  };
  const r = migrate.migrateConfig({ version: 1, limits: { maxAttemptsPerPrompt: 9 } }, { backup: false, to: 2 });
  assert.equal(r.config.limits.maxAttemptsPerTurn, 9, 'the value moved rather than being lost to a default');
  assert.equal(r.config.limits.maxAttemptsPerPrompt, undefined);
});

test('a missing step in the chain does not strand the app', () => {
  reset();
  // Only 2→3 is registered; 1→2 is absent, which is a packaging mistake rather
  // than the user's problem. It must still end up at the current version.
  migrate.MIGRATIONS[2] = (cfg) => ({ ...cfg, ranStepTwo: true });
  const r = migrate.migrateConfig({ version: 1, enabled: false }, { backup: false, to: 3 });
  assert.equal(r.config.version, 3);
  assert.deepEqual(r.steps, [2]);
  assert.equal(r.config.enabled, false);
});

test('a step that returns nothing leaves the config intact', () => {
  reset();
  migrate.MIGRATIONS[1] = (cfg) => {
    cfg.mutatedInPlace = true;
    // No return — a plausible slip, and it must not blank the config.
  };
  const r = migrate.migrateConfig({ version: 1, enabled: false }, { backup: false, to: 2 });
  assert.equal(r.config.mutatedInPlace, true);
  assert.equal(r.config.enabled, false);
  assert.equal(r.config.version, 2);
});

/* ------------------------------- backups -------------------------------- */

test('upgrading keeps a copy of the file it replaced', () => {
  reset();
  writeRaw({ version: 1, enabled: false, ui: { accent: 'amber' } });
  migrate.MIGRATIONS[1] = (cfg) => cfg;

  const r = migrate.migrateConfig(JSON.parse(fs.readFileSync(configFile(), 'utf8')), { to: 2 });
  assert.ok(r.backup, 'the path is reported so the log can name it');
  const kept = JSON.parse(fs.readFileSync(r.backup, 'utf8'));
  assert.equal(kept.version, 1, 'the backup predates the migration');
  assert.equal(kept.ui.accent, 'amber');
});

test('an existing backup is never overwritten', () => {
  reset();
  writeRaw({ version: 1, enabled: false });
  const first = migrate.backupConfig(1);
  writeRaw({ version: 1, enabled: true });
  const second = migrate.backupConfig(1);
  assert.equal(first, second);
  // The point of a backup is that it predates the change; a second launch must
  // not replace it with an already-migrated copy.
  assert.equal(JSON.parse(fs.readFileSync(first, 'utf8')).enabled, false);
});

test('a failed backup does not block the upgrade', () => {
  reset();
  // No config.json on disk at all, so copyFileSync throws.
  migrate.MIGRATIONS[1] = (cfg) => ({ ...cfg, upgraded: true });
  const r = migrate.migrateConfig({ version: 1 }, { to: 2 });
  assert.equal(r.backup, null);
  assert.equal(r.migrated, true, 'the migration is what the user needs; the backup is a courtesy');
  assert.equal(r.config.upgraded, true);
});

/* --------------------------- from the future ---------------------------- */

test('a config from a newer version is left exactly as written', () => {
  reset();
  const future = { version: 99, enabled: false, somethingNew: { deep: 1 } };
  const r = migrate.migrateConfig(future);
  assert.equal(r.newer, true);
  assert.equal(r.migrated, false);
  // Stamping it down to the current version would make the newer app think an
  // unmigrated file had already been migrated.
  assert.equal(r.config.version, 99);
  assert.deepEqual(r.config.somethingNew, { deep: 1 });
  assert.equal(r.backup, null, 'nothing was changed, so there is nothing to back up');
});

/* --------------------- integration through loadConfig ------------------- */

test('loadConfig upgrades on the way in and reports what it did', () => {
  reset();
  writeRaw({ version: 1, enabled: false, ui: { accent: 'amber' } });
  const cfg = loadConfig();
  assert.equal(cfg.enabled, false, 'user settings survive');
  assert.equal(cfg.ui.accent, 'amber');
  assert.equal(cfg.version, migrate.SCHEMA_VERSION);
  // At v1 there is nothing to migrate, so nothing is reported. The field exists
  // either way, which is what main.js reads.
  assert.equal(loadConfig.lastMigration, null);
});

test('a config from a newer version is flagged rather than silently accepted', () => {
  reset();
  writeRaw({ version: 99, enabled: false, futureSetting: 'keep me' });
  const cfg = loadConfig();
  assert.ok(loadConfig.lastMigration);
  assert.equal(loadConfig.lastMigration.newer, true);
  assert.equal(cfg.futureSetting, 'keep me', 'unknown keys survive, so a downgrade is not destructive');
  assert.equal(cfg.enabled, false);
});

test('unknown keys survive a save, so downgrading loses nothing', () => {
  reset();
  writeRaw({ version: 1, enabled: true, someV2Feature: { nested: true } });
  // Exactly what the app does on every settings change: load, merge, write back.
  saveConfig(loadConfig());
  const onDisk = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  assert.deepEqual(onDisk.someV2Feature, { nested: true });
  // And the defaults are all present alongside it.
  assert.equal(onDisk.limits.maxAttemptsPerPrompt, defaultConfig().limits.maxAttemptsPerPrompt);
});

test('a corrupt config falls back to defaults and reports no migration', () => {
  reset();
  fs.writeFileSync(configFile(), '{ not json', 'utf8');
  const cfg = loadConfig();
  assert.equal(cfg.enabled, true, 'defaults keep recovery working');
  assert.equal(loadConfig.lastMigration, null, 'a parse failure is not an upgrade');
});

/* ---------------------- the other three data files ---------------------- */

test('the ledger validates field by field, so any shape is survivable', () => {
  reset();
  const { ledgerFile } = require('../../src/shared/paths');
  const ledger = require('../../src/shared/ledger');
  // A future version might store attempts as an object; reading that as an array
  // must degrade to empty rather than throw in the hook's hot path.
  fs.writeFileSync(ledgerFile(), JSON.stringify({ version: 7, attempts: { a: 1 }, sessions: null }), 'utf8');
  const read = ledger.readLedger();
  assert.deepEqual(read.attempts, []);
  assert.deepEqual(read.sessions, {});
});

test('an event log line with an unknown kind is still readable', () => {
  reset();
  const { eventLogFile } = require('../../src/shared/paths');
  const eventlog = require('../../src/shared/eventlog');
  fs.writeFileSync(
    eventLogFile(),
    `${JSON.stringify({ at: 1, kind: 'invented-in-v3', detail: 'x' })}\n${JSON.stringify({ at: 2, kind: 'info' })}\n`,
    'utf8'
  );
  const events = eventlog.read(10);
  assert.equal(events.length, 2, 'history belongs to the user and must stay readable by every version');
  assert.equal(events[1].kind, 'invented-in-v3');
});

/* -------------------------- deepMerge semantics -------------------------- */

/**
 * These pin down what a config *patch* can and cannot express.
 *
 * The asymmetry is deliberate and was learned the hard way: because a patch is
 * merged, `{analytics: {rates: {}}}` cannot mean "remove every rate" — it means
 * "change nothing", and a reset button built on it silently did nothing. Any
 * setting that needs clearing gets its own IPC channel (see `reset-rates`), and
 * these tests are here so the next person reaches for that instead.
 */
test('an object patch cannot delete keys, so a reset needs its own channel', () => {
  const base = { analytics: { rates: { 'claude-opus-5': { input: 5 } }, enabled: true } };
  const merged = deepMerge(base, { analytics: { rates: {} } });
  assert.deepEqual(
    merged.analytics.rates,
    { 'claude-opus-5': { input: 5 } },
    'an empty object means "no changes", never "remove everything"'
  );
});

test('an array patch replaces wholesale, so a list can be emptied', () => {
  // The other half of the rule, and why the project allow/deny lists are fine to
  // save as plain patches: arrays are overwritten rather than recursed into.
  const base = { advanced: { projectDenylist: ['C:/secret'] } };
  assert.deepEqual(deepMerge(base, { advanced: { projectDenylist: [] } }).advanced.projectDenylist, []);
  assert.deepEqual(deepMerge(base, { advanced: { projectDenylist: ['a', 'b'] } }).advanced.projectDenylist, ['a', 'b']);
});

test('a partial patch leaves untouched siblings exactly as they were', () => {
  // The property the merge exists for: the UI sends only what changed, and must
  // never blank out a setting it did not know about.
  const base = defaultConfig();
  const merged = deepMerge(base, { limits: { maxAttemptsPerPrompt: 9 } });
  assert.equal(merged.limits.maxAttemptsPerPrompt, 9);
  assert.equal(merged.limits.maxAttemptsPerHour, base.limits.maxAttemptsPerHour);
  assert.equal(merged.features.apiErrorRecovery, base.features.apiErrorRecovery);
  assert.equal(merged.enabled, base.enabled);
});

test('undefined in a patch is ignored rather than blanking a value', () => {
  // JSON.stringify drops undefined, but an in-process patch can carry it, and
  // "field absent from the form" must not read as "set it to nothing".
  const merged = deepMerge({ ui: { accent: 'violet' } }, { ui: { accent: undefined } });
  assert.equal(merged.ui.accent, 'violet');
});
