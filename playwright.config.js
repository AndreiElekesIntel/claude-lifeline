'use strict';
/**
 * Playwright config for the Electron UI tests.
 *
 * Workers are pinned to 1: the app takes a single-instance lock, so two
 * concurrent launches would have the second one quit immediately.
 */

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  // Screenshot capture is a build artefact, not a check — run it via
  // `npm run screenshots` so a normal test run stays fast and side-effect free.
  testIgnore: process.env.LIFELINE_SHOTS ? [] : ['**/screenshots.spec.js'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
