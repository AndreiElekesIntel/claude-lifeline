# The App

Seven tabs, dark and light, and a tray icon whose colour tells you the state at a glance: **violet** protecting active work, **blue** waiting for sessions, **amber** something needs you, **grey** paused.

The app is optional. Recovery happens inside Claude Code's own process, so quitting the tray does not stop your sessions being protected — see [How It Works](How-It-Works).

![Dashboard](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/dashboard-dark.png)

## Sessions

Every Claude Code session on the machine, live — including what each one has cost so far.

Strictly read-only: it reads the JSON records Claude Code maintains and probes liveness with signal 0, which tests for a process without affecting it. **Watching your sessions can never disturb them.**

![Sessions](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/sessions-dark.png)

## Coverage

Every failure class, its policy, and a switch. Covered in full on [What It Recovers From](What-It-Recovers-From).

![Coverage](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/coverage-dark.png)

## Analytics

Time worked, sessions, tokens and estimated spend — computed here, on this machine, from transcripts Claude Code already wrote. Nothing is sent anywhere and nothing is written back.

Every figure and chart answers to the range picker at the top: a week, a month, three, six, twelve, or all time.

![Analytics](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/analytics-dark.png)

There is a second view over Claude Code's own `/usage` statistics, which knows things transcripts do not — all-time totals, per-model splits, your longest session ever. It takes the same range:

![Usage and models](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/usage-dark.png)

### Two honesty notes on these numbers

**Windowed per-model costs are apportioned, and are marked as such.** `/usage` records the input/output/cache-write/cache-read split only as an all-time total, and those four are priced about tenfold apart. So a window can only scale the model's all-time cost by its share of the tokens, which assumes the token mix held steady over time. At all time the figures are measured, not apportioned.

**"When you work" is the one panel that ignores the range picker.** Claude Code stores hour-of-day activity as a single install-wide tally with no dates attached, so there is nothing to slice a week out of. The panel says so rather than sitting silently under a picker and looking like it responded.

**Cost is an estimate by construction.** Claude Code records tokens, not money, so these are tokens × published rate and will not match a subscription bill. The rates are editable under Settings → Analytics & cost for exactly that reason.

## Activity

Every recovery, skip, and block, filterable by kind. This is the answer to "what happened while I was asleep".

![Activity](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/activity-dark.png)

## Settings

Feature toggles, the four safety limits, analytics, and per-project allow/deny lists.

![Settings](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/settings-dark.png)

Below that, the per-failure policy table — wait, attempt cap, and strategy for each of the ten classes:

![Per-failure policy](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/policies-dark.png)

## About

A doctor's-eye view of the install — what is registered, how many checks are armed, and how many recoveries have actually happened:

![About](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/about-dark.png)

Scroll down and it tells you where every byte it writes lives, so you can go and read it:

![About, paths](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/about-detail-dark.png)

The version you are running is the first chip at the top, and the foot of the page carries the whole build string — app, Electron, Chromium, Node, and the config schema version. That line is selectable so it can be pasted straight into an issue, which is the only reason it exists: "which version" and "which Electron" are the first two questions any rendering bug needs answered.

## Light theme

Follows Windows by default, or pick one.

| | |
|---|---|
| ![Dashboard, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/dashboard-light.png) | ![Coverage, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/coverage-light.png) |
| ![Analytics, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/analytics-light.png) | ![Sessions, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/sessions-light.png) |
| ![Settings, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/settings-light.png) | ![Policies, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/policies-light.png) |

---

**The screenshots on this page are generated by a test.** They are captured by `test/e2e/screenshots.spec.js` against the real app, so an image can never show a UI that no longer passes its own suite.
