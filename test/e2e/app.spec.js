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
const fs = require('fs');
const path = require('path');
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

test('prompt-completion notifications are off until asked for, then persist', async () => {
  /**
   * Off by default is the assertion that matters. This one fires on every finished
   * prompt rather than on a failure, so an upgrade that silently switched it on
   * would start interrupting far more than the app did before — and the setting
   * someone reaches for after that is "notifications, off".
   */
  const sandbox = fx.makeSandbox('prompt-done');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="settings"]');

  const row = page.locator('.toggle-row').filter({ hasText: 'Tell me when a prompt finishes' });
  const box = row.locator('input[type=checkbox]');
  await expect(box).not.toBeChecked();

  await box.click();
  await expect.poll(() => fx.savedValue(sandbox, 'features.promptCompleteNotifications')).toBe(true);

  await fx.close(ctx);
  ctx = await fx.launch(sandbox);
  await ctx.page.click('.nav-item[data-tab="settings"]');
  await expect(
    ctx.page.locator('.toggle-row').filter({ hasText: 'Tell me when a prompt finishes' }).locator('input[type=checkbox]')
  ).toBeChecked();
});

test('the hook’s completion signal toasts immediately, once, and audibly', async () => {
  /**
   * The unit suite covers the signal file and the freshness rules; this proves the
   * wiring — that the app is really watching, that the feature flag is consulted,
   * that one write cannot become several toasts, and that the toast is not silent.
   *
   * The timing assertion is the point of the rewrite. Detection used to ride the
   * five-second poll, so the toast could arrive after the user had already looked
   * back at the terminal. It is now driven by fs.watch, so a generous-but-real
   * ceiling of two seconds would fail on the old implementation.
   *
   * Notification.show is stubbed in the main process rather than asserted against a
   * real Windows toast: there is no API to read back what Action Center displayed,
   * and waiting on a visible toast would make the test depend on Focus Assist.
   */
  const sandbox = fx.makeSandbox('prompt-done-fires');
  fx.writeConfig(sandbox, { version: 1, features: { promptCompleteNotifications: false } });
  ctx = await fx.launch(sandbox);
  const { app, page } = ctx;

  /**
   * Installed once, then read separately. Doing both in one repeatedly-polled
   * evaluate makes Playwright drop the result ("Resulting promise was garbage
   * collected"), so the spy and the readback are deliberately two calls.
   */
  await app.evaluate(({ Notification }) => {
    globalThis.__toasts = [];
    // Deliberately does not call through: this suite must not leave toasts in the
    // user's Action Center.
    Notification.prototype.show = function patched() {
      globalThis.__toasts.push({ title: this.title, body: this.body, silent: this.silent, at: Date.now() });
    };
  });
  /**
   * Read after a fixed settle, never in a poll.
   *
   * An `app.evaluate` issued into the window where the main process is posting a
   * notification gets abandoned by Playwright — "Resulting promise was garbage
   * collected" — so retry-until-nonempty fails for a reason that has nothing to do
   * with Lifeline. Waiting first and reading once is both reliable and a stronger
   * assertion: the toast has to have arrived within the settle, not merely by the
   * end of a ten-second poll.
   */
  const settle = () => page.waitForTimeout(1_500);
  const collect = async () => JSON.parse(await app.evaluate(() => JSON.stringify(globalThis.__toasts)));

  // Exactly what the Stop hook writes, so this exercises the real contract.
  const signal = (rec) =>
    fs.writeFileSync(path.join(sandbox.lifelineHome, 'last-completion.json'), JSON.stringify(rec), 'utf8');

  // With the feature off, a completion must stay silent.
  signal({ sessionId: 'done-1', cwd: 'C:/work/payments-api', name: null, at: Date.now() });
  await settle();
  expect(await collect()).toEqual([]);

  await page.click('.nav-item[data-tab="settings"]');
  await page.locator('.toggle-row').filter({ hasText: 'Tell me when a prompt finishes' }).locator('input[type=checkbox]').click();
  await expect.poll(() => fx.savedValue(sandbox, 'features.promptCompleteNotifications')).toBe(true);

  const wroteAt = Date.now();
  signal({ sessionId: 'done-1', cwd: 'C:/work/payments-api', name: null, at: wroteAt });
  await settle();

  const [toast] = await collect();
  expect(toast).toBeTruthy();
  expect(toast.title).toContain('finished');
  // The folder leaf identifies which session it was — a toast that says only
  // "a session finished" is useless with three of them running.
  expect(toast.body).toContain('payments-api');
  // Audible: a completion is the one notification actively being waited for.
  expect(toast.silent).toBe(false);
  /**
   * Immediate. This is the assertion the rewrite exists for: detection used to ride
   * the five-second poll, so this ceiling fails on the old implementation. Observed
   * at single-digit milliseconds — a second is slack for a loaded CI box.
   */
  expect(toast.at - wroteAt).toBeLessThan(1_000);

  /**
   * One write, one toast. fs.watch fires several times for a single write on
   * Windows, so without the timestamp dedupe this is where two or three appear.
   */
  await page.waitForTimeout(2_500);
  expect(await collect()).toHaveLength(1);

  // A second, genuinely new completion is announced again.
  signal({ sessionId: 'done-1', cwd: 'C:/work/payments-api', name: null, at: Date.now() });
  await settle();
  expect(await collect()).toHaveLength(2);
});

test('a stale completion signal is not announced when the app starts', async () => {
  /**
   * The signal file outlives the app, and the watcher can fire on startup. Opening
   * the tray must not announce a prompt that finished hours ago — the same reasoning
   * that stops an already-idle session being reported as newly finished.
   */
  const sandbox = fx.makeSandbox('prompt-done-stale');
  fx.writeConfig(sandbox, { version: 1, features: { promptCompleteNotifications: true } });
  fs.writeFileSync(
    path.join(sandbox.lifelineHome, 'last-completion.json'),
    JSON.stringify({ sessionId: 'old-1', cwd: 'C:/work/payments-api', name: null, at: Date.now() - 3_600_000 }),
    'utf8'
  );

  ctx = await fx.launch(sandbox);
  const { app, page } = ctx;
  const toasts = await app.evaluate(({ Notification }) => {
    globalThis.__toasts = [];
    Notification.prototype.show = function patched() {
      globalThis.__toasts.push({ title: this.title });
    };
    return globalThis.__toasts;
  });
  expect(toasts).toEqual([]);

  // Touching the file must not resurrect the old record either: it is stale by
  // timestamp, not merely already-seen.
  fs.appendFileSync(path.join(sandbox.lifelineHome, 'last-completion.json'), '', 'utf8');
  await page.waitForTimeout(1_500);
  expect(await app.evaluate(() => globalThis.__toasts)).toEqual([]);
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
  await page.locator('.toggle-row').filter({ hasText: 'Sound on failure notifications' }).locator('input').click();
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

/**
 * Contrast, measured rather than eyeballed.
 *
 * The semantic buttons put a status colour on a tint of itself, which is the
 * combination most likely to fall below AA — and the one least likely to be
 * noticed, because it still looks like a deliberate design. Both themes are
 * checked: the light palette is where these actually failed (--ok read 2.86:1
 * against its own tint), and the dark one is where a future "let's soften that"
 * edit would break next.
 */
test('status colours meet WCAG AA against the surfaces they sit on', async () => {
  const sandbox = fx.makeSandbox('contrast');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  const audit = () =>
    page.evaluate(() => {
      // Both notations have to be handled explicitly. `color-mix()` resolves to
      // `color(srgb 0.87 0.92 0.93)` — 0–1 floats — while plain colours come back
      // as `rgb(15, 157, 99)`. Canvas is not a shortcut here: assigning an
      // unsupported string to fillStyle is a silent no-op that leaves the previous
      // colour in place, so a canvas probe reports the tinted buttons as whatever
      // was painted before them and quietly passes.
      const rgb = (css) => {
        const n = (css.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        if (n.length < 3) return null;
        // srgb floats are 0–1; rgb() channels are 0–255. Nothing else uses this
        // function, so the notation prefix is the reliable discriminator.
        return css.startsWith('color(') ? n.map((v) => Math.round(v * 255)) : n;
      };
      const lum = (c) => {
        const s = c.map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
      };
      const ratio = (a, b) => {
        const la = lum(a);
        const lb = lum(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      };

      const out = [];
      for (const [sel, name] of [
        ['.btn.go', 'go button'],
        ['.btn.hold', 'hold button'],
        ['.btn.danger', 'danger button'],
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const fg = rgb(cs.color);
          const bg = rgb(cs.backgroundColor);
          out.push({
            desc: `${name} ${el.id ? '#' + el.id : ''}`,
            fontSize: parseFloat(cs.fontSize),
            // null rather than a number if either colour failed to parse, so an
            // unhandled notation surfaces as a failure instead of a false pass.
            ratio: fg && bg ? ratio(fg, bg) : null,
          });
        }
      }
      return { theme: document.documentElement.dataset.theme, out };
    });

  const problems = [];
  for (let i = 0; i < 2; i++) {
    // Both semantic buttons live on Settings, alongside the destructive ones.
    await page.click('.nav-item[data-tab="settings"]');
    const { theme, out } = await audit();
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      if (c.ratio === null) {
        problems.push(`${theme}: ${c.desc} — could not read its colours, so contrast is unverified`);
      } else if (c.ratio < 4.5) {
        // 4.5:1 is AA for normal text. These are all 13px, so the 3:1 large-text
        // allowance does not apply to any of them.
        problems.push(`${theme}: ${c.desc} is ${c.ratio.toFixed(2)}:1 at ${c.fontSize}px`);
      }
    }
    await page.click('#themeToggle');
  }

  expect(problems.join('\n')).toBe('');
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

test('navigation reaches every tab and the about tab lists real paths', async () => {
  const sandbox = fx.makeSandbox('nav');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  // Read off the sidebar rather than hard-coded, so adding a tab without wiring
  // its section — the exact bug History and Launchpad shipped with first — fails
  // here instead of being invisible until someone clicks it.
  const tabs = await page.locator('.nav-item').evaluateAll((els) => els.map((el) => el.dataset.tab));
  expect(tabs).toEqual(['dashboard', 'sessions', 'history', 'launchpad', 'analytics', 'coverage', 'activity', 'settings', 'about']);

  for (const tab of tabs) {
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

test('the sessions table shows what each live session has cost so far', async () => {
  const sandbox = fx.makeSandbox('session-cost');
  const id = 'cost-1';
  fx.writeSession(sandbox, { pid: process.pid, sessionId: id, cwd: 'C:/work/payments-api', status: 'busy' });
  // The cost comes from the transcript scan, joined to the live session by id —
  // the session file itself records no tokens.
  fx.writeTranscript(sandbox, { slug: 'payments-api', id, cwd: 'C:/work/payments-api', messages: 8 });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="sessions"]');
  // Located by its header rather than by column number, so reordering the table
  // does not silently point this at the wrong cell.
  const col = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#sessionTable thead th')).findIndex((th) => th.textContent.includes('Cost'))
  );
  expect(col).toBeGreaterThan(-1);
  const cell = page.locator('#sessionBody tr').first().locator('td').nth(col);

  // Before the scan lands the cell is a skeleton, not a zero: zero is a claim,
  // and this is an absence of data. It has to say "pending" to a screen reader
  // too, since the bar contains no text at all.
  await expect(cell).toHaveAttribute('aria-busy', 'true');
  await expect(cell.locator('.skel')).toBeVisible();

  // Opening Sessions kicks the scan off, so the figure arrives on its own.
  await expect(cell).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 });
  await expect(cell).toContainText('$');
  // Tokens in the tooltip: they are the evidence for a derived figure.
  await expect(cell).toHaveAttribute('title', /tokens/);
});

test('with analytics off the cost column says so rather than showing a zero', async () => {
  const sandbox = fx.makeSandbox('session-cost-off');
  fx.writeConfig(sandbox, { version: 1, analytics: { enabled: false } });
  fx.writeSession(sandbox, { pid: process.pid, sessionId: 'c-off', cwd: 'C:/work/demo', status: 'busy' });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.click('.nav-item[data-tab="sessions"]');
  // Located by its header rather than by column number, so reordering the table
  // does not silently point this at the wrong cell.
  const col = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#sessionTable thead th')).findIndex((th) => th.textContent.includes('Cost'))
  );
  expect(col).toBeGreaterThan(-1);
  const cell = page.locator('#sessionBody tr').first().locator('td').nth(col);
  // Not a skeleton, and not "$0.00" — no scan is going to arrive, and a zero
  // would read as a measured figure.
  await expect(cell).toHaveText('off');
  await expect(cell.locator('.skel')).toHaveCount(0);
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
  await page.click('#analyticsRange .range-btn[data-range="year"]');
  await expect(page.locator('#chartTitle')).toHaveText('Monthly activity');
  await expect(page.locator('#activityChart .chart-col')).toHaveCount(12);

  // Three months is still months, but a shorter axis than a year.
  await page.click('#analyticsRange .range-btn[data-range="quarter"]');
  await expect(page.locator('#chartTitle')).toHaveText('Monthly activity');
  await expect(page.locator('#activityChart .chart-col')).toHaveCount(3);
});

test('the range picker marks the selected range and slides its glider onto it', async () => {
  const sandbox = fx.makeSandbox('analytics-glider');
  fx.writeTranscript(sandbox, { id: 'an-g', messages: 4 });
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="analytics"]');
  await expect(page.locator('#anSessions')).toHaveText('1', { timeout: 20_000 });

  // Six ranges, exactly one selected, and the selection is exposed to a screen
  // reader rather than being carried by the highlight alone.
  await expect(page.locator('#analyticsRange .range-btn')).toHaveCount(6);
  await expect(page.locator('#analyticsRange .range-btn[aria-selected="true"]')).toHaveCount(1);
  await expect(page.locator('#analyticsRange .range-btn[data-range="week"]')).toHaveAttribute('aria-selected', 'true');

  // The glider is one element moved by transform, so "is it on the right button"
  // is a geometry question: its box has to sit over the active button's box.
  const onActive = async () =>
    page.evaluate(() => {
      const active = document.querySelector('#analyticsRange .range-btn.active');
      const glider = document.querySelector('#rangeGlider');
      if (!active || !glider) return null;
      const a = active.getBoundingClientRect();
      const g = glider.getBoundingClientRect();
      return { dx: Math.abs(a.x - g.x), dw: Math.abs(a.width - g.width), w: g.width };
    });

  const atWeek = await onActive();
  expect(atWeek).not.toBeNull();
  expect(atWeek.w).toBeGreaterThan(0); // a zero-width glider means it never measured
  expect(atWeek.dx).toBeLessThan(2);
  expect(atWeek.dw).toBeLessThan(2);

  await page.click('#analyticsRange .range-btn[data-range="half"]');
  await expect(page.locator('#analyticsRange .range-btn[data-range="half"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analyticsRange .range-btn[data-range="week"]')).toHaveAttribute('aria-selected', 'false');
  // Wait out the slide before measuring, or the transform is caught mid-flight.
  await page.waitForTimeout(400);

  const atHalf = await onActive();
  expect(atHalf.dx).toBeLessThan(2);
  expect(atHalf.dw).toBeLessThan(2);
});

test('both analytics tablists are driveable from the keyboard', async () => {
  const sandbox = fx.makeSandbox('analytics-keys');
  fx.writeTranscript(sandbox, { id: 'an-k', messages: 4 });
  fx.writeClaudeStats(sandbox);
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="analytics"]');
  await expect(page.locator('#anSessions')).toHaveText('1', { timeout: 20_000 });

  // role="tablist" tells a screen reader that arrows move between the options.
  // If they do not, the markup describes an interaction that does not exist.
  await page.click('#analyticsRange .range-btn[data-range="week"]');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#analyticsRange .range-btn[data-range="month"]')).toHaveAttribute('aria-selected', 'true');
  // Focus follows selection, so the next press continues from here.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#analyticsRange .range-btn[data-range="quarter"]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#analyticsRange .range-btn[data-range="month"]')).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('End');
  await expect(page.locator('#analyticsRange .range-btn[data-range="all"]')).toHaveAttribute('aria-selected', 'true');
  // Clamped, not wrapped: this is an ordered scale, so running off the end and
  // reappearing at a week would lose the reader's place.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#analyticsRange .range-btn[data-range="all"]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(page.locator('#analyticsRange .range-btn[data-range="week"]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#analyticsRange .range-btn[data-range="week"]')).toHaveAttribute('aria-selected', 'true');

  // The view switch carries the same role, and has to keep the same promise.
  await page.click('#analyticsViews .seg-btn[data-view="work"]');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#usageBody')).toBeVisible();
  await expect(page.locator('#analyticsViews .seg-btn[data-view="usage"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analyticsViews .seg-btn[data-view="work"]')).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#analyticsBody')).toBeVisible();
  await expect(page.locator('#analyticsViews .seg-btn[data-view="work"]')).toHaveAttribute('aria-selected', 'true');
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
  await expect(page.locator('#usageMissing')).toBeHidden({ timeout: 20_000 });

  // The range picker drives this view too, and it stays visible across both.
  await expect(page.locator('#analyticsRange')).toBeVisible();

  // All time, so these are the file's own whole-install totals rather than a
  // window summed from its per-date rows.
  await page.click('#analyticsRange .range-btn[data-range="all"]');
  await expect(page.locator('#usSessions')).toHaveText('267');
  await expect(page.locator('#usMessages')).toHaveText('107.8K');

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

test('the usage view windows its counts, and says which figures are apportioned', async () => {
  const sandbox = fx.makeSandbox('usage-range');
  // The fixture's per-date rows cover today and yesterday only, and mention just
  // opus. Whole-install totals are much larger — which is the whole point: a
  // windowed figure has to come from the dated rows, not from these.
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
  await expect(page.locator('#usageMissing')).toBeHidden({ timeout: 20_000 });

  // Past 7 days: 3 sessions yesterday + 9 today, summed from dailyActivity —
  // not the 267 the file reports for the whole install.
  await page.click('#analyticsRange .range-btn[data-range="week"]');
  await expect(page.locator('#usSessions')).toHaveText('12');
  await expect(page.locator('#usMessages')).toHaveText('480');
  await expect(page.locator('#usSessionsFoot')).toContainText('past 7 days');

  // Only opus appears in the dated rows, so haiku is absent from the window
  // rather than being carried in at its all-time size.
  await expect(page.locator('#usModelBody tr')).toHaveCount(1);
  await expect(page.locator('#usModelBody tr').first()).toContainText('opus-4-8');

  // A windowed cost cannot be measured from this cache, and the view says so
  // instead of presenting the estimate as fact.
  await expect(page.locator('#usCostFoot')).toContainText('apportioned');
  await expect(page.locator('#usageNote')).toContainText('apportioned');

  // Back to all time and the caveat goes away with it.
  await page.click('#analyticsRange .range-btn[data-range="all"]');
  await expect(page.locator('#usSessions')).toHaveText('267');
  await expect(page.locator('#usageNote')).not.toContainText('apportioned');
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

  /**
   * One entry per group — counted from the page rather than hardcoded.
   *
   * The point of the assertion is that the jump list and the groups stay in step; a
   * literal count only tested that, and failed whenever a group was added (which is
   * how the Desktop widgets group broke it). Comparing the two counts keeps the real
   * invariant and needs no edit next time.
   */
  const items = page.locator('#settingsNav .settings-nav-item');
  // Scoped to the settings tab: `.settings-group` is also used on Coverage and
  // About, so an unscoped count would be a much larger number that means nothing.
  await expect(items).toHaveCount(await page.locator('.tab[data-tab="settings"] .settings-group').count());
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

test('the about page names the version it is actually running', async () => {
  const sandbox = fx.makeSandbox('aboutversion');
  ctx = await fx.launch(sandbox);
  const { page } = ctx;
  await page.click('.nav-item[data-tab="about"]');

  // Compared against package.json rather than hardcoded, so a version bump does
  // not break this test — what is being asserted is that the page reports the
  // real version, not that the version is any particular string.
  const pkg = require('../../package.json');
  await expect(page.locator('#aboutChips')).toContainText(`v${pkg.version}`);

  // And the build line carries the runtimes, which is what an issue report needs.
  const build = page.locator('.about-build');
  await expect(build).toContainText(`Claude Lifeline v${pkg.version}`);
  await expect(build).toContainText('Electron ');
  await expect(build).toContainText('Chromium ');
  await expect(build).toContainText('Node ');

  // Nothing may read as a literal 'undefined' — the failure mode of building this
  // string from a state field that main forgot to send.
  await expect(build).not.toContainText('undefined');
  await expect(page.locator('#aboutChips')).not.toContainText('unknown');

  // The version has to be selectable, because its whole purpose is being copied
  // into a bug report — and the app sets `user-select: none` globally.
  expect(await build.evaluate((n) => getComputedStyle(n).userSelect)).toBe('text');
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
