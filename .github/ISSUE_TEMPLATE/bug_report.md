---
name: Bug report
about: Something Lifeline did, or failed to do
labels: bug
---

## What happened

## What you expected

## `npm run doctor` output

```
paste it here — it reports which hooks are registered and where they point,
which is the first thing to check for anything recovery-related
```

## Environment

- Windows version:
- Node version (`node -v`):
- Lifeline version:
- Installed via: `run.bat` / `npm run install-hook` / the .exe

## Relevant events

Lifeline logs to `%APPDATA%\claude-lifeline\events.jsonl`. The last few lines
around the failure are usually enough. If the hook itself misbehaved, turn on
`advanced.debugLogging` and attach `hook.log`.
