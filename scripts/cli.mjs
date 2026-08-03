#!/usr/bin/env node
/**
 * Command-line control for Lifeline.
 *
 * The point of this file: recovery is a Claude Code hook, so it works with no
 * app running at all. `install` is therefore a complete installation — the tray
 * app is optional visibility on top of it.
 *
 *   node scripts/cli.mjs install     register the recovery hooks
 *   node scripts/cli.mjs uninstall   remove them
 *   node scripts/cli.mjs pin         run recovery from a frozen copy, not this tree
 *   node scripts/cli.mjs doctor      check that everything is wired up
 *   node scripts/cli.mjs status      one-line summary
 *
 *   node scripts/cli.mjs statusline-on / statusline-off
 *                                    show session state inside Claude Code itself
 *
 * ## Controlling the app from a terminal
 *
 *   node scripts/cli.mjs pause / resume     the master switch
 *   node scripts/cli.mjs sessions           what is running right now
 *   node scripts/cli.mjs log [n]            recent events
 *   node scripts/cli.mjs cost [days]        what it has cost
 *   node scripts/cli.mjs launch <preset>    start a saved shortcut
 *   node scripts/cli.mjs presets            list the shortcuts
 *   node scripts/cli.mjs widget <name> on|off
 *   node scripts/cli.mjs config [key [value]]
 *
 * ### Why these write config rather than talking to the app
 *
 * There is no IPC socket, and adding one would mean a listening port or a named
 * pipe on every user's machine for the sake of a few commands. It is not needed:
 * config.json *is* the interface. The app watches it and reloads, the hook reads it
 * on every fire, and so a CLI write takes effect in both — including when the app
 * is not running, which is the case an IPC channel would handle worst.
 *
 * The one thing this cannot do is make a window appear, since that needs a process
 * with a screen. `launch` is the exception that works anyway: starting a session is
 * spawning a terminal, which any process can do, so it goes through the same
 * launcher the app's own buttons use.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const installer = require(path.join(root, 'src/shared/installer.js'));
const paths = require(path.join(root, 'src/shared/paths.js'));
const { loadConfig, saveConfig, deepMerge } = require(path.join(root, 'src/shared/config.js'));
const eventlog = require(path.join(root, 'src/shared/eventlog.js'));
const ledger = require(path.join(root, 'src/shared/ledger.js'));
const sessions = require(path.join(root, 'src/shared/sessions.js'));
const launcher = require(path.join(root, 'src/shared/launcher.js'));
const launchpad = require(path.join(root, 'src/shared/launchpad.js'));
const analytics = require(path.join(root, 'src/shared/analytics.js'));
const { ERROR_CLASSES, effectivePolicy } = require(path.join(root, 'src/shared/policy.js'));

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};
// Respect NO_COLOR and non-TTY output so piping into a file stays readable.
const plain = process.env.NO_COLOR || !process.stdout.isTTY;
const paint = (code, s) => (plain ? s : `${code}${s}${c.reset}`);
const ok = (s) => paint(c.green, s);
const warn = (s) => paint(c.yellow, s);
const bad = (s) => paint(c.red, s);
const dim = (s) => paint(c.dim, s);

function cmdInstall() {
  const res = installer.install();
  console.log(ok('✓') + ` Registered hooks: ${res.installed.join(', ')}`);
  if (res.backup) console.log(dim(`  Backup of your previous settings: ${res.backup}`));
  console.log(dim(`  Settings file: ${res.settingsFile}`));
  console.log('');
  console.log('Sessions started from now on are protected.');
  // Worth being explicit: hooks are read at startup, so this is not retroactive.
  console.log(dim('Claude Code loads hooks at startup, so restart any session that is already running.'));
  return 0;
}

/**
 * Copy the recovery code into Lifeline's own data folder and point the hooks
 * there instead of at this checkout.
 *
 * Why this exists: settings.json stores an absolute path to the hook, and by
 * default that path is the working tree. That is exactly right for a user who
 * installed the app and never touches it — and exactly wrong while developing,
 * because Claude Code will run whatever is on disk the moment a turn fails. A
 * failure landing mid-save runs a half-written file, in a process whose whole
 * job is to not make a bad situation worse.
 *
 * A frozen copy decouples the two: edit the tree freely, and recovery keeps
 * running the version that was working when you pinned it. Re-run `pin` to
 * publish your changes, `install` to go back to live-from-tree.
 *
 * Only the files the hook actually loads are copied — src/hook and src/shared.
 * The Electron app is not part of the recovery path and is deliberately left out.
 */
function cmdPin() {
  const dest = path.join(paths.lifelineHome(), 'runtime');
  // Replaced wholesale rather than merged: a stale file left behind from a
  // previous pin is the one thing worse than no pin at all.
  fs.rmSync(dest, { recursive: true, force: true });
  for (const dir of ['src/hook', 'src/shared']) {
    fs.cpSync(path.join(root, dir), path.join(dest, dir), { recursive: true });
  }

  const entry = path.join(dest, 'src', 'hook', 'lifeline-hook.js');
  if (!fs.existsSync(entry)) throw new Error(`Snapshot failed: ${entry} was not created.`);

  // Provenance, so a future you can tell which commit is actually running.
  let rev = 'unknown';
  try {
    rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout, or no git — the stamp is a convenience, not a requirement */
  }
  fs.writeFileSync(
    path.join(dest, 'PINNED.json'),
    JSON.stringify({ pinnedAt: new Date().toISOString(), source: root, commit: rev }, null, 2),
    'utf8'
  );

  const res = installer.install({ hookEntry: entry });
  console.log(ok('✓') + ` Recovery pinned to a frozen copy  ${dim(`(commit ${rev})`)}`);
  console.log(dim(`  Snapshot: ${dest}`));
  console.log(dim(`  Hooks now run: ${entry}`));
  if (res.backup) console.log(dim(`  Settings backup: ${res.backup}`));
  console.log('');
  console.log('You can now edit the source tree without affecting live recovery.');
  console.log(dim('Re-run `node scripts/cli.mjs pin` to publish changes, or `install` to track the tree again.'));
  console.log(dim('Claude Code loads hooks at startup, so restart a session for this to take effect.'));
  return 0;
}

function cmdUninstall() {
  const res = installer.uninstall();
  if (!res.removed.length) {
    console.log(warn('•') + ' No Lifeline hooks were installed.');
    return 0;
  }
  console.log(ok('✓') + ` Removed hooks from: ${res.removed.join(', ')}`);
  if (res.backup) console.log(dim(`  Backup: ${res.backup}`));
  return 0;
}

/**
 * Put the live dot inside Claude Code itself.
 *
 * The Sessions table's dot only helps once you have switched to Lifeline's window,
 * which is the thing you were trying to avoid doing. `statusLine` is the one place
 * Lifeline can draw inside a session.
 */
function cmdStatuslineInstall() {
  const res = installer.installStatusline();
  console.log(ok('✓') + ' Lifeline statusline registered');
  if (res.replaced) {
    // Said loudly: replacing someone's statusline silently would be rude, and the
    // reassurance that it is recoverable is the part that matters.
    console.log(warn('•') + ` Your previous statusline was replaced: ${dim(String(res.replaced.command || ''))}`);
    console.log(dim(`  Saved to ${res.stash} — \`statusline-off\` puts it back exactly as it was.`));
  }
  if (res.backup) console.log(dim(`  Settings backup: ${res.backup}`));
  console.log('');
  console.log('Each session now shows its own state at the start of the line, and how many');
  console.log('other sessions are finished at the end.');
  console.log(dim('Claude Code reads settings at startup, so restart a session to see it.'));
  return 0;
}

function cmdStatuslineUninstall() {
  const res = installer.uninstallStatusline();
  if (!res.removed) {
    console.log(warn('•') + ` ${res.detail}`);
    return 0;
  }
  console.log(ok('✓') + ' Lifeline statusline removed');
  if (res.restored) console.log(dim(`  Restored: ${String(res.restored.command || '')}`));
  if (res.backup) console.log(dim(`  Settings backup: ${res.backup}`));
  return 0;
}

/** The hook path settings.json actually contains, or null if none is registered. */
function registeredHookPath() {
  try {
    const settings = JSON.parse(fs.readFileSync(paths.claudeSettingsFile(), 'utf8'));
    for (const list of Object.values(settings.hooks || {})) {
      if (!Array.isArray(list)) continue;
      for (const group of list) {
        for (const h of group.hooks || []) {
          // The command is `node "<path>"`, so the quoted argument is the path.
          const m = /^node\s+"([^"]+)"/.exec(String(h.command || ''));
          if (m && m[1].includes('lifeline-hook')) return m[1];
        }
      }
    }
  } catch {
    /* unreadable settings is reported separately by the registration check */
  }
  return null;
}

/** Metadata for the frozen snapshot, if one has been created. */
function pinInfo() {
  const dir = path.join(paths.lifelineHome(), 'runtime');
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'PINNED.json'), 'utf8'));
    return { dir, ...meta };
  } catch {
    return null;
  }
}

/** Everything that has to be true for a session to actually get resumed. */
function cmdDoctor() {
  const problems = [];
  const line = (state, label, detail) => {
    const mark = state === 'ok' ? ok('✓') : state === 'warn' ? warn('!') : bad('✗');
    console.log(`${mark} ${label}${detail ? dim(`  ${detail}`) : ''}`);
  };

  console.log(paint(c.bold, 'Claude Lifeline — doctor') + '\n');

  // 1. Node can run the hook.
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) line('ok', `Node ${process.versions.node}`);
  else {
    line('fail', `Node ${process.versions.node} is too old`, 'the hook needs Node 20+');
    problems.push('Upgrade Node to 20 or newer.');
  }

  // 2. The hook file exists where settings.json actually points — which is not
  // necessarily this checkout, since `pin` can redirect it to a snapshot.
  const registered = registeredHookPath();
  const hook = registered || paths.hookEntry();
  if (fs.existsSync(hook)) line('ok', 'Hook script present', hook);
  else {
    line('fail', 'Hook script missing', hook);
    problems.push('The hook file is missing — run `npm run install-hook` to repoint it.');
  }

  const pin = pinInfo();
  if (pin && registered && registered.startsWith(pin.dir)) {
    line('ok', 'Running a pinned snapshot', `commit ${pin.commit}, pinned ${pin.pinnedAt}`);
  } else if (pin) {
    // A leftover snapshot that nothing points at is only clutter, but saying so
    // beats leaving someone to wonder which copy is live.
    line('warn', 'A pinned snapshot exists but is not in use', 'hooks run from the source tree');
  }

  // 3. Hooks registered.
  const st = installer.status();
  if (st.error) {
    line('fail', 'Cannot read Claude settings', st.error);
    problems.push('Fix settings.json, then run install again.');
  } else if (st.complete) {
    line('ok', 'Recovery hooks registered', st.events.join(', '));
  } else if (st.installed) {
    const missing = st.expected.filter((e) => !st.events.includes(e));
    line('warn', 'Some hooks are missing', `missing: ${missing.join(', ')}`);
    problems.push('Run `npm run install-hook` to repair the registration.');
  } else {
    line('fail', 'No recovery hooks registered', st.settingsFile);
    problems.push('Run `npm run install-hook` — without this, nothing is protected.');
  }

  // 3b. The in-session dot. Optional, so its absence is information, not a problem.
  const sl = installer.statuslineStatus();
  if (sl.installed) line('ok', 'In-session dot active', 'statusline registered');
  else if (sl.other) line('warn', 'Another statusline is configured', 'run `statusline-on` to show the dot in sessions');
  else line('warn', 'No in-session dot', 'run `statusline-on` to show session state inside Claude Code');

  // 4. Master switch.
  const cfg = loadConfig();
  if (cfg.enabled) line('ok', 'Protection enabled');
  else {
    line('warn', 'Protection is paused', 'nothing will be resumed');
    problems.push('Protection is paused — resume it from the tray or set enabled: true.');
  }

  if (cfg.features.apiErrorRecovery) line('ok', 'API error recovery on');
  else {
    line('warn', 'API error recovery is off', 'the core feature is disabled');
    problems.push('Turn API error recovery back on in Settings.');
  }

  // 5. Writable data dir — the ledger is what prevents retry loops.
  try {
    fs.mkdirSync(paths.lifelineHome(), { recursive: true });
    const probe = path.join(paths.lifelineHome(), '.doctor-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    line('ok', 'Data folder writable', paths.lifelineHome());
  } catch (err) {
    line('fail', 'Data folder is not writable', err.message);
    problems.push('Lifeline cannot write its ledger, so it cannot bound retries.');
  }

  // 6. What it would do right now, per class.
  console.log('\n' + paint(c.bold, 'Policy in effect'));
  for (const cls of ERROR_CLASSES) {
    const p = effectivePolicy(cls, cfg);
    const action = !p.resume || p.strategy === 'notify' ? warn('alert only') : p.strategy === 'compact' ? paint(c.cyan, 'compact + resume') : ok('auto-resume');
    console.log(`  ${cls.padEnd(22)} ${action}${p.resume ? dim(`  wait ${Math.round(p.backoffMs / 1000)}s, up to ${p.maxAttempts}x`) : ''}`);
  }

  // 7. Live state.
  const live = sessions.listSessions();
  const sum = sessions.summarise(live, cfg.limits.stalledAfterMs);
  const stats = ledger.stats();
  console.log('\n' + paint(c.bold, 'Right now'));
  console.log(`  Sessions: ${sum.alive} live, ${sum.busy} working${sum.stalled ? warn(`, ${sum.stalled} stalled`) : ''}${sum.dead ? bad(`, ${sum.dead} died mid-task`) : ''}`);
  console.log(`  Recoveries: ${stats.today} in the last 24h, ${stats.total} recorded`);

  const attention = eventlog.read(200).filter((e) => e.needsAttention);
  if (attention.length) {
    console.log('\n' + paint(c.bold, 'Needs your attention'));
    for (const e of attention.slice(0, 5)) {
      console.log(`  ${warn('!')} ${e.label || e.errorClass}: ${e.detail || ''}`);
    }
  }

  console.log('');
  if (problems.length) {
    console.log(bad(`${problems.length} problem${problems.length === 1 ? '' : 's'} to fix:`));
    problems.forEach((p) => console.log(`  • ${p}`));
    return 1;
  }
  console.log(ok('Everything checks out. Your sessions will resume themselves after an API error.'));
  return 0;
}

function cmdStatus() {
  const cfg = loadConfig();
  const st = installer.status();
  const sum = sessions.summarise(sessions.listSessions(), cfg.limits.stalledAfterMs);
  const stats = ledger.stats();
  const protection = !cfg.enabled ? 'paused' : st.complete ? 'active' : 'hooks not installed';
  console.log(`Lifeline ${protection} · ${sum.alive} session(s), ${sum.busy} working · ${stats.today} recovered in 24h`);
  return cfg.enabled && st.complete ? 0 : 1;
}

/* ========================= controlling the app ========================= */

/**
 * Write one dotted key into config.json.
 *
 * Merged over the loaded config rather than written raw, so a CLI change cannot
 * drop a key the app added — see loadConfig's contract in config.js.
 */
function patchConfig(dotted, value) {
  const parts = dotted.split('.');
  const patch = {};
  let node = patch;
  for (let i = 0; i < parts.length - 1; i++) {
    node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
  const next = deepMerge(loadConfig(), patch);
  saveConfig(next);
  return next;
}

/** Read one dotted key, or undefined. */
function readConfigPath(cfg, dotted) {
  return dotted.split('.').reduce((node, k) => (node == null ? undefined : node[k]), cfg);
}

/**
 * The master switch, from a terminal.
 *
 * Worth saying explicitly which sessions this affects: the hook reads config on
 * every fire, so a pause applies to sessions that are already running — unlike
 * installing a hook, which does not.
 */
function cmdPause() {
  const cfg = loadConfig();
  if (!cfg.enabled) {
    console.log(warn('•') + ' Protection was already paused.');
    return 0;
  }
  patchConfig('enabled', false);
  eventlog.append({ kind: eventlog.KINDS.INFO, detail: 'Protection paused from the command line.' });
  console.log(ok('✓') + ' Protection paused. Nothing will be resumed.');
  console.log(dim('  This applies to sessions already running — the hook reads config on every failure.'));
  console.log(dim('  Turn it back on: node scripts/cli.mjs resume'));
  return 0;
}

function cmdResume() {
  const cfg = loadConfig();
  if (cfg.enabled) {
    console.log(warn('•') + ' Protection was already on.');
    return 0;
  }
  patchConfig('enabled', true);
  eventlog.append({ kind: eventlog.KINDS.INFO, detail: 'Protection resumed from the command line.' });
  console.log(ok('✓') + ' Protection on. Sessions will resume themselves after an API error.');
  return 0;
}

/** Every live session, one per line. The `status` command's detail view. */
function cmdSessions() {
  const cfg = loadConfig();
  const list = sessions.listSessions();
  if (!list.length) {
    console.log(dim('No sessions registered. Claude Code writes a record per session while it runs.'));
    return 0;
  }

  const stalled = new Set(sessions.findStalled(list, cfg.limits.stalledAfterMs).map((s) => s.sessionId));
  console.log(paint(c.bold, 'Sessions') + '\n');
  for (const s of list) {
    const state = !s.alive
      ? bad('gone')
      : stalled.has(s.sessionId)
        ? warn('stalled')
        : s.status === 'busy'
          ? paint(c.cyan, 'working')
          : ok('idle');
    const idle = s.idleMs == null ? '' : dim(` last active ${humanAge(s.idleMs)}`);
    const name = s.name || (s.cwd ? path.basename(s.cwd) : 'unknown');
    console.log(`  ${state.padEnd(plain ? 8 : 17)} ${String(s.sessionId || '').slice(0, 8)}  ${name}${idle}`);
  }
  console.log('');
  const sum = sessions.summarise(list, cfg.limits.stalledAfterMs);
  console.log(dim(`${sum.alive} live, ${sum.busy} working, ${sum.stalled} stalled, ${sum.dead} died mid-task`));
  return 0;
}

/** Rounded, human age of a duration in ms. */
function humanAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

/**
 * Recent events, newest first.
 *
 * Includes `fix` where there is one: an alert whose whole purpose is to say what
 * to do should say it here too, not only in the app's window.
 */
function cmdLog(argv) {
  const limit = Math.min(Math.max(Number(argv[0]) || 20, 1), 500);
  const events = eventlog.read(limit);
  if (!events.length) {
    console.log(dim('Nothing logged yet.'));
    return 0;
  }
  const tone = { recovered: ok, notified: warn, blocked: bad, error: bad, skipped: dim, info: dim };
  for (const e of events) {
    const mark = (tone[e.kind] || dim)('•');
    const when = new Date(e.at).toLocaleString();
    console.log(`${mark} ${dim(when)}  ${e.label || e.errorClass || e.kind}`);
    if (e.detail) console.log(`    ${e.detail}`);
    if (e.fix) console.log(`    ${paint(c.cyan, '→')} ${e.fix}`);
  }
  return 0;
}

/**
 * What Claude Code has cost, from the transcripts.
 *
 * A synchronous scan rather than the app's worker pool: a CLI invocation has
 * nothing else to do while it waits, and reusing the app's cache would mean
 * running its scheduler outside the app.
 */
function cmdCost(argv) {
  const days = Math.min(Math.max(Number(argv[0]) || 30, 1), 3650);
  const cfg = loadConfig();
  if (!cfg.analytics.enabled) {
    console.log(warn('•') + ' Analytics is turned off, so there is nothing to report.');
    console.log(dim('  Turn it on: node scripts/cli.mjs config analytics.enabled true'));
    return 1;
  }

  const sym = cfg.analytics.currencySymbol || '$';
  const rep = analytics.report({ pricingOverrides: cfg.analytics.rates, sessionLimit: 100000 });
  const series = analytics.dailySeries(rep.recent, days);
  const cost = series.reduce((n, d) => n + d.costUsd, 0);
  const active = series.reduce((n, d) => n + d.activeMs, 0);
  const tokens = series.reduce((n, d) => n + d.tokens, 0);
  const count = series.reduce((n, d) => n + d.sessions, 0);

  console.log(paint(c.bold, `Last ${days} day${days === 1 ? '' : 's'}`) + '\n');
  console.log(`  Sessions      ${count}`);
  console.log(`  Active time   ${humanDuration(active)}`);
  console.log(`  Tokens        ${tokens.toLocaleString()}`);
  console.log(`  Estimated     ${sym}${cost.toFixed(2)}`);
  console.log('');
  console.log(dim(`All time: ${sym}${rep.totals.all.costUsd.toFixed(2)} across ${rep.totals.all.sessions} sessions.`));
  // Said once, plainly: this is arithmetic on token counts, not a bill.
  console.log(dim('Derived from token counts at published rates — Claude Code records tokens, not money.'));
  return 0;
}

function humanDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The saved shortcuts, with the ids `launch` takes. */
function cmdPresets() {
  const list = launchpad.listPresets(loadConfig());
  if (!list.length) {
    console.log(dim('No shortcuts saved. Create them on the Launchpad tab.'));
    return 0;
  }
  console.log(paint(c.bold, 'Shortcuts') + '\n');
  for (const p of list) {
    console.log(`  ${paint(c.cyan, p.id.padEnd(14))} ${p.label}`);
    const bits = [p.cwd, p.model, p.permissionMode].filter(Boolean);
    if (bits.length) console.log(`  ${' '.repeat(14)} ${dim(bits.join('  ·  '))}`);
  }
  console.log('');
  console.log(dim('Start one: node scripts/cli.mjs launch <id>'));
  return 0;
}

/**
 * Start a saved shortcut, or a bare session in a folder.
 *
 * Goes through launcher.launch, which is the same path the app's buttons use — so
 * argv still travels as JSON on disk rather than through a shell. That matters
 * most here: a preset's pre-prompt is prose, and wt.exe or cmd.exe would mangle or
 * execute parts of it. See launcher.js.
 */
function cmdLaunch(argv) {
  const which = String(argv[0] || '').trim();
  if (!which) {
    console.error(bad('✗ ') + 'Which shortcut? Run `presets` to see the ids.');
    return 2;
  }

  const cfg = loadConfig();
  const preset = launchpad.findPreset(cfg, which)
    // Convenience: name it by label as well as id, since the label is what is on
    // the button and the id is a generated string nobody memorises.
    || launchpad.listPresets(cfg).find((p) => p.label.toLowerCase() === which.toLowerCase());

  if (!preset) {
    console.error(bad('✗ ') + `No shortcut called "${which}".`);
    console.error(dim('  Run `node scripts/cli.mjs presets` to see what exists.'));
    return 1;
  }

  const res = launcher.launch(preset, { node: process.execPath });
  console.log(ok('✓') + ` Starting ${preset.label}${preset.cwd ? dim(`  in ${preset.cwd}`) : ''}`);
  console.log(dim(`  via ${res.via}`));
  eventlog.append({ kind: eventlog.KINDS.INFO, detail: `Started "${preset.label}" from the command line.`, cwd: preset.cwd || null });
  return 0;
}

/** The two desktop widgets. Config-only, so the app picks the change up live. */
function cmdWidget(argv) {
  const names = ['shortcuts', 'status'];
  const name = String(argv[0] || '').toLowerCase();
  const verb = String(argv[1] || '').toLowerCase();

  if (!names.includes(name) || !['on', 'off'].includes(verb)) {
    console.error(bad('✗ ') + 'Usage: widget <shortcuts|status> <on|off>');
    const cfg = loadConfig();
    for (const n of names) {
      console.error(dim(`  ${n.padEnd(10)} currently ${cfg.widgets[n].enabled ? 'on' : 'off'}`));
    }
    return 2;
  }

  patchConfig(`widgets.${name}.enabled`, verb === 'on');
  console.log(ok('✓') + ` The ${name} widget is ${verb}.`);
  if (verb === 'on') console.log(dim('  It appears on the desktop when the app is running.'));
  return 0;
}

/**
 * Read or write any config key, for the things that have no dedicated command.
 *
 * Deliberately typed rather than string-only: `true` written as the string "true"
 * is a value the schema does not expect, and every consumer treats a non-empty
 * string as truthy — so `config enabled false` would have *enabled* protection.
 * That is the kind of failure a config editor must not have.
 */
function cmdConfig(argv) {
  const cfg = loadConfig();
  const key = argv[0];

  if (!key) {
    // No key: the whole file, which is the useful default for a config command.
    console.log(JSON.stringify(cfg, null, 2));
    return 0;
  }

  if (argv.length < 2) {
    const value = readConfigPath(cfg, key);
    if (value === undefined) {
      console.error(bad('✗ ') + `No such setting: ${key}`);
      return 1;
    }
    console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
    return 0;
  }

  const current = readConfigPath(cfg, key);
  if (current === undefined) {
    console.error(bad('✗ ') + `No such setting: ${key}`);
    console.error(dim('  Run `node scripts/cli.mjs config` to see every key.'));
    return 1;
  }
  if (current !== null && typeof current === 'object') {
    console.error(bad('✗ ') + `${key} is a section, not a single setting.`);
    return 1;
  }

  const raw = argv.slice(1).join(' ');
  let value = raw;
  if (typeof current === 'boolean') {
    if (!/^(true|false|on|off|yes|no|1|0)$/i.test(raw)) {
      console.error(bad('✗ ') + `${key} is a switch — pass true or false.`);
      return 1;
    }
    value = /^(true|on|yes|1)$/i.test(raw);
  } else if (typeof current === 'number') {
    value = Number(raw);
    if (!Number.isFinite(value)) {
      console.error(bad('✗ ') + `${key} is a number, and "${raw}" is not one.`);
      return 1;
    }
  }

  patchConfig(key, value);
  console.log(ok('✓') + ` ${key}: ${dim(String(current))} → ${String(value)}`);
  return 0;
}

const commands = {
  install: cmdInstall,
  uninstall: cmdUninstall,
  pin: cmdPin,
  doctor: cmdDoctor,
  status: cmdStatus,
  'statusline-on': cmdStatuslineInstall,
  'statusline-off': cmdStatuslineUninstall,
  pause: cmdPause,
  resume: cmdResume,
  sessions: cmdSessions,
  log: cmdLog,
  cost: cmdCost,
  presets: cmdPresets,
  launch: cmdLaunch,
  widget: cmdWidget,
  config: cmdConfig,
};
const cmd = process.argv[2];

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`Claude Lifeline

Setup
  install         register the recovery hooks with Claude Code
  uninstall       remove them
  pin             snapshot the recovery code and run hooks from that copy
  statusline-on   show session state as a dot inside Claude Code itself
  statusline-off  restore whatever statusline you had before

Checking
  doctor          verify every link in the recovery chain
  status          one-line summary
  sessions        every live session and what it is doing
  log [n]         recent events, newest first (default 20)
  cost [days]     time, tokens and estimated spend (default 30)

Controlling
  pause           stop resuming sessions, including ones already running
  resume          start again
  launch <id>     start a saved shortcut
  presets         list the saved shortcuts and their ids
  widget <shortcuts|status> <on|off>
  config [key [value]]
                  read or write any setting; no arguments prints them all

These write config.json, which the app watches and the hook reads on every
failure — so they work whether or not the app is running.`);
  process.exit(0);
}

if (!commands[cmd]) {
  console.error(bad(`Unknown command: ${cmd}`));
  console.error(dim('Run with --help to see what exists.'));
  process.exit(2);
}

try {
  // Everything after the command name, so a command can take arguments.
  process.exit(commands[cmd](process.argv.slice(3)));
} catch (err) {
  console.error(bad('✗ ') + err.message);
  process.exit(1);
}
