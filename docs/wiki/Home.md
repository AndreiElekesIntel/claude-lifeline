# Claude Lifeline

**Your Claude Code session dies at 2am from a rate limit. Lifeline waits it out and tells it to continue.**

A long agent run ends when the API hiccups — a rate limit, a 503, a dropped stream. The work is fine, the context is fine, but the turn is over and nothing picks it back up until you notice. Lifeline notices instead. It hooks into Claude Code's own failure event, waits for the appropriate backoff, and injects a message that resumes the turn exactly where it stopped.

This wiki is the long-form documentation. The [README](https://github.com/AndreiElekesIntel/claude-lifeline#readme) is deliberately short.

## Start here

| Page | What it covers |
|---|---|
| **[Getting Started](Getting-Started)** | The three ways to install, in order of how much you want |
| **[How It Works](How-It-Works)** | The `StopFailure` hook, exit code 2, and why nothing has to be running |
| **[What It Recovers From](What-It-Recovers-From)** | All ten failure classes, what happens to each, and why |
| **[Safety](Safety)** | The four limits that make auto-resume unable to spin |
| **[The App](The-App)** | Every tab and both desktop widgets, with screenshots |
| **[Install and Uninstall](Install-and-Uninstall)** | Full install reference, verification, SmartScreen, autostart |
| **[Configuration](Configuration)** | Every config key, and where each file lives on disk |
| **[Extras](Extras)** | `npm run pin`, and shutting the machine down when work is finished |
| **[Development](Development)** | Tests, layout, design notes, contributing |
| **[Limitations](Limitations)** | What this does not do |

## The one-paragraph version

Claude Code fires `StopFailure` when an API error ends a turn. Lifeline registers a hook on it with `asyncRewake`, classifies the failure, waits out the backoff, and exits with **code 2** — which is how a hook injects a message and wakes the model. The recovery runs inside Claude Code's own process, so **nothing has to be running for your sessions to be protected**. The tray app is optional; it shows you what happened and lets you configure it.

Retryable failures are waited out. Hopeless ones — a bad credential, a billing problem — alert you instead, because retrying them burns the attempt budget and buries the one message that says what to fix.

**Nothing here phones home.** Lifeline makes no network requests at all. Every number on the Analytics tab is computed on your machine from files Claude Code already wrote.
