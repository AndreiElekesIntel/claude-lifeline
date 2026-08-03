# The App

Nine tabs, two desktop widgets, dark and light, and a tray icon whose colour tells you the state at a glance: **violet** protecting active work, **blue** waiting for sessions, **amber** something needs you, **grey** paused.

The app is optional. Recovery happens inside Claude Code's own process, so quitting the tray does not stop your sessions being protected — see [How It Works](How-It-Works).

![Dashboard](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/dashboard-dark.png)

## Sessions

Every Claude Code session on the machine, live — including what each one has cost so far.

A dot beside each name answers the only question you usually have: **green** is finished and waiting for you, **violet and pulsing** is still working, **amber** claims to be working but has gone quiet, **red** died. The State column says the same thing in words; the dot is there so that with five terminals open you can tell which ones are done without reading any of them.

Strictly read-only: it reads the JSON records Claude Code maintains and probes liveness with signal 0, which tests for a process without affecting it. **Watching your sessions can never disturb them.**

![Sessions](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/sessions-dark.png)

## History

Every session Claude Code has ever recorded on this machine, grouped by day and searchable by name, folder, or anything said in it. Click one to resume it in a new window — Lifeline hands `claude --resume` the id and gets out of the way.

Sessions can be renamed here. The name is Lifeline's own label rather than anything written back into Claude Code's files, so "that refactor from Tuesday" stays findable without touching a transcript.

![History](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/history-dark.png)

## Launchpad

Sessions you start often, saved as one-click presets: a folder, a model, a permission mode, whichever skills to load, and an opening prompt. Click one and it opens a terminal already primed.

Each preset can take a global hotkey — <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>1</kbd> and up — so a session can be started without the app being on screen at all. **Send to desktop** writes a normal Windows shortcut, for the ones that belong next to your other launchers.

![Launchpad](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/launchpad-dark.png)

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

### Telling you when a prompt is done

**Notifications** holds two independent switches, because they answer different questions.

The first is about failures: a session was resumed, or something needs you. On by default — rare, and each one worth an interruption.

The second, **"Tell me when a prompt finishes"**, toasts with a sound the moment a turn ends and a session is waiting for you, so a long run does not need watching. It is off until you ask for it: it fires on *every* completed prompt, which across several sessions is a different amount of noise entirely.

It is driven by Claude Code's `Stop` hook, so it lands at the same instant the CLI prints its `✻ Baked for 42s` line rather than on the app's next poll.

Two things it deliberately does not do. A completion older than a minute is never announced, so restarting the app does not greet you with whatever finished last. And a turn that ended with background work still running is not called finished — that is a pause Lifeline is about to resume, not a result.

See [Configuration → Notifications](Configuration#notifications) for how the detection works and why it needs no extra hook.

## About

A doctor's-eye view of the install — what is registered, how many checks are armed, and how many recoveries have actually happened:

![About](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/about-dark.png)

Scroll down and it tells you where every byte it writes lives, so you can go and read it:

![About, paths](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/about-detail-dark.png)

The version you are running is the first chip at the top, and the foot of the page carries the whole build string — app, Electron, Chromium, Node, and the config schema version. That line is selectable so it can be pasted straight into an issue, which is the only reason it exists: "which version" and "which Electron" are the first two questions any rendering bug needs answered.

## Desktop widgets

Two small always-on-top windows that live on the wallpaper instead of in the app. Both are off until you turn them on, under **Settings → Desktop widgets** or from the tray menu.

**Shortcuts** is your Launchpad presets as a floating strip. One click starts the session, and the digit on each chip is its global hotkey.

**Status** is the question the app is for, answered without opening it: is Lifeline running, how many sessions is it watching, and has anything gone wrong. The mark is drawn at runtime in the current status colour, so the largest thing on the panel is also the fastest to read.

| | |
|---|---|
| ![Shortcuts widget](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/widget-shortcuts.png) | ![Status widget](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/widget-status-card.png) |

### Looks

A **look** is not a theme: a theme changes what a widget is made of, a look changes what it *is*. Each answers a different question about how much of your desktop you are willing to give it.

| | |
|---|---|
| **Card** | The full readout — status, counts, and anything wrong. The default, because it is the only one that explains itself. |
| **Bar** | One horizontal strip, for along the top of a screen where a tall panel would cover work. |
| **Orb** | The mark and a single number. For knowing it is alive without a dashboard on your wallpaper. Status only. |

![Status widget, bar](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/widget-status-bar.png)

![Status widget, orb](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/widget-status-orb.png)

Six themes, four accents, adjustable opacity and width, and **click through** — which makes the window ignore the mouse entirely so clicks land on whatever is behind it. That last one can lock you out of the widget it is set on, so it is also in the tray menu and in Settings: a setting that hides its own off switch is a trap.

Drag either one by its header. A widget remembers where it was put, and if that position is no longer on any display — the second monitor went away — it is pulled back somewhere reachable rather than opening into space, because a widget has no taskbar button and no alt-tab entry to rescue it with.

![Widget settings](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/widgets-settings-dark.png)

## Light theme

Follows Windows by default, or pick one.

| | |
|---|---|
| ![Dashboard, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/dashboard-light.png) | ![Coverage, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/coverage-light.png) |
| ![Analytics, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/analytics-light.png) | ![Sessions, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/sessions-light.png) |
| ![History, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/history-light.png) | ![Launchpad, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/launchpad-light.png) |
| ![Settings, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/settings-light.png) | ![Policies, light](https://raw.githubusercontent.com/AndreiElekesIntel/claude-lifeline/main/docs/screenshots/policies-light.png) |

---

**The screenshots on this page are generated by a test.** They are captured by `test/e2e/screenshots.spec.js` against the real app, so an image can never show a UI that no longer passes its own suite.
