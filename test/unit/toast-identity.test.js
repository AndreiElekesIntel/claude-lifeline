'use strict';
/**
 * The notification title.
 *
 * Windows shows the name it finds under `AppUserModelId\<id>` in the registry — not
 * the productName, not the exe description. So the toast title depends on three
 * things agreeing: the id the app posts under, the id `build.appId` gives the
 * installer, and the id this registration writes. When they drift, nothing errors;
 * the toasts silently go back to reading "com.aelekes.claudelifeline", which is the
 * bug this replaces. A literal in three files cannot be trusted to stay in sync, so
 * the agreement is asserted instead.
 *
 * Nothing here writes to the registry. `registerToastIdentity` is not called: it
 * shells out to reg.exe, and a unit suite must not leave state on the developer's
 * machine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const identity = require('../../src/main/toast-identity');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the AUMID matches the installer’s appId', () => {
  // If these disagree the installed app and the running app have two identities,
  // and only one of them has a display name registered.
  const pkg = JSON.parse(read('package.json'));
  assert.equal(identity.APP_USER_MODEL_ID, pkg.build.appId);
});

test('the app posts notifications under the id that gets registered', () => {
  /**
   * The failure mode this catches: someone edits the `setAppUserModelId` call (or
   * puts the literal back) and the registration now describes an id nothing uses.
   * Checked as source text because the alternative is booting Electron.
   */
  const main = read('src/main/main.js');
  assert.match(main, /setAppUserModelId\(APP_USER_MODEL_ID\)/);
  assert.ok(!/setAppUserModelId\(['"]/.test(main), 'the app user model id should not be a literal at the call site');
});

test('the display name is what a person would expect to read', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(identity.DISPLAY_NAME, pkg.build.productName);
  // The whole point: never the reverse-DNS id.
  assert.ok(!identity.DISPLAY_NAME.includes('.'));
});

test('the registry key is per-user, so no elevation is ever needed', () => {
  // HKLM would need admin, and would make a per-user app write machine-wide state.
  assert.match(identity.AUMID_KEY, /^HKCU\\/);
  assert.ok(identity.AUMID_KEY.endsWith(identity.APP_USER_MODEL_ID));
});

test('registering off Windows is a no-op rather than an error', async () => {
  // The suite runs on Windows, so the platform is faked. Restored in a finally:
  // leaving process.platform patched would corrupt every test that follows.
  const real = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const res = await identity.registerToastIdentity();
    assert.equal(res.ok, false);
    assert.match(res.reason, /windows/i);
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
});
