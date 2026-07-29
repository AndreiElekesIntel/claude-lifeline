'use strict';
/**
 * Generates the screenshots used in the README.
 *
 * Kept as a spec rather than a one-off script so the images can never drift from
 * a UI that still passes its tests — regenerating them is `npm run screenshots`.
 * The data seeded here is representative, not real: a plausible mix of a working
 * session, a recovery, and a failure that needs a human.
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fx = require('./fixtures');

const SHOTS = path.join(fx.REPO_ROOT, 'docs', 'screenshots');

/** A believable few hours of activity. */
function seed(sandbox) {
  const now = Date.now();
  const min = 60_000;

  fx.writeSession(sandbox, {
    pid: process.pid,
    sessionId: 'a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60',
    cwd: 'C:/work/payments-api',
    name: 'refactor-billing-service',
    status: 'busy',
    startedAt: now - 142 * min,
    updatedAt: now - 12_000,
  });
  fx.writeSession(sandbox, {
    pid: process.ppid || process.pid,
    sessionId: 'b7e2d4a9-1c3f-4e82-9d5a-6b8c2f1e7a34',
    cwd: 'C:/work/telemetry-dashboard',
    name: 'add-latency-charts',
    status: 'idle',
    startedAt: now - 38 * min,
    updatedAt: now - 4 * min,
  });

  // Oldest first: the log is append-only, and the UI reverses it on read.
  fx.writeEvents(sandbox, [
    {
      at: now - 96 * min,
      kind: 'recovered',
      sessionId: 'a3f8c1d2',
      cwd: 'C:/work/payments-api',
      errorClass: 'overloaded',
      label: 'API overloaded',
      strategy: 'resume',
      attemptNumber: 1,
      waitedMs: 30_000,
      detail: 'Resumed after api overloaded (attempt 1).',
    },
    {
      at: now - 71 * min,
      kind: 'recovered',
      sessionId: 'a3f8c1d2',
      cwd: 'C:/work/payments-api',
      errorClass: 'rate_limit',
      label: 'Rate limited',
      strategy: 'resume',
      attemptNumber: 1,
      waitedMs: 60_000,
      detail: 'Resumed after rate limited (attempt 1).',
    },
    {
      at: now - 44 * min,
      kind: 'recovered',
      sessionId: 'b7e2d4a9',
      cwd: 'C:/work/telemetry-dashboard',
      errorClass: 'unknown',
      label: 'Connection lost',
      strategy: 'resume',
      attemptNumber: 2,
      waitedMs: 40_000,
      detail: 'Resumed after connection lost (attempt 2).',
    },
    {
      at: now - 26 * min,
      kind: 'recovered',
      sessionId: 'a3f8c1d2',
      cwd: 'C:/work/payments-api',
      errorClass: 'invalid_request',
      label: 'Context overflow',
      strategy: 'compact',
      attemptNumber: 1,
      waitedMs: 5_000,
      detail: 'Compacted the conversation, then resumed.',
    },
    {
      at: now - 9 * min,
      kind: 'recovered',
      sessionId: 'a3f8c1d2',
      cwd: 'C:/work/payments-api',
      errorClass: 'server_error',
      label: 'Server error',
      strategy: 'resume',
      attemptNumber: 1,
      waitedMs: 15_000,
      detail: 'Resumed after server error (attempt 1).',
    },
  ]);
}

/** Screenshots of a real window; the frameless chrome is part of the product. */
async function shoot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('capture README screenshots in both themes', async () => {
  const sandbox = fx.makeSandbox('shots');
  seed(sandbox);
  // Hooks pre-installed so the shots show the healthy steady state, not the
  // first-run warning banner.
  fx.writeConfig(sandbox, { ui: { theme: 'dark', accent: 'violet', startMinimised: false } });
  // Analytics reads transcripts and Usage reads Claude Code's own stats file, so
  // both need seeding or those two tabs photograph as empty states.
  fx.writeTranscript(sandbox, {
    slug: 'payments-api',
    id: 'a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60',
    title: 'Refactor the billing service',
    cwd: 'C:/work/payments-api',
    messages: 24,
  });
  fx.writeTranscript(sandbox, {
    slug: 'telemetry-dashboard',
    id: 'b7e2d4a9-1c3f-4e82-9d5a-6b8c2f1e7a34',
    title: 'Add latency charts',
    cwd: 'C:/work/telemetry-dashboard',
    model: 'claude-sonnet-5',
    messages: 12,
  });
  fx.writeClaudeStats(sandbox);

  const ctx = await fx.launch(sandbox);
  const { page } = ctx;

  try {
    await page.setViewportSize({ width: 1180, height: 800 });

    // Install hooks so the dashboard reports full protection.
    await page.click('.nav-item[data-tab="settings"]');
    await page.click('#btnInstallHooks2');
    await expect(page.locator('.toast').last()).toContainText('Hooks installed');
    // Let the toast fade so it does not sit over the UI in the shots.
    await page.waitForTimeout(4200);

    // Analytics first, before the dashboard. Transcripts are only scanned when
    // this tab is opened, and the dashboard's "This week" card reads that scan —
    // shooting the dashboard cold photographs three em-dashes and a prompt to
    // open Analytics, which is honest behaviour but a poor advertisement.
    await page.click('.nav-item[data-tab="analytics"]');
    await expect(page.locator('#analyticsBodyRows tr').first()).toBeVisible({ timeout: 20_000 });
    await shoot(page, 'analytics-dark');

    await page.click('.nav-item[data-tab="dashboard"]');
    await expect(page.locator('#hookBanner')).toBeHidden();
    await expect(page.locator('#recentTimeline .tl-item').first()).toBeVisible();
    await expect(page.locator('#dashWeekHours')).not.toHaveText('—');
    await shoot(page, 'dashboard-dark');

    await page.click('.nav-item[data-tab="sessions"]');
    await expect(page.locator('#sessionBody tr').first()).toBeVisible();
    await shoot(page, 'sessions-dark');

    await page.click('.nav-item[data-tab="analytics"]');

    await page.click('#analyticsViews .seg-btn[data-view="usage"]');
    await expect(page.locator('#usageContent')).toBeVisible();
    await expect(page.locator('#usageMissing')).toBeHidden();
    await shoot(page, 'usage-dark');

    await page.click('.nav-item[data-tab="coverage"]');
    await expect(page.locator('#coverageClasses .cov-card').first()).toBeVisible();
    await shoot(page, 'coverage-dark');

    await page.click('.nav-item[data-tab="activity"]');
    await expect(page.locator('#activityTimeline .tl-item').first()).toBeVisible();
    await shoot(page, 'activity-dark');

    await page.click('.nav-item[data-tab="settings"]');
    await shoot(page, 'settings-dark');

    // Scrolled to the per-failure policy table, the clearest view of the design.
    await page.locator('#policyList').scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await shoot(page, 'policies-dark');

    await page.click('.nav-item[data-tab="about"]');
    await shoot(page, 'about-dark');

    // The paths and provenance sit below the fold, and they are the part of this
    // page worth showing: where data actually lives, and what built it.
    await page.locator('.built-with').scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await shoot(page, 'about-detail-dark');

    // Light theme.
    await page.click('#themeToggle');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.waitForTimeout(400);

    await page.click('.nav-item[data-tab="dashboard"]');
    await shoot(page, 'dashboard-light');

    await page.click('.nav-item[data-tab="coverage"]');
    await expect(page.locator('#coverageClasses .cov-card').first()).toBeVisible();
    await shoot(page, 'coverage-light');

    await page.click('.nav-item[data-tab="analytics"]');
    // Back to the work view: the segmented choice is sticky, and the dark pass
    // left it on Usage.
    await page.click('#analyticsViews .seg-btn[data-view="work"]');
    await expect(page.locator('#analyticsBodyRows tr').first()).toBeVisible({ timeout: 20_000 });
    // Scroll position is sticky too, and the dark pass scrolled down to reach the
    // policy table — without this the page header sits above the top of the shot.
    await page.locator('#content').evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(250);
    await shoot(page, 'analytics-light');

    await page.click('.nav-item[data-tab="sessions"]');
    await expect(page.locator('#sessionBody tr').first()).toBeVisible();
    await shoot(page, 'sessions-light');

    await page.click('.nav-item[data-tab="settings"]');
    await page.locator('#content').evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(250);
    await shoot(page, 'settings-light');
    await page.locator('#policyList').scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await shoot(page, 'policies-light');
  } finally {
    await fx.close(ctx);
  }
});
