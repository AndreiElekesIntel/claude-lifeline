'use strict';
/**
 * UI behaviour tests against the real Electron app.
 *
 * These assert what a user can actually see and do — that the status matches the
 * underlying state, that a config change survives a restart, and that installing
 * hooks writes the settings Claude Code will read. Each test runs against its own
 * sandbox home, so nothing here can touch real sessions or real settings.json.
 */

const { test, expect } = require('@playwright/test');
const fx = require('./fixtures');

let ctx = null;

/** The newest toast. Several can be on screen at once, so never match them all. */
const latestToast = (page) => page.locator('.toast').last();

test.afterEach(async () => {
  await fx.close(ctx);
  ctx = null;
});

test('window opens with the shell, brand, and a resolved status', async () => {
  const sandbox = fx.makeSandbox('boot');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await expect(page.locator('.brand')).toHaveText('Claude Lifeline');
  // A status must resolve to one of the five real states — never stay "Starting…".
  await expect(page.locator('#statusPill')).toHaveAttribute(
    'data-status',
    /^(running|waiting|paused|attention|error)$/
  );
  await expect(page.locator('#statusText')).not.toHaveText('Starting…');
  // The runtime-generated tray icon should have loaded as a data URL.
  await expect(page.locator('#brandIcon')).toHaveAttribute('src', /^data:image\/png/);
});

test('with no sessions the app reports waiting, not running', async () => {
  const sandbox = fx.makeSandbox('empty');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await expect(page.locator('#statusPill')).toHaveAttribute('data-status', 'waiting');
  await expect(page.locator('#statLive')).toHaveText('0');

  await page.click('.nav-item[data-tab="sessions"]');
  await expect(page.locator('#sessionsEmpty')).toBeVisible();
  await expect(page.locator('#sessionBody tr')).toHaveCount(0);
});

test('a busy session drives the status to running and lists the project', async () => {
  const sandbox = fx.makeSandbox('busy');
  // Our own pid is guaranteed alive, which is what makes the liveness probe pass.
  fx.writeSession(sandbox, { pid: process.pid, status: 'busy', cwd: 'C:/work/payments-api', name: 'refactor-billing' });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await expect(page.locator('#statusPill')).toHaveAttribute('data-status', 'running');
  await expect(page.locator('#statLive')).toHaveText('1');

  await page.click('.nav-item[data-tab="sessions"]');
  const row = page.locator('#sessionBody tr').first();
  await expect(row).toContainText('refactor-billing');
  await expect(row).toContainText('payments-api');
  await expect(row.locator('.chip')).toHaveText('working');
});

test('a session that claims to be busy but has gone quiet reads as stalled', async () => {
  const sandbox = fx.makeSandbox('stalled');
  fx.writeSession(sandbox, {
    pid: process.pid,
    status: 'busy',
    cwd: 'C:/work/stuck',
    // Well past the 15-minute default threshold.
    updatedAt: Date.now() - 3_600_000,
  });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="sessions"]');
  await expect(page.locator('#sessionBody tr').first().locator('.chip')).toHaveText('stalled');
});

test('a vanished process that was mid-work is shown as died, not as working', async () => {
  const sandbox = fx.makeSandbox('dead');
  // A pid this high is not in use; the signal-0 probe will report it gone.
  fx.writeSession(sandbox, { pid: 4_190_000_001, status: 'busy', cwd: 'C:/work/crashed' });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="sessions"]');
  const row = page.locator('#sessionBody tr').first();
  await expect(row.locator('.chip')).toHaveText('died while working');
  await expect(row.locator('.chip')).toHaveClass(/danger/);
});

test('recoveries appear on the dashboard and in the activity log', async () => {
  const sandbox = fx.makeSandbox('events');
  fx.writeEvents(sandbox, [
    {
      kind: 'recovered',
      sessionId: 'abc12345',
      cwd: 'C:/work/payments-api',
      errorClass: 'rate_limit',
      label: 'Rate limited',
      strategy: 'resume',
      attemptNumber: 1,
      waitedMs: 60_000,
      detail: 'Resumed after rate limited (attempt 1).',
    },
    {
      kind: 'notified',
      sessionId: 'def67890',
      cwd: 'C:/work/other',
      errorClass: 'billing_error',
      label: 'Billing problem',
      detail: 'Needs a billing change. Retrying only burns attempts.',
      needsAttention: true,
    },
  ]);
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  // An outstanding non-retryable failure must win over the happy path.
  await expect(page.locator('#statusPill')).toHaveAttribute('data-status', 'attention');
  await expect(page.locator('#statAttention')).toHaveText('1');

  const recent = page.locator('#recentTimeline .tl-item');
  await expect(recent).toHaveCount(2);
  await expect(recent.filter({ hasText: 'Rate limited' })).toContainText('waited 1m');

  await page.click('.nav-item[data-tab="activity"]');
  await expect(page.locator('#badgeAttention')).toHaveText('1');

  // Filtering narrows to one kind.
  await page.selectOption('#activityFilter', 'recovered');
  await expect(page.locator('#activityTimeline .tl-item')).toHaveCount(1);
  await expect(page.locator('#activityTimeline .tl-item')).toContainText('Rate limited');
});

test('event text is rendered as text, never as markup', async () => {
  const sandbox = fx.makeSandbox('xss');
  fx.writeEvents(sandbox, [
    {
      kind: 'recovered',
      label: 'Rate limited',
      cwd: 'C:/work/x',
      // API error strings are untrusted input; this must never become an element.
      detail: '<img src=x onerror="window.__pwned=1"> and <b>bold</b>',
    },
  ]);
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  const item = page.locator('#recentTimeline .tl-item').first();
  await expect(item.locator('.tl-detail')).toContainText('<img src=x');
  expect(await item.locator('.tl-detail img').count()).toBe(0);
  expect(await item.locator('.tl-detail b').count()).toBe(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('pausing protection changes the status and persists to disk', async () => {
  const sandbox = fx.makeSandbox('pause');
  fx.writeSession(sandbox, { pid: process.pid, status: 'busy' });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await expect(page.locator('#statusPill')).toHaveAttribute('data-status', 'running');
  await page.click('#btnToggleProtection');

  await expect(page.locator('#statusPill')).toHaveAttribute('data-status', 'paused');
  await expect(page.locator('#statProtection')).toHaveText('Off');
  await expect(page.locator('#btnToggleProtection')).toHaveText('Resume protection');
  await expect.poll(() => fx.savedValue(sandbox, 'enabled')).toBe(false);

  // And it comes back.
  await page.click('#btnToggleProtection');
  await expect(page.locator('#statusPill')).toHaveAttribute('data-status', 'running');
  await expect.poll(() => fx.savedValue(sandbox, 'enabled')).toBe(true);
});

test('the hook warning banner appears only until hooks are installed', async () => {
  const sandbox = fx.makeSandbox('hookbanner');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await expect(page.locator('#hookBanner')).toBeVisible();
  await page.click('#btnInstallHooks');

  await expect(page.locator('#hookBanner')).toBeHidden();
  await expect(latestToast(page)).toContainText('Hooks installed');

  // The settings actually written must be what Claude Code will honour.
  const settings = fx.readClaudeSettings(sandbox);
  expect(Object.keys(settings.hooks)).toContain('StopFailure');
  const hook = settings.hooks.StopFailure[0].hooks[0];
  expect(hook.asyncRewake).toBe(true);
  expect(hook.command).toMatch(/lifeline-hook\.js/);
});

test('feature toggles persist and survive a restart', async () => {
  const sandbox = fx.makeSandbox('toggles');
  ctx = await fx.launch(sandbox);
  await ctx.page.click('.nav-item[data-tab="settings"]');

  const row = ctx.page.locator('.toggle-row').filter({ hasText: 'Nudge after tool timeouts' });
  const box = row.locator('input[type=checkbox]');
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked();

  await expect.poll(() => fx.savedValue(sandbox, 'features.toolFailureRecovery')).toBe(true);

  // Restart: the saved value must come back, which is what makes it a setting
  // rather than a session-local UI state.
  await fx.close(ctx);
  ctx = await fx.launch(sandbox);
  await ctx.page.click('.nav-item[data-tab="settings"]');
  await expect(
    ctx.page.locator('.toggle-row').filter({ hasText: 'Nudge after tool timeouts' }).locator('input[type=checkbox]')
  ).toBeChecked();
});

test('a limit outside its allowed range is rejected and reverted', async () => {
  const sandbox = fx.makeSandbox('limits');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="settings"]');

  const field = page.locator('.field').filter({ hasText: 'Attempts per prompt' }).locator('input');
  await expect(field).toHaveValue('5');

  await field.fill('0');
  await field.blur();
  await expect(latestToast(page)).toContainText('must be between');
  await expect(field).toHaveValue('5');
  // Rejected outright: the bad value must never reach disk. Nothing has been
  // saved at this point, so the setting is still at its default.
  expect(fx.savedValue(sandbox, 'limits.maxAttemptsPerPrompt')).not.toBe(0);

  // A value inside the range is accepted.
  await field.fill('8');
  await field.blur();
  await expect.poll(() => fx.savedValue(sandbox, 'limits.maxAttemptsPerPrompt')).toBe(8);
});

test('a partial save does not blank out unrelated settings', async () => {
  const sandbox = fx.makeSandbox('merge');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="settings"]');

  // Change two unrelated things; both must end up in the file together.
  await page.locator('.toggle-row').filter({ hasText: 'Sound with notifications' }).locator('input').click();
  await expect.poll(() => fx.savedValue(sandbox, 'features.soundAlerts')).toBe(true);

  await page.selectOption('#accentSelect', 'emerald');
  await expect.poll(() => fx.savedValue(sandbox, 'ui.accent')).toBe('emerald');

  const cfg = fx.readConfig(sandbox);
  expect(cfg.features.soundAlerts).toBe(true);
  expect(cfg.features.apiErrorRecovery).toBe(true);
  expect(cfg.limits.maxAttemptsPerPrompt).toBe(5);
});

test('policies for non-retryable classes are labelled manual and off by default', async () => {
  const sandbox = fx.makeSandbox('policies');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="settings"]');

  // All ten real error classes must be configurable.
  await expect(page.locator('#policyList .policy-row')).toHaveCount(10);

  const billing = page.locator('.policy-row').filter({ hasText: 'Billing problem' });
  await expect(billing.locator('.chip')).toHaveText('manual');
  await expect(billing.locator('input[type=checkbox]')).not.toBeChecked();
  // Numeric fields are disabled while the class is not resumed — a wait time on
  // something that never retries would be meaningless.
  await expect(billing.locator('input[type=number]').first()).toBeDisabled();

  const rate = page.locator('.policy-row').filter({ hasText: 'Rate limited' });
  await expect(rate.locator('input[type=checkbox]')).toBeChecked();
  await expect(rate.locator('input[type=number]').first()).toHaveValue('60000');
});

test('theme switches both ways and the choice is saved', async () => {
  const sandbox = fx.makeSandbox('theme');
  fx.writeConfig(sandbox, { ui: { theme: 'dark', startMinimised: false } });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.click('#themeToggle');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => fx.savedValue(sandbox, 'ui.theme')).toBe('light');

  await page.click('#themeToggle');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Light theme must stay readable, not just differently coloured.
  await page.click('#themeToggle');
  const contrast = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return { bg: s.getPropertyValue('--bg').trim(), text: s.getPropertyValue('--text').trim() };
  });
  expect(contrast.bg).not.toBe(contrast.text);
});

test('every accent choice applies immediately', async () => {
  const sandbox = fx.makeSandbox('accent');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="settings"]');

  for (const accent of ['blue', 'emerald', 'amber', 'violet']) {
    await page.selectOption('#accentSelect', accent);
    await expect(page.locator('html')).toHaveAttribute('data-accent', accent);
  }
});

test('resetting settings restores every default', async () => {
  const sandbox = fx.makeSandbox('reset');
  fx.writeConfig(sandbox, {
    enabled: false,
    features: { apiErrorRecovery: false, soundAlerts: true },
    limits: { maxAttemptsPerPrompt: 42 },
    ui: { theme: 'light', startMinimised: false },
  });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await expect(page.locator('#statusPill')).toHaveAttribute('data-status', 'paused');
  await page.click('.nav-item[data-tab="settings"]');
  await page.click('#btnResetConfig');

  await expect(latestToast(page)).toContainText('defaults');
  await expect.poll(() => fx.savedValue(sandbox, 'limits.maxAttemptsPerPrompt')).toBe(5);
  const cfg = fx.readConfig(sandbox);
  expect(cfg.enabled).toBe(true);
  expect(cfg.features.apiErrorRecovery).toBe(true);
  expect(cfg.features.soundAlerts).toBe(false);
});

test('navigation reaches all five tabs and the about tab lists real paths', async () => {
  const sandbox = fx.makeSandbox('nav');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  for (const tab of ['sessions', 'activity', 'settings', 'about', 'dashboard']) {
    await page.click(`.nav-item[data-tab="${tab}"]`);
    await expect(page.locator(`.tab[data-tab="${tab}"]`)).toBeVisible();
    await expect(page.locator(`.nav-item[data-tab="${tab}"]`)).toHaveClass(/active/);
  }

  await page.click('.nav-item[data-tab="about"]');
  const paths = page.locator('#aboutPaths');
  await expect(paths).toContainText('lifeline');
  await expect(paths).toContainText('lifeline-hook.js');
});

test('the renderer is sandboxed: no Node reachable from page scripts', async () => {
  const sandbox = fx.makeSandbox('security');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  const probe = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    module: typeof window.module,
    // Only the explicit bridge should exist.
    lifeline: typeof window.lifeline,
  }));
  expect(probe.require).toBe('undefined');
  expect(probe.process).toBe('undefined');
  expect(probe.module).toBe('undefined');
  expect(probe.lifeline).toBe('object');
});

test('closing the window hides it instead of quitting, so watching continues', async () => {
  const sandbox = fx.makeSandbox('hide');
  ctx = await fx.launch(sandbox);
  const { app, page } = ctx;

  await page.click('#btnClose');
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);

  // The process is still alive — the window merely went to the tray.
  const stillRunning = await app.evaluate(({ app: a }) => !!a);
  expect(stillRunning).toBe(true);
});

test('a corrupt config file does not stop the app from starting', async () => {
  const sandbox = fx.makeSandbox('corrupt');
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(sandbox.lifelineHome, 'config.json'), '{ this is not json', 'utf8');

  ctx = await fx.launch(sandbox);
  // Falls back to defaults rather than refusing to run.
  await expect(ctx.page.locator('#statusPill')).toHaveAttribute('data-status', /waiting|running/);
  await expect(ctx.page.locator('#statProtection')).toHaveText(/On|Partial/);
});

test('a torn line in the event log is skipped, not fatal', async () => {
  const sandbox = fx.makeSandbox('torn');
  const fs = require('fs');
  const path = require('path');
  fx.writeEvents(sandbox, [{ kind: 'recovered', label: 'Rate limited', detail: 'first' }]);
  // Simulates a crash mid-append.
  fs.appendFileSync(path.join(sandbox.lifelineHome, 'events.jsonl'), '{"kind":"recov', 'utf8');

  ctx = await fx.launch(sandbox);
  await expect(ctx.page.locator('#recentTimeline .tl-item')).toHaveCount(1);
  await expect(ctx.page.locator('#recentTimeline .tl-item')).toContainText('Rate limited');
});

test('a recovery written while the app is open shows up without a restart', async () => {
  const sandbox = fx.makeSandbox('live');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await expect(page.locator('#recentTimeline .empty')).toBeVisible();

  // The moment a session is rescued is the one the user cares about, so the app
  // watches the log rather than waiting for its next poll.
  fx.writeEvents(sandbox, [
    { kind: 'recovered', label: 'API overloaded', errorClass: 'overloaded', cwd: 'C:/work/live', detail: 'Resumed after api overloaded (attempt 1).', attemptNumber: 1 },
  ]);

  await expect(page.locator('#recentTimeline .tl-item')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#recentTimeline .tl-item')).toContainText('API overloaded');
});

test('uninstalling hooks removes them and brings the warning back', async () => {
  const sandbox = fx.makeSandbox('uninstall');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="settings"]');
  await page.click('#btnInstallHooks2');
  await expect.poll(() => Object.keys(fx.readClaudeSettings(sandbox).hooks || {}).length).toBeGreaterThan(0);

  await page.click('#btnUninstallHooks');
  await expect(latestToast(page)).toContainText('Removed hooks');
  await expect.poll(() => {
    const s = fx.readClaudeSettings(sandbox);
    return Object.keys((s && s.hooks) || {}).length;
  }).toBe(0);

  await page.click('.nav-item[data-tab="dashboard"]');
  await expect(page.locator('#hookBanner')).toBeVisible();
});

test('installing hooks leaves a user’s unrelated hooks untouched', async () => {
  const sandbox = fx.makeSandbox('preserve');
  const fs = require('fs');
  const path = require('path');
  // Someone else's configuration. Losing this would be a serious regression.
  fs.writeFileSync(
    path.join(sandbox.claudeHome, 'settings.json'),
    JSON.stringify({
      model: 'opus',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
      },
    }),
    'utf8'
  );

  ctx = await fx.launch(sandbox);
  await ctx.page.click('.nav-item[data-tab="settings"]');
  await ctx.page.click('#btnInstallHooks2');
  await expect(latestToast(ctx.page)).toContainText('Hooks installed');

  const settings = fx.readClaudeSettings(sandbox);
  expect(settings.model).toBe('opus');
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('echo mine');
  expect(settings.hooks.StopFailure).toBeTruthy();
});

test('the coverage panel explains all ten failure classes', async () => {
  const sandbox = fx.makeSandbox('coverage');
  ctx = await fx.launch(sandbox);
  const items = ctx.page.locator('#coverageList .cov-item');
  await expect(items).toHaveCount(10);

  // The retry asymmetry is the design's core claim, so it must be visible.
  await expect(items.filter({ hasText: 'Rate limited' })).toContainText('Auto-resume');
  await expect(items.filter({ hasText: 'Context overflow' })).toContainText('Compact + resume');
  await expect(items.filter({ hasText: 'Authentication failed' })).toContainText('Alert you');
  await expect(items.filter({ hasText: 'Billing problem' })).toContainText('Alert you');
});
