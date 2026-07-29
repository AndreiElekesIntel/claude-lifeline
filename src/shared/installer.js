'use strict';
/**
 * Installs and removes Lifeline's hooks in Claude Code's user settings.
 *
 * This edits a file the user relies on, so the rules are strict:
 *   - Back up settings.json before the first write.
 *   - Merge, never replace: existing hooks are preserved exactly.
 *   - Tag our entries with a marker so uninstall removes only ours.
 *   - Write atomically, so an interrupted save cannot truncate settings.
 */

const fs = require('fs');
const path = require('path');
const { claudeSettingsFile, claudeHome, hookEntry, lifelineHome } = require('./paths');

/** Marker that identifies a Lifeline-owned hook entry. */
const MARKER = 'claude-lifeline';

/**
 * Events Lifeline registers, with the flags each one needs.
 *
 * `entry` is overridable so recovery can be pointed at a frozen snapshot instead
 * of the live source tree (see `cli.mjs pin`). Editing the tree that
 * settings.json points at means a failure arriving mid-save runs a half-written
 * file — fine for a released install, not while developing.
 */
function hookSpecs({ entry: entryOverride } = {}) {
  const entry = entryOverride || hookEntry();
  const cmd = `node "${entry}"`;
  return [
    {
      event: 'StopFailure',
      // asyncRewake is the mechanism: exit 2 injects stderr and wakes the model.
      hook: {
        type: 'command',
        command: cmd,
        shell: 'bash',
        timeout: 600,
        asyncRewake: true,
        rewakeMessage: '[Claude Lifeline] Session recovered after an API failure.',
        rewakeSummary: 'Claude Lifeline resumed this session',
        _source: MARKER,
      },
    },
    {
      event: 'Stop',
      hook: {
        type: 'command',
        command: cmd,
        shell: 'bash',
        timeout: 30,
        asyncRewake: true,
        rewakeMessage: '[Claude Lifeline] Background work still pending.',
        rewakeSummary: 'Claude Lifeline flagged pending background work',
        _source: MARKER,
      },
    },
    {
      event: 'PostToolUseFailure',
      hook: {
        type: 'command',
        command: cmd,
        shell: 'bash',
        timeout: 30,
        asyncRewake: true,
        rewakeMessage: '[Claude Lifeline] A tool call did not complete.',
        rewakeSummary: 'Claude Lifeline flagged a tool failure',
        _source: MARKER,
      },
    },
  ];
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(claudeSettingsFile(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    // A malformed settings.json must stop the install: overwriting it would
    // destroy configuration we cannot reconstruct.
    throw new Error(`Cannot parse ${claudeSettingsFile()} — fix or move it before installing: ${err.message}`);
  }
}

function writeSettings(settings) {
  const file = claudeSettingsFile();
  fs.mkdirSync(claudeHome(), { recursive: true });
  const tmp = path.join(claudeHome(), `.settings.lifeline.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Timestamped backup kept in Lifeline's own directory. */
function backupSettings() {
  const file = claudeSettingsFile();
  if (!fs.existsSync(file)) return null;
  const dir = path.join(lifelineHome(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `settings.${stamp}.json`);
  fs.copyFileSync(file, dest);
  return dest;
}

const isOurs = (h) => !!h && (h._source === MARKER || (typeof h.command === 'string' && h.command.includes('lifeline-hook')));

function install({ hookEntry: entry } = {}) {
  const backup = backupSettings();
  const settings = readSettings();
  settings.hooks = settings.hooks || {};

  const installed = [];
  for (const spec of hookSpecs({ entry })) {
    const list = Array.isArray(settings.hooks[spec.event]) ? settings.hooks[spec.event] : [];

    // Drop any previous Lifeline entry so re-installing upgrades in place
    // instead of stacking duplicates.
    const cleaned = list
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((group) => (group.hooks || []).length > 0);

    // Reuse a match-all group if one exists; otherwise add ours.
    const target = cleaned.find((g) => !g.matcher || g.matcher === '');
    if (target) target.hooks.push(spec.hook);
    else cleaned.push({ matcher: '', hooks: [spec.hook] });

    settings.hooks[spec.event] = cleaned;
    installed.push(spec.event);
  }

  writeSettings(settings);
  return { ok: true, backup, installed, settingsFile: claudeSettingsFile() };
}

function uninstall() {
  const file = claudeSettingsFile();
  if (!fs.existsSync(file)) return { ok: true, removed: [], detail: 'No settings.json found.' };

  const backup = backupSettings();
  const settings = readSettings();
  const removed = [];

  for (const event of Object.keys(settings.hooks || {})) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) continue;
    const before = JSON.stringify(list);
    const cleaned = list
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((group) => (group.hooks || []).length > 0);
    if (cleaned.length) settings.hooks[event] = cleaned;
    else delete settings.hooks[event];
    if (before !== JSON.stringify(settings.hooks[event] || [])) removed.push(event);
  }

  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(settings);
  return { ok: true, backup, removed, settingsFile: file };
}

/** Which of our hooks are currently registered. */
function status() {
  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    return { installed: false, error: err.message, events: [] };
  }
  const events = [];
  for (const [event, list] of Object.entries((settings && settings.hooks) || {})) {
    if (!Array.isArray(list)) continue;
    for (const group of list) {
      if ((group.hooks || []).some(isOurs)) events.push(event);
    }
  }
  const wanted = hookSpecs().map((s) => s.event);
  return {
    installed: events.length > 0,
    complete: wanted.every((w) => events.includes(w)),
    events: [...new Set(events)],
    expected: wanted,
    settingsFile: claudeSettingsFile(),
  };
}

module.exports = { install, uninstall, status, hookSpecs, backupSettings, MARKER };
