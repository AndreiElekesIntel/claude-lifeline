'use strict';
/**
 * The History and Launchpad tabs, driven through the real UI.
 *
 * These two tabs are the ones that *act on the outside world* — one reopens a
 * session, the other starts a new one and can put an icon on the Desktop — so what
 * matters here is the boundary rather than the pixels. Three things are checked at
 * every turn:
 *
 *   - A launch is refused when it should be. Resuming a session that is still
 *     running would put a second `claude` on the same transcript, which is exactly
 *     the interference Lifeline exists to avoid.
 *   - A session id from a transcript is validated against disk before it reaches a
 *     command line. Those ids come out of files full of model output.
 *   - The configuration actually saved is the one the buttons will use later.
 *
 * Nothing here spawns a terminal. `LIFELINE_NO_SPAWN=1` makes main write the launch
 * pair and stop, and the pair is then read off disk — so the argv, the cwd and the
 * prompt are all asserted, while the developer's desktop stays free of windows and
 * no real `claude` competes with the sessions already running. The one round trip
 * that has to execute something — the batch quoting — is covered in
 * launcher.test.js, which runs it.
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fx = require('./fixtures');

/** The prefix launcher.js gives every generated pair. Kept in step with it. */
const LAUNCH_PREFIX = 'claude-lifeline-launch';

let ctx = null;

const latestToast = (page) => page.locator('.toast').last();

test.afterEach(async () => {
  await fx.close(ctx);
  ctx = null;
});

/** A sandbox with somewhere safe to write desktop icons and launch pairs. */
function launchSandbox(label) {
  const sandbox = fx.makeSandbox(label);
  sandbox.desktop = path.join(sandbox.root, 'desktop');
  fs.mkdirSync(sandbox.desktop, { recursive: true });
  return sandbox;
}

/** Launch with spawning disabled and the Desktop pointed at the sandbox. */
function launchApp(sandbox) {
  return fx.launch(sandbox, {
    LIFELINE_NO_SPAWN: '1',
    LIFELINE_DESKTOP_DIR: sandbox.desktop,
  });
}

/** Every launch spec currently in TEMP, by filename. */
function launchSpecs() {
  return new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(LAUNCH_PREFIX) && f.endsWith('.json')));
}

/**
 * The spec written since `before`, waited for.
 *
 * Read from disk rather than taken from the IPC reply, because the spec is what
 * the runner will actually execute — asserting on a value main happened to return
 * would not prove the file says the same thing. Diffed against a snapshot rather
 * than picked by mtime: TEMP is shared, and a leftover from an earlier run has a
 * timestamp too.
 */
async function newLaunchSpec(before) {
  let name = null;
  await expect
    .poll(() => {
      name = [...launchSpecs()].find((f) => !before.has(f)) || null;
      return Boolean(name);
    }, { timeout: 10_000 })
    .toBe(true);
  return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), name), 'utf8'));
}

/** Two days of transcripts, so grouping has more than one group to make. */
function seedHistory(sandbox) {
  const day = 86_400_000;
  const now = Date.now();
  fx.writeTranscript(sandbox, {
    slug: 'payments-api',
    id: 'a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60',
    title: 'Refactor the billing service',
    cwd: 'C:/work/payments-api',
    messages: 10,
  });
  fx.writeTranscript(sandbox, {
    slug: 'telemetry-dashboard',
    id: 'b7e2d4a9-1c3f-4e82-9d5a-6b8c2f1e7a34',
    title: 'Add latency charts',
    cwd: 'C:/work/telemetry-dashboard',
    model: 'claude-sonnet-5',
    messages: 6,
  });
  // Two days back, so it lands in its own day group rather than merging into today.
  fx.writeTranscript(sandbox, {
    slug: 'payments-api',
    id: 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    title: 'Chase the flaky webhook test',
    cwd: 'C:/work/payments-api',
    messages: 8,
    startedAt: now - 2 * day,
  });
}

/* ================================= history ================================= */

test('history groups past sessions by day, with a total per day', async () => {
  const sandbox = launchSandbox('hist-groups');
  seedHistory(sandbox);
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="history"]');

  // The first open scans every transcript on disk, so the rows get the same
  // generous timeout the analytics tab does.
  await expect(page.locator('#historyList .hist-row')).toHaveCount(3, { timeout: 20_000 });
  // Today's two, and the one from two days ago.
  await expect(page.locator('#historyList .day-group')).toHaveCount(2);
  await expect(page.locator('#histSessions')).toHaveText('3');
  await expect(page.locator('#histDays')).toHaveText('2');
  // Every day header carries its own count, time and cost.
  await expect(page.locator('.day-group').first().locator('.day-stat')).toHaveCount(3);
  await expect(page.locator('.day-group').first().locator('.day-stat').first()).toHaveText('2 sessions');
  await expect(page.locator('#historyEmpty')).toBeHidden();

  // The titles come from the transcripts, not from the filenames.
  await expect(page.locator('#historyList')).toContainText('Refactor the billing service');
  await expect(page.locator('#historyList')).toContainText('Add latency charts');
});

test('a day group collapses and stays collapsed through a re-render', async () => {
  const sandbox = launchSandbox('hist-collapse');
  seedHistory(sandbox);
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="history"]');
  await expect(page.locator('#historyList .hist-row').first()).toBeVisible({ timeout: 20_000 });

  const first = page.locator('.day-group').first();
  await first.locator('.day-head').click();
  await expect(first).toHaveClass(/collapsed/);
  await expect(first.locator('.day-head')).toHaveAttribute('aria-expanded', 'false');

  // A search re-renders the list; the collapse is the user's state, not the data's.
  await page.fill('#historySearch', 'payments');
  await expect(page.locator('#historyList .hist-row')).toHaveCount(2);
  await expect(page.locator('.day-group').first()).toHaveClass(/collapsed/);
});

test('search filters by project, title and prompt, and says what it filtered from', async () => {
  const sandbox = launchSandbox('hist-search');
  seedHistory(sandbox);
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="history"]');
  await expect(page.locator('#historyList .hist-row')).toHaveCount(3, { timeout: 20_000 });

  await page.fill('#historySearch', 'telemetry');
  await expect(page.locator('#historyList .hist-row')).toHaveCount(1);
  // "1" on its own reads as "one session exists", which is the wrong impression.
  await expect(page.locator('#histSessionsFoot')).toHaveText('of 3 on disk');

  await page.fill('#historySearch', 'latency charts');
  await expect(page.locator('#historyList .hist-row')).toHaveCount(1);

  // A query matching nothing is a different empty state from having no sessions,
  // and the difference decides whether the user clears the box or starts working.
  await page.fill('#historySearch', 'zzzz-no-such-session');
  await expect(page.locator('#historyEmpty')).toBeVisible();
  await expect(page.locator('#historyEmptyText')).toHaveText('Nothing matches that search.');

  await page.fill('#historySearch', '');
  await expect(page.locator('#historyList .hist-row')).toHaveCount(3);
});

test('with no transcripts history says so rather than showing an empty grid', async () => {
  const sandbox = launchSandbox('hist-none');
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="history"]');
  await expect(page.locator('#historyEmpty')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#historyEmptyText')).toHaveText('No sessions on disk yet.');
});

test('with analytics off history explains itself instead of looking broken', async () => {
  const sandbox = launchSandbox('hist-off');
  seedHistory(sandbox);
  fx.writeConfig(sandbox, { analytics: { enabled: false } });
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="history"]');
  await expect(page.locator('#historyOffBanner')).toBeVisible();
  // The stat cards go too: four em-dashes would imply a scan that found nothing.
  await expect(page.locator('#historyStats')).toBeHidden();
  await expect(page.locator('#historyList .hist-row')).toHaveCount(0);
});

/* ================================= resume ================================= */

test('clicking a session resumes it, with the id and cwd taken from disk', async () => {
  const sandbox = launchSandbox('hist-resume');
  seedHistory(sandbox);
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="history"]');
  await expect(page.locator('#historyList .hist-row').first()).toBeVisible({ timeout: 20_000 });

  const row = page.locator('.hist-row[data-session-id="a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60"]');
  const before = launchSpecs();
  // The whole row is the target — the user asked to press a session and have it
  // open, not to find a button.
  await row.locator('.hist-main').click();
  await expect(latestToast(page)).toContainText('Opening');

  // The spec on disk is what the runner will execute.
  const spec = await newLaunchSpec(before);
  expect(spec.args).toContain('--resume');
  expect(spec.args).toContain('a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60');
  // From the transcript's own `cwd` field: the project directory name is the cwd
  // with every non-alphanumeric replaced by a dash, which is not reversible.
  expect(spec.cwd).toBe('C:/work/payments-api');
});

test('resuming a session that is still running is never queued behind it', async () => {
  const sandbox = launchSandbox('hist-resume-live');
  const id = 'a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60';
  seedHistory(sandbox);
  // Our own pid, so the liveness probe genuinely passes.
  fx.writeSession(sandbox, { pid: process.pid, sessionId: id, cwd: 'C:/work/payments-api', status: 'busy' });
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="history"]');
  const row = page.locator(`.hist-row[data-session-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });

  const before = launchSpecs();
  await row.locator('.hist-main').click();

  // A second process appending to a transcript the first one is writing is the
  // interference this whole feature is built to avoid, so the resume itself is
  // refused — and refused before anything is written, not after.
  await expect(latestToast(page)).toContainText('same transcript');
  expect([...launchSpecs()].filter((f) => !before.has(f))).toEqual([]);
});

/**
 * The refusal above offers a way through, and takes it when asked.
 *
 * Claude Code keeps a session record alive for as long as its process is, so the
 * "still running" branch lands on exactly the recent rows a user is most likely
 * to click — which made History's Resume look broken even though it was working
 * as designed. A new session in the same folder is the thing that was actually
 * wanted, and it is safe: one process, one new transcript.
 */
test('a running session offers a fresh one in its folder, with no --resume', async () => {
  const sandbox = launchSandbox('hist-resume-fresh');
  const id = 'a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60';
  seedHistory(sandbox);
  fx.writeSession(sandbox, { pid: process.pid, sessionId: id, cwd: 'C:/work/payments-api', status: 'busy' });
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="history"]');
  const row = page.locator(`.hist-row[data-session-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });

  const before = launchSpecs();
  await row.locator('.hist-main').click();

  // The alternative is offered on the refusal, not applied silently: starting a
  // second session against a folder someone is working in is their call.
  const action = latestToast(page).locator('.toast-action');
  await expect(action).toContainText('payments-api');
  await action.click();

  // The critical assertion: a *new* session, so no --resume and no session id
  // anywhere on the command line. Passing both would be the double-writer case
  // the refusal exists to prevent.
  const spec = await newLaunchSpec(before);
  expect(spec.cwd).toBe('C:/work/payments-api');
  expect(spec.args).not.toContain('--resume');
  expect(spec.args.join(' ')).not.toContain(id);
});

test('a session id that is not on disk cannot reach a command line', async () => {
  const sandbox = launchSandbox('hist-resume-bogus');
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  // Straight at the channel, because the UI only ever offers ids it found in a
  // scan — and the scan reads transcripts, which are full of model output. The
  // channel is what has to hold.
  const results = await page.evaluate(async () => {
    const attempts = [
      '../../../../windows/system32/calc',
      'a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60 & calc.exe',
      '"; calc.exe; "',
      '',
      'not-a-uuid',
      // Well-formed, but no transcript and no session record: nothing proves it exists.
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    ];
    const out = [];
    for (const id of attempts) out.push(await window.lifeline.resumeSession(id));
    return out;
  });

  for (const res of results) expect(res.ok).toBe(false);
  // The malformed ones are rejected on shape; the well-formed one on existence.
  expect(results[0].reason).toMatch(/not a session id/i);
  expect(results[5].reason).toMatch(/could not find/i);
});

/* ================================= rename ================================= */

test('a session can be renamed, and the new name is what history then shows', async () => {
  const sandbox = launchSandbox('hist-rename');
  const id = 'b7e2d4a9-1c3f-4e82-9d5a-6b8c2f1e7a34';
  seedHistory(sandbox);
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="history"]');
  const row = page.locator(`.hist-row[data-session-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.locator('.hist-title')).toHaveText('Add latency charts');

  await row.locator('.hist-actions button', { hasText: 'Rename' }).click();
  const input = row.locator('.rename-input');
  await expect(input).toBeVisible();
  await input.fill('Latency work — do not lose this');
  await input.press('Enter');

  await expect(latestToast(page)).toContainText('Renamed');
  await expect(page.locator(`.hist-row[data-session-id="${id}"] .hist-title`)).toHaveText(
    'Latency work — do not lose this',
    { timeout: 20_000 }
  );

  // It lands in Claude Code's own transcript as an appended record, which is what
  // makes the name outlive Lifeline — and appending is the only write, so nothing
  // Claude Code already wrote is touched.
  const file = path.join(sandbox.claudeHome, 'projects', 'telemetry-dashboard', `${id}.jsonl`);
  const records = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const custom = records.filter((r) => r.type === 'custom-title');
  expect(custom).toHaveLength(1);
  expect(custom[0].customTitle).toBe('Latency work — do not lose this');
  expect(custom[0].source).toBe('claude-lifeline');
  // Appended, not inserted: the original title record is still there and first.
  expect(records[0].type).toBe('ai-title');
  expect(records[records.length - 1].type).toBe('custom-title');
});

test('escape abandons a rename without writing anything', async () => {
  const sandbox = launchSandbox('hist-rename-esc');
  const id = 'b7e2d4a9-1c3f-4e82-9d5a-6b8c2f1e7a34';
  seedHistory(sandbox);
  const file = path.join(sandbox.claudeHome, 'projects', 'telemetry-dashboard', `${id}.jsonl`);
  const before = fs.readFileSync(file, 'utf8');
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="history"]');
  const row = page.locator(`.hist-row[data-session-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });

  await row.locator('.hist-actions button', { hasText: 'Rename' }).click();
  await row.locator('.rename-input').fill('half-typed thought');
  await row.locator('.rename-input').press('Escape');

  await expect(page.locator(`.hist-row[data-session-id="${id}"] .hist-title`)).toHaveText('Add latency charts');
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
});

test('a running session refuses a rename before the user types, not after', async () => {
  const sandbox = launchSandbox('hist-rename-live');
  const id = 'a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60';
  seedHistory(sandbox);
  fx.writeSession(sandbox, { pid: process.pid, sessionId: id, cwd: 'C:/work/payments-api', status: 'busy' });
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="history"]');
  const row = page.locator(`.hist-row[data-session-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });

  await row.locator('.hist-actions button', { hasText: 'Rename' }).click();

  // Being told after typing a name that the session is busy is the worse order,
  // so the verdict is asked for first and the field never appears.
  await expect(latestToast(page)).toContainText('still running');
  await expect(row.locator('.rename-input')).toHaveCount(0);
});

/* ================================ launchpad ================================ */

/** A config with one preset, saved the way the app saves it. */
function seedPreset(sandbox, over = {}) {
  fx.writeConfig(sandbox, {
    launchpad: {
      presets: [
        {
          id: 'aaaaaa',
          label: 'Morning triage',
          cwd: 'C:/work/payments-api',
          model: 'opus',
          permissionMode: 'plan',
          skills: ['code-review'],
          prePrompt: 'Read the overnight failures.\nThen tell me which are real.',
          accelerator: null,
          ...over,
        },
      ],
    },
  });
}

test('with no presets the launchpad offers to create the first one', async () => {
  const sandbox = launchSandbox('lp-empty');
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="launchpad"]');
  await expect(page.locator('#presetEmpty')).toBeVisible();
  await expect(page.locator('#presetGrid .preset-card')).toHaveCount(0);

  await page.click('#btnFirstPreset');
  await expect(page.locator('#presetEditor')).toBeVisible();
  await expect(page.locator('#presetEditorTitle')).toHaveText('New shortcut');
  // Nothing to delete yet, so the button that would do it is not offered.
  await expect(page.locator('#btnDeletePreset')).toBeHidden();
});

test('a saved preset becomes a card showing what it will do', async () => {
  const sandbox = launchSandbox('lp-card');
  seedPreset(sandbox);
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="launchpad"]');
  const card = page.locator('#presetGrid .preset-card').first();
  await expect(card).toBeVisible();
  await expect(card.locator('.preset-label')).toHaveText('Morning triage');
  // Folder, model, mode, skill — the four things that change what the session does.
  await expect(card.locator('.preset-chip')).toHaveCount(4);
  await expect(card).toContainText('payments-api');
  await expect(card).toContainText('opus');
  await expect(card).toContainText('plan');
  await expect(card).toContainText('/code-review');
  // The prompt preview is one line, whatever the prompt's shape.
  await expect(card.locator('.preset-prompt')).toHaveText('Read the overnight failures. Then tell me which are real.');
});

test('pressing a preset launches it with the argv the preset describes', async () => {
  const sandbox = launchSandbox('lp-launch');
  seedPreset(sandbox);
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="launchpad"]');
  const before = launchSpecs();
  await page.locator('#presetGrid .preset-launch').first().click();
  await expect(latestToast(page)).toContainText('Starting');

  const spec = await newLaunchSpec(before);
  expect(spec.cwd).toBe('C:/work/payments-api');
  expect(spec.args.slice(0, 4)).toEqual(['--model', 'opus', '--permission-mode', 'plan']);
  // Both unattended defaults, so a shortcut never opens and then waits on a dialog
  // for someone who has already walked away.
  expect(spec.args).toContain('--dangerously-skip-permissions');
  expect(spec.args).toContain('--strict-mcp-config');
  // The prompt is the last argument, with its skill line on top and its line
  // breaks intact — which is the entire reason it travels in a JSON spec.
  expect(spec.args[spec.args.length - 1]).toBe(
    '/code-review\n\nRead the overnight failures.\nThen tell me which are real.'
  );
});

test('a preset is saved, edited in place, and deleted, all from the grid', async () => {
  const sandbox = launchSandbox('lp-crud');
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="launchpad"]');
  await page.click('#btnNewPreset');
  await page.fill('#presetLabel', 'Ship the release');
  await page.fill('#presetCwd', 'C:/work/payments-api');
  await page.selectOption('#presetModel', 'sonnet');
  await page.fill('#presetPrompt', 'Draft the release notes.');
  await page.click('#btnSavePreset');

  await expect(latestToast(page)).toContainText('saved');
  await expect(page.locator('#presetGrid .preset-card')).toHaveCount(1);
  await expect(page.locator('.preset-label').first()).toHaveText('Ship the release');

  // It reached config, which is what the launch will read.
  await expect
    .poll(() => {
      const saved = fx.readConfig(sandbox).launchpad.presets;
      return saved.length === 1 ? saved[0].label : null;
    })
    .toBe('Ship the release');
  const saved = fx.readConfig(sandbox).launchpad.presets[0];
  expect(saved.id).toMatch(/^[a-z0-9]{6,32}$/);
  expect(saved.model).toBe('sonnet');
  // Defaulted on at the point of saving, not at the point of launching, so the
  // preset keeps behaving the way it did when it was created.
  expect(saved.skipPermissions).toBe(true);
  expect(saved.strictMcpConfig).toBe(true);

  // Editing keeps the id, because a desktop icon names it.
  await page.locator('.preset-foot button', { hasText: 'Edit' }).first().click();
  await expect(page.locator('#presetEditorTitle')).toContainText('Ship the release');
  await page.fill('#presetLabel', 'Ship it');
  await page.click('#btnSavePreset');
  await expect(page.locator('.preset-label').first()).toHaveText('Ship it');
  await expect.poll(() => fx.readConfig(sandbox).launchpad.presets[0].id).toBe(saved.id);

  await page.locator('.preset-foot button', { hasText: 'Edit' }).first().click();
  await page.click('#btnDeletePreset');
  await expect(latestToast(page)).toContainText('deleted');
  await expect(page.locator('#presetGrid .preset-card')).toHaveCount(0);
  await expect(page.locator('#presetEmpty')).toBeVisible();
  await expect.poll(() => fx.readConfig(sandbox).launchpad.presets.length).toBe(0);
});

test('a preset with no name is refused with a reason, and nothing is stored', async () => {
  const sandbox = launchSandbox('lp-invalid');
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="launchpad"]');
  await page.click('#btnNewPreset');
  await page.fill('#presetLabel', '   ');
  await page.fill('#presetPrompt', 'This would have been lost.');
  await page.click('#btnSavePreset');

  await expect(latestToast(page)).toContainText('name');
  // The editor stays open with the text still in it: a refusal should not also
  // throw away what was typed.
  await expect(page.locator('#presetEditor')).toBeVisible();
  await expect(page.locator('#presetPrompt')).toHaveValue('This would have been lost.');
  await expect(page.locator('#presetGrid .preset-card')).toHaveCount(0);
});

test('a poll does not discard a half-typed preset', async () => {
  const sandbox = launchSandbox('lp-poll');
  seedPreset(sandbox);
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="launchpad"]');
  await page.click('#btnNewPreset');
  await page.fill('#presetLabel', 'Half-typed');
  await page.fill('#presetPrompt', 'Two paragraphs in.\n\nStill going.');

  // The live state arrives every few seconds and re-renders the tab. Losing an
  // unsaved prompt to a background refresh would be unforgivable, so the editor
  // is excluded from that path.
  await page.waitForTimeout(6_000);
  await expect(page.locator('#presetLabel')).toHaveValue('Half-typed');
  await expect(page.locator('#presetPrompt')).toHaveValue('Two paragraphs in.\n\nStill going.');
});

test('the skill picker offers what is installed and flags what is not', async () => {
  const sandbox = launchSandbox('lp-skills');
  // A skill is a directory with a SKILL.md in it — a stray folder is not one.
  for (const name of ['code-review', 'release-notes']) {
    const dir = path.join(sandbox.claudeHome, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
  }
  fs.mkdirSync(path.join(sandbox.claudeHome, 'skills', 'not-a-skill'), { recursive: true });
  // The preset names one that has since been uninstalled.
  seedPreset(sandbox, { skills: ['code-review', 'uninstalled-skill'] });

  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="launchpad"]');
  await page.locator('.preset-foot button', { hasText: 'Edit' }).first().click();

  const chips = page.locator('#presetSkills .skill-chip');
  await expect(chips).toHaveCount(3); // two installed, plus the missing one
  await expect(page.locator('#presetSkills')).not.toContainText('not-a-skill');
  // Dropping the missing one silently would make the shortcut quietly stop doing
  // part of its job, so it is shown and flagged instead.
  await expect(page.locator('#presetSkills .skill-chip.missing')).toHaveCount(1);
  await expect(page.locator('#presetSkills .skill-chip.missing')).toContainText('/uninstalled-skill');

  // Ticking one adds it to the preset that gets saved.
  await page.locator('.skill-chip', { hasText: '/release-notes' }).locator('input').check();
  await page.click('#btnSavePreset');
  await expect
    .poll(() => fx.readConfig(sandbox).launchpad.presets[0].skills.slice().sort())
    .toEqual(['code-review', 'release-notes', 'uninstalled-skill']);
});

test('send to desktop writes a real .lnk that points at a durable script', async () => {
  const sandbox = launchSandbox('lp-desktop');
  seedPreset(sandbox);
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="launchpad"]');
  await page.locator('.preset-foot button', { hasText: 'Send to desktop' }).first().click();
  await expect(latestToast(page)).toContainText('Desktop');

  // Named after the label, so the user can find it.
  const lnk = path.join(sandbox.desktop, 'Morning triage.lnk');
  expect(fs.existsSync(lnk)).toBe(true);
  expect(fs.statSync(lnk).size).toBeGreaterThan(0);

  // And the script it points at lives in Lifeline's own directory, keyed by preset
  // id. A `.lnk` outlives the app that made it: in TEMP it would be an icon that
  // works today and fails silently after the next cleanup.
  const launchDir = path.join(sandbox.lifelineHome, 'launch');
  const files = fs.readdirSync(launchDir);
  expect(files).toContain('claude-lifeline-launch-preset-aaaaaa.cmd');
  expect(files).toContain('claude-lifeline-launch-preset-aaaaaa.json');

  const spec = JSON.parse(fs.readFileSync(path.join(launchDir, 'claude-lifeline-launch-preset-aaaaaa.json'), 'utf8'));
  expect(spec.cwd).toBe('C:/work/payments-api');
  expect(spec.args).toContain('--dangerously-skip-permissions');

  // Deleting the preset takes its icon with it, or the desktop keeps a button that
  // fails on click.
  await page.locator('.preset-foot button', { hasText: 'Edit' }).first().click();
  await page.click('#btnDeletePreset');
  await expect(latestToast(page)).toContainText('deleted');
  await expect.poll(() => fs.existsSync(lnk)).toBe(false);
});

test('a preset label that is a PowerShell payload stays a label', async () => {
  const sandbox = launchSandbox('lp-desktop-hostile');
  /**
   * A label that writes a file if it is ever evaluated.
   *
   * It has to fit inside the 60-character label cap — a payload clipped in half
   * would prove nothing about the quoting — so it resolves its own target rather
   * than carrying a long absolute path. `$env:TEMP` is also the second half of the
   * check: single-quoted PowerShell literals do not expand variables, so the
   * sentinel can only appear if this label was evaluated rather than quoted.
   */
  const sentinel = path.join(os.tmpdir(), 'lifeline-pwned.txt');
  fs.rmSync(sentinel, { force: true });
  const label = "x'; ni $env:TEMP\\lifeline-pwned.txt; '";
  expect(label.length).toBeLessThanOrEqual(60);
  seedPreset(sandbox, { label });
  ctx = await launchApp(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="launchpad"]');
  await page.locator('.preset-foot button', { hasText: 'Send to desktop' }).first().click();
  await expect(latestToast(page)).toContainText('Desktop');

  // Nothing was evaluated: the payload's own side effect never happened.
  expect(fs.existsSync(sentinel)).toBe(false);

  // One shortcut, and its name is a filename rather than a path — a label cannot
  // steer the write out of the desktop directory.
  const written = fs.readdirSync(sandbox.desktop).filter((f) => f.endsWith('.lnk'));
  expect(written).toHaveLength(1);
  expect(path.basename(written[0])).toBe(written[0]);
  // The quote survives, and the backslash became a dash: characters Windows
  // forbids in a filename are replaced rather than stripped, so two different
  // labels cannot collapse onto one file.
  expect(written[0]).toBe("x'; ni $env-TEMP-lifeline-pwned.txt; '.lnk");
});
