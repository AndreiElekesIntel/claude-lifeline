# Limitations

- **Windows-first.** The hook is cross-platform; the tray app, autostart, and shutdown scripts are Windows-specific.
- **Not retroactive.** Sessions running before you install the hooks are not protected until restarted — Claude Code reads hooks at startup.
- **Interactive sessions only.** `asyncRewake` needs an interactive or streaming-input session; plain `claude -p` print mode exits before a rewake can land.
- **Cost is an estimate.** Tokens × published rate, which is not what a subscription bills. Override the rates under Settings → Analytics & cost.
- **Windowed per-model costs are apportioned, not measured.** `/usage` stores the input/output/cache split only as an all-time total, so a range can only scale by its share of tokens. See [The App](The-App#two-honesty-notes-on-these-numbers).
- **"When you work" is always all-time.** Claude Code records hour-of-day counts without dates, so that one chart cannot follow the range picker.
- **Uses internal hook options.** `asyncRewake` is not part of Claude Code's documented public API and could change between releases. `npm run doctor` will tell you if the wiring stops matching.

## Not affiliated with Anthropic

MIT licensed. Built with **Claude Opus 5** in **Claude Code** — which makes it a tool built inside the thing it protects: the failures it recovers from are ones it hit while being written.
