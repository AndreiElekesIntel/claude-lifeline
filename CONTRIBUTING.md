# Contributing

Issues and pull requests are welcome. The most valuable report is a way a Claude Code session can die that Lifeline does not catch yet.

## How changes land

`main` is protected. Nobody pushes to it directly except the owner; everything else arrives as a pull request that the owner reviews.

1. **Fork**, then branch from `main`. Name the branch after the failure it fixes, not the file it touches.
2. **Make the change.**
3. **Add a test that would have failed before it.** This is not a formality — every bug fixed in 1.1.0 was a bug the existing suite happily passed.
4. **Run all three:**
   ```bash
   npm test
   npm run test:e2e
   npm run lint
   ```
   CI runs the same three on Windows, plus a screenshot capture.
5. **Open the PR** describing what failure mode the change addresses.

Merges are squashed, so your branch's work-in-progress commits do not land on `main` — write the PR title as the commit message you want.

## What the tests are allowed to touch

Nothing of yours. The suite redirects `LIFELINE_HOME` and `CLAUDE_CONFIG_DIR` into a throwaway directory and gives each test its own Electron `--user-data-dir`, so a run cannot read your real sessions, rewrite your real `~/.claude/settings.json`, or collide with a tray app you have open.

If you add a fixture that writes somewhere, keep it inside the sandbox. A test that touches a real path is a test that can destroy someone's work.

## House style

- **Comments explain *why*, not *what*.** The diff already says what. If a line looks odd and the oddness is the point, say so — otherwise the next reader deletes it and reintroduces the bug.
- **The hook has no dependencies and must keep none.** Claude Code spawns `src/hook/lifeline-hook.js` as a bare Node process; it cannot rely on module resolution or an install step.
- **The hook fails safe.** Any unexpected error exits 0. Lifeline must never be the reason a session breaks. `EXIT_REWAKE = 2` is a lint-enforced invariant.
- **No `innerHTML` in the renderer, ever.** Event details carry API error text and session names, which are untrusted strings. Lint enforces this.
- **Outbound links are keys, not URLs.** Main owns the URL table; the renderer names an entry in it. An open-anything channel would turn any injected string into a browser launch.

`npm run lint` checks the project-specific invariants above, not just style.

## Before proposing a new auto-recovery

Some failures repeat identically however many times you retry them. Auto-resuming those is worse than doing nothing, because it burns the attempt budget and buries the one message that says what to fix — an expired credential is the clearest case.

So a PR that makes a new class auto-resume should say why a retry could plausibly succeed. If it can't, the right change is an alert, and the Coverage tab already has a place for it.

## Where to read first

[`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) is the mechanism, including the `StopFailure` payload shape and how each finding about Claude Code's internals was verified. `asyncRewake` is not part of the documented public API, so if a Claude Code release ever breaks recovery, that document is the list of things to re-check.
