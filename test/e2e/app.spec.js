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

test('hooks install themselves on first launch, so a fresh install protects nothing by accident', async () => {
  const sandbox = fx.makeSandbox('autoinstall');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  // The whole point of auto-install: nobody has to find a button for recovery to
  // work. So the warning banner must never appear on a clean machine.
  await expect(page.locator('#hookBanner')).toBeHidden();

  // The settings actually written must be what Claude Code will honour.
  await expect.poll(() => Object.keys((fx.readClaudeSettings(sandbox) || {}).hooks || {})).toContain('StopFailure');
  const settings = fx.readClaudeSettings(sandbox);
  const hook = settings.hooks.StopFailure[0].hooks[0];
  expect(hook.asyncRewake).toBe(true);
  expect(hook.command).toMatch(/lifeline-hook\.js/);
});

test('with auto-install off the banner warns, and the button still installs', async () => {
  const sandbox = fx.makeSandbox('hookbanner');
  // Opting out is what makes the banner reachable at all — and the banner is the
  // only thing telling a user in that state that nothing is protected.
  fx.writeConfig(sandbox, { hooks: { autoInstall: false, optedOut: false } });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await expect(page.locator('#hookBanner')).toBeVisible();
  expect(fx.readClaudeSettings(sandbox)).toBe(null);

  await page.click('#btnInstallHooks');

  await expect(page.locator('#hookBanner')).toBeHidden();
  await expect(latestToast(page)).toContainText('Hooks installed');
  expect(Object.keys(fx.readClaudeSettings(sandbox).hooks)).toContain('StopFailure');
});

test('feature toggles persist and survive a restart', async () => {
  const sandbox = fx.makeSandbox('toggles');
  ctx = await fx.launch(sandbox);
  // Recovery behaviours live on Coverage; Settings keeps the tuning knobs.
  await ctx.page.click('.nav-item[data-tab="coverage"]');

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
  await ctx.page.click('.nav-item[data-tab="coverage"]');
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

test('per-failure tuning is disabled for classes that never retry', async () => {
  const sandbox = fx.makeSandbox('policies');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="settings"]');

  // All ten real error classes must be tunable.
  await expect(page.locator('#policyList .policy-row')).toHaveCount(10);

  const billing = page.locator('.policy-row').filter({ hasText: 'Billing problem' });
  await expect(billing.locator('.chip')).toHaveText('alert only');
  // Numeric fields are disabled while the class is not resumed — a wait time on
  // something that never retries would be meaningless.
  await expect(billing.locator('input[type=number]').first()).toBeDisabled();

  const rate = page.locator('.policy-row').filter({ hasText: 'Rate limited' });
  await expect(rate.locator('input[type=number]').first()).toBeEnabled();
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

/* ============================== coverage =============================== */

test('the coverage tab lists all ten failure classes with their outcomes', async () => {
  const sandbox = fx.makeSandbox('coverage');
  ctx = await fx.launch(sandbox);
  await ctx.page.click('.nav-item[data-tab="coverage"]');

  const cards = ctx.page.locator('#coverageClasses .cov-card');
  await expect(cards).toHaveCount(10);

  // The retry asymmetry is the design's core claim, so it must be visible.
  await expect(cards.filter({ hasText: 'Rate limited' })).toContainText('Auto-resume');
  await expect(cards.filter({ hasText: 'Context overflow' })).toContainText('Compact + resume');
  await expect(cards.filter({ hasText: 'Authentication failed' })).toContainText('Alert you');
  await expect(cards.filter({ hasText: 'Billing problem' })).toContainText('Alert you');

  // State is carried on the card, so "covered" is legible at a glance.
  await expect(cards.filter({ hasText: 'Rate limited' })).toHaveAttribute('data-on', 'true');
  await expect(cards.filter({ hasText: 'Billing problem' })).toHaveAttribute('data-on', 'false');
});

test('the dashboard coverage widget shows totals that match the coverage tab', async () => {
  const sandbox = fx.makeSandbox('cov-widget');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  // Totals only on the dashboard — the per-class detail is a tab away.
  const enabled = await page.locator('#covEnabled').textContent();
  const disabled = await page.locator('#covDisabled').textContent();
  expect(Number(enabled)).toBeGreaterThan(0);
  expect(Number(disabled)).toBeGreaterThan(0);

  await page.click('.side-stack [data-goto="coverage"]');
  await expect(page.locator('.tab[data-tab="coverage"]')).toBeVisible();
  await expect(page.locator('#covStatEnabled')).toHaveText(enabled.trim());
  await expect(page.locator('#covStatDisabled')).toHaveText(disabled.trim());
});

test('turning a class off in coverage persists and collapses it to alert-only', async () => {
  const sandbox = fx.makeSandbox('cov-off');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="coverage"]');

  const card = page.locator('#coverageClasses .cov-card').filter({ hasText: 'Rate limited' });
  await card.locator('.switch input').click();

  await expect(card).toHaveAttribute('data-on', 'false');
  await expect(card).toContainText('Alert you');
  await expect.poll(() => fx.savedValue(sandbox, 'policies.rate_limit.resume')).toBe(false);
});

test('enabling a hopeless class is held back by the guard, and says so', async () => {
  const sandbox = fx.makeSandbox('cov-guard');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="coverage"]');

  const card = page.locator('#coverageClasses .cov-card').filter({ hasText: 'Authentication failed' });
  await card.locator('.switch input').click();

  // The switch is honoured in config, but the resolved outcome is still notify —
  // and the card explains the discrepancy rather than looking broken.
  await expect.poll(() => fx.savedValue(sandbox, 'policies.authentication_failed.resume')).toBe(true);
  await expect(card.locator('.cov-card-blocked')).toBeVisible();
  await expect(card).toContainText('Alert you');
  await expect(card).toHaveAttribute('data-on', 'false');

  // And the way out is on the card itself.
  await card.locator('.cov-card-blocked .link-btn').click();
  await expect.poll(() => fx.savedValue(sandbox, 'features.respectNonRetryable')).toBe(false);
  await expect(card).toHaveAttribute('data-on', 'true');
  await expect(card).toContainText('Auto-resume');
});

test('“enable everything” does not silently disarm the safety guard', async () => {
  const sandbox = fx.makeSandbox('cov-all');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="coverage"]');
  await page.click('#btnCoverageAll');

  await expect(latestToast(page)).toContainText('still alert');
  await expect.poll(() => fx.savedValue(sandbox, 'features.toolFailureRecovery')).toBe(true);
  await expect.poll(() => fx.savedValue(sandbox, 'features.respectNonRetryable')).toBe(true);
});

/* ============================== analytics ============================== */

test('analytics reports on the sessions it finds in transcripts', async () => {
  const sandbox = fx.makeSandbox('analytics');
  fx.writeTranscript(sandbox, {
    slug: 'payments-api',
    id: 'an-1',
    title: 'Refactor the billing module',
    cwd: 'C:/work/payments-api',
    messages: 6,
  });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="analytics"]');
  // A scan runs in a worker, so the numbers arrive a moment after the tab does.
  await expect(page.locator('#anSessions')).toHaveText('1', { timeout: 20_000 });
  await expect(page.locator('#anHours')).not.toHaveText('—');

  // Cost is derived, and the UI has to say so — an authoritative-looking number
  // that is really an estimate is the failure mode.
  await expect(page.locator('#estimateNote')).toContainText('estimate');

  const row = page.locator('#analyticsBodyRows tr').first();
  await expect(row).toContainText('Refactor the billing module');
  await expect(row).toContainText('payments-api');
});

test('the activity chart keeps a bar per day even with nothing recorded', async () => {
  const sandbox = fx.makeSandbox('analytics-empty');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="analytics"]');

  await expect(page.locator('#anSessions')).toHaveText('0', { timeout: 20_000 });
  await expect(page.locator('#analyticsEmpty')).toBeVisible();
  await expect(page.locator('#chartTag')).toContainText('no activity');
});

test('the range selector switches the chart from days to months', async () => {
  const sandbox = fx.makeSandbox('analytics-range');
  fx.writeTranscript(sandbox, { id: 'an-r', messages: 4 });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="analytics"]');
  await expect(page.locator('#anSessions')).toHaveText('1', { timeout: 20_000 });

  await expect(page.locator('#chartTitle')).toHaveText('Daily activity');
  await expect(page.locator('#activityChart .chart-col')).toHaveCount(7);

  // A year at day resolution is 365 bars, which is why the grain changes.
  await page.selectOption('#analyticsRange', 'year');
  await expect(page.locator('#chartTitle')).toHaveText('Monthly activity');
  await expect(page.locator('#activityChart .chart-col')).toHaveCount(12);
});

test('turning analytics off stops the scan and explains why the tab is empty', async () => {
  const sandbox = fx.makeSandbox('analytics-off');
  fx.writeConfig(sandbox, { version: 1, analytics: { enabled: false } });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="analytics"]');
  await expect(page.locator('#analyticsOffBanner')).toBeVisible();
  await expect(page.locator('#analyticsBody')).toBeHidden();
  // Both views read the same switch, so neither is left visible and empty.
  await expect(page.locator('#usageBody')).toBeHidden();
  await expect(page.locator('#dashWeekHint')).toBeHidden();
});

/* ---------------------------- usage & models ---------------------------- */

test('the usage view reads Claude Code’s own /usage statistics', async () => {
  const sandbox = fx.makeSandbox('usage');
  fx.writeClaudeStats(sandbox, {
    totalSessions: 267,
    totalMessages: 107842,
    modelUsage: {
      'claude-opus-4-8': { inputTokens: 1e6, outputTokens: 2e6, cacheReadInputTokens: 5e8, costUSD: 0 },
      'claude-haiku-4-5-20251001': { inputTokens: 1e7, outputTokens: 2e7, cacheReadInputTokens: 9e8, costUSD: 0 },
    },
  });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="analytics"]');
  await page.click('#analyticsViews .seg-btn[data-view="usage"]');

  await expect(page.locator('#usSessions')).toHaveText('267', { timeout: 20_000 });
  await expect(page.locator('#usMessages')).toHaveText('107.8K');
  await expect(page.locator('#usageMissing')).toBeHidden();

  // The range selector has no meaning for whole-history totals, so it goes away
  // rather than sitting there inert.
  await expect(page.locator('#analyticsRange')).toBeHidden();

  // Ordered by cost, not tokens: haiku has more tokens and costs far less.
  const rows = page.locator('#usModelBody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('opus-4-8');

  // Cost is Lifeline's, because /usage reports $0 per model on a subscription.
  await expect(page.locator('#usageNote')).toContainText("cost column is Lifeline's");
  await expect(page.locator('#usCost')).not.toHaveText('—');

  await expect(page.locator('#usHourChart .chart-col')).toHaveCount(24);
  await expect(page.locator('#usRecords .hero-metric')).toHaveCount(4);
});

test('with no stats file the usage view asks the user to run /usage', async () => {
  const sandbox = fx.makeSandbox('usage-missing');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="analytics"]');
  await page.click('#analyticsViews .seg-btn[data-view="usage"]');

  await expect(page.locator('#usageMissing')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#usageMissing')).toContainText('/usage');
  await expect(page.locator('#usageContent')).toBeHidden();
});

test('a stats file from an unknown version is refused rather than misread', async () => {
  const sandbox = fx.makeSandbox('usage-version');
  // The real risk: a future Claude Code renames fields, an optimistic reader
  // finds something, and the app shows a confidently wrong total.
  fx.writeClaudeStats(sandbox, { version: 99, totalSessions: 5 });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="analytics"]');
  await page.click('#analyticsViews .seg-btn[data-view="usage"]');
  await expect(page.locator('#usageMissing')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#usSessions')).not.toHaveText('5');
});

/* =========================== settings grouping ========================== */

test('settings are grouped, and the jump list scrolls to each group', async () => {
  const sandbox = fx.makeSandbox('settings-nav');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="settings"]');

  // One entry per group: the page was previously one long undifferentiated list.
  const items = page.locator('#settingsNav .settings-nav-item');
  await expect(items).toHaveCount(8);
  await expect(items.first()).toHaveText('Installation');

  await items.filter({ hasText: 'Analytics & cost' }).click();
  await expect(page.locator('#setAnalytics')).toBeInViewport();
  await expect(page.locator('#setAnalytics')).toHaveClass(/flash/);
});

test('a rate override is saved whole, and reset clears it', async () => {
  const sandbox = fx.makeSandbox('rates');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="settings"]');

  const row = page.locator('#ratesBody tr').first();
  const model = (await row.locator('.cell-main').textContent()).trim();
  await row.locator('input').first().fill('123');
  await row.locator('input').first().blur();

  // The whole row is written, not just the edited cell: a partial override would
  // let the other three rates fall back to the mid-tier default. And the values
  // filled in must be the model's real published rates — seeding them with zeros
  // would price every other token kind at nothing, which reads as a suspiciously
  // cheap day rather than as a bug.
  await expect.poll(() => fx.savedValue(sandbox, `analytics.rates.${model}.input`)).toBe(123);
  const { RATES } = require('../../src/shared/pricing');
  for (const kind of ['output', 'cacheWrite', 'cacheRead']) {
    await expect.poll(() => fx.savedValue(sandbox, `analytics.rates.${model}.${kind}`)).toBe(RATES[model][kind]);
  }

  await page.click('#btnResetRates');
  await expect.poll(() => fx.savedValue(sandbox, 'analytics.rates')).toEqual({});
});

/* ================================ about ================================= */

test('the about page reports live figures, not static copy', async () => {
  const sandbox = fx.makeSandbox('about');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="about"]');

  await expect(page.locator('#aboutMetrics .hero-metric')).toHaveCount(4);
  await expect(page.locator('#aboutMetrics')).toContainText('checks enabled');
  await expect(page.locator('#aboutSteps .step')).toHaveCount(4);
  await expect(page.locator('#aboutRetryCards .split-card')).toHaveCount(2);

  // Paths are the practical part of an about page: they have to be real and
  // openable, not decoration.
  const rows = page.locator('#aboutPaths .path-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.filter({ hasText: 'Data folder' })).toContainText(sandbox.lifelineHome);

  // The provenance credit, which is a claim about the project and not decoration.
  await expect(page.locator('.built-with')).toContainText('Claude Opus 5');
  await expect(page.locator('.built-with')).toContainText('Claude Code');
  await expect(page.locator('#aboutFoot')).toContainText('Not affiliated with Anthropic');
});

test('the about recovery count agrees with the timeline, including recoveries older than the ledger keeps', async () => {
  const sandbox = fx.makeSandbox('aboutcount');
  const hour = 3_600_000;
  // Deliberately straddling the ledger's 48-hour prune window. The count used to
  // come from the ledger's attempt total, so on any machine older than two days
  // the about page read "0 recoveries logged" directly above a list of them —
  // exactly the inconsistency the dashboard already guards against.
  fx.writeEvents(sandbox, [
    { at: Date.now() - 200 * hour, kind: 'recovered', sessionId: 'old1', errorClass: 'overloaded', label: 'API overloaded', strategy: 'resume' },
    { at: Date.now() - 100 * hour, kind: 'recovered', sessionId: 'old2', errorClass: 'rate_limit', label: 'Rate limited', strategy: 'resume' },
    { at: Date.now() - 2 * hour, kind: 'recovered', sessionId: 'new1', errorClass: 'server_error', label: 'Server error', strategy: 'resume' },
  ]);
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  // The dashboard's figure is scoped to today, and stays that way.
  await expect(page.locator('#statRecovered')).toHaveText('1');

  await page.click('.nav-item[data-tab="about"]');
  const logged = page.locator('#aboutMetrics .hero-metric').filter({ hasText: 'recoveries logged' });
  await expect(logged.locator('.hero-metric-num')).toHaveText('3');

  // And the same three are actually listed, so the number is not just a number.
  // Filtered, because the activity tab shows every kind — including whatever the
  // app logged about its own startup.
  await page.click('.nav-item[data-tab="activity"]');
  await page.selectOption('#activityFilter', 'recovered');
  await expect(page.locator('#activityTimeline .tl-item')).toHaveCount(3);
});

test('outbound links name a key and are opened by main, never loaded in-app', async () => {
  const sandbox = fx.makeSandbox('links');
  ctx = await fx.launch(sandbox);
  const { page, app } = ctx;

  // The security property, asserted in the markup: a URL anywhere in the
  // renderer would mean an injected string could become a browser launch.
  const keys = await page.locator('[data-link]').evaluateAll((els) => els.map((e) => e.dataset.link));
  expect(keys.length).toBeGreaterThan(0);
  expect([...new Set(keys)].sort()).toEqual(['issues', 'releases', 'repo']);
  for (const k of keys) expect(k).not.toMatch(/https?:/);

  // Every key must actually resolve, or a button would be a silent no-op.
  for (const key of ['repo', 'releases', 'issues']) {
    const opened = await app.evaluate(async ({ shell, BrowserWindow }, k) => {
      const calls = [];
      const real = shell.openExternal;
      shell.openExternal = (url) => {
        calls.push(url);
        return Promise.resolve();
      };
      try {
        // Invoked the way the renderer does it, through the preload bridge, so
        // this exercises the real channel rather than a copy of the URL table.
        const win = BrowserWindow.getAllWindows()[0];
        await win.webContents.executeJavaScript(`window.lifeline.openLink(${JSON.stringify(k)})`);
        return calls;
      } finally {
        shell.openExternal = real;
      }
    }, key);
    expect(opened.length, `${key} did not resolve to a URL`).toBe(1);
    expect(opened[0]).toMatch(/^https:\/\/github\.com\/.+claude-lifeline/);
  }

  // And an unknown key opens nothing rather than falling through to something.
  const stray = await app.evaluate(async ({ shell, BrowserWindow }) => {
    const calls = [];
    const real = shell.openExternal;
    shell.openExternal = (url) => {
      calls.push(url);
      return Promise.resolve();
    };
    try {
      const win = BrowserWindow.getAllWindows()[0];
      const ok = await win.webContents.executeJavaScript(
        'window.lifeline.openLink("https://evil.example/")'
      );
      return { calls, ok };
    } finally {
      shell.openExternal = real;
    }
  });
  expect(stray.calls).toEqual([]);
  expect(stray.ok).toBe(false);
});

/* ============================== migration ============================== */

test('a config from an older schema is upgraded rather than reset', async () => {
  const sandbox = fx.makeSandbox('migrate');
  // Settings a user would notice losing.
  fx.writeConfig(sandbox, {
    version: 1,
    enabled: false,
    ui: { accent: 'amber', theme: 'light' },
    limits: { maxAttemptsPerDay: 42 },
  });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await expect(page.locator('#statusPill')).toHaveAttribute('data-status', 'paused');
  await page.click('.nav-item[data-tab="settings"]');
  await expect(page.locator('#themeSelect')).toHaveValue('light');
  expect(fx.savedValue(sandbox, 'limits.maxAttemptsPerDay')).toBe(42);
});

test('settings written by a newer version are preserved, not stripped', async () => {
  const sandbox = fx.makeSandbox('migrate-newer');
  fx.writeConfig(sandbox, { version: 99, enabled: true, someFutureFeature: { nested: true } });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  // Changing anything rewrites the file; the unknown key has to come through, or
  // installing an older build once would cost the user their v2 settings.
  await page.click('.nav-item[data-tab="settings"]');
  await page.click('#themeSelect');
  await page.selectOption('#themeSelect', 'dark');
  await expect.poll(() => fx.savedValue(sandbox, 'someFutureFeature.nested')).toBe(true);
});
