# Install and Uninstall

Requires Windows 10 or 11 and Node 20+. Nothing needs administrator rights — everything written lives under your own user profile.

For the short version, see [Getting Started](Getting-Started).

## Option 1 — `run.bat` (does everything)

Double-click `run.bat`, or run it with flags:

```bash
run.bat                  # install, register hooks, build, shortcuts, autostart, launch
run.bat -SkipBuild       # skip the packaged build; autostart runs from this checkout
run.bat -NoLaunch        # set everything up but do not start the app
run.bat -Proxy ""        # install without a proxy (defaults to Intel's)
```

It is idempotent — re-running repairs a partial install rather than duplicating anything. The hooks go in first, before the app and the shortcuts, so that if a later step fails the machine is still protected.

## Option 2 — by hand

```bash
npm install
npm run install-hook     # this is the part that protects your sessions
npm start                # optional: the tray app
npm run build            # optional: build the installer + portable exe into dist/
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1   # optional: start at logon
```

## Verify

```bash
npm run doctor
```

```
✓ Node 24.15.0
✓ Hook script present
✓ Recovery hooks registered  StopFailure, Stop, PostToolUseFailure
✓ Protection enabled
✓ API error recovery on
✓ Data folder writable

Everything checks out. Your sessions will resume themselves after an API error.
```

## Uninstall

```bash
npm run uninstall-hook                                                   # remove the hooks
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
```

Uninstalling is **recorded as a decision**, so the app will not quietly reinstall the hooks on its next launch. `hooks.autoInstall` exists to repair an accidental removal, not to override a deliberate one.

## The unsigned-binary note

`npm run build` produces two artifacts in `dist/`, neither of which is code-signed:

| | |
|---|---|
| `Claude Lifeline Setup 1.1.0.exe` | per-user installer, choosable install directory, desktop shortcut |
| `Claude Lifeline 1.1.0.exe` | portable — runs without installing |

Because they are unsigned, SmartScreen will warn on first run. Build from source or use *More info → Run anyway*.

## Why the build goes through `scripts/build.mjs`

Two things in electron-builder's toolchain download fail on a stock Windows 11 machine, and both are avoidable, so `npm run build` wraps it:

- Its `winCodeSign` bundle contains **macOS symlinks**. Creating a symlink on Windows needs Developer Mode or an elevated shell, so extraction fails with *"Cannot create symbolic link : A required privilege is not held by the client"* — after three retries. Those files are the macOS signing toolchain and a `--win` build never reads them, so the wrapper pre-populates the cache with everything except `darwin/`.
- Its Go helper shells out to `7za`, which it expects on `PATH` while npm only installs it under `node_modules/7zip-bin`.

The wrapper only affects the build environment — it changes nothing about the app. If a future electron-builder upgrade wants a different bundle version, bump `WIN_CODE_SIGN` in that script to the version named in the error.

## Why a Scheduled Task and not a Windows service?

A Windows service runs in session 0, which has no desktop — it cannot draw a tray icon or raise a toast. A Scheduled Task triggered at logon is the supported way to get service-like autostart for an app with a UI. It needs no elevation, since everything Lifeline touches lives under your user profile.
