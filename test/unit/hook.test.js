'use strict';
/**
 * End-to-end tests for the hook process itself.
 *
 * These spawn the real hook binary and assert on its exit code, because the
 * exit code *is* the contract with Claude Code: 2 resumes the session, 0 does
 * nothing. A unit test of the internals could pass while that contract broke.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', '..', 'src', 'hook', 'lifeline-hook.js');
const EXIT_NOOP = 0;
const EXIT_REWAKE = 2;

function runHook(payload, { config = null, home = null } = {}) {
  const scratch = home || fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-hook-'));
  if (config) {
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'config.json'), JSON.stringify(config), 'utf8');
  }
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, LIFELINE_HOME: scratch },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { ...res, scratch, events: readEvents(scratch) };
}

function readEvents(home) {
  try {
    return fs
      .readFileSync(path.join(home, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const stopFailure = (over = {}) => ({
  hook_event_name: 'StopFailure',
  session_id: 'sess-' + Math.random().toString(16).slice(2),
  prompt_id: 'prompt-' + Math.random().toString(16).slice(2),
  cwd: 'C:\\work\\project',
  error: 'server_error',
  last_assistant_message: 'I was editing the config file when it failed.',
  ...over,
});

// Fast backoff so the suite does not sit waiting out real delays.
const fastConfig = (over = {}) => ({
  enabled: true,
  policies: {
    server_error: { backoffMs: 0 },
    rate_limit: { backoffMs: 0 },
    overloaded: { backoffMs: 0 },
    unknown: { backoffMs: 0 },
    invalid_request: { backoffMs: 0 },
    max_output_tokens: { backoffMs: 0 },
  },
  limits: { cooldownMs: 0 },
  ...over,
});

test('a transient API error exits 2 to resume the session', () => {
  const r = runHook(stopFailure({ error: 'server_error' }), { config: fastConfig() });
  assert.equal(r.status, EXIT_REWAKE, 'exit 2 is what makes Claude Code resume');
  assert.match(r.stderr, /Continue exactly where you left off/);
  assert.match(r.stderr, /Claude Lifeline recovery context/);
});

test('the injected message carries the failure class and attempt number', () => {
  const r = runHook(stopFailure({ error: 'rate_limit' }), { config: fastConfig() });
  assert.equal(r.status, EXIT_REWAKE);
  assert.match(r.stderr, /Failure class: rate_limit/);
  assert.match(r.stderr, /Recovery attempt: 1/);
});

test('the injected message quotes the last output so the model can orient', () => {
  const r = runHook(stopFailure({ last_assistant_message: 'Editing src/app.ts now' }), { config: fastConfig() });
  assert.match(r.stderr, /Editing src\/app\.ts now/);
});

test('an auth failure is reported but never retried', () => {
  const r = runHook(stopFailure({ error: 'authentication_failed' }), { config: fastConfig() });
  assert.equal(r.status, EXIT_NOOP, 'retrying a bad credential cannot succeed');
  assert.equal(r.stderr, '');
  const ev = r.events.find((e) => e.kind === 'notified');
  assert.ok(ev, 'the user still needs to be told');
  assert.equal(ev.needsAttention, true);
});

test('a billing error is reported but never retried', () => {
  const r = runHook(stopFailure({ error: 'billing_error' }), { config: fastConfig() });
  assert.equal(r.status, EXIT_NOOP);
  assert.ok(r.events.some((e) => e.kind === 'notified'));
});

test('context overflow asks for a compact rather than retrying unchanged', () => {
  const r = runHook(stopFailure({ error: 'invalid_request' }), { config: fastConfig() });
  assert.equal(r.status, EXIT_REWAKE);
  assert.match(r.stderr, /\/compact/);
});

test('truncated output resumes from the cut', () => {
  const r = runHook(stopFailure({ error: 'max_output_tokens' }), { config: fastConfig() });
  assert.equal(r.status, EXIT_REWAKE);
  assert.match(r.stderr, /Continue from exactly where the output stopped/);
});

test('an unrecognised class still resumes via the fallback policy', () => {
  const r = runHook(stopFailure({ error: 'some_future_error' }), { config: fastConfig() });
  assert.equal(r.status, EXIT_REWAKE, 'a new error class must not silently disable recovery');
});

test('the master switch stops all recovery', () => {
  const r = runHook(stopFailure(), { config: fastConfig({ enabled: false }) });
  assert.equal(r.status, EXIT_NOOP);
  assert.equal(r.stderr, '');
  assert.ok(r.events.some((e) => e.kind === 'skipped' && e.reason === 'disabled'));
});

test('the API-error feature toggle stops only that path', () => {
  const r = runHook(stopFailure(), { config: fastConfig({ features: { apiErrorRecovery: false } }) });
  assert.equal(r.status, EXIT_NOOP);
  assert.ok(r.events.some((e) => e.reason === 'feature_off'));
});

test('a denylisted project is left alone', () => {
  const r = runHook(stopFailure({ cwd: 'C:\\secret\\thing' }), {
    config: fastConfig({ advanced: { projectDenylist: ['C:\\secret'] } }),
  });
  assert.equal(r.status, EXIT_NOOP);
  assert.ok(r.events.some((e) => e.reason === 'project_filtered'));
});

test('an allowlist excludes everything outside it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-allow-'));
  const cfg = fastConfig({ advanced: { projectAllowlist: ['C:\\work'] } });

  const inside = runHook(stopFailure({ cwd: 'C:\\work\\repo' }), { config: cfg, home });
  assert.equal(inside.status, EXIT_REWAKE);

  const outside = runHook(stopFailure({ cwd: 'D:\\elsewhere' }), { config: cfg, home });
  assert.equal(outside.status, EXIT_NOOP);
});

test('repeated failures on one prompt stop at the cap', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-cap-'));
  const cfg = fastConfig({ limits: { maxAttemptsPerPrompt: 2, cooldownMs: 0 } });
  const payload = stopFailure();

  assert.equal(runHook(payload, { config: cfg, home }).status, EXIT_REWAKE);
  assert.equal(runHook(payload, { config: cfg, home }).status, EXIT_REWAKE);

  const third = runHook(payload, { config: cfg, home });
  assert.equal(third.status, EXIT_NOOP, 'the loop guard must hold');
  const blocked = third.events.find((e) => e.kind === 'blocked');
  assert.ok(blocked);
  assert.equal(blocked.reason, 'prompt_limit');
});

test('malformed stdin is ignored quietly', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-bad-'));
  const res = spawnSync(process.execPath, [HOOK], {
    input: 'this is not json',
    env: { ...process.env, LIFELINE_HOME: scratch },
    encoding: 'utf8',
  });
  assert.equal(res.status, EXIT_NOOP, 'garbage in must not break the session');
});

test('empty stdin is ignored quietly', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-empty-'));
  const res = spawnSync(process.execPath, [HOOK], {
    input: '',
    env: { ...process.env, LIFELINE_HOME: scratch },
    encoding: 'utf8',
  });
  assert.equal(res.status, EXIT_NOOP);
});

test('unrelated hook events are ignored', () => {
  const r = runHook({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash' }, { config: fastConfig() });
  assert.equal(r.status, EXIT_NOOP);
});

test('a clean Stop with no background work does nothing', () => {
  const r = runHook({ hook_event_name: 'Stop', session_id: 's', cwd: 'C:\\w', background_tasks: [], session_crons: [] }, { config: fastConfig() });
  assert.equal(r.status, EXIT_NOOP, 'a finished turn must not be nudged');
});

test('a Stop with in-flight background work resumes', () => {
  const r = runHook(
    {
      hook_event_name: 'Stop',
      session_id: 's',
      prompt_id: 'p',
      cwd: 'C:\\w',
      background_tasks: [{ id: 't1', status: 'running', description: 'build' }],
      session_crons: [],
    },
    { config: fastConfig() }
  );
  assert.equal(r.status, EXIT_REWAKE);
  assert.match(r.stderr, /background task/i);
});

test('a scheduled cron is left to wake the session itself', () => {
  const r = runHook(
    {
      hook_event_name: 'Stop',
      session_id: 's',
      cwd: 'C:\\w',
      background_tasks: [{ id: 't1', status: 'running' }],
      session_crons: [{ id: 'c1', schedule: '*/5 * * * *' }],
    },
    { config: fastConfig() }
  );
  assert.equal(r.status, EXIT_NOOP, 'nudging here would duplicate the cron wake');
});

test('an already-resumed Stop does not chain another resume', () => {
  const r = runHook(
    {
      hook_event_name: 'Stop',
      session_id: 's',
      cwd: 'C:\\w',
      stop_hook_active: true,
      background_tasks: [{ id: 't1', status: 'running' }],
      session_crons: [],
    },
    { config: fastConfig() }
  );
  assert.equal(r.status, EXIT_NOOP);
});

test('tool-failure nudging is off unless enabled', () => {
  const r = runHook(
    { hook_event_name: 'PostToolUseFailure', session_id: 's', cwd: 'C:\\w', tool_name: 'Bash', is_timeout: true, error: 'timed out' },
    { config: fastConfig() }
  );
  assert.equal(r.status, EXIT_NOOP);
});

test('an enabled tool timeout nudges the model', () => {
  const r = runHook(
    { hook_event_name: 'PostToolUseFailure', session_id: 's', cwd: 'C:\\w', tool_name: 'Bash', is_timeout: true, error: 'timed out' },
    { config: fastConfig({ features: { toolFailureRecovery: true } }) }
  );
  assert.equal(r.status, EXIT_REWAKE);
  assert.match(r.stderr, /timeout/i);
});

test('an ordinary tool error is left to the model even when enabled', () => {
  const r = runHook(
    { hook_event_name: 'PostToolUseFailure', session_id: 's', cwd: 'C:\\w', tool_name: 'Bash', error: 'exit 1' },
    { config: fastConfig({ features: { toolFailureRecovery: true } }) }
  );
  assert.equal(r.status, EXIT_NOOP, 'the model already sees and handles normal tool errors');
});

test('a recovery is written to the event log for the UI', () => {
  const r = runHook(stopFailure({ error: 'overloaded' }), { config: fastConfig() });
  const ev = r.events.find((e) => e.kind === 'recovered');
  assert.ok(ev);
  assert.equal(ev.errorClass, 'overloaded');
  assert.equal(ev.attemptNumber, 1);
  assert.ok(ev.at, 'events need a timestamp to render a timeline');
});

test('backoff is actually observed before resuming', () => {
  const t0 = Date.now();
  const r = runHook(stopFailure({ error: 'server_error' }), {
    config: fastConfig({ policies: { server_error: { backoffMs: 1200 } } }),
  });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, EXIT_REWAKE);
  assert.ok(elapsed >= 1000, `expected a real wait, took ${elapsed}ms`);
});

test('a missing config file falls back to working defaults', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-nocfg-'));
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(stopFailure({ error: 'max_output_tokens' })),
    env: { ...process.env, LIFELINE_HOME: scratch },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(res.status, EXIT_REWAKE, 'no config must still mean protected');
});

test('a corrupt config file falls back to working defaults', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-badcfg-'));
  fs.writeFileSync(path.join(scratch, 'config.json'), '{ broken', 'utf8');
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(stopFailure({ error: 'max_output_tokens' })),
    env: { ...process.env, LIFELINE_HOME: scratch },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(res.status, EXIT_REWAKE, 'a broken config must not disable recovery');
});
