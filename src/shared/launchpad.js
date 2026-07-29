'use strict';
/**
 * Launchpad presets: saved session configurations, and desktop shortcuts to them.
 *
 * A preset is everything needed to start a session without typing anything — a
 * working directory, a model, a permission mode, some skills, and a pre-prompt.
 * launcher.js already knows how to turn that into a running `claude`; this file
 * owns the *storage* side: validating what the renderer sends before it reaches
 * config, and writing a real `.lnk` when the user wants one on the desktop.
 *
 * ## Why presets are validated rather than trusted
 *
 * They arrive from the renderer and end up on a command line, in a filename, and
 * in a shortcut the user will double-click months later with no memory of what it
 * does. Anything malformed that survives into config is a button that fails at the
 * one moment it is needed. So a preset is normalised on the way in — unknown
 * fields dropped, strings clipped, the id checked — and a bad one is rejected with
 * a reason rather than stored and left to break later.
 *
 * ## Why the desktop shortcut is a `.lnk` and not a `.bat`
 *
 * A `.bat` on the desktop would work, but it looks like a script, cannot carry an
 * icon, and flashes a console before whatever it starts. A `.lnk` is what "add to
 * desktop" means on Windows: an icon, a name, a tooltip.
 *
 * Windows has no API for writing one without COM, so it goes through
 * `WScript.Shell` in PowerShell. The interesting part is *how* the values reach
 * PowerShell, because the first attempt at this failed:
 *
 *   - **`powershell -Command` mangles backslashes.** Passing the assignments as a
 *     command string turned `C:\Users\...` into `C:\\Users\\...` and the shortcut
 *     was never created. Measured, not guessed.
 *   - **So the assignments are written to a `.ps1` file instead**, and every value
 *     is a *single-quoted* PowerShell literal. Single quotes are the one PowerShell
 *     string form with no escapes and no variable expansion: `$(...)`, backticks
 *     and backslashes are all literal inside them, and the only character needing
 *     care is `'` itself, which doubles. That makes a label of
 *     `'; Remove-Item C:\ -Recurse; '` a label, not a command.
 *
 * The `.ps1` is written with a BOM, because PowerShell 5 reads a BOM-less file as
 * the system codepage and would corrupt a label containing an em dash.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { PERMISSION_MODES, SKILL_RE } = require('./launcher');

/** Longest label accepted. It has to fit under a desktop icon and in a button. */
const MAX_LABEL = 60;
/** A pre-prompt is prose, and can be long. Capped so config stays a small file. */
const MAX_PROMPT = 4000;
/** More than this and the grid stops being a grid. Not a technical limit. */
const MAX_PRESETS = 60;

/**
 * Preset ids are generated here, never accepted from the renderer as-is.
 *
 * The id names a preset in a `.lnk` argument and in a keyboard shortcut binding,
 * so it must be filename-safe and stable across renames.
 */
const ID_RE = /^[a-z0-9]{6,32}$/;

/**
 * A fresh id from a counter and a source of entropy the caller provides.
 *
 * `now` and `seed` are parameters rather than reads of `Date.now()` and
 * `Math.random()` so the id is deterministic under test — two presets created in
 * the same millisecond must still differ, and a test that cannot control that
 * cannot check it.
 */
function newId(now = Date.now(), seed = Math.random()) {
  const stamp = Number(now).toString(36).slice(-8);
  const rand = Math.floor(seed * 0xfffff).toString(36).padStart(4, '0').slice(0, 4);
  return `${stamp}${rand}`.replace(/[^a-z0-9]/g, '0').slice(0, 32).padEnd(6, '0');
}

/** One line of text, with control characters removed. See session-rename.js. */
function oneLine(input, max) {
  return String(input == null ? '' : input)
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Normalise a preset from the renderer into the shape stored in config.
 *
 * Returns `{ok, preset}` or `{ok: false, reason}`. Fields are dropped rather than
 * corrected where a correction would be a guess: an unrecognised permission mode
 * becomes *no* mode (the CLI default) rather than a mode the user did not pick.
 *
 * A label is the only required field, and only because a button with no text on it
 * is not usable. Everything else has a sensible absence.
 */
function normalisePreset(input, { now = Date.now(), seed = Math.random() } = {}) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'That is not a preset.' };

  const label = oneLine(input.label, MAX_LABEL);
  if (!label) return { ok: false, reason: 'Give the shortcut a name — it becomes the button text.' };

  // An id from the renderer is accepted only if it is one we could have issued,
  // since editing an existing preset has to keep its id (a desktop shortcut names
  // it). Anything else gets a fresh one rather than an error.
  const id = ID_RE.test(String(input.id || '')) ? String(input.id) : newId(now, seed);

  const skills = [];
  for (const raw of Array.isArray(input.skills) ? input.skills : []) {
    const name = String(raw || '').trim().replace(/^\//, '');
    // Same rule as buildPrompt: a name that is not a slug would become prose in
    // the prompt, which reads as an instruction rather than a skill.
    if (SKILL_RE.test(name) && !skills.includes(name)) skills.push(name);
  }

  const mode = String(input.permissionMode || '').trim();

  const preset = {
    id,
    label,
    /** Absent means "wherever Claude Code would start", which is a valid choice. */
    cwd: oneLine(input.cwd, 400) || null,
    model: oneLine(input.model, 60) || null,
    permissionMode: PERMISSION_MODES.includes(mode) ? mode : null,
    skills,
    /**
     * Not `oneLine`: a pre-prompt is allowed to be several paragraphs, and the
     * whole reason the launcher writes a JSON spec is that a multi-line prompt
     * survives. Only the length is bounded.
     */
    prePrompt: String(input.prePrompt == null ? '' : input.prePrompt).slice(0, MAX_PROMPT),
    /**
     * The two unattended defaults, stored explicitly so a preset keeps behaving
     * the way it did when it was saved even if the default changes. Only an
     * explicit `false` opts out — see claudeArgs().
     */
    skipPermissions: input.skipPermissions !== false,
    strictMcpConfig: input.strictMcpConfig !== false,
    /**
     * An accelerator like 'CommandOrControl+Alt+1', or null.
     *
     * Validated by Electron when it is registered, not here: the list of valid key
     * names belongs to Electron, and a copy of it here would drift. What matters at
     * this layer is that it is a short single line.
     */
    accelerator: oneLine(input.accelerator, 60) || null,
  };

  return { ok: true, preset };
}

/** Every stored preset, normalised. Bad entries are dropped, not thrown over. */
function listPresets(config) {
  const raw = (config && config.launchpad && config.launchpad.presets) || [];
  const out = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    const res = normalisePreset(p, { now: 0, seed: 0 });
    // A stored preset that no longer validates is skipped rather than shown
    // broken: the alternative is a button whose behaviour nobody can predict.
    if (res.ok && !out.some((q) => q.id === res.preset.id)) out.push(res.preset);
  }
  return out.slice(0, MAX_PRESETS);
}

/** Find one by id. Returns null rather than throwing — the caller has a UI. */
function findPreset(config, id) {
  return listPresets(config).find((p) => p.id === String(id || '')) || null;
}

/**
 * Insert or replace a preset, returning the new array.
 *
 * Pure: it takes the current list and returns the next one, leaving the caller to
 * decide whether to save. Position is preserved on an edit, because the grid order
 * is the user's own arrangement and having a rename jump a button to the end would
 * be its own bug.
 */
function upsertPreset(config, input, opts = {}) {
  const res = normalisePreset(input, opts);
  if (!res.ok) return res;

  const presets = listPresets(config);
  const at = presets.findIndex((p) => p.id === res.preset.id);
  if (at >= 0) presets[at] = res.preset;
  else if (presets.length >= MAX_PRESETS) return { ok: false, reason: `That is the ${MAX_PRESETS}-shortcut limit. Delete one first.` };
  else presets.push(res.preset);

  return { ok: true, preset: res.preset, presets };
}

/** Remove by id, returning the new array. Silent when the id is unknown. */
function removePreset(config, id) {
  return listPresets(config).filter((p) => p.id !== String(id || ''));
}

/**
 * Reorder to match a list of ids.
 *
 * Ids not mentioned keep their relative order at the end, so a stale drag from a
 * renderer that has not seen a newly added preset cannot delete it.
 */
function reorderPresets(config, ids) {
  const presets = listPresets(config);
  const wanted = (Array.isArray(ids) ? ids : []).map(String);
  const seen = new Set();
  const out = [];
  for (const id of wanted) {
    const p = presets.find((q) => q.id === id);
    if (p && !seen.has(id)) {
      seen.add(id);
      out.push(p);
    }
  }
  for (const p of presets) if (!seen.has(p.id)) out.push(p);
  return out;
}

/* ========================= desktop shortcuts ========================= */

/** A PowerShell single-quoted literal. The only escape inside one is `''`. */
function psLiteral(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

/**
 * A filename for a shortcut, derived from the label.
 *
 * The characters Windows forbids in a filename are replaced rather than stripped,
 * so `Ship: it` becomes `Ship- it` instead of `Ship it` — closer to what the user
 * typed, and it cannot collapse two different labels into one filename. Trailing
 * dots and spaces go because Windows silently drops them, which would make the
 * file we wrote not the file we can find again.
 */
function shortcutFileName(label) {
  const safe = oneLine(label, MAX_LABEL)
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/, '')
    .trim();
  return `${safe || 'Claude session'}.lnk`;
}

/**
 * Write a `.lnk` on the desktop that launches this preset.
 *
 * `launcher` is passed in rather than required at the top, so this module can be
 * tested without a real launcher and so the caller controls where the launch files
 * are written.
 *
 * The shortcut points at a **committed launcher script**, not at a temporary one.
 * A `.lnk` outlives the app that made it: pointing it at a file in TEMP would
 * produce a desktop icon that works today and fails silently after the next
 * cleanup, which is the worst failure mode available here. So the pair is written
 * into Lifeline's own data directory, keyed by preset id, and rewritten whenever
 * the preset changes.
 */
function writeDesktopShortcut(preset, { desktopDir, launchDir, launcher, iconPath = null, powershell = 'powershell' } = {}) {
  const res = normalisePreset(preset, { now: 0, seed: 0 });
  if (!res.ok) return res;
  const p = res.preset;

  if (!desktopDir) return { ok: false, reason: 'Could not find your Desktop folder.' };
  if (!launchDir || !launcher) return { ok: false, reason: 'Launcher is not available.' };

  let script;
  try {
    fs.mkdirSync(launchDir, { recursive: true });
    // Keyed by id, not by timestamp: a shortcut is long-lived, so editing the
    // preset must update the file the existing icon already points at rather than
    // leaving it running the old configuration.
    ({ script } = launcher.writeLaunchFiles(p, { dir: launchDir, stamp: `preset-${p.id}` }));
  } catch (err) {
    return { ok: false, reason: `Could not write the launch script: ${err.message}` };
  }

  const cmd = launcher.resolveCommand(script);
  /**
   * A `.lnk` has one Arguments *string*, not an argv, so the wt route needs its
   * script path quoted inside it — unlike the spawn path, where the bare form is
   * required. Verified both ways: a `.lnk` with a quoted path inside Arguments
   * launches correctly even when the path contains spaces.
   */
  const args = cmd.via === 'wt' ? `-- cmd /k "${script}"` : `/c start "" cmd /k "${script}"`;

  const lnk = path.join(desktopDir, shortcutFileName(p.label));
  const ps1 = path.join(launchDir, `shortcut-${p.id}.ps1`);

  const lines = [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject WScript.Shell',
    `$lnk = $shell.CreateShortcut(${psLiteral(lnk)})`,
    `$lnk.TargetPath = ${psLiteral(cmd.file)}`,
    `$lnk.Arguments = ${psLiteral(args)}`,
    // Where the *shortcut* starts, which is not where the session starts — the
    // session's cwd is in the JSON spec. A missing directory here makes Windows
    // refuse to launch the shortcut at all, so it falls back to the user profile.
    `$lnk.WorkingDirectory = ${psLiteral(p.cwd && fs.existsSync(p.cwd) ? p.cwd : os.homedir())}`,
    // The tooltip is the one place the preset explains itself on the desktop.
    `$lnk.Description = ${psLiteral(describe(p))}`,
  ];
  if (iconPath) lines.push(`$lnk.IconLocation = ${psLiteral(iconPath)}`);
  lines.push('$lnk.Save()');

  try {
    // BOM first: PowerShell 5 reads a BOM-less file as the system codepage, which
    // corrupts an em dash or an accent in a label.
    fs.writeFileSync(ps1, `\ufeff${lines.join('\r\n')}\r\n`, 'utf8');
    // -File, not -Command: passing these assignments as a command string doubles
    // every backslash and the shortcut is never created. Measured.
    execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'pipe' });
  } catch (err) {
    const detail = String((err && err.stderr) || err.message || '').trim().split('\n')[0];
    return { ok: false, reason: `Windows refused to create the shortcut: ${detail || 'unknown error'}` };
  }

  if (!fs.existsSync(lnk)) return { ok: false, reason: 'The shortcut was not created, and Windows gave no reason.' };
  return { ok: true, lnk, script, via: cmd.via };
}

/**
 * One line describing what a preset does, for the shortcut tooltip.
 *
 * Assembled from what is set rather than from a template with blanks, so a preset
 * with only a directory does not get a tooltip full of "none".
 */
function describe(preset) {
  const bits = [];
  if (preset.cwd) bits.push(path.basename(String(preset.cwd).replace(/[\\/]+$/, '')) || preset.cwd);
  if (preset.model) bits.push(preset.model);
  if (preset.skills && preset.skills.length) bits.push(preset.skills.map((s) => `/${s}`).join(' '));
  if (preset.permissionMode) bits.push(preset.permissionMode);
  const tail = bits.length ? ` — ${bits.join(' · ')}` : '';
  // Windows truncates a Description around 260 characters, so it is clipped here
  // rather than by the shell.
  return `Claude Code: ${preset.label}${tail}`.slice(0, 250);
}

/** Delete a shortcut previously written for this label. */
function removeDesktopShortcut(preset, { desktopDir } = {}) {
  if (!desktopDir) return { ok: false, reason: 'Could not find your Desktop folder.' };
  const lnk = path.join(desktopDir, shortcutFileName(preset && preset.label));
  try {
    fs.unlinkSync(lnk);
    return { ok: true, lnk };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, lnk, missing: true };
    return { ok: false, reason: `Could not remove the shortcut: ${err.message}` };
  }
}

module.exports = {
  MAX_LABEL,
  MAX_PROMPT,
  MAX_PRESETS,
  ID_RE,
  newId,
  normalisePreset,
  listPresets,
  findPreset,
  upsertPreset,
  removePreset,
  reorderPresets,
  psLiteral,
  shortcutFileName,
  describe,
  writeDesktopShortcut,
  removeDesktopShortcut,
};
