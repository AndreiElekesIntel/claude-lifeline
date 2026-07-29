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

/**
 * The registry is the one piece of state LIFELINE_HOME cannot redirect.
 *
 * These four are the regression guard for a real escape: e2e-launched apps
 * registered against the developer's own HKCU and left `IconUri` pointing at a
 * `Temp\lifeline-*` sandbox, which was deleted when the run finished — so the real
 * install's toasts lost their icon to a test. Anything that reaches reg.exe from a
 * sandboxed run is the bug, so these assert the refusal, not the write.
 */
test('a test launch refuses to register, so it cannot overwrite the real entry', async () => {
  const real = process.env.LIFELINE_E2E;
  try {
    process.env.LIFELINE_E2E = '1';
    const res = await identity.registerToastIdentity();
    assert.equal(res.ok, false);
    assert.match(res.reason, /test/i);
    // Nothing was written, so nothing claims to have been.
    assert.equal(res.icon, undefined);
  } finally {
    if (real === undefined) delete process.env.LIFELINE_E2E;
    else process.env.LIFELINE_E2E = real;
  }
});

test('a sandboxed LIFELINE_HOME refuses too, even without the e2e flag', async () => {
  // A test that forgets the flag, or a script run against a scratch home, must not
  // publish an icon path that is about to be deleted.
  const realHome = process.env.LIFELINE_HOME;
  const realFlag = process.env.LIFELINE_E2E;
  try {
    delete process.env.LIFELINE_E2E;
    process.env.LIFELINE_HOME = path.join(require('os').tmpdir(), 'lifeline-scratch-not-real');
    const res = await identity.registerToastIdentity();
    assert.equal(res.ok, false);
    assert.match(res.reason, /sandbox/i);
  } finally {
    if (realHome === undefined) delete process.env.LIFELINE_HOME;
    else process.env.LIFELINE_HOME = realHome;
    if (realFlag !== undefined) process.env.LIFELINE_E2E = realFlag;
  }
});

test('LIFELINE_HOME pointing at the real dir is not treated as a sandbox', async () => {
  /**
   * The guard must key on *where* the home is, not on the variable existing —
   * setup.ps1 and some launchers set LIFELINE_HOME explicitly to the default path,
   * and refusing there would reintroduce the raw-id titles the module exists to fix.
   *
   * Asserts skipReason directly rather than through registerToastIdentity: the
   * latter would go on to call reg.exe, which is the write this whole guard exists
   * to prevent, and a unit suite must not perform it either.
   */
  const realHome = process.env.LIFELINE_HOME;
  const realFlag = process.env.LIFELINE_E2E;
  const appData = process.env.APPDATA;
  try {
    delete process.env.LIFELINE_E2E;
    process.env.APPDATA = 'C:\\Users\\someone\\AppData\\Roaming';
    // Deliberately a different case: Windows paths are case-insensitive, and a
    // case-sensitive compare here would skip a legitimate launch.
    process.env.LIFELINE_HOME = 'c:\\users\\someone\\appdata\\roaming\\Claude-Lifeline';
    assert.equal(identity.skipReason(), null);
  } finally {
    if (realHome === undefined) delete process.env.LIFELINE_HOME;
    else process.env.LIFELINE_HOME = realHome;
    if (realFlag !== undefined) process.env.LIFELINE_E2E = realFlag;
    process.env.APPDATA = appData;
  }
});

test('the shortcut stamp uses the same id as the registration', () => {
  /**
   * The registry key supplies the toast's name; a Start Menu shortcut carrying the
   * same AUMID is what lets Windows attribute a toast to it. If the two ids ever
   * disagree the app is back to showing the raw string, with nothing erroring —
   * which is the exact bug this file exists to prevent, one level further out.
   *
   * Checked as source text because calling the stamper would rewrite a real shortcut.
   */
  const src = read('src/main/toast-identity.js');
  assert.match(src, /psLiteral\(APP_USER_MODEL_ID\)/);
  assert.ok(!/psLiteral\('com\./.test(src), 'the stamped id should not be a literal');
  // PKEY_AppUserModel_ID: the wrong property silently stamps nothing useful.
  assert.match(src, /9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3/i);
});

test('the e2e fixture sets the flag that suppresses registration', () => {
  // The guard above is only load-bearing if every e2e launch actually carries the
  // flag. If the fixture stops setting it, the escape is back and silent.
  assert.match(read('test/e2e/fixtures.js'), /LIFELINE_E2E:\s*'1'/);
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
