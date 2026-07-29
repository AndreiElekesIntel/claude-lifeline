# What It Recovers From

Not every failure should be retried, and that distinction is the core of the design. A rate limit clears on its own, so waiting is the right move. An invalid API key fails identically on every attempt — retrying it burns the attempt budget and buries the one message that tells you what to fix.

## The ten classes

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

## The Coverage tab

That table, live — every way a turn can end, what happens to it, and a switch on each one:

![Coverage](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/coverage-dark.png)

Turning a class off **downgrades it to alert-only** rather than ignoring it — you still find out.

Turning a *hopeless* class on is held back by a guard that explains why, because auto-resuming an expired credential just hides the message that says so. The guard is deliberate friction, not a bug: it can be overridden, but not without reading why you shouldn't.

## Beyond API errors

- **Background tasks still running** when a turn ends — resumes once they report back
- **Tool timeouts and interruptions** — optionally nudges the model instead of letting the turn end (off by default; it is the noisiest check)
- **Stalled sessions** — flags a session that claims to be working but has not progressed
- **Dead sessions** — notices when the CLI process vanished mid-task

Each of these is a separate toggle under [Configuration](Configuration) → `features`.

## See also

- [Safety](Safety) — why a retryable class still cannot spin
- [How It Works](How-It-Works) — where the classification happens
