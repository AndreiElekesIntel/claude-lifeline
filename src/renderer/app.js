'use strict';
/**
 * Renderer logic.
 *
 * Runs sandboxed: no Node, no require, no network. Everything it knows arrives
 * through `window.lifeline` (see preload.js), and everything it changes goes
 * back the same way.
 *
 * Rendering rule followed throughout: build DOM nodes and set `textContent`.
 * Session names, project paths, and API error text are all attacker-adjacent
 * strings, and innerHTML on any of them would be an injection hole — so it is
 * not used for dynamic content anywhere in this file.
 */

const api = window.lifeline;

/** Last state pushed from main. Every render reads from this. */
let state = null;
/** Guards the config forms from echoing a save back as a fresh edit. */
let applyingConfig = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ============================ small helpers ============================ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** "3m ago" style. Coarse on purpose: exact seconds are noise here. */
function relTime(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function humanMs(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/** Last path segment — the project name is what identifies a session to a human. */
function projectName(cwd) {
  if (!cwd) return '—';
  const parts = String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

function toast(message, tone = 'info') {
  const host = $('#toastHost');
  const t = el('div', `toast ${tone}`);
  t.appendChild(el('div', 'bar'));
  t.appendChild(el('span', null, message));
  host.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 220);
  }, 3600);
}

/* ============================== theming =============================== */

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme, accent) {
  const root = document.documentElement;
  const resolved = theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : theme;
  root.dataset.theme = resolved;
  root.dataset.accent = accent || 'violet';
}

// Following Windows live means reacting to the OS switch, not just reading it once.
systemDark.addEventListener('change', () => {
  if (state && state.config.ui.theme === 'system') applyTheme('system', state.config.ui.accent);
});

/* ============================ navigation ============================== */

function goTo(tab) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.dataset.tab === tab));
  $('#content').scrollTop = 0;
}

$$('.nav-item').forEach((btn) => btn.addEventListener('click', () => goTo(btn.dataset.tab)));
$$('[data-goto]').forEach((btn) => btn.addEventListener('click', () => goTo(btn.dataset.goto)));

/* ============================== dashboard ============================= */

const STATUS_TEXT = {
  running: 'Protecting',
  waiting: 'Waiting for sessions',
  paused: 'Paused',
  attention: 'Needs attention',
  error: 'Error',
};

function renderStatus() {
  const pill = $('#statusPill');
  pill.dataset.status = state.status;
  $('#statusText').textContent = STATUS_TEXT[state.status] || state.status;
  if (state.iconUrl) $('#brandIcon').src = state.iconUrl;

  const btn = $('#btnToggleProtection');
  btn.textContent = state.config.enabled ? 'Pause protection' : 'Resume protection';
  btn.classList.toggle('primary', !state.config.enabled);
  btn.classList.toggle('ghost', state.config.enabled);
}

function renderDashboard() {
  const { summary, stats, hooks, config } = state;

  // The banner is the single most important thing on the page when it applies:
  // without hooks installed, nothing at all is protected.
  $('#hookBanner').classList.toggle('hidden', Boolean(hooks && hooks.complete));

  $('#statLive').textContent = summary.alive;
  $('#statLiveFoot').textContent = summary.busy
    ? `${summary.busy} working right now`
    : summary.alive
      ? 'all idle'
      : 'nothing running';

  const recoveredToday = stats.recoveredToday ?? stats.today;
  $('#statRecovered').textContent = recoveredToday;
  const lastAt = stats.lastRecoveryAt || stats.lastAttemptAt;
  $('#statRecoveredFoot').textContent = lastAt ? `last ${relTime(lastAt)}` : 'none yet';

  $('#statAttention').textContent = state.attention.length;
  $('#statAttentionFoot').textContent = state.attention.length
    ? 'needs a human'
    : 'nothing outstanding';

  const prot = $('#statProtection');
  prot.textContent = config.enabled ? (hooks && hooks.complete ? 'On' : 'Partial') : 'Off';
  prot.className = 'stat-value ' + (config.enabled && hooks && hooks.complete ? 'ok' : 'warn');
  $('#statProtectionFoot').textContent = !config.enabled
    ? 'paused by you'
    : hooks && hooks.complete
      ? `${hooks.events.length} hooks active`
      : 'hooks not installed';

  const dashSub = $('#dashSubtitle');
  dashSub.textContent = config.enabled
    ? 'Watching your Claude Code sessions. Recovery runs inside Claude Code, so it works even with this window closed.'
    : 'Protection is paused — sessions will not be resumed automatically.';

  renderTimeline($('#recentTimeline'), state.events.filter(isRecoveryish).slice(0, 6), {
    art: '◌',
    title: 'No recoveries yet — that is the good outcome.',
    hint: 'Anything Lifeline rescues will show up here.',
  });

  renderCoverage();
}

function isRecoveryish(e) {
  return ['recovered', 'notified', 'blocked'].includes(e.kind);
}

function renderTimeline(host, events, empty) {
  host.replaceChildren();
  if (!events.length) {
    const box = el('div', 'empty');
    box.appendChild(el('div', 'empty-art', empty.art));
    box.appendChild(el('p', null, empty.title));
    box.appendChild(el('span', null, empty.hint));
    host.appendChild(box);
    return;
  }

  const chipTone = { recovered: 'ok', notified: 'warn', blocked: 'danger', skipped: '', info: 'info', error: 'danger' };
  const kindLabel = {
    recovered: 'Resumed',
    notified: 'Action needed',
    blocked: 'Blocked',
    skipped: 'Skipped',
    info: 'Info',
    error: 'Error',
    stalled: 'Stalled',
    dead: 'Dead',
  };

  for (const e of events) {
    const item = el('div', 'tl-item');
    item.dataset.kind = e.kind;
    item.appendChild(el('div', 'tl-mark'));

    const body = el('div', 'tl-body');
    const title = el('div', 'tl-title');
    title.appendChild(el('span', null, e.label || e.errorClass || kindLabel[e.kind] || e.kind));
    const chip = el('span', `chip ${chipTone[e.kind] || ''}`.trim(), kindLabel[e.kind] || e.kind);
    title.appendChild(chip);
    body.appendChild(title);

    if (e.detail) body.appendChild(el('div', 'tl-detail', e.detail));

    const meta = el('div', 'tl-meta');
    if (e.cwd) meta.appendChild(el('span', null, projectName(e.cwd)));
    if (e.attemptNumber) meta.appendChild(el('span', null, `attempt ${e.attemptNumber}`));
    if (e.waitedMs) meta.appendChild(el('span', null, `waited ${humanMs(e.waitedMs)}`));
    if (e.strategy === 'compact') meta.appendChild(el('span', null, 'via /compact'));
    if (meta.childElementCount) body.appendChild(meta);

    item.appendChild(body);
    item.appendChild(el('div', 'tl-time', relTime(e.at)));
    host.appendChild(item);
  }
}

function renderCoverage() {
  const host = $('#coverageList');
  host.replaceChildren();
  const actionText = { resume: 'Auto-resume', compact: 'Compact + resume', notify: 'Alert you' };

  for (const meta of state.policyMeta || []) {
    const eff = (state.config.policies && state.config.policies[meta.key]) || {};
    const resume = eff.resume !== undefined ? eff.resume : meta.defaultResume;
    const strategy = resume ? meta.strategy : 'notify';

    const row = el('div', 'cov-item');
    const chip = el('span', `chip ${strategy === 'notify' ? 'warn' : strategy === 'compact' ? 'info' : 'ok'}`, actionText[strategy]);
    row.appendChild(chip);
    row.appendChild(el('span', 'cov-name', meta.label));
    row.appendChild(el('span', 'cov-why', meta.reason));
    host.appendChild(row);
  }
}

/* =============================== sessions ============================= */

function renderSessions() {
  const body = $('#sessionBody');
  const list = state.sessions || [];
  body.replaceChildren();
  $('#sessionsEmpty').classList.toggle('hidden', list.length > 0);
  $('#sessionTable').classList.toggle('hidden', list.length === 0);

  const badge = $('#badgeSessions');
  badge.textContent = list.length ? String(list.length) : '';

  const stalledAfter = state.config.limits.stalledAfterMs;

  for (const s of list) {
    const tr = el('tr');

    const nameCell = el('td');
    nameCell.appendChild(el('div', 'cell-main', s.name || s.kind || 'Claude Code'));
    nameCell.appendChild(el('div', 'cell-sub', String(s.sessionId || '').slice(0, 8)));
    tr.appendChild(nameCell);

    const projCell = el('td');
    projCell.appendChild(el('div', 'cell-main', projectName(s.cwd)));
    projCell.appendChild(el('div', 'cell-sub', s.cwd || ''));
    tr.appendChild(projCell);

    // State merges liveness with reported status: "busy" on a dead process is
    // the dead-session case, and showing it as busy would be a lie.
    let tone = '';
    let text = s.status || 'unknown';
    if (!s.alive) {
      tone = 'danger';
      text = s.status === 'busy' ? 'died while working' : 'exited';
    } else if (s.status === 'busy' && s.idleMs > stalledAfter) {
      tone = 'warn';
      text = 'stalled';
    } else if (s.status === 'busy') {
      tone = 'accent';
      text = 'working';
    } else {
      tone = 'info';
      text = 'idle';
    }
    const stateCell = el('td');
    stateCell.appendChild(el('span', `chip ${tone}`, text));
    tr.appendChild(stateCell);

    tr.appendChild(el('td', 'mono', relTime(s.updatedAt)));
    tr.appendChild(el('td', 'mono', s.pid));
    body.appendChild(tr);
  }
}

/* =============================== activity ============================= */

function renderActivity() {
  const filter = $('#activityFilter').value;
  const events = (state.events || []).filter((e) => filter === 'all' || e.kind === filter);
  renderTimeline($('#activityTimeline'), events, {
    art: '⌁',
    title: filter === 'all' ? 'Nothing logged yet.' : 'No events of this kind.',
    hint: 'Events appear the moment a session hits trouble.',
  });

  const badge = $('#badgeAttention');
  badge.textContent = state.attention.length ? String(state.attention.length) : '';
}

$('#activityFilter').addEventListener('change', () => renderActivity());

/* =============================== settings ============================= */

const FEATURE_COPY = {
  apiErrorRecovery: ['Resume after API errors', 'The core feature: when a rate limit, overload, or dropped connection ends a turn, wait it out and continue.'],
  contextOverflowRecovery: ['Recover from context overflow', 'When the conversation grows too long to send, run /compact and then continue.'],
  toolFailureRecovery: ['Nudge after tool timeouts', 'If a tool call times out or is interrupted, prompt the model to handle it instead of stopping.'],
  backgroundTaskRecovery: ['Wait for background tasks', 'If a turn ends while background work is still running, resume once it reports back.'],
  stalledSessionDetection: ['Detect stalled sessions', 'Flag a session that says it is working but has not made progress for a long time.'],
  deadSessionDetection: ['Detect dead sessions', 'Notice when the Claude Code process disappeared mid-task.'],
  deadSessionRelaunch: ['Relaunch dead sessions', 'Start a replacement with --resume. Off by default, because it launches processes on your behalf.'],
  desktopNotifications: ['Desktop notifications', 'A Windows toast whenever a session is resumed or needs you.'],
  soundAlerts: ['Sound with notifications', 'Play the notification sound instead of showing it silently.'],
  respectNonRetryable: ['Never retry hopeless failures', 'Keep auth, billing, and org-policy errors on notify-only. Turning this off lets you force retries that cannot succeed.'],
};

const LIMIT_COPY = {
  maxAttemptsPerPrompt: ['Attempts per prompt', 'Resumes for a single prompt before Lifeline gives up.', 1, 50],
  maxAttemptsPerHour: ['Attempts per hour', 'Per session, in a rolling hour.', 1, 200],
  maxAttemptsPerDay: ['Attempts per day', 'Across every session — the backstop against runaway spend.', 1, 5000],
  cooldownMs: ['Cooldown (ms)', 'Ignore a repeat failure that lands within this window.', 0, 600000],
  maxBackoffMs: ['Maximum backoff (ms)', 'Ceiling on the exponential wait between attempts.', 1000, 3600000],
  stalledAfterMs: ['Stalled after (ms)', 'Idle time before a working session counts as stalled.', 60000, 21600000],
};

const ADVANCED_COPY = {
  debugLogging: ['Verbose hook logging', 'Write every hook decision to hook.log. Useful when diagnosing why a session was not resumed.'],
};

/** Read a nested path like 'limits.cooldownMs'. */
function patchFor(path, value) {
  const parts = path.split('.');
  const root = {};
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] = {};
  cur[parts[parts.length - 1]] = value;
  return root;
}

async function pushConfig(path, value) {
  if (applyingConfig) return;
  try {
    const cfg = await api.saveConfig(patchFor(path, value));
    if (state) state.config = cfg;
    applyTheme(cfg.ui.theme, cfg.ui.accent);
  } catch (err) {
    toast(`Could not save: ${err.message}`, 'danger');
  }
}

function switchControl(checked, onChange) {
  const wrap = el('label', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange(input.checked));
  wrap.appendChild(input);
  wrap.appendChild(el('span', 'switch-track'));
  wrap.appendChild(el('span', 'switch-thumb'));
  return wrap;
}

function toggleRow(title, desc, checked, onChange) {
  const row = el('div', 'toggle-row');
  const text = el('div', 'toggle-text');
  text.appendChild(el('div', 'toggle-title', title));
  text.appendChild(el('div', 'toggle-desc', desc));
  row.appendChild(text);
  row.appendChild(switchControl(checked, onChange));
  return row;
}

/**
 * The settings forms are rebuilt only when the structure could have changed,
 * not on every 5s poll — re-creating inputs under the cursor would fight the
 * user's typing.
 */
function renderSettings() {
  const cfg = state.config;

  const features = $('#featureToggles');
  features.replaceChildren();
  for (const [key, [title, desc]] of Object.entries(FEATURE_COPY)) {
    features.appendChild(toggleRow(title, desc, cfg.features[key], (v) => pushConfig(`features.${key}`, v)));
  }

  const limits = $('#limitFields');
  limits.replaceChildren();
  for (const [key, [label, hint, min, max]] of Object.entries(LIMIT_COPY)) {
    const field = el('label', 'field');
    field.appendChild(el('span', 'field-label', label));
    const input = document.createElement('input');
    input.className = 'input';
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.value = String(cfg.limits[key]);
    // Commit on blur/Enter, not per keystroke: a half-typed "1" in a max-attempts
    // field would otherwise be saved as a real limit of 1.
    input.addEventListener('change', () => {
      const n = Number(input.value);
      if (!Number.isFinite(n) || n < min || n > max) {
        input.value = String(cfg.limits[key]);
        toast(`${label} must be between ${min} and ${max}.`, 'warn');
        return;
      }
      pushConfig(`limits.${key}`, Math.round(n));
    });
    field.appendChild(input);
    field.appendChild(el('span', 'field-hint', hint));
    limits.appendChild(field);
  }

  renderPolicies();

  $('#themeSelect').value = cfg.ui.theme;
  $('#accentSelect').value = cfg.ui.accent;

  const adv = $('#advancedToggles');
  adv.replaceChildren();
  for (const [key, [title, desc]] of Object.entries(ADVANCED_COPY)) {
    adv.appendChild(toggleRow(title, desc, cfg.advanced[key], (v) => pushConfig(`advanced.${key}`, v)));
  }

  const advFields = $('#advancedFields');
  advFields.replaceChildren();
  const logField = el('label', 'field');
  logField.appendChild(el('span', 'field-label', 'Event log size'));
  const logInput = document.createElement('input');
  logInput.className = 'input';
  logInput.type = 'number';
  logInput.min = '100';
  logInput.max = '100000';
  logInput.value = String(cfg.advanced.eventLogLimit);
  logInput.addEventListener('change', () => pushConfig('advanced.eventLogLimit', Math.round(Number(logInput.value) || 2000)));
  logField.appendChild(logInput);
  logField.appendChild(el('span', 'field-hint', 'Events kept in events.jsonl before the oldest are trimmed.'));
  advFields.appendChild(logField);

  renderHookStatus();
}

function renderPolicies() {
  const host = $('#policyList');
  const cfg = state.config;
  host.replaceChildren();

  for (const meta of state.policyMeta || []) {
    const eff = (cfg.policies && cfg.policies[meta.key]) || {};
    const row = el('div', 'policy-row');

    const nameBox = el('div');
    const name = el('div', 'policy-name');
    name.appendChild(el('span', null, meta.label));
    if (!meta.defaultResume) name.appendChild(el('span', 'chip warn', 'manual'));
    else if (meta.strategy === 'compact') name.appendChild(el('span', 'chip info', 'compact'));
    nameBox.appendChild(name);
    nameBox.appendChild(el('div', 'policy-why', meta.reason));
    row.appendChild(nameBox);

    const numField = (label, key, value, min, max) => {
      const f = el('div', 'policy-field');
      const lab = el('label', null, label);
      f.appendChild(lab);
      const input = document.createElement('input');
      input.className = 'input';
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.value = String(value);
      input.disabled = eff.resume === false;
      input.addEventListener('change', () => {
        const n = Number(input.value);
        if (!Number.isFinite(n) || n < min || n > max) {
          input.value = String(value);
          return;
        }
        pushConfig(`policies.${meta.key}.${key}`, Math.round(n));
      });
      f.appendChild(input);
      return f;
    };

    row.appendChild(numField('Wait (ms)', 'backoffMs', eff.backoffMs ?? 0, 0, 3600000));
    row.appendChild(numField('Max tries', 'maxAttempts', eff.maxAttempts ?? 0, 0, 50));

    row.appendChild(
      switchControl(eff.resume, (v) => {
        pushConfig(`policies.${meta.key}.resume`, v).then(() => renderPolicies());
      })
    );

    host.appendChild(row);
  }
}

function renderHookStatus() {
  const host = $('#hookStatus');
  const hooks = state.hooks || { events: [], expected: [] };
  host.replaceChildren();

  if (hooks.error) {
    const line = el('div', 'hook-line');
    line.appendChild(el('span', 'dot off'));
    line.appendChild(el('span', null, hooks.error));
    host.appendChild(line);
    return;
  }

  const descriptions = {
    StopFailure: 'API error ended the turn — the main recovery path',
    Stop: 'Turn ended cleanly — checks for pending background work',
    PostToolUseFailure: 'A tool call failed, timed out, or was interrupted',
  };

  for (const event of hooks.expected || []) {
    const on = (hooks.events || []).includes(event);
    const line = el('div', 'hook-line');
    line.appendChild(el('span', `dot ${on ? 'on' : 'off'}`));
    line.appendChild(el('strong', null, event));
    line.appendChild(el('span', 'field-hint', on ? descriptions[event] || 'registered' : 'not registered'));
    host.appendChild(line);
  }

  const note = el('div', 'field-hint');
  note.textContent = `settings.json: ${(state.paths && state.paths.settings) || ''}`;
  host.appendChild(note);
}

/* ================================ about =============================== */

function renderAbout() {
  const host = $('#aboutPaths');
  host.replaceChildren();
  const rows = [
    ['Data folder', state.paths.home],
    ['Config', state.paths.config],
    ['Event log', state.paths.events],
    ['Hook script', state.paths.hook],
    ['Claude settings', state.paths.settings],
  ];
  for (const [k, v] of rows) {
    host.appendChild(el('div', 'k', k));
    host.appendChild(el('div', 'v', v || '—'));
  }
}

/* ============================= wiring ================================= */

$('#themeToggle').addEventListener('click', () => {
  // The toggle is a direct dark/light flip, which also means leaving 'system'.
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next, state && state.config.ui.accent);
  pushConfig('ui.theme', next).then(() => {
    if (state) $('#themeSelect').value = next;
  });
});

$('#themeSelect').addEventListener('change', (e) => {
  applyTheme(e.target.value, state.config.ui.accent);
  pushConfig('ui.theme', e.target.value);
});
$('#accentSelect').addEventListener('change', (e) => {
  applyTheme(state.config.ui.theme, e.target.value);
  pushConfig('ui.accent', e.target.value);
});

$('#btnMin').addEventListener('click', () => api.window.minimise());
$('#btnMax').addEventListener('click', () => api.window.maximise());
$('#btnClose').addEventListener('click', () => api.window.close());

$('#btnToggleProtection').addEventListener('click', async () => {
  const next = !state.config.enabled;
  await pushConfig('enabled', next);
  toast(next ? 'Protection resumed.' : 'Protection paused — sessions will not be resumed.', next ? 'ok' : 'warn');
  await refresh();
});

async function installHooks() {
  try {
    const res = await api.installHooks();
    toast(`Hooks installed for ${res.installed.join(', ')}.`, 'ok');
    await refresh();
  } catch (err) {
    toast(`Install failed: ${err.message}`, 'danger');
  }
}

$('#btnInstallHooks').addEventListener('click', installHooks);
$('#btnInstallHooks2').addEventListener('click', installHooks);

$('#btnUninstallHooks').addEventListener('click', async () => {
  try {
    const res = await api.uninstallHooks();
    toast(res.removed.length ? `Removed hooks from ${res.removed.join(', ')}.` : 'No Lifeline hooks were installed.', 'warn');
    await refresh();
  } catch (err) {
    toast(`Removal failed: ${err.message}`, 'danger');
  }
});

$('#btnOpenSettings').addEventListener('click', () => api.openPath('settings'));

$('#btnClearAttention').addEventListener('click', async () => {
  await api.clearAttention();
  toast('Acknowledged. History is kept.', 'ok');
  await refresh();
});

$('#btnResetConfig').addEventListener('click', async () => {
  const cfg = await api.resetConfig();
  state.config = cfg;
  applyTheme(cfg.ui.theme, cfg.ui.accent);
  renderSettings();
  toast('Settings restored to defaults.', 'ok');
});

/* ============================== rendering ============================= */

/** Everything that is safe to redraw on every poll. */
function renderLive() {
  renderStatus();
  renderDashboard();
  renderSessions();
  renderActivity();
  renderHookStatus();
}

function apply(next, { full = false } = {}) {
  const prevConfig = state ? JSON.stringify(state.config) : null;
  state = next;
  applyTheme(state.config.ui.theme, state.config.ui.accent);
  renderLive();
  // Rebuild the forms only when the config actually changed — otherwise the
  // 5s poll would recreate the input the user is currently typing into.
  if (full || prevConfig !== JSON.stringify(state.config)) {
    applyingConfig = true;
    renderSettings();
    applyingConfig = false;
  }
  if (full) renderAbout();
}

async function refresh() {
  apply(await api.getState());
}

api.onState((next) => apply(next));
api.onNavigate((tab) => goTo(tab));
api.onConfigChanged(() => refresh());

// Relative timestamps go stale on their own; nudge them without a round trip.
setInterval(() => {
  if (state) {
    renderDashboard();
    renderSessions();
    renderActivity();
  }
}, 15_000);

api.getState().then((s) => apply(s, { full: true }));
