# How It Works

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

## The consequence that matters

**The recovery runs inside Claude Code's own process.** That is the important architectural point: nothing has to be running for your sessions to be protected. No watchdog process, no polling, no window open.

The tray app is *optional*. It shows you what happened and lets you configure it, and you can quit it without losing protection.

## Fail-safe by construction

The hook is written so that **any unexpected error exits 0** — the code that means "nothing to do, carry on". Lifeline must never be the reason a session breaks. A crash in the recovery logic degrades to no recovery, not to a broken turn.

## Full mechanism

The payload shape, the exact hook wiring, and how each finding about Claude Code's internals was verified are in [**docs/HOW-IT-WORKS.md**](https://github.com/AndreiElekesIntel/claude-lifeline/blob/main/docs/HOW-IT-WORKS.md) in the repository.

One caveat worth stating here: `asyncRewake` is **not part of Claude Code's documented public API** and could change between releases. `npm run doctor` will tell you if the wiring stops matching.

## See also

- [What It Recovers From](What-It-Recovers-From) — the classification step, in full
- [Safety](Safety) — the limits checked before any resume
