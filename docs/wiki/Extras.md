# Extras

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
