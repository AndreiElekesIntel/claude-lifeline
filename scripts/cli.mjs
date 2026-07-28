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
 *   node scripts/cli.mjs doctor      check that everything is wired up
 *   node scripts/cli.mjs status      one-line summary
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const installer = require(path.join(root, 'src/shared/installer.js'));
const paths = require(path.join(root, 'src/shared/paths.js'));
const { loadConfig } = require(path.join(root, 'src/shared/config.js'));
const eventlog = require(path.join(root, 'src/shared/eventlog.js'));
const ledger = require(path.join(root, 'src/shared/ledger.js'));
const sessions = require(path.join(root, 'src/shared/sessions.js'));
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

  // 2. The hook file exists where settings.json points.
  const hook = paths.hookEntry();
  if (fs.existsSync(hook)) line('ok', 'Hook script present', hook);
  else {
    line('fail', 'Hook script missing', hook);
    problems.push('The hook file is missing — reinstall the project.');
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

const commands = { install: cmdInstall, uninstall: cmdUninstall, doctor: cmdDoctor, status: cmdStatus };
const cmd = process.argv[2];

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`Claude Lifeline

  install     register the recovery hooks with Claude Code
  uninstall   remove them
  doctor      verify every link in the recovery chain
  status      one-line summary`);
  process.exit(0);
}

if (!commands[cmd]) {
  console.error(bad(`Unknown command: ${cmd}`));
  process.exit(2);
}

try {
  process.exit(commands[cmd]());
} catch (err) {
  console.error(bad('✗ ') + err.message);
  process.exit(1);
}
