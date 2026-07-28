# How it works

The findings that this project is built on, and how each was verified. Written down because the mechanism relies on Claude Code internals — if a future release changes them, this is the document that tells you what to re-check.

## The problem

A long Claude Code run ends when the API fails mid-turn. The context is intact and the work is fine, but the turn is over. Nothing resumes it until a human notices, which for an overnight run means hours of idle time.

An external watchdog is the obvious answer and the wrong one: it would have to attach to a running CLI process or synthesise keystrokes, both of which risk disturbing live sessions. So the first question was whether Claude Code can resume *itself*.

## The mechanism

It can, via two features:

### `StopFailure`

Claude Code fires this event **instead of** `Stop` when an API error ends a turn. The payload:

```jsonc
{
  "session_id": "…",
  "transcript_path": "…",
  "cwd": "…",
  "prompt_id": "…",             // stable across a turn's retries — the scope key for attempt limits
  "hook_event_name": "StopFailure",
  "error": "rate_limit",        // one of ten classes, validated by the CLI
  "error_details": { … },
  "last_assistant_message": "…" // used to remind the model what it was doing
}
```

The ten classes the CLI validates against — this is why `policy.js` keys off them rather than matching error-message text:

`rate_limit` · `overloaded` · `authentication_failed` · `oauth_org_not_allowed` · `billing_error` · `invalid_request` · `model_not_found` · `server_error` · `max_output_tokens` · `unknown`

### `asyncRewake`

A hook option: *"If true, hook runs in background and wakes the model on exit code 2 (blocking error)."*

**Exit code 2 is the whole contract.** It injects the hook's stderr into the conversation as a `<system-reminder>` and wakes the model, resuming the turn. Exit 0 means "do nothing". This is why the hook writes its resume message to stderr, and why `EXIT_REWAKE = 2` is a lint-enforced invariant.

Because `asyncRewake` runs the hook in the background, the hook can `sleep` through a 60-second rate-limit backoff without blocking anything.

## Verification

The mechanism was proven end-to-end against local mock API servers rather than by triggering real failures — deterministic, and it never touched a live session. Every run used a sandboxed `CLAUDE_CONFIG_DIR`.

A mock server returned a malformed 200 to kill turn 2. The resulting transcript:

```
line 5   assistant   API Error: API returned an empty or malformed response (HTTP 200)
line 8   user        <system-reminder>
                     [Lifeline] API error recovered. Continue exactly where you left off.
                     </system-reminder>
line 10  assistant   TURN3        ← the session resumed on its own
```

Line 10 is the proof: the model continued with no human involvement and no external process.

### The print-mode gate

`asyncRewake` is gated on the session being interactive **or** having streaming input:

```js
K = !isInteractive() || hasStreamingInput()
```

So it works in normal interactive sessions and with `--input-format stream-json`, but **not** in plain `claude -p` print mode — that process exits before a rewake can land. This is a documented limitation, not a bug to fix.

## Why not every failure is retried

This is the design's central asymmetry, and the reason a blind "just send continue" loop is worse than nothing.

A rate limit clears with time, so waiting and resuming works. An invalid API key fails **identically** on every attempt. Retrying it:

1. burns the attempt budget that a real transient failure would need,
2. spends tokens on guaranteed failures, and
3. buries the one message that says what to fix under a wall of retries.

So `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, and `model_not_found` are `resume: false, strategy: 'notify'`. Lifeline surfaces them and stops.

`invalid_request` is the interesting middle case: it usually means "prompt is too long". Retrying unchanged repeats the failure exactly, so the policy is `strategy: 'compact'` — free context first, *then* continue.

## Why the loop guard is four separate limits

Each catches a different runaway shape:

| Limit | Catches |
|---|---|
| per prompt (`prompt_id`) | one stuck prompt retrying forever |
| per hour, per session | a single session bursting |
| per day, machine-wide | aggregate spend across every project |
| cooldown | duplicate hook fires for one failure |

Scoping the per-prompt count to `prompt_id` is what makes the budget useful: Claude Code keeps it stable across a turn's retries, so a stuck prompt cannot spin, while a genuinely new prompt gets a fresh budget.

The ledger tolerates concurrent writers (several sessions can fail at once) with last-writer-wins. A lost attempt record only ever makes Lifeline *more* conservative on the next read, never less — the failure mode points the safe way.

## Session monitoring

`~/.claude/sessions/<pid>.json` is written by Claude Code itself:

```jsonc
{ "pid": 37000, "sessionId": "…", "cwd": "…", "status": "busy", "name": "…", "updatedAt": 1770000000000 }
```

Reading these files gives real session state with zero process attachment. Liveness uses `process.kill(pid, 0)`, which tests for a process without signalling it (`EPERM` means alive but owned by another user). Monitoring therefore cannot disturb a running session — which is what makes it safe to poll every 5 seconds.

Two derived states matter:

- **stalled** — alive, `status: "busy"`, but `updatedAt` is far in the past
- **dead** — the process is gone while its last recorded status was `busy`

Both are reported, not auto-fixed. Relaunching a dead session means starting a process on the user's behalf, so it is off by default.

## Fail-safe posture

The hook's top-level catch exits **0**, and the event log swallows its own write errors. The reasoning is one-directional: a Lifeline bug that fails to resume a session costs you the same idle time you already had. A Lifeline bug that *breaks* a session costs you work. So every uncertain path degrades toward doing nothing.

The same logic explains why a corrupt `config.json` falls back to defaults instead of throwing: a broken settings file is not a reason to stop rescuing sessions.

## What to re-check if a release breaks this

1. `npm run doctor` — reports whether the hooks are still registered as expected.
2. Does `StopFailure` still fire? Set `advanced.debugLogging: true` and look at `hook.log`.
3. Does exit code 2 still rewake? This is the single load-bearing assumption.
4. Have the ten error classes changed? An unrecognised class falls back to the `unknown` policy, so a new class degrades gracefully rather than being dropped.
