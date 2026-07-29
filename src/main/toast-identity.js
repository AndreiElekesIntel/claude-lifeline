'use strict';
/**
 * Makes Windows toasts say "Claude Lifeline" instead of "com.aelekes.claudelifeline".
 *
 * ## Why this is needed at all
 *
 * `app.setAppUserModelId(id)` tells Windows *which* app is posting a toast, and
 * that id is all the notification platform gets. The name and icon shown in the
 * banner and in Action Center are not taken from the toast, the exe, or
 * package.json — Windows looks the id up under
 * `HKCU\Software\Classes\AppUserModelId\<id>` and reads `DisplayName` and
 * `IconUri` from there. With no such key it has nothing to display, so it falls
 * back to printing the raw id, which is why the toasts read
 * "com.aelekes.claudelifeline".
 *
 * A packaged MSIX or a Start Menu shortcut carrying the same AUMID would register
 * this for us. Lifeline is an NSIS/portable build whose shortcut is written by
 * setup.ps1, so nothing ever created the key — hence doing it here, at startup,
 * where it is guaranteed to match the id the app actually posts under.
 *
 * **Both halves are needed.** The registry key supplies the name; a Start Menu
 * shortcut carrying the same id is what lets the notification platform attribute a
 * toast to that name in the first place. With the key alone the toasts still read
 * "com.aelekes.claudelifeline", which is why `stampStartMenuShortcut` exists.
 *
 * ## Why HKCU, and why this is safe
 *
 * Per-user, so no elevation is needed and nothing outside this user's hive is
 * touched. The key is keyed by our own reverse-DNS id, so it cannot collide with
 * another app's registration. It is written through `reg.exe` rather than a
 * dependency because this file is in the main process of an app with zero runtime
 * dependencies, and spawning one short-lived process at startup is cheaper than
 * carrying a native registry binding.
 *
 * Every failure here is swallowed. A wrong-looking notification title is a
 * cosmetic problem, and it must never be the reason the app fails to start.
 *
 * ## Why a sandboxed run must not register
 *
 * The registry is the one thing a test cannot be sandboxed away from. Every other
 * write goes through LIFELINE_HOME, but HKCU is per-user and machine-wide, so an
 * app launched by the e2e suite writes over the *real* installation's entry. That
 * is not hypothetical: it happened, and it left `IconUri` pointing into a
 * `Temp\lifeline-*` directory that was deleted when the test finished, so the real
 * app's toasts lost their icon. `skipReason` below is what keeps a test run from
 * reaching outside its sandbox.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const { drawIcon } = require('./tray-icon');
const { lifelineHome } = require('../shared/paths');

/**
 * The identity Windows knows us by.
 *
 * Must match `build.appId` in package.json and the `setAppUserModelId` call, or
 * the registration describes an id nothing posts under and the toasts keep showing
 * the raw string. Exported so a test can assert that agreement rather than trust
 * three copies of a literal to stay in sync.
 */
const APP_USER_MODEL_ID = 'com.aelekes.claudelifeline';

/** What the toast should say it is from. */
const DISPLAY_NAME = 'Claude Lifeline';

const AUMID_KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`;

/**
 * A PNG on disk for Windows to show beside the app name.
 *
 * `IconUri` has to be a file path — the notification platform reads it from
 * outside our process, so an in-memory buffer or a data URL is no use. Written
 * into Lifeline's own data dir rather than next to the exe, because a portable
 * build may sit somewhere read-only, and %APPDATA% is writable by definition.
 *
 * Regenerated only when missing: this runs on every launch, and the icon is
 * deterministic.
 */
function ensureIconFile() {
  const file = path.join(lifelineHome(), 'toast-icon.png');
  try {
    if (fs.existsSync(file)) return file;
    fs.mkdirSync(lifelineHome(), { recursive: true });
    // 64px: large enough for the Action Center entry, and the same size the
    // recovery toasts already draw.
    fs.writeFileSync(file, drawIcon(64, 'running'));
    return file;
  } catch {
    // No icon is fine — DisplayName alone fixes the title, which is the point.
    return null;
  }
}

/** One `reg add`, fire-and-forget. */
function regAdd(name, value) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['add', AUMID_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true }, (err) =>
      resolve(!err)
    );
  });
}

/**
 * Why this run must not touch the registry, or null if it may.
 *
 * Two cases, and both are the same underlying rule: only an app running against
 * the real data dir may publish a machine-wide path.
 *
 *  - `LIFELINE_E2E` — a test launch. Explicit, and the reason this check exists.
 *  - A redirected `LIFELINE_HOME` — any sandboxed run, whether or not it set the
 *    e2e flag. Checked by where the icon would actually land rather than by the
 *    variable being present, so pointing LIFELINE_HOME at the default path (which
 *    some setups do) is still allowed to register.
 */
function skipReason() {
  if (process.env.LIFELINE_E2E === '1') return 'test launch';
  if (!process.env.LIFELINE_HOME) return null;

  const appData = process.env.APPDATA;
  if (!appData) return 'sandboxed home';
  const real = path.join(appData, 'claude-lifeline');
  // Compared case-insensitively: Windows paths are, and a case difference here
  // would silently turn a legitimate launch into a skipped one.
  return path.resolve(process.env.LIFELINE_HOME).toLowerCase() === real.toLowerCase() ? null : 'sandboxed home';
}

/**
 * Register the display name and icon for our AUMID.
 *
 * Idempotent (`reg add /f` overwrites), and a no-op off Windows or in a sandboxed
 * run. Awaited at startup so the first toast of the session already has a name, but
 * a failure only means a badly-labelled notification.
 */
async function registerToastIdentity() {
  if (process.platform !== 'win32') return { ok: false, reason: 'not windows' };

  const skip = skipReason();
  if (skip) return { ok: false, reason: skip };

  const named = await regAdd('DisplayName', DISPLAY_NAME);
  const icon = ensureIconFile();
  const iconSet = icon ? await regAdd('IconUri', icon) : false;
  const stamped = await stampStartMenuShortcut();

  return { ok: named, displayName: DISPLAY_NAME, icon: iconSet ? icon : null, shortcut: stamped };
}

/**
 * Put our AUMID on the Start Menu shortcut.
 *
 * The registry key above is necessary but, on its own, was not sufficient: the
 * notification platform resolves a desktop app's display name by finding a Start
 * Menu shortcut whose `System.AppUserModel.ID` matches the id the toast was posted
 * under. Ours had none — `WScript.Shell`, which setup.ps1 uses, cannot set a
 * property-store value at all — so Windows had no shortcut to attribute the toast to
 * and kept printing the raw id even with DisplayName present.
 *
 * Done through PowerShell because setting it needs `IPropertyStore` on `IShellLink`,
 * which has no plain command-line equivalent. That is a heavy way to write one
 * property, so it runs only when the shortcut exists and is not already stamped —
 * on every normal launch this reads one property and stops.
 *
 * Failure is silent by design, as everywhere else in this file: an unstamped
 * shortcut means a badly-labelled toast, which is never worth a startup error.
 */
function stampStartMenuShortcut() {
  const appData = process.env.APPDATA;
  if (!appData) return Promise.resolve(false);
  const lnk = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${DISPLAY_NAME}.lnk`);
  if (!fs.existsSync(lnk)) return Promise.resolve(false);

  // Single-quoted inside PowerShell, with any quote doubled: these values are ours,
  // but building a script string around a path still deserves escaping.
  const psLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
$lnk = ${psLiteral(lnk)}
$aumid = ${psLiteral(APP_USER_MODEL_ID)}
$shell = New-Object -ComObject Shell.Application
$item = $shell.Namespace([System.IO.Path]::GetDirectoryName($lnk)).ParseName([System.IO.Path]::GetFileName($lnk))
if ($item.ExtendedProperty('System.AppUserModel.ID') -eq $aumid) { exit 0 }
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LifelineAumid {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] private class ShellLink {}
  [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IPersistFile { void GetClassID(out Guid c); [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint m);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string f, [MarshalAs(UnmanagedType.Bool)] bool r);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f); }
  [StructLayout(LayoutKind.Sequential)] private struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Sequential)] private struct PropVariant { public ushort vt; ushort r1, r2, r3; public IntPtr p; IntPtr p2; }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IPropertyStore { void GetCount(out uint c); void GetAt(uint i, out PropertyKey k);
    void GetValue(ref PropertyKey k, out PropVariant v); void SetValue(ref PropertyKey k, ref PropVariant v); void Commit(); }
  [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant pv);
  public static void Set(string lnkPath, string aumid) {
    var link = new ShellLink();
    ((IPersistFile)link).Load(lnkPath, 2);
    var store = (IPropertyStore)link;
    // PKEY_AppUserModel_ID; vt 31 is VT_LPWSTR.
    var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var pv = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(aumid) };
    store.SetValue(ref key, ref pv);
    store.Commit();
    ((IPersistFile)link).Save(lnkPath, true);
    PropVariantClear(ref pv);
  }
}
'@
[LifelineAumid]::Set($lnk, $aumid)
`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20_000 },
      (err) => resolve(!err)
    );
  });
}

// skipReason is exported so the isolation guard can be tested without letting a
// unit suite reach reg.exe — asserting it through registerToastIdentity would mean
// performing the very write the guard exists to prevent.
module.exports = { registerToastIdentity, skipReason, APP_USER_MODEL_ID, DISPLAY_NAME, AUMID_KEY };
