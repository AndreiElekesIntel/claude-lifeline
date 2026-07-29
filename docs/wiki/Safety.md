# Safety: why this cannot spin

Auto-resume has one serious failure mode — retrying a permanent error forever, spending tokens on every pass. Four independent limits must **all** pass before a resume happens.

| Limit | Default | Stops |
|---|---|---|
| per prompt | 5 | one stuck prompt retrying without end |
| per hour | 20 | a single session bursting |
| per day | 100 | runaway spend, machine-wide |
| cooldown | 5s | duplicate fires for one failure |

## Exponential backoff

Waits grow as `base × 2ⁿ`, capped at 5 minutes. A persistent problem backs off instead of hammering — the first retry of a rate limit waits 60s, the fifth waits minutes.

## The ledger

Attempts are recorded in a ledger keyed by `prompt_id`. That key is the point: a **new** prompt gets a fresh budget, while a **stuck** one cannot spin. Without per-prompt keying, a long productive session would eventually exhaust a global counter and stop being protected.

The ledger lives at `%APPDATA%\claude-lifeline\ledger.json`.

## Fail-safe

**Any unexpected error in the hook exits 0.** Lifeline must never be the reason a session breaks. If the recovery logic itself throws, the outcome is "no recovery happened" — never "the turn was corrupted".

## Non-retryable classes stay non-retryable

`respectNonRetryable` (on by default) keeps authentication, billing, org-policy and bad-model failures on alert-only. See [What It Recovers From](What-It-Recovers-From) for why each is hopeless rather than merely unlucky.

## Project scoping

`advanced.projectDenylist` and `advanced.projectAllowlist` restrict which paths are ever recovered. An empty allowlist means all projects; a denylist entry always wins. Useful when one repo shouldn't auto-spend.

## See also

- [Configuration](Configuration) — where to change all four limits
- [The App](The-App#activity) — the Activity tab shows every skip and block, with the reason
