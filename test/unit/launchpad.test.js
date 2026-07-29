'use strict';
/**
 * Launchpad presets and desktop shortcuts.
 *
 * Two things are worth testing here and one of them is a security boundary.
 *
 * The first is validation: a preset comes from the renderer and ends up on a
 * command line, in a filename, and in an icon the user double-clicks months later.
 * Anything malformed that survives into config is a button that fails at the one
 * moment it is needed, so the tests below check what is *dropped* as carefully as
 * what is kept.
 *
 * The second is `psLiteral`. Every preset value reaches PowerShell through it, so a
 * label containing `'; Remove-Item C:\ -Recurse; '` has to come out the far side as
 * a label. The shortcut test does not simulate that — it writes a real `.lnk` into
 * a temporary directory standing in for the Desktop, with a hostile label, and then
 * reads the shortcut back through COM to confirm the label stayed data. Nothing here
 * touches the user's real Desktop, `~/.claude`, or any running session.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const launchpad = require('../../src/shared/launchpad');
const launcher = require('../../src/shared/launcher');

/** A config shaped like the real one, with just the launchpad branch filled in. */
function withPresets(presets) {
  return { launchpad: { presets } };
}

/** Deterministic ids, so a test can assert on one. */
const FIXED = { now: 0, seed: 0 };

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lifeline-${name}-`));
}

/* ============================== normalisePreset ============================== */

test('a label is the only required field, because a blank button is not usable', () => {
  assert.equal(launchpad.normalisePreset({ label: '   ' }, FIXED).ok, false);
  assert.equal(launchpad.normalisePreset({}, FIXED).ok, false);
  assert.equal(launchpad.normalisePreset(null, FIXED).ok, false);
  assert.equal(launchpad.normalisePreset('Ship it', FIXED).ok, false);

  const res = launchpad.normalisePreset({ label: 'Ship it' }, FIXED);
  assert.equal(res.ok, true);
  assert.equal(res.preset.label, 'Ship it');
  // Everything else has a sensible absence rather than an invented value.
  assert.equal(res.preset.cwd, null);
  assert.equal(res.preset.model, null);
  assert.equal(res.preset.permissionMode, null);
  assert.deepEqual(res.preset.skills, []);
  assert.equal(res.preset.prePrompt, '');
  assert.equal(res.preset.accelerator, null);
});

test('an unrecognised permission mode becomes no mode, never a guessed one', () => {
  // Correcting it would be picking a mode the user did not pick, and the modes
  // differ in how much they let a session do unattended.
  for (const bad of ['bypass', 'BYPASSPERMISSIONS', 'plan --yes', 'yolo', '']) {
    assert.equal(launchpad.normalisePreset({ label: 'x', permissionMode: bad }, FIXED).preset.permissionMode, null, bad);
  }
  assert.equal(launchpad.normalisePreset({ label: 'x', permissionMode: 'plan' }, FIXED).preset.permissionMode, 'plan');
});

test('skills are filtered to slugs and de-duplicated, with a leading slash allowed', () => {
  const res = launchpad.normalisePreset(
    { label: 'x', skills: ['/lab-infra-jira', 'lab-infra-jira', 'purchasing-jira', 'rm -rf /', 'has space', '', null] },
    FIXED
  );
  // '/lab-infra-jira' and 'lab-infra-jira' are the same skill, so it appears once.
  // The rest are dropped: as prompt text they would read as instructions.
  assert.deepEqual(res.preset.skills, ['lab-infra-jira', 'purchasing-jira']);
});

test('a non-array skills field is an empty list rather than a crash', () => {
  assert.deepEqual(launchpad.normalisePreset({ label: 'x', skills: 'lab-infra-jira' }, FIXED).preset.skills, []);
});

test('the label is collapsed to one line and clipped, since it has to fit under an icon', () => {
  const res = launchpad.normalisePreset({ label: `  Ship\n\tit\u0007 now  ${'x'.repeat(200)}` }, FIXED);
  assert.equal(res.preset.label.length, launchpad.MAX_LABEL);
  assert.match(res.preset.label, /^Ship it now x+$/);
});

test('a pre-prompt keeps its line breaks, which is the whole point of the JSON spec', () => {
  const prompt = 'Review the diff.\n\n- check the tests\n- check the docs';
  const res = launchpad.normalisePreset({ label: 'x', prePrompt: prompt }, FIXED);
  assert.equal(res.preset.prePrompt, prompt);
});

test('a pre-prompt is length-bounded so config stays a small file', () => {
  const res = launchpad.normalisePreset({ label: 'x', prePrompt: 'a'.repeat(launchpad.MAX_PROMPT + 500) }, FIXED);
  assert.equal(res.preset.prePrompt.length, launchpad.MAX_PROMPT);
});

test('the unattended defaults are on, and only an explicit false opts out', () => {
  const on = launchpad.normalisePreset({ label: 'x' }, FIXED).preset;
  assert.equal(on.skipPermissions, true);
  assert.equal(on.strictMcpConfig, true);

  const off = launchpad.normalisePreset({ label: 'x', skipPermissions: false, strictMcpConfig: false }, FIXED).preset;
  assert.equal(off.skipPermissions, false);
  assert.equal(off.strictMcpConfig, false);

  // Absent or undefined is not "off" — a preset saved before the flags existed
  // should still launch unattended.
  const undef = launchpad.normalisePreset({ label: 'x', skipPermissions: undefined }, FIXED).preset;
  assert.equal(undef.skipPermissions, true);
});

test('unknown fields are dropped rather than carried into config', () => {
  const res = launchpad.normalisePreset({ label: 'x', env: { PATH: 'C:\\evil' }, args: ['--dangerous'], id: 'ok' }, FIXED);
  assert.deepEqual(
    Object.keys(res.preset).sort(),
    ['accelerator', 'cwd', 'id', 'label', 'model', 'permissionMode', 'prePrompt', 'skills', 'skipPermissions', 'strictMcpConfig']
  );
});

test('an id is kept only if it is one we could have issued', () => {
  // Editing a preset has to keep its id, because a desktop shortcut names it.
  assert.equal(launchpad.normalisePreset({ label: 'x', id: 'abc123' }, FIXED).preset.id, 'abc123');
  // Anything else gets a fresh id rather than an error: the id is ours to assign,
  // and a path-shaped one would end up in a filename.
  for (const bad of ['../../etc', 'ABC123', 'ab', 'a'.repeat(40), 'has space', '']) {
    const id = launchpad.normalisePreset({ label: 'x', id: bad }, FIXED).preset.id;
    assert.match(id, launchpad.ID_RE, `${bad} -> ${id}`);
    assert.notEqual(id, bad);
  }
});

test('a generated id is always filename-safe, whatever the clock and entropy give', () => {
  for (const now of [0, 1, 1_700_000_000_000, Number.MAX_SAFE_INTEGER]) {
    for (const seed of [0, 0.5, 0.999999]) {
      const id = launchpad.newId(now, seed);
      assert.match(id, launchpad.ID_RE, `${now}/${seed} -> ${id}`);
    }
  }
});

test('two presets made in the same millisecond still get different ids', () => {
  assert.notEqual(launchpad.newId(1_700_000_000_000, 0.1), launchpad.newId(1_700_000_000_000, 0.9));
});

/* ============================== the stored list ============================== */

test('a stored preset that no longer validates is skipped, not shown broken', () => {
  const presets = launchpad.listPresets(withPresets([{ label: 'Good', id: 'abc123' }, { label: '' }, null, 'nope']));
  assert.deepEqual(presets.map((p) => p.label), ['Good']);
});

test('a missing launchpad branch is an empty list rather than a crash', () => {
  for (const cfg of [null, {}, { launchpad: {} }, { launchpad: { presets: 'nope' } }]) {
    assert.deepEqual(launchpad.listPresets(cfg), []);
  }
});

test('a duplicated id is collapsed, so one button cannot mean two things', () => {
  const presets = launchpad.listPresets(withPresets([{ id: 'abc123', label: 'First' }, { id: 'abc123', label: 'Second' }]));
  assert.deepEqual(presets.map((p) => p.label), ['First']);
});

test('an edit keeps its position, because the grid order is the user\'s arrangement', () => {
  const cfg = withPresets([
    { id: 'aaaaaa', label: 'A' },
    { id: 'bbbbbb', label: 'B' },
    { id: 'cccccc', label: 'C' },
  ]);
  const res = launchpad.upsertPreset(cfg, { id: 'bbbbbb', label: 'B renamed' }, FIXED);
  assert.equal(res.ok, true);
  assert.deepEqual(res.presets.map((p) => p.label), ['A', 'B renamed', 'C']);
});

test('a new preset is appended, and the limit is refused with a reason', () => {
  const many = Array.from({ length: launchpad.MAX_PRESETS }, (_, i) => ({
    id: `p${String(i).padStart(5, '0')}`,
    label: `P${i}`,
  }));
  const full = launchpad.upsertPreset(withPresets(many), { label: 'One more' }, FIXED);
  assert.equal(full.ok, false);
  assert.match(full.reason, /limit/i);

  // At the limit, editing an existing one still works — it is not a new row.
  const edit = launchpad.upsertPreset(withPresets(many), { id: 'p00000', label: 'P0 renamed' }, FIXED);
  assert.equal(edit.ok, true);
  assert.equal(edit.presets.length, launchpad.MAX_PRESETS);
});

test('an invalid preset is rejected without touching the stored list', () => {
  const cfg = withPresets([{ id: 'aaaaaa', label: 'A' }]);
  const res = launchpad.upsertPreset(cfg, { label: '' }, FIXED);
  assert.equal(res.ok, false);
  assert.equal(res.presets, undefined);
  assert.deepEqual(cfg.launchpad.presets.map((p) => p.label), ['A']);
});

test('removing an unknown id is silent rather than an error', () => {
  const cfg = withPresets([{ id: 'aaaaaa', label: 'A' }, { id: 'bbbbbb', label: 'B' }]);
  assert.deepEqual(launchpad.removePreset(cfg, 'bbbbbb').map((p) => p.id), ['aaaaaa']);
  assert.deepEqual(launchpad.removePreset(cfg, 'zzzzzz').map((p) => p.id), ['aaaaaa', 'bbbbbb']);
  assert.deepEqual(launchpad.removePreset(cfg, null).map((p) => p.id), ['aaaaaa', 'bbbbbb']);
});

test('a reorder that omits an id keeps it rather than deleting it', () => {
  // A renderer that has not yet seen a newly added preset would send a stale list.
  // Treating an omission as a delete would lose a preset to a race.
  const cfg = withPresets([
    { id: 'aaaaaa', label: 'A' },
    { id: 'bbbbbb', label: 'B' },
    { id: 'cccccc', label: 'C' },
  ]);
  assert.deepEqual(launchpad.reorderPresets(cfg, ['cccccc', 'aaaaaa']).map((p) => p.id), ['cccccc', 'aaaaaa', 'bbbbbb']);
  assert.deepEqual(launchpad.reorderPresets(cfg, []).map((p) => p.id), ['aaaaaa', 'bbbbbb', 'cccccc']);
  assert.deepEqual(launchpad.reorderPresets(cfg, null).map((p) => p.id), ['aaaaaa', 'bbbbbb', 'cccccc']);
});

test('a reorder cannot duplicate or invent an id', () => {
  const cfg = withPresets([{ id: 'aaaaaa', label: 'A' }, { id: 'bbbbbb', label: 'B' }]);
  const out = launchpad.reorderPresets(cfg, ['bbbbbb', 'bbbbbb', 'zzzzzz', 'aaaaaa']);
  assert.deepEqual(out.map((p) => p.id), ['bbbbbb', 'aaaaaa']);
});

test('findPreset returns null for an unknown id instead of throwing', () => {
  const cfg = withPresets([{ id: 'aaaaaa', label: 'A' }]);
  assert.equal(launchpad.findPreset(cfg, 'aaaaaa').label, 'A');
  assert.equal(launchpad.findPreset(cfg, 'zzzzzz'), null);
  assert.equal(launchpad.findPreset(cfg, undefined), null);
});

/* ============================== psLiteral ============================== */

test('psLiteral makes a PowerShell injection attempt into a string', () => {
  // The three shapes that would each execute if the value were interpolated bare,
  // or double-quoted, into the script.
  assert.equal(launchpad.psLiteral("'; Remove-Item C:\\ -Recurse; '"), "'''; Remove-Item C:\\ -Recurse; '''");
  assert.equal(launchpad.psLiteral('$(Get-Date)'), "'$(Get-Date)'");
  assert.equal(launchpad.psLiteral('`n$env:USERNAME'), "'`n$env:USERNAME'");
});

test('psLiteral leaves backslashes alone, since the values are Windows paths', () => {
  assert.equal(launchpad.psLiteral('C:\\Users\\a b\\repo'), "'C:\\Users\\a b\\repo'");
});

test('psLiteral turns an absent value into an empty literal, never into $null', () => {
  assert.equal(launchpad.psLiteral(null), "''");
  assert.equal(launchpad.psLiteral(undefined), "''");
  assert.equal(launchpad.psLiteral(0), "'0'");
});

test('every quote in a value is doubled, not just the first', () => {
  assert.equal(launchpad.psLiteral("a'b'c"), "'a''b''c'");
});

/* ============================== shortcutFileName ============================== */

test('characters Windows forbids in a filename are replaced, not stripped', () => {
  // Stripping would collapse `Ship: it` and `Ship it` into the same file, so one
  // preset's shortcut would overwrite another's.
  assert.equal(launchpad.shortcutFileName('Ship: it'), 'Ship- it.lnk');
  assert.notEqual(launchpad.shortcutFileName('a:b'), launchpad.shortcutFileName('ab'));
  assert.equal(launchpad.shortcutFileName('a<b>c"d/e\\f|g?h*i'), 'a-b-c-d-e-f-g-h-i.lnk');
});

test('a path traversal in a label cannot escape the desktop directory', () => {
  const name = launchpad.shortcutFileName('../../../Windows/System32/evil');
  assert.equal(path.basename(name), name);
  assert.equal(name.includes('/'), false);
  assert.equal(name.includes('\\'), false);
});

test('trailing dots and spaces go, because Windows silently drops them', () => {
  // Otherwise the file we wrote is not the file we can find again to delete.
  assert.equal(launchpad.shortcutFileName('Ship it. '), 'Ship it.lnk');
  assert.equal(launchpad.shortcutFileName('Ship it...'), 'Ship it.lnk');
});

test('a label with nothing usable in it still yields a filename', () => {
  assert.equal(launchpad.shortcutFileName('///'), '---.lnk');
  assert.equal(launchpad.shortcutFileName(''), 'Claude session.lnk');
  assert.equal(launchpad.shortcutFileName(null), 'Claude session.lnk');
});

/* ============================== describe ============================== */

test('a tooltip lists only what is set, with no blanks for what is not', () => {
  assert.equal(launchpad.describe({ label: 'Ship it' }), 'Claude Code: Ship it');
  assert.equal(
    launchpad.describe({ label: 'Ship it', cwd: 'C:\\work\\repo\\', model: 'opus', skills: ['lab-infra-jira'], permissionMode: 'plan' }),
    'Claude Code: Ship it — repo · opus · /lab-infra-jira · plan'
  );
});

test('a tooltip is clipped, because Windows truncates a Description anyway', () => {
  assert.ok(launchpad.describe({ label: 'x', model: 'm'.repeat(400) }).length <= 250);
});

/* ============================== the real .lnk ============================== */

test('writeDesktopShortcut refuses clearly when it has nowhere to write', () => {
  const res = launchpad.writeDesktopShortcut({ label: 'x' }, { launchDir: tmpdir('nodesk'), launcher });
  assert.equal(res.ok, false);
  assert.match(res.reason, /Desktop/);

  const noLauncher = launchpad.writeDesktopShortcut({ label: 'x' }, { desktopDir: tmpdir('nolauncher') });
  assert.equal(noLauncher.ok, false);
  assert.match(noLauncher.reason, /Launcher/);
});

test('an invalid preset is refused before any file is written', () => {
  const desktopDir = tmpdir('desk-invalid');
  const res = launchpad.writeDesktopShortcut({ label: '' }, { desktopDir, launchDir: tmpdir('launch-invalid'), launcher });
  assert.equal(res.ok, false);
  assert.deepEqual(fs.readdirSync(desktopDir), []);
});

test('a shortcut is written into Lifeline\'s own directory, never into TEMP', { skip: process.platform !== 'win32' }, () => {
  // A `.lnk` outlives the app that made it. Pointing it at a launch script in TEMP
  // would produce an icon that works today and fails silently after the next
  // cleanup, so the pair is keyed by preset id in a directory we own.
  const desktopDir = tmpdir('desk-write');
  const launchDir = path.join(tmpdir('home-write'), 'launch');

  const res = launchpad.writeDesktopShortcut(
    { id: 'abc123', label: 'Ship it', cwd: process.cwd(), model: 'opus', prePrompt: 'Review the diff.\nCheck the tests.' },
    { desktopDir, launchDir, launcher }
  );

  assert.equal(res.ok, true, res.reason);
  assert.equal(res.lnk, path.join(desktopDir, 'Ship it.lnk'));
  assert.ok(fs.existsSync(res.lnk));
  // Keyed by id, so editing the preset updates the file the existing icon points at.
  assert.equal(path.dirname(res.script), launchDir);
  assert.match(path.basename(res.script), /preset-abc123\.cmd$/);
  assert.equal(res.script.startsWith(os.tmpdir()) && !launchDir.startsWith(os.tmpdir()), false);

  // The multi-line prompt survives, because it travels in the JSON spec rather
  // than on a command line.
  const spec = JSON.parse(fs.readFileSync(res.script.replace(/\.cmd$/, '.json'), 'utf8'));
  assert.ok(spec.args.includes('Review the diff.\nCheck the tests.'));
});

test('a hostile label reaches the shortcut as a label, not as a command', { skip: process.platform !== 'win32' }, () => {
  // The end-to-end check on psLiteral: if the quoting were wrong, this label would
  // close the string and run the rest. The `.lnk` is then read back through the
  // same COM interface that wrote it, so what is asserted is what Windows stored.
  const desktopDir = tmpdir('desk-hostile');
  const launchDir = path.join(tmpdir('home-hostile'), 'launch');
  const label = "It's $(pwd) `n & done";

  const res = launchpad.writeDesktopShortcut({ id: 'abc124', label, cwd: process.cwd() }, { desktopDir, launchDir, launcher });
  assert.equal(res.ok, true, res.reason);

  const probe = path.join(launchDir, 'read-back.ps1');
  fs.writeFileSync(
    probe,
    `\ufeff$s = New-Object -ComObject WScript.Shell\r\n` +
      `$l = $s.CreateShortcut(${launchpad.psLiteral(res.lnk)})\r\n` +
      `Write-Output $l.Description\r\n`,
    'utf8'
  );
  const back = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe], { encoding: 'utf8' });

  // The label came back whole — every metacharacter intact and inert.
  assert.ok(back.includes(label), back);
  // And it was stored as the shortcut's own name, so `$(pwd)` was never evaluated.
  assert.equal(back.includes(process.cwd()) && !label.includes(process.cwd()), false);
});

test('a shortcut can be removed, and removing a missing one is not an error', () => {
  const desktopDir = tmpdir('desk-remove');
  const lnk = path.join(desktopDir, 'Ship it.lnk');
  fs.writeFileSync(lnk, 'not really a shortcut', 'utf8');

  const gone = launchpad.removeDesktopShortcut({ label: 'Ship it' }, { desktopDir });
  assert.equal(gone.ok, true);
  assert.equal(fs.existsSync(lnk), false);

  // Deleting a preset should not fail just because its icon was already dragged
  // to the recycle bin.
  const again = launchpad.removeDesktopShortcut({ label: 'Ship it' }, { desktopDir });
  assert.equal(again.ok, true);
  assert.equal(again.missing, true);
});

test('removing a shortcut targets the same filename that writing one produced', () => {
  const desktopDir = tmpdir('desk-roundtrip');
  const label = 'Ship: it. ';
  const lnk = path.join(desktopDir, launchpad.shortcutFileName(label));
  fs.writeFileSync(lnk, 'x', 'utf8');
  assert.equal(launchpad.removeDesktopShortcut({ label }, { desktopDir }).missing, undefined);
  assert.equal(fs.existsSync(lnk), false);
});
