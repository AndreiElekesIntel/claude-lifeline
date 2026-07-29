# Configuration

`%APPDATA%\claude-lifeline\config.json`, editable from the Settings tab.

A corrupt or missing file **falls back to defaults rather than throwing** — a broken config is not a reason to stop rescuing sessions. A config written by an older version is upgraded on load, and keys written by a *newer* version are preserved rather than stripped, so downgrading does not lose settings.

```jsonc
{
  "enabled": true,                     // master switch; off means the hook does nothing
  "features": {
    "apiErrorRecovery": true,          // the core feature
    "contextOverflowRecovery": true,   // /compact when context overflows
    "toolFailureRecovery": false,      // nudge on tool timeouts — noisier, so off
    "backgroundTaskRecovery": true,
    "stalledSessionDetection": true,
    "deadSessionDetection": true,
    "desktopNotifications": true,
    "promptCompleteNotifications": false, // toast when a prompt finishes — off, see below
    "soundAlerts": false,
    "respectNonRetryable": true        // keep auth/billing on alert-only
  },
  "limits": {
    "maxAttemptsPerPrompt": 5,
    "maxAttemptsPerHour": 20,
    "maxAttemptsPerDay": 100,
    "cooldownMs": 5000,
    "maxBackoffMs": 300000,
    "stalledAfterMs": 900000
  },
  "analytics": {
    "enabled": true,                   // read transcripts for time/token/cost reporting
    "rates": {}                        // per-model overrides, USD per million tokens
  },
  "launchpad": {
    "presets": []                      // saved one-click sessions; see below
  },
  "widgets": {
    "shortcuts": { "enabled": false, "look": "card" },
    "status":    { "enabled": false, "look": "card" }
  },
  "hooks": {
    "autoInstall": true                // register missing hooks at startup
  },
  "advanced": {
    "projectDenylist": [],             // never recover these paths
    "projectAllowlist": [],            // empty = all projects
    "debugLogging": false
  }
}
```

The four `limits` that matter for runaway protection are explained on [Safety](Safety). The `features` toggles map to the checks listed on [What It Recovers From](What-It-Recovers-From).

`analytics.rates` exists because cost here is tokens × published rate, which is not what a subscription bills — override the rates to match whatever you actually pay.

### Notifications

`desktopNotifications` covers the things that went **wrong** — a session was resumed, a failure needs you, a limit was hit. On by default: those are rare and each one is worth an interruption.

`promptCompleteNotifications` is the other kind — a toast, with a sound, the moment a turn ends and a session is waiting for you, so you can go and do something else while a long run finishes. It is **off by default and deliberately a separate switch**, because it fires on every completed prompt: across several concurrent sessions that is a different volume of noise, and an upgrade that silently turned it on would make the app interrupt far more than it did before.

The trigger is Claude Code's **`Stop` hook** — the same instant the CLI prints its `✻ Baked for 42s` line. The hook writes one small line to `last-completion.json`, the app watches that file, and the toast appears immediately.

That is a change from how this first worked. The original version inferred "finished" from a `busy` → `idle` change in the session records on the app's five-second poll, which was wrong twice over: it could arrive up to five seconds late, by which time you had already looked back at the terminal; and a session stops being `busy` for reasons that are not "your work is done" — a turn pausing on a background task, for one — so some toasts announced a pause as a completion. The hook is handed the background-task list, so it can tell the difference.

Writing the signal costs about 0.09 ms, so nothing measurable is added to Claude Code's critical path, and a failure there is swallowed — a missed toast never disturbs a session.

Two consequences worth knowing:

- A completion recorded **more than a minute ago is not announced**, so restarting the app does not toast about whatever finished last. Same reasoning as before: at startup, old and new are indistinguishable, and saying nothing is the honest choice.
- A turn that ended **with background work still running** is not reported as finished — that is a pause, and Lifeline is about to resume it. A session whose process *vanished* is a crash, which is what `deadSessionDetection` covers.

Completion toasts always play a sound; `soundAlerts` governs the *failure* toasts, which are the ones worth keeping quiet.

The toast title takes **two** things, and the app sets up both at startup:

1. A per-user registry entry (`HKCU\Software\Classes\AppUserModelId\com.aelekes.claudelifeline`) holding `DisplayName` and `IconUri`. Windows reads the name shown on a toast from here, not from the executable.
2. The same id stamped onto the Start Menu shortcut as `System.AppUserModel.ID`. This is the part that is easy to miss: the notification platform attributes a desktop app's toast by finding a shortcut carrying that id, so with the registry key alone the notifications still read `com.aelekes.claudelifeline`. `WScript.Shell` — which `setup.ps1` uses to write shortcuts — cannot set a property-store value at all, so the app does it itself.

Windows also caches what it has already displayed, so toasts posted before both were in place keep their old label until the next one arrives.

That entry is the one thing a sandboxed run cannot be isolated from — `LIFELINE_HOME` redirects every file Lifeline writes, but the registry is per-user and machine-wide. So an app launched with `LIFELINE_E2E=1`, or against a `LIFELINE_HOME` that is not the real data directory, **does not register at all**: it would otherwise overwrite the real installation's entry with an icon path inside a scratch directory that is deleted when the run ends.

### `launchpad.presets`

One entry per saved session. Everything except `id` and `label` is optional — an entry with only those two opens a plain session in your home directory.

```jsonc
{
  "id": "a1b2c3",                          // generated; do not reuse one
  "label": "Morning triage",
  "cwd": "C:/work/payments-api",
  "model": "opus",                         // opus | sonnet | haiku, or omit for the default
  "permissionMode": "plan",                // manual | auto | acceptEdits | dontAsk | plan | bypassPermissions
  "skills": ["code-review"],               // loaded as /code-review before the prompt
  "prePrompt": "Read the overnight CI failures.",
  "accelerator": "CommandOrControl+Alt+1"  // global hotkey
}
```

The field is `prePrompt`, not `prompt` — a `prompt` key is dropped on load and the preset launches silently with no opening message.

### `widgets`

Both widgets take the same keys, and both are `enabled: false` until you ask for one.

| Key | |
|---|---|
| `enabled` | off by default; a window appearing on your desktop uninvited is not something an app should do |
| `look` | `card`, `bar`, or — status only — `orb` |
| `theme` / `accent` | `system`, `dark`, `light`, `midnight`, `slate`, `glass`; accents as elsewhere |
| `width` | the **card** width, 180–520. The bar and orb have their own fixed sizes, so switching look and back does not lose what you chose here |
| `opacity` | 0.35–1. The floor is deliberate: invisible is what `enabled: false` is for |
| `alwaysOnTop` | on by default, because a widget that hides behind the editor is not a widget. Turn it off while screen-sharing |
| `clickThrough` | the window ignores the mouse entirely. It then cannot be dragged or clicked either, so the off switch is also in the tray menu and in Settings |
| `compact` | fewer details, less space |
| `x` / `y` | where it was last dragged, or `null` for "wherever is sensible". Both or neither — half a coordinate is not a position |

A saved `x`/`y` is a *request*, checked against the displays that exist at launch. If it is off every screen — a monitor was unplugged — the widget is pulled back somewhere reachable instead, because a widget has no taskbar button and no alt-tab entry, so off-screen means gone. Setting both to `null` (or **Reset position** in Settings) puts it back in its default corner.

## Where everything lives

| Path | What |
|---|---|
| `%APPDATA%\claude-lifeline\config.json` | your settings |
| `%APPDATA%\claude-lifeline\events.jsonl` | what happened, append-only |
| `%APPDATA%\claude-lifeline\ledger.json` | attempt counts (the loop guard) |
| `%APPDATA%\claude-lifeline\runtime\` | the pinned snapshot, if you ran `npm run pin` |
| `%APPDATA%\claude-lifeline\backups\` | settings.json backups, taken before every install |
| `~\.claude\settings.json` | where the hooks are registered |

The About tab lists these live, so you can go and read them.

## Nothing here phones home

Lifeline makes **no network requests at all** — every number on the Analytics tab is computed on this machine from files Claude Code already wrote. The source is public so you can check that rather than take our word for it.

## Hook installation is non-destructive

It backs up `settings.json`, merges into existing hook groups, tags its own entries, and **aborts rather than overwriting** a file it cannot parse. Your own hooks are left alone.
