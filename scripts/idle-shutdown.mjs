#!/usr/bin/env node
/**
 * Shut the machine down once every Claude Code session has genuinely finished.
 *
 * The decision lives in src/shared/idle-shutdown.js and is deliberately a veto:
 * anything unexplained blocks. This file is the part that waits and then acts.
 *
 * Usage:
 *   node scripts/idle-shutdown.mjs --check              report and exit; never acts
 *   node scripts/idle-shutdown.mjs --at 05:00           wait until 05:00, then decide
 *   node scripts/idle-shutdown.mjs --at 05:00 --dry-run  as above, but only say what it would do
 *   node scripts/idle-shutdown.mjs --now                decide immediately
 *
 * Options:
 *   --grace <min>    keep re-checking for this long after the deadline, in case a
 *                    session is mid-recovery. Default 90.
 *   --recheck <min>  interval between re-checks during the grace period. Default 10.
 *   --quiet <min>    transcript silence required before a session counts as done.
 *   --hibernate      hibernate instead of powering off.
 *   --dry-run        never issue the shutdown command.
 *
 * Exit codes: 0 shutdown issued (or would be), 1 blocked, 2 bad arguments.
 *
 * The default is 90 minutes of grace with a re-check every 10, because the
 * failure this guards against is a session that is 3 minutes into a 5-attempt
 * rate-limit backoff at the moment the clock strikes. Giving up immediately on
 * the first blocked check would defeat the point of running Lifeline at all.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idle = require(path.join(root, 'src/shared/idle-shutdown.js'));
const eventlog = require(path.join(root, 'src/shared/eventlog.js'));

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
function opt(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const MIN = 60_000;
const args = {
  check: has('--check'),
  now: has('--now'),
  dryRun: has('--dry-run'),
  hibernate: has('--hibernate'),
  at: opt('--at'),
  graceMs: Number(opt('--grace', '90')) * MIN,
  recheckMs: Number(opt('--recheck', '10')) * MIN,
  quietMs: opt('--quiet') ? Number(opt('--quiet')) * MIN : undefined,
};

if (has('--help') || has('-h')) {
  console.log(
    [
      'Shut down when all Claude Code sessions are truly finished.',
      '',
      '  --check            report the decision and exit (never acts)',
      '  --at HH:MM         wait until this local time, then decide',
      '  --now              decide immediately',
      '  --grace <min>      keep re-checking this long after the deadline (default 90)',
      '  --recheck <min>    re-check interval during grace (default 10)',
      '  --quiet <min>      transcript silence required per session (default 20)',
      '  --hibernate        hibernate instead of powering off',
      '  --dry-run          say what would happen, but do not shut down',
    ].join('\n')
  );
  process.exit(0);
}

for (const [name, value] of [
  ['--grace', args.graceMs],
  ['--recheck', args.recheckMs],
]) {
  if (!Number.isFinite(value) || value < 0) {
    console.error(`Invalid ${name}: expected a number of minutes.`);
    process.exit(2);
  }
}
if (args.quietMs !== undefined && (!Number.isFinite(args.quietMs) || args.quietMs <= 0)) {
  console.error('Invalid --quiet: expected a positive number of minutes.');
  process.exit(2);
}

const stamp = () => new Date().toLocaleTimeString();
const log = (msg) => console.log(`[${stamp()}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Next occurrence of HH:MM in local time — tomorrow if it has already passed. */
function nextTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) return null;
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target;
}

function report(result) {
  if (result.safe) {
    log('All sessions are finished. Nothing is in flight.');
    return;
  }
  log(`Not safe to shut down — ${result.blockers.length} blocker(s):`);
  for (const b of result.blockers) console.log(`    • ${b.detail}`);
}

function powerOff() {
  // shutdown.exe rather than Stop-Computer: it is present on every Windows 11
  // edition and needs no PowerShell module. /t 60 leaves a minute to cancel with
  // `shutdown /a`, which matters when the decision was made while you slept.
  const cmdArgs = args.hibernate ? ['/h'] : ['/s', '/t', '60', '/c', 'Claude Lifeline: all sessions finished.'];
  return new Promise((resolve) => {
    execFile('shutdown', cmdArgs, (err, stdout, stderr) => {
      if (err) {
        log(`Shutdown command failed: ${(stderr || err.message).trim()}`);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

async function decideAndAct() {
  const deadline = Date.now() + args.graceMs;
  let attempt = 0;

  for (;;) {
    attempt++;
    const result = idle.assess(args.quietMs === undefined ? {} : { quietMs: args.quietMs });
    report(result);

    if (result.safe) {
      const what = args.hibernate ? 'Hibernating' : 'Shutting down';
      if (args.dryRun) {
        log(`[dry run] ${what} now. Nothing was actually done.`);
        eventlog.append({
          kind: eventlog.KINDS.INFO,
          detail: `Idle shutdown check passed after ${attempt} attempt(s). Dry run — no action taken.`,
        });
        return 0;
      }
      eventlog.append({
        kind: eventlog.KINDS.INFO,
        detail:
          `All ${result.checks.sessionsAlive} session(s) verified finished; ${what.toLowerCase()} the machine. ` +
          `Checked ${result.checks.transcriptsExamined} transcript(s), no recoveries in the last ${Math.round(result.recoveryWindowMs / 60_000)} min.`,
      });
      log(`${what} in 60 seconds. Cancel with:  shutdown /a`);
      const issued = await powerOff();
      return issued ? 0 : 1;
    }

    if (Date.now() + args.recheckMs > deadline) {
      // Out of grace. Staying on is the deliberate outcome — the reasons are in
      // the log so the morning has an explanation rather than a mystery.
      const reasons = result.blockers.map((b) => b.detail).join(' ');
      log(`Grace period exhausted after ${attempt} check(s). Leaving the machine on.`);
      eventlog.append({
        kind: eventlog.KINDS.INFO,
        needsAttention: false,
        detail: `Idle shutdown declined: work was still in flight after ${Math.round(args.graceMs / 60_000)} min of grace. ${reasons}`.slice(0, 900),
      });
      return 1;
    }

    log(`Re-checking in ${Math.round(args.recheckMs / 60_000)} min (grace ends ${new Date(deadline).toLocaleTimeString()}).`);
    await sleep(args.recheckMs);
  }
}

async function main() {
  if (args.check) {
    const result = idle.assess(args.quietMs === undefined ? {} : { quietMs: args.quietMs });
    report(result);
    console.log('');
    console.log(`  sessions alive/busy   ${result.checks.sessionsAlive} / ${result.checks.sessionsBusy}`);
    console.log(`  transcripts checked   ${result.checks.transcriptsExamined} (${result.checks.transcriptsUnfinished} unfinished)`);
    console.log(`  recoveries in window  ${result.checks.recoveriesInWindow}`);
    console.log(`  items needing you     ${result.checks.openAttention}`);
    return result.safe ? 0 : 1;
  }

  if (!args.now && !args.at) {
    console.error('Nothing to do: pass --check, --now, or --at HH:MM. See --help.');
    return 2;
  }

  if (args.at) {
    const target = nextTime(args.at);
    if (!target) {
      console.error(`Invalid --at "${args.at}": expected HH:MM in 24-hour form.`);
      return 2;
    }
    const waitMs = target.getTime() - Date.now();
    log(`Waiting until ${target.toLocaleString()} (${Math.round(waitMs / 60_000)} min) before deciding.`);
    log('Recovery is unaffected by this process: it runs inside Claude Code.');
    await sleep(waitMs);
  }

  return decideAndAct();
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Any crash means the decision was never made, and the only safe reading of
    // "no decision" is: do not shut down.
    console.error(`Idle shutdown aborted: ${err && err.message}`);
    try {
      eventlog.append({ kind: eventlog.KINDS.ERROR, detail: `Idle shutdown check crashed, machine left on: ${err && err.message}` });
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
