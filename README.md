# Claude Lifeline

**Your Claude Code session dies at 2am from a rate limit. Lifeline waits it out and tells it to continue.**

A long agent run ends when the API hiccups — a rate limit, a 503, a dropped stream. The work is fine, the context is fine, but the turn is over and nothing picks it back up until you notice. Lifeline notices instead.

It hooks into Claude Code's own failure event, waits for the appropriate backoff, and injects a message that resumes the turn exactly where it stopped.

![Dashboard](docs/screenshots/dashboard-dark.png)

---

## How it works

Claude Code fires a `StopFailure` event when an API error ends a turn, instead of the normal `Stop`. Lifeline registers a hook on that event with `asyncRewake` enabled. The hook classifies the failure, waits out the backoff, and exits with **code 2** — which is how a hook injects a message and wakes the model.

```
turn dies (rate limit)
        ↓
StopFailure  →  Lifeline hook
                  ├─ retryable?          no  → log it, notify you, stop
                  ├─ within limits?      no  → log it, stop
                  ├─ wait out backoff    (60s for a rate limit)
                  └─ exit 2 + message    → model wakes and continues
```

**The recovery runs inside Claude Code's own process.** That is the important architectural consequence: nothing has to be running for your sessions to be protected. No watchdog process, no polling, no window open. The tray app is *optional* — it shows you what happened and lets you configure it, and you can quit it without losing protection.

---

## What it recovers from

Not every failure should be retried, and that distinction is the core of the design. A rate limit clears on its own, so waiting is the right move. An invalid API key fails identically on every attempt — retrying it burns the attempt budget and buries the one message that tells you what to fix.

| Failure | What Lifeline does | Why |
|---|---|---|
| `rate_limit` | waits 60s, resumes | the limit clears with time |
| `overloaded` | waits 30s, resumes | server-side capacity, transient |
| `server_error` | waits 15s, resumes | a 5xx usually succeeds on retry |
| `unknown` (dropped connection, timeout) | waits 20s, resumes | the common overnight-failure case |
| `max_output_tokens` | resumes from the cut | continuing from the truncation is valid |
| `invalid_request` (context too long) | `/compact`, then resumes | retrying unchanged repeats the failure |
| `authentication_failed` | **alerts you** | credentials are wrong; no retry can fix it |
| `oauth_org_not_allowed` | **alerts you** | an org policy decision |
| `billing_error` | **alerts you** | needs a billing change |
| `model_not_found` | **alerts you** | a bad model id is a config error |

![Per-failure policy](docs/screenshots/policies-dark.png)

Every row above is configurable — wait time, attempt cap, and whether it auto-resumes at all.

### Beyond API errors

- **Background tasks still running** when a turn ends — resumes once they report back
- **Tool timeouts and interruptions** — optionally nudges the model instead of letting the turn end
- **Stalled sessions** — flags a session that claims to be working but has not progressed
- **Dead sessions** — notices when the CLI process vanished mid-task

---

## Safety: why this cannot spin

Auto-resume has one serious failure mode — retrying a permanent error forever, spending tokens on every pass. Four independent limits must *all* pass before a resume happens:

| Limit | Default | Stops |
|---|---|---|
| per prompt | 5 | one stuck prompt retrying without end |
| per hour | 20 | a single session bursting |
| per day | 100 | runaway spend, machine-wide |
| cooldown | 5s | duplicate fires for one failure |

Waits grow exponentially (`base × 2ⁿ`, capped at 5 minutes), so a persistent problem backs off instead of hammering. Attempts are recorded in a ledger keyed by `prompt_id`, so a *new* prompt gets a fresh budget while a stuck one cannot spin.

The hook is also written to fail safe: **any unexpected error exits 0.** Lifeline must never be the reason a session breaks.

---

## Install

Requires Windows 10/11 and Node 20+.

```bash
git clone <your-fork> claude-lifeline
cd claude-lifeline
npm install
npm run install-hook     # this is the part that protects your sessions
```

Verify the whole chain:

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

> Claude Code reads hooks at startup, so **restart any session that is already running** to pick them up.

### Optional: the tray app

```bash
npm start                                                    # run it
npm run build                                                # build an installer
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1   # start at logon
```

`npm run build` produces two artifacts in `dist/`, neither of which is code-signed:

| | |
|---|---|
| `Claude Lifeline Setup 1.0.0.exe` | per-user installer, choosable install directory, desktop shortcut |
| `Claude Lifeline 1.0.0.exe` | portable — runs without installing |

Because they are unsigned, SmartScreen will warn on first run. Build from source or use *More info → Run anyway*.

<details>
<summary>Why the build goes through <code>scripts/build.mjs</code></summary>

Two things in electron-builder's toolchain download fail on a stock Windows 11 machine, and both are avoidable, so `npm run build` wraps it:

- Its `winCodeSign` bundle contains **macOS symlinks**. Creating a symlink on Windows needs Developer Mode or an elevated shell, so extraction fails with *"Cannot create symbolic link : A required privilege is not held by the client"* — after three retries. Those files are the macOS signing toolchain and a `--win` build never reads them, so the wrapper pre-populates the cache with everything except `darwin/`.
- Its Go helper shells out to `7za`, which it expects on `PATH` while npm only installs it under `node_modules/7zip-bin`.

The wrapper only affects the build environment — it changes nothing about the app. If a future electron-builder upgrade wants a different bundle version, bump `WIN_CODE_SIGN` in that script to the version named in the error.

</details>

<details>
<summary>Why a Scheduled Task and not a Windows service?</summary>

A Windows service runs in session 0, which has no desktop — it cannot draw a tray icon or raise a toast. A Scheduled Task triggered at logon is the supported way to get service-like autostart for an app with a UI. It needs no elevation, since everything Lifeline touches lives under your user profile.

</details>

---

## The app

Five tabs, dark and light, and a tray icon whose colour tells you the state at a glance: **violet** protecting active work, **blue** waiting for sessions, **amber** something needs you, **grey** paused.

| | |
|---|---|
| ![Sessions](docs/screenshots/sessions-dark.png) | ![Activity](docs/screenshots/activity-dark.png) |
| **Sessions** — read from Claude Code's own session records. Nothing is attached to or altered. | **Activity** — every recovery, skip, and block, filterable. |
| ![Settings](docs/screenshots/settings-dark.png) | ![Light theme](docs/screenshots/dashboard-light.png) |
| **Settings** — feature toggles, safety limits, per-failure policy. | **Light theme** — follows Windows, or pick one. |

Session monitoring is strictly read-only: it reads the JSON records Claude Code maintains and probes liveness with signal 0, which tests for a process without affecting it. Watching your sessions can never disturb them.

---

## Configuration

`%APPDATA%\claude-lifeline\config.json`, editable from the Settings tab. A corrupt or missing file falls back to defaults rather than throwing — a broken config is not a reason to stop rescuing sessions.

```jsonc
{
  "enabled": true,
  "features": {
    "apiErrorRecovery": true,        // the core feature
    "contextOverflowRecovery": true, // /compact when context overflows
    "toolFailureRecovery": false,    // nudge on tool timeouts
    "backgroundTaskRecovery": true,
    "respectNonRetryable": true      // keep auth/billing on alert-only
  },
  "limits": {
    "maxAttemptsPerPrompt": 5,
    "maxAttemptsPerHour": 20,
    "maxAttemptsPerDay": 100,
    "maxBackoffMs": 300000
  },
  "advanced": {
    "projectDenylist": [],           // never recover these paths
    "projectAllowlist": [],          // empty = all projects
    "debugLogging": false
  }
}
```

| Path | What |
|---|---|
| `%APPDATA%\claude-lifeline\config.json` | your settings |
| `%APPDATA%\claude-lifeline\events.jsonl` | what happened, append-only |
| `%APPDATA%\claude-lifeline\ledger.json` | attempt counts (the loop guard) |
| `%APPDATA%\claude-lifeline\backups\` | settings.json backups, taken before every install |
| `~\.claude\settings.json` | where the hooks are registered |

---

## Development

```bash
npm test             # 56 unit tests
npm run test:e2e     # 25 Playwright tests against the real Electron app
npm run lint         # project-specific invariant checks
npm run screenshots  # regenerate docs/screenshots/
npm run dev          # run with devtools open
npm run build        # installer + portable exe into dist/
```

Tests redirect `LIFELINE_HOME` and `CLAUDE_CONFIG_DIR` to a throwaway directory, so a test run can never read your real sessions or rewrite your real `settings.json`.

```
src/
  hook/lifeline-hook.js   the actual fix — runs inside Claude Code, no dependencies
  shared/policy.js        per-failure decisions and rationale
  shared/ledger.js        the four-way loop guard
  shared/installer.js     safe settings.json editing (backs up, merges, never clobbers)
  main/                   Electron main, tray, monitor
  renderer/               the UI
scripts/
  cli.mjs                 install / uninstall / doctor / status
  build.mjs               packaging, with the Windows toolchain workarounds
  make-icons.mjs          generates assets/icon.ico from the tray drawing code
```

### Design notes

- **Zero runtime dependencies.** The hook is spawned as a bare Node process by Claude Code; it cannot rely on module resolution or an install step.
- **The tray icon is generated at runtime** — PNGs encoded with Node's built-in `zlib`, so status colours and DPI variants need no image assets.
- **The renderer is locked down**: `contextIsolation: true`, `nodeIntegration: false`, a strict CSP, and no `innerHTML` anywhere. Event details carry API error text and session names, which are untrusted strings; lint enforces this.
- **Hook installation is non-destructive**: it backs up `settings.json`, merges into existing hook groups, tags its own entries, and *aborts* rather than overwriting a file it cannot parse.

---

## Limitations

- **Windows-first.** The hook is cross-platform; the tray app and autostart script are Windows-specific.
- **Not retroactive.** Sessions running before you install the hooks are not protected until restarted.
- **Interactive sessions only.** `asyncRewake` needs an interactive or streaming-input session; plain `claude -p` print mode exits before a rewake can land.
- **Uses internal hook options.** `asyncRewake` is not part of Claude Code's documented public API and could change between releases. `npm run doctor` will tell you if the wiring stops matching.

## License

MIT
