# Extras

## The same dot, inside Claude Code

The dot in the Sessions table only helps once you have switched to Lifeline's window — which is the thing you were trying to avoid doing. This puts it in the terminal instead:

```bash
npm run statusline-on     # show it
npm run statusline-off    # put your old statusline back
```

Each session's line then starts with its own state and ends with a count of the others:

```
○ my-project | Opus 5 (200k context) | $0.42 | 91.2s | ctx 158.0k/200.0k  ● 11 done
```

A **violet ring** means this session is still working, a **filled green circle** means it is done. Amber `◑` is stalled, red `●` died. The trailing `● 11 done` is how many *other* sessions are finished — this one is excluded, since "1 done" on the line you are reading tells you nothing. It disappears entirely at zero, so a single-session terminal looks exactly as it did before.

Ring versus filled circle, rather than only a colour change: green-vs-violet is the pair red-green colour blindness collapses, and the shape still reads under `NO_COLOR`.

**It replaces your statusline rather than wrapping it.** `statusLine` holds one command, and chaining would put a second Node startup on a path Claude Code blocks on for every refresh. So Lifeline's line reproduces the stock fields — folder, model, cost, elapsed, context — and your original command is saved to `%APPDATA%\claude-lifeline\statusline-previous.json`, which `statusline-off` restores byte-for-byte. `settings.json` is backed up first, separately.

Claude Code reads settings at startup, so restart a session to see it.

## Keep recovery working while you edit the code

The hooks point at a path. If that path is your working tree, an edit mid-session runs half-written code.

```bash
npm run pin
```

This snapshots the recovery code to `%APPDATA%\claude-lifeline\runtime\` and re-registers the hooks against the snapshot, so your live sessions keep being rescued by a known-good copy while you work on the next one.

- `npm run pin` again to publish your changes as the new known-good copy
- `npm run install-hook` to go back to tracking the working tree

This matters most when the thing you are editing *is* the hook — which, if you are contributing, it usually is.

## Shut the machine down when the work is genuinely finished

An overnight run that finishes at 3am leaves a laptop on until morning. This checks, and only powers off if everything is really done:

```bash
npm run shutdown-check                                                          # report only, never acts
powershell -ExecutionPolicy Bypass -File scripts\schedule-shutdown.ps1 -At 05:00 -DryRun
powershell -ExecutionPolicy Bypass -File scripts\schedule-shutdown.ps1 -At 05:00
```

The decision is a **veto, not a score**: anything unexplained blocks it. A busy session, a turn that ended mid-tool-call, a recent recovery attempt, or anything flagged for attention all refuse the shutdown.

It keeps re-checking through a **90-minute grace period**, because the case it exists for is a session three minutes into a five-attempt rate-limit backoff at the moment the clock strikes. A single check at 05:00 would see an idle session and power off mid-recovery.

If in doubt, the machine stays on.

Start with `-DryRun`. It registers a task that reports its decision and shuts nothing down.
