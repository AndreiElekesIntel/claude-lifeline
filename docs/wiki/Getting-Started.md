# Getting Started

Requires Windows 10 or 11 and Node 20+. Nothing needs administrator rights — everything written lives under your own user profile.

Two commands and one double-click, depending on how much you want.

## Just protect my sessions

No app, no tray icon, nothing running:

```bash
git clone https://github.com/AndreiElekesIntel/claude-lifeline.git
cd claude-lifeline
npm install
npm run install-hook
```

That is the whole feature. The recovery runs inside Claude Code — see [How It Works](How-It-Works).

## Everything, set up for me

Hooks, the tray app, a desktop shortcut, start-at-logon, every feature on. Double-click **`run.bat`** in the repo root, or:

```bash
run.bat
```

It is idempotent — re-running repairs a partial install rather than duplicating anything. The hooks go in first, before the app and the shortcuts, so that if a later step fails the machine is still protected.

## Just give me the .exe

Grab it from the [**latest release**](https://github.com/AndreiElekesIntel/claude-lifeline/releases/latest):

| Download | What it is |
|---|---|
| `Claude Lifeline Setup 1.1.0.exe` | per-user installer — desktop shortcut, choosable install directory |
| `Claude Lifeline 1.1.0.exe` | portable — runs from wherever you put it, installs nothing |

The installer registers the recovery hooks on first launch, so the .exe alone is a complete install.

Neither artifact is code-signed, so SmartScreen will warn on first run — see [Install and Uninstall](Install-and-Uninstall#the-unsigned-binary-note).

## Then restart your sessions

**Claude Code reads hooks at startup, so restart any session that is already running.** Sessions started before the install are not protected until they restart.

## Check it worked

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

## Next

- [What It Recovers From](What-It-Recovers-From) — and what it deliberately does not
- [The App](The-App) — the optional tray UI
- [Configuration](Configuration) — the settings and where they live
