---
name: A failure that should have been recovered
about: A turn ended and Lifeline did not resume it
labels: bug, recovery
---

The most useful report there is: a way a session can die that Lifeline does not
catch yet.

## The failure

- Error class, if you know it (one of `rate_limit` `overloaded`
  `authentication_failed` `oauth_org_not_allowed` `billing_error`
  `invalid_request` `model_not_found` `server_error` `max_output_tokens`
  `unknown`):
- What Claude Code showed when the turn ended:

## What Lifeline did

Check `%APPDATA%\claude-lifeline\events.jsonl` — a skip or block is logged with
its reason, and that reason is usually the answer:

```
paste the relevant lines
```

- [ ] Nothing was logged at all (the hook may not be registered — check `npm run doctor`)
- [ ] It was logged as skipped or blocked
- [ ] It resumed, but into the wrong state

## What should have happened, and why a retry would fix it

<!-- The important part. Some failures repeat identically however many times you
     retry them, and for those the right behaviour is to alert rather than to
     resume — retrying buries the message that says what to fix. -->
