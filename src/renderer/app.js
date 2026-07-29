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
/** Last analytics payload. Null until the first scan finishes. */
let analytics = null;
/** Which window the Analytics tab is showing. */
let analyticsRange = 'week';
/** 'work' (from transcripts) or 'usage' (Claude Code's own /usage data). */
let analyticsView = 'work';
/** True while a scan is in flight, so Refresh cannot stack requests. */
let analyticsLoading = false;

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

/**
 * Durations for the analytics views.
 *
 * Hours-and-minutes rather than humanMs()'s single unit: "7h 20m" is the shape
 * people read a working day in, and rounding it to "7h" throws away the part
 * they care about when comparing days.
 */
function humanDuration(ms) {
  if (!ms) return '0m';
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Compact token counts — 1.2M reads faster than 1,234,567 in a stat card. */
function humanCount(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

/* ------------------------- loading placeholders ------------------------ */

/**
 * Show a metric as "still being counted" rather than as an em-dash.
 *
 * A cold analytics scan takes a couple of seconds, and during it every figure
 * used to read "—", which is also what the app shows when a value is genuinely
 * zero or unavailable. So a busy tab was indistinguishable from an empty one.
 * Rolling digits are unambiguous: something is being worked out.
 *
 * The digits are deliberately random per frame — this is a progress indicator,
 * not a count-up to a value that is not known yet. Pretending to converge on a
 * number would be inventing one.
 */
const rollingTimers = new WeakMap();

function startRolling(node, { width = 3, prefix = '' } = {}) {
  if (!node) return;
  if (rollingTimers.has(node)) return; // already rolling; do not stack timers
  node.classList.add('metric-rolling');
  // The dimming says "provisional" to someone looking at it. These say the same
  // to a screen reader, which would otherwise read the random digits out as the
  // figure — the one audience for whom the animation carries no meaning at all.
  node.setAttribute('aria-busy', 'true');
  node.setAttribute('aria-label', 'Loading');

  const tick = () => {
    let out = '';
    for (let i = 0; i < width; i++) out += String(Math.floor(Math.random() * 10));
    node.textContent = `${prefix}${out}`;
  };
  tick();
  // ~11fps. Fast enough to read as motion, slow enough not to look like noise.
  rollingTimers.set(node, setInterval(tick, 90));
}

/** Stop the roll and put the real value in. Safe to call when not rolling. */
function stopRolling(node, text) {
  if (!node) return;
  const timer = rollingTimers.get(node);
  if (timer !== undefined) {
    clearInterval(timer);
    rollingTimers.delete(node);
  }
  node.classList.remove('metric-rolling');
  // Both must go, or the placeholder's "Loading" label keeps overriding the real
  // value for anyone reading this with assistive tech.
  node.removeAttribute('aria-busy');
  node.removeAttribute('aria-label');
  if (text !== undefined) node.textContent = text;
}

/** Roll every metric in a group, by element id. */
function rollAll(ids, opts) {
  for (const id of ids) startRolling($(`#${id}`), opts);
}

function currencySymbol() {
  const a = state && state.config && state.config.analytics;
  return (a && a.currencySymbol) || '$';
}

/** Money, with enough precision that a cheap day is not shown as zero. */
function money(usd) {
  const v = Number(usd) || 0;
  const sym = currencySymbol();
  if (v === 0) return `${sym}0`;
  if (v < 1) return `${sym}${v.toFixed(2)}`;
  if (v < 1000) return `${sym}${v.toFixed(2)}`;
  return `${sym}${Math.round(v).toLocaleString()}`;
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
  // Analytics can take seconds on a cold cache, so it is only scanned when a tab
  // that needs it is actually opened rather than on every poll. Sessions is in
  // that set because of its cost column, which reads the same scan.
  if (tab === 'analytics' || tab === 'sessions') loadAnalytics();
  // The picker was built while this tab was hidden, where every offset measures
  // zero — so the glider has to be placed the first time it is actually visible.
  if (tab === 'analytics') syncRangePicker();
  // History reads the same scan. Only re-fetched on first open, or when the report
  // has moved on: regrouping on every visit would discard a search mid-typing.
  if (tab === 'history') loadHistory({ scan: !historyData });
  if (tab === 'launchpad') renderLaunchpad();
}

$$('.nav-item').forEach((btn) => btn.addEventListener('click', () => goTo(btn.dataset.tab)));

// Delegated so buttons rendered later still work.
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-goto]');
  if (target) goTo(target.dataset.goto);

  // Outbound links. The renderer names a key, never a URL — main owns the list,
  // and these open in the system browser rather than in this window.
  const link = e.target.closest('[data-link]');
  if (link) api.openLink(link.dataset.link);
});

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
  if (state.iconUrl) {
    $('#brandIcon').src = state.iconUrl;
    $('#aboutIcon').src = state.iconUrl;
  }

  // Coloured by what the button does, not by what the current state is: amber
  // while protection runs (the click pauses it), green while it is paused (the
  // click starts it again).
  const btn = $('#btnToggleProtection');
  const on = state.config.enabled;
  btn.textContent = on ? 'Pause protection' : 'Resume protection';
  btn.classList.toggle('hold', on);
  btn.classList.toggle('go', !on);
  btn.classList.remove('primary', 'ghost');
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

  renderCoverageWidget();
  renderDashWeek();
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

/* ============================== coverage ============================== */

/**
 * Which config flags belong to which Coverage group.
 *
 * Split by *where the check runs*, because that determines whether it works with
 * the app closed — the hook-based ones do, the watcher-based ones do not, and
 * mixing them in one list made that impossible to tell.
 */
const COVERAGE_BEHAVIOURS = ['apiErrorRecovery', 'contextOverflowRecovery', 'backgroundTaskRecovery', 'toolFailureRecovery'];
const COVERAGE_DETECTION = ['stalledSessionDetection', 'deadSessionDetection'];

/** Everything the Coverage tab counts as a switch, for the totals. */
function coverageCounts() {
  const cfg = state.config;
  let enabled = 0;
  let disabled = 0;

  for (const meta of state.policyMeta || []) {
    // The resolved answer, not the raw switch: a class held back by the
    // non-retryable guard is not actually covered, however it is configured.
    if (meta.effective && meta.effective.resume) enabled += 1;
    else disabled += 1;
  }
  for (const key of [...COVERAGE_BEHAVIOURS, ...COVERAGE_DETECTION]) {
    if (cfg.features[key]) enabled += 1;
    else disabled += 1;
  }
  return { enabled, disabled, total: enabled + disabled };
}

/** Dashboard widget: totals only — the detail lives on the Coverage tab. */
function renderCoverageWidget() {
  const { enabled, disabled, total } = coverageCounts();
  $('#covEnabled').textContent = enabled;
  $('#covDisabled').textContent = disabled;
  $('#covBar').style.width = total ? `${Math.round((enabled / total) * 100)}%` : '0%';
  $('#covSummaryHint').textContent = `${enabled} of ${total} checks active${disabled ? ` · ${disabled} will alert you instead` : ''}.`;

  const badge = $('#badgeCoverage');
  badge.textContent = disabled ? String(disabled) : '';
  badge.title = disabled ? `${disabled} checks are off` : '';
}

function renderCoverage() {
  const cfg = state.config;
  const { enabled, disabled } = coverageCounts();
  $('#covStatEnabled').textContent = enabled;
  $('#covStatDisabled').textContent = disabled;

  const behavioursOn = COVERAGE_BEHAVIOURS.filter((k) => cfg.features[k]).length;
  $('#covStatFeatures').textContent = `${behavioursOn}/${COVERAGE_BEHAVIOURS.length}`;
  $('#covStatFeaturesFoot').textContent = behavioursOn === COVERAGE_BEHAVIOURS.length ? 'all on' : 'some off';

  const detectOn = COVERAGE_DETECTION.filter((k) => cfg.features[k]).length;
  $('#covStatDetect').textContent = `${detectOn}/${COVERAGE_DETECTION.length}`;
  $('#covStatDetectFoot').textContent = 'needs Lifeline open';

  renderCoverageClasses();

  const behaviours = $('#coverageBehaviours');
  behaviours.replaceChildren();
  for (const key of COVERAGE_BEHAVIOURS) {
    const [title, desc] = FEATURE_COPY[key];
    behaviours.appendChild(toggleRow(title, desc, cfg.features[key], (v) => pushConfig(`features.${key}`, v)));
  }

  const detection = $('#coverageDetection');
  detection.replaceChildren();
  for (const key of COVERAGE_DETECTION) {
    const [title, desc] = FEATURE_COPY[key];
    detection.appendChild(toggleRow(title, desc, cfg.features[key], (v) => pushConfig(`features.${key}`, v)));
  }
}

const STRATEGY_TEXT = { resume: 'Auto-resume', compact: 'Compact + resume', notify: 'Alert you' };
const STRATEGY_TONE = { resume: 'ok', compact: 'info', notify: 'warn' };

function renderCoverageClasses() {
  const host = $('#coverageClasses');
  const cfg = state.config;
  host.replaceChildren();

  for (const meta of state.policyMeta || []) {
    const eff = (cfg.policies && cfg.policies[meta.key]) || {};
    const resolved = meta.effective || { resume: meta.defaultResume, strategy: meta.strategy, blockedBy: null };
    const on = eff.resume !== undefined ? eff.resume : meta.defaultResume;

    const card = el('div', 'cov-card');
    card.dataset.on = String(Boolean(resolved.resume));

    const head = el('div', 'cov-card-head');
    const titles = el('div', 'cov-card-titles');
    titles.appendChild(el('div', 'cov-card-name', meta.label));
    titles.appendChild(el('code', 'cov-card-key', meta.key));
    head.appendChild(titles);
    head.appendChild(
      switchControl(on, (v) => {
        pushConfig(`policies.${meta.key}.resume`, v).then(() => refresh());
      })
    );
    card.appendChild(head);

    card.appendChild(el('div', 'cov-card-why', meta.reason));

    const foot = el('div', 'cov-card-foot');
    foot.appendChild(el('span', `chip ${STRATEGY_TONE[resolved.strategy] || ''}`, STRATEGY_TEXT[resolved.strategy] || resolved.strategy));
    if (!meta.defaultResume) foot.appendChild(el('span', 'chip', 'manual by default'));
    if (eff.maxAttempts) foot.appendChild(el('span', 'cov-card-num', `${eff.maxAttempts} tries`));
    if (eff.backoffMs) foot.appendChild(el('span', 'cov-card-num', `waits ${humanMs(eff.backoffMs)}`));
    card.appendChild(foot);

    // The one case where the switch and the outcome disagree. Saying so — with
    // the way to change it — is the difference between a safety guard and a
    // toggle that appears broken.
    if (resolved.blockedBy === 'respectNonRetryable') {
      const warn = el('div', 'cov-card-blocked');
      warn.appendChild(el('span', null, 'Held on alert-only by the "never retry hopeless failures" safety guard.'));
      const link = el('button', 'link-btn', 'Turn the guard off');
      link.addEventListener('click', () => {
        pushConfig('features.respectNonRetryable', false).then(() => {
          refresh();
          toast('Safety guard off — hopeless failures can now be retried.', 'warn');
        });
      });
      warn.appendChild(link);
      card.appendChild(warn);
    }

    host.appendChild(card);
  }
}

$('#btnCoverageAll').addEventListener('click', async () => {
  const patch = { features: {}, policies: {} };
  for (const key of [...COVERAGE_BEHAVIOURS, ...COVERAGE_DETECTION]) patch.features[key] = true;
  for (const meta of state.policyMeta || []) patch.policies[meta.key] = { resume: true };
  await api.saveConfig(patch);
  await refresh();
  // Deliberately not clearing respectNonRetryable: "enable all" should not
  // silently disarm the guard that stops pointless auth retries.
  toast('Every check enabled. Hopeless failures still alert rather than retry.', 'ok');
});

$('#btnCoverageRecommended').addEventListener('click', async () => {
  const patch = { features: { respectNonRetryable: true }, policies: {} };
  for (const key of [...COVERAGE_BEHAVIOURS, ...COVERAGE_DETECTION]) {
    // Matches config.js's defaults: the noisy one stays off.
    patch.features[key] = key !== 'toolFailureRecovery';
  }
  for (const meta of state.policyMeta || []) patch.policies[meta.key] = { resume: meta.defaultResume };
  await api.saveConfig(patch);
  await refresh();
  toast('Recommended coverage restored.', 'ok');
});

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
    const chip = el('span', `chip ${tone}`, text);
    // `idleMs` is time since the transcript was last written, so it is the evidence
    // for the word in the chip rather than extra detail — worth saying, because
    // this column used to claim "stalled" for sessions that were plainly working.
    if (s.alive && s.status === 'busy') chip.title = `Last wrote to its transcript ${relTime(s.activeAt)}.`;
    stateCell.appendChild(chip);
    tr.appendChild(stateCell);

    tr.appendChild(sessionCostCell(s));
    tr.appendChild(el('td', 'mono', relTime(s.activeAt || s.updatedAt)));
    tr.appendChild(el('td', 'mono', s.pid));
    body.appendChild(tr);
  }
}

/**
 * What this session has cost so far.
 *
 * The figure comes from the analytics scan, which is the only thing that reads
 * transcripts — so it is joined here by session id rather than recomputed. Three
 * states worth distinguishing, because a bare "—" for all of them reads as a
 * bug: analytics turned off, not scanned yet, and scanned-but-no-transcript
 * (which is normal for a session that has not sent a message).
 */
function sessionCostCell(s) {
  const cell = el('td', 'mono');

  if (state.config.analytics && state.config.analytics.enabled === false) {
    cell.textContent = 'off';
    cell.classList.add('cost-muted');
    cell.title = 'Analytics is turned off, so cost is not tracked.';
    return cell;
  }

  if (!analytics) {
    // Deliberately a placeholder rather than a zero: zero is a claim, and this
    // is an absence of data. Opening the tab kicks the scan off.
    cell.appendChild(el('span', 'skel skel-cost'));
    cell.title = 'Reading transcripts…';
    // The bar is empty of text, so without this the cell reads as blank rather
    // than as pending.
    cell.setAttribute('aria-busy', 'true');
    cell.setAttribute('aria-label', 'Reading transcripts');
    return cell;
  }

  const rec = costBySession().get(String(s.sessionId || ''));
  if (!rec) {
    cell.textContent = '—';
    cell.classList.add('cost-muted');
    cell.title = 'No transcript activity recorded for this session yet.';
    return cell;
  }

  cell.textContent = money(rec.costUsd);
  // Tokens in the tooltip: the cost is derived from them, so this is the
  // evidence for the number rather than extra trivia.
  const tk = rec.tokens || {};
  const total = (tk.input || 0) + (tk.output || 0) + (tk.cacheWrite || 0) + (tk.cacheRead || 0);
  cell.title = `${humanCount(total)} tokens · ${humanCount(tk.output || 0)} out${rec.model ? ` · ${rec.model}` : ''}`;
  if (rec.costUsd === 0) cell.classList.add('cost-muted');
  return cell;
}

/**
 * Session id → its analytics record, rebuilt only when the report changes.
 *
 * renderSessions runs on the 5s poll, and rebuilding a 50-entry map each time
 * for every row would be quadratic for no reason.
 */
let costIndex = { from: null, map: new Map() };
function costBySession() {
  if (costIndex.from === analytics) return costIndex.map;
  const map = new Map();
  for (const r of (analytics && analytics.recent) || []) {
    if (r.sessionId) map.set(String(r.sessionId), r);
  }
  costIndex = { from: analytics, map };
  return map;
}

/* =============================== analytics ============================= */

const RANGE_LABEL = {
  week: 'past 7 days',
  month: 'past 30 days',
  quarter: 'past 3 months',
  half: 'past 6 months',
  year: 'past 12 months',
  all: 'all time',
};

/** The selector's own labels — short, because they sit in a row of six. */
const RANGES = [
  ['week', '1W', 'Past 7 days'],
  ['month', '1M', 'Past 30 days'],
  ['quarter', '3M', 'Past 3 months'],
  ['half', '6M', 'Past 6 months'],
  ['year', '12M', 'Past 12 months'],
  ['all', 'All', 'All time'],
];

/** Fetch a report, showing progress rather than an empty page during a cold scan. */
async function loadAnalytics({ force = false } = {}) {
  if (analyticsLoading) return;
  const off = state && state.config.analytics && state.config.analytics.enabled === false;
  $('#analyticsOffBanner').classList.toggle('hidden', !off);
  $('#analyticsViews').classList.toggle('hidden', Boolean(off));
  if (off) {
    // Both views read the same disabled switch, so hide the pair rather than
    // leaving one visible and empty.
    $('#analyticsBody').classList.add('hidden');
    $('#usageBody').classList.add('hidden');
    // Sessions still needs telling, so its cost column says "off" rather than
    // sitting on a loading placeholder that will never resolve.
    renderSessions();
    return;
  }
  applyAnalyticsView();

  analyticsLoading = true;
  const btn = $('#btnRefreshAnalytics');
  btn.disabled = true;
  // A cold scan reads hundreds of megabytes; without this the tab looks broken
  // for a couple of seconds on first open. Only on a cold scan — a refresh
  // already has figures on screen, and blanking them to roll digits would be a
  // step backwards.
  if (!analytics) {
    $('#chartTag').textContent = 'reading transcripts…';
    rollAll(['anHours', 'anSessions', 'anTokens']);
    startRolling($('#anCost'), { prefix: `${currencySymbol()}0.`, width: 2 });
    rollAll(['dashWeekHours', 'dashWeekSessions']);
    startRolling($('#dashWeekCost'), { prefix: `${currencySymbol()}0.`, width: 2 });
  }
  try {
    const res = await api.analyticsReport({ force });
    if (res && res.error) toast(`Analytics: ${res.error}`, 'warn');
    if (res && res.report) analytics = res.report;
    renderAnalytics();
    renderDashWeek();
    // The sessions table prices each row from this same report, so it needs a
    // redraw too — otherwise its cost column keeps its loading placeholder
    // until the next 5s poll happens to come round.
    renderSessions();
  } catch (err) {
    toast(`Analytics failed: ${err.message}`, 'danger');
  } finally {
    analyticsLoading = false;
    btn.disabled = false;
    // Whatever happened, nothing may still be rolling. On the failure path
    // renderAnalytics() returned early (no report), so without this the digits
    // would spin forever on a tab that has given up.
    const stillRolling = ['anHours', 'anSessions', 'anTokens', 'anCost', 'dashWeekHours', 'dashWeekSessions', 'dashWeekCost'];
    for (const id of stillRolling) {
      const node = $(`#${id}`);
      if (node && node.classList.contains('metric-rolling')) stopRolling(node, '—');
    }
    if ($('#chartTag').textContent === 'reading transcripts…') $('#chartTag').textContent = '';
  }
}

$('#btnRefreshAnalytics').addEventListener('click', () => loadAnalytics({ force: true }));

/**
 * Build the range picker, once.
 *
 * Built here rather than written out in the HTML so RANGES stays the single
 * definition of what ranges exist — adding one should not mean editing markup,
 * a label map, and a bucket list in three files.
 */
function renderRangePicker() {
  const host = $('#analyticsRange');
  const glider = $('#rangeGlider');
  // Keep the glider; replace only the buttons.
  for (const old of $$('#analyticsRange .range-btn')) old.remove();

  for (const [key, short, full] of RANGES) {
    const btn = el('button', 'range-btn', short);
    btn.dataset.range = key;
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    // The short label is the only visible text, so the full one has to reach
    // assistive tech some other way.
    btn.title = full;
    btn.setAttribute('aria-label', full);
    btn.addEventListener('click', () => selectRange(key));
    host.appendChild(btn);
  }
  host.appendChild(glider);
  // syncRangePicker suppresses the transition itself on a first placement, so
  // there is nothing to coordinate here. This normally measures zero anyway —
  // the Analytics tab is hidden at boot — and goTo() re-syncs when it opens.
  syncRangePicker();
}

/** Switch range, repaint whichever view is showing, and keep the glider with it. */
function selectRange(key) {
  if (analyticsRange === key) return;
  analyticsRange = key;
  syncRangePicker();
  renderAnalytics();
  if (analyticsView === 'usage') renderUsage();
}

/**
 * Arrow-key navigation, because this is a `role="tablist"`.
 *
 * That role is a promise: a screen reader announces the group as tabs and its
 * user then expects arrows to move between them. Leaving it to Tab alone means
 * the markup describes an interaction the app does not actually support — worse
 * than not claiming the role at all. Home/End included for the same reason.
 *
 * Delegated to the host so it keeps working if the buttons are ever rebuilt.
 */
$('#analyticsRange').addEventListener('keydown', (e) => {
  const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const keys = RANGES.map(([k]) => k);
  const at = keys.indexOf(analyticsRange);
  let next = null;

  if (e.key in STEP) {
    // Clamped rather than wrapped: these are an ordered scale from a week to all
    // time, so running off the end and reappearing at the other loses your place.
    next = keys[Math.min(keys.length - 1, Math.max(0, at + STEP[e.key]))];
  } else if (e.key === 'Home') {
    next = keys[0];
  } else if (e.key === 'End') {
    next = keys[keys.length - 1];
  } else {
    return;
  }

  e.preventDefault(); // arrows would otherwise scroll the tab behind the picker
  selectRange(next);
  // Focus follows selection, which is what makes the next arrow press continue
  // from here rather than from wherever the ring was left.
  const btn = $(`#analyticsRange .range-btn[data-range="${next}"]`);
  if (btn) btn.focus();
});

/** Move the glider and the active class onto the selected range. */
function syncRangePicker() {
  const host = $('#analyticsRange');
  const glider = $('#rangeGlider');
  let active = null;
  for (const btn of $$('#analyticsRange .range-btn')) {
    const on = btn.dataset.range === analyticsRange;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) active = btn;
  }
  if (!active) return;
  // Measured off rects rather than offsetLeft, because the reference edge matters
  // and offsetLeft's is ambiguous: the glider's `left: 0` resolves to the host's
  // *padding* box, so the border has to be added back explicitly. Doing this with
  // offsetLeft minus clientLeft double-counted the 1px border and left the glider
  // sitting a pixel to the left of its button. Rects are also sub-pixel, which
  // offsetWidth is not — the buttons are 42.09px wide at this font size.
  const hostBox = host.getBoundingClientRect();
  const activeBox = active.getBoundingClientRect();
  const padLeft = hostBox.left + host.clientLeft;

  // Nothing useful to measure yet — this runs once at boot, while the Analytics
  // tab is still hidden and every offset is zero. Writing a zero width here would
  // be harmless but pointless, and leaving style.width unset is what lets the
  // check below recognise a genuine first placement.
  if (activeBox.width < 1) return;

  // Whether the glider has ever been placed, read off the width this function
  // assigns rather than off its rendered box: the glider has a 1px border on each
  // side, so its rect measures 2px even at `width: 0` and a rect-based test never
  // sees "unplaced". Sliding in from nothing reads as a glitch, so the first real
  // placement is instant and only later range changes animate.
  const unplaced = !(parseFloat(glider.style.width) > 0);
  if (unplaced) host.classList.add('no-anim');

  glider.style.width = `${activeBox.width}px`;
  glider.style.transform = `translateX(${activeBox.left - padLeft}px)`;

  if (unplaced) {
    // Two frames: one for the untransitioned values to paint, one before the
    // transition is allowed back — removing it in the same frame re-enables it
    // before the new width has committed, which animates anyway.
    requestAnimationFrame(() => requestAnimationFrame(() => host.classList.remove('no-anim')));
  }
}

/** Switch view, and mark the choice for assistive tech as well as visually. */
function selectAnalyticsView(view) {
  analyticsView = view;
  for (const b of $$('#analyticsViews .seg-btn')) {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    // The `active` class is a colour. This is the part a screen reader reads.
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  applyAnalyticsView();
}

$$('#analyticsViews .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => selectAnalyticsView(btn.dataset.view));
});

// Arrows across the two views, for the same reason the range picker has them:
// role="tablist" tells a screen reader arrows will work. Only two options here,
// so left/up and right/down simply pick one or the other.
$('#analyticsViews').addEventListener('keydown', (e) => {
  const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
  const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
  if (!back && !fwd) return;
  e.preventDefault();
  const view = back ? 'work' : 'usage';
  if (view !== analyticsView) selectAnalyticsView(view);
  const btn = $(`#analyticsViews .seg-btn[data-view="${view}"]`);
  if (btn) btn.focus();
});

/**
 * Show one of the two Analytics views.
 *
 * The range picker applies to both now. It used to be hidden on the usage view,
 * because Claude Code's stats are whole-install totals — but the cache does keep
 * per-date rows, so the window is real for counts and apportioned for cost. See
 * windowStats() in claude-stats.js, and the caveat the view prints.
 */
function applyAnalyticsView() {
  const usage = analyticsView === 'usage';
  $('#analyticsBody').classList.toggle('hidden', usage);
  $('#usageBody').classList.toggle('hidden', !usage);
  if (usage) renderUsage();
  // The glider is measured from layout, and a hidden ancestor measures as zero —
  // so re-sync now that this view is on screen.
  syncRangePicker();
}

/** Dashboard's week strip. Reuses whatever analytics already has — never scans. */
function renderDashWeek() {
  const hint = $('#dashWeekHint');
  if (state.config.analytics && state.config.analytics.enabled === false) {
    stopRolling($('#dashWeekHours'), '—');
    stopRolling($('#dashWeekSessions'), '—');
    stopRolling($('#dashWeekCost'), '—');
    hint.textContent = 'Analytics is turned off.';
    return;
  }
  if (!analytics) {
    // Left as-is rather than blanked: if a scan is running these are rolling,
    // and the hint below already says what is happening.
    hint.textContent = analyticsLoading
      ? 'Reading your transcripts…'
      : 'Open Analytics to read your transcripts.';
    return;
  }
  const w = analytics.totals.week;
  stopRolling($('#dashWeekHours'), humanDuration(w.activeMs));
  stopRolling($('#dashWeekSessions'), String(w.sessions));
  stopRolling($('#dashWeekCost'), money(w.costUsd));
  hint.textContent = `${w.projects} project${w.projects === 1 ? '' : 's'} · cost is an estimate from token counts.`;
}

function renderAnalytics() {
  if (!analytics) return;
  const t = analytics.totals[analyticsRange] || analytics.totals.week;
  const label = RANGE_LABEL[analyticsRange];

  // stopRolling rather than a plain assignment: these four may be mid-roll from
  // a cold scan, and setting textContent alone would leave the timer running to
  // overwrite the real figure a frame later.
  stopRolling($('#anHours'), humanDuration(t.activeMs));
  $('#anHoursFoot').textContent = `active time, ${label}`;
  stopRolling($('#anSessions'), String(t.sessions));
  $('#anSessionsFoot').textContent = `${t.projects} project${t.projects === 1 ? '' : 's'} · ${t.userMessages} prompts`;
  stopRolling($('#anCost'), money(t.costUsd));
  $('#anCostFoot').textContent = 'estimated from tokens';
  stopRolling($('#anTokens'), humanCount(t.tokens));
  $('#anTokensFoot').textContent = `${t.assistantMessages} replies`;

  // Only mention fallback pricing when it actually happened — a permanent
  // caveat is a caveat nobody reads.
  const noteText = $('#estimateNoteText');
  noteText.textContent = analytics.estimatedRates
    ? 'Claude Code records tokens, not money. These figures are tokens × published rate. Some usage came from a model with no known rate, so a mid-tier fallback was applied — check Settings → Analytics & cost.'
    : 'Claude Code records tokens, not money. These figures are tokens × published rate, so they will not match a subscription bill. Rates are editable under Settings → Analytics & cost.';
  $('#estimateNote').classList.toggle('warn', Boolean(analytics.estimatedRates));

  renderChart();
  renderProjectBars();
  renderSessionHistory();
  // The usage view shares the same payload, so a refresh has to repaint whichever
  // of the two is on screen.
  if (analyticsView === 'usage') renderUsage();
}

/** Which series to chart: days for short ranges, months once a year is in view. */
function chartSeries() {
  if (analyticsRange === 'week') return { rows: analytics.daily.week, title: 'Daily activity', fmt: shortDay };
  if (analyticsRange === 'month') return { rows: analytics.daily.month, title: 'Daily activity', fmt: shortDay };
  const monthly = analytics.monthly || {};
  // All-time has no fixed length to chart, so it borrows the 12-month shape.
  const rows = monthly[analyticsRange] || monthly.year || [];
  return { rows, title: 'Monthly activity', fmt: shortMonth };
}

function shortDay(key, at) {
  const d = new Date(at);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

function shortMonth(key, at) {
  return new Date(at).toLocaleDateString(undefined, { month: 'short' });
}

/**
 * A bar chart in plain DOM.
 *
 * No charting library: the whole renderer is CSP-locked and dependency-free, and
 * a bar per day is a div with a height. Bars are scaled to the busiest bucket
 * rather than to 24h, because a fixed axis makes every real day look empty.
 */
function renderChart() {
  const host = $('#activityChart');
  const { rows, title, fmt } = chartSeries();
  $('#chartTitle').textContent = title;
  host.replaceChildren();

  const peak = rows.reduce((m, r) => Math.max(m, r.activeMs), 0);
  const total = rows.reduce((sum, r) => sum + r.activeMs, 0);
  $('#chartTag').textContent = peak ? `peak ${humanDuration(peak)}` : 'no activity yet';

  if (!total) {
    const box = el('div', 'empty');
    box.appendChild(el('div', 'empty-art', '◌'));
    box.appendChild(el('p', null, 'Nothing recorded in this range.'));
    box.appendChild(el('span', null, 'Time is read from Claude Code transcripts as you work.'));
    host.appendChild(box);
    return;
  }

  const grid = el('div', 'chart-bars');
  // A 30-day month gives each column about 16px, which is narrower than the
  // shortest duration string — so past 14 bars the per-bar value is dropped and
  // only every other label is drawn. Nothing is lost: the exact figures are on
  // each column's tooltip either way, and the tag above states the peak.
  const dense = rows.length > 14;
  if (dense) grid.classList.add('dense');

  rows.forEach((r, i) => {
    const col = el('div', 'chart-col');
    col.title = `${r.key} — ${humanDuration(r.activeMs)}, ${r.sessions} session${r.sessions === 1 ? '' : 's'}, ${money(r.costUsd)}`;

    const track = el('div', 'chart-track');
    const bar = el('div', 'chart-bar');
    // Floor at 2% so a short-but-real day is still visible next to a long one.
    bar.style.height = r.activeMs ? `${Math.max(2, Math.round((r.activeMs / peak) * 100))}%` : '0';
    if (!r.activeMs) bar.classList.add('zero');
    track.appendChild(bar);
    col.appendChild(track);

    if (!dense) col.appendChild(el('div', 'chart-val', r.activeMs ? humanDuration(r.activeMs) : ''));
    // Anchored to the last column rather than the first, so the most recent day
    // is always labelled — that is the one being read.
    const labelled = !dense || (rows.length - 1 - i) % 2 === 0;
    col.appendChild(el('div', 'chart-label', labelled ? fmt(r.key, r.at) : ''));
    grid.appendChild(col);
  });
  host.appendChild(grid);
}

function renderProjectBars() {
  const host = $('#projectBars');
  // Ranked over the selected range, so these bars agree with the figures above
  // them. The two older fields are the fallback for a cached report written
  // before projectsByRange existed.
  const byRange = analytics.projectsByRange || {};
  const rows = byRange[analyticsRange]
    || (analyticsRange === 'all' && analytics.projectsAllTime)
    || analytics.projects
    || [];
  host.replaceChildren();

  if (!rows.length) {
    const box = el('div', 'empty');
    box.appendChild(el('div', 'empty-art', '◌'));
    box.appendChild(el('p', null, 'No projects yet.'));
    host.appendChild(box);
    return;
  }

  const peak = rows.reduce((m, r) => Math.max(m, r.activeMs), 0) || 1;
  for (const r of rows) {
    const row = el('div', 'bar-row');
    const head = el('div', 'bar-head');
    head.appendChild(el('span', 'bar-name', projectName(r.cwd)));
    head.appendChild(el('span', 'bar-val', humanDuration(r.activeMs)));
    row.appendChild(head);

    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = `${Math.max(2, Math.round((r.activeMs / peak) * 100))}%`;
    track.appendChild(fill);
    row.appendChild(track);

    row.appendChild(el('div', 'bar-sub', `${r.sessions} session${r.sessions === 1 ? '' : 's'} · ${money(r.costUsd)} · ${humanCount(r.tokens)} tokens`));
    row.title = r.cwd || '';
    host.appendChild(row);
  }
}

/** Sessions in the selected window, newest first. */
function renderSessionHistory() {
  const body = $('#analyticsBodyRows');
  const spans = { week: 7, month: 30, quarter: 90, half: 180, year: 365, all: Number.MAX_SAFE_INTEGER };
  const days = spans[analyticsRange] ?? 7;
  const from = days === Number.MAX_SAFE_INTEGER ? 0 : analytics.generatedAt - days * 86_400_000;
  const rows = (analytics.recent || []).filter((s) => (s.firstAt || 0) >= from);

  body.replaceChildren();
  $('#analyticsEmpty').classList.toggle('hidden', rows.length > 0);
  $('#analyticsTable').classList.toggle('hidden', rows.length === 0);
  $('#historyTag').textContent = rows.length ? `${rows.length} most recent` : '';

  for (const s of rows) {
    const tr = el('tr');

    const nameCell = el('td');
    // Falls back through title → last prompt → id: an unnamed session still has
    // to be recognisable, and the first thing asked is usually enough.
    const name = s.title || (s.lastPrompt ? `${s.lastPrompt.slice(0, 60)}…` : String(s.sessionId || '').slice(0, 8));
    nameCell.appendChild(el('div', 'cell-main', name));
    const sub = el('div', 'cell-sub');
    sub.textContent = [s.model, s.gitBranch].filter(Boolean).join(' · ') || String(s.sessionId || '').slice(0, 8);
    nameCell.appendChild(sub);
    tr.appendChild(nameCell);

    tr.appendChild(el('td', null, projectName(s.cwd)));

    const workedCell = el('td');
    workedCell.appendChild(el('div', 'cell-main', humanDuration(s.activeMs)));
    // Elapsed alongside active, because the difference is the point: a 20-minute
    // session spread over 6 hours is a different day than a solid 20 minutes.
    if (s.elapsedMs > s.activeMs) workedCell.appendChild(el('div', 'cell-sub', `over ${humanDuration(s.elapsedMs)}`));
    tr.appendChild(workedCell);

    const tk = s.tokens || {};
    const totalTokens = (tk.input || 0) + (tk.output || 0) + (tk.cacheWrite || 0) + (tk.cacheRead || 0);
    const tokenCell = el('td');
    tokenCell.appendChild(el('div', 'cell-main', humanCount(totalTokens)));
    tokenCell.appendChild(el('div', 'cell-sub', `${humanCount(tk.output || 0)} out`));
    tr.appendChild(tokenCell);

    tr.appendChild(el('td', 'mono', money(s.costUsd)));
    tr.appendChild(el('td', 'mono', relTime(s.lastAt)));
    body.appendChild(tr);
  }
}

/* ---------------------- usage & models (/usage data) ------------------- */

/** Trim `claude-sonnet-4-5-20250929` down to something a table column can hold. */
function shortModel(id) {
  return String(id || '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
}

/** A local YYYY-MM-DD date string, printed short. Not parsed as UTC. */
function shortDate(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return iso || '';
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Claude Code's own `/usage` figures.
 *
 * Everything here comes from `~/.claude/stats-cache.json` — whole-install totals
 * the CLI maintains itself. The range selector does not apply (there is no window
 * to slice), and the file may be absent on a machine that has never run `/usage`,
 * which is a banner rather than an error.
 */
function renderUsage() {
  // No report yet means a scan is on its way — leave the panels as they are
  // rather than flashing "no statistics" at someone who has plenty.
  if (!analytics) return;
  const u = analytics.claudeStats;
  const missing = !u || !u.available;
  $('#usageMissing').classList.toggle('hidden', !missing);
  $('#usageContent').classList.toggle('hidden', missing);
  if (missing) {
    if (u && u.reason) $('#usageMissing').querySelector('.banner-body span').textContent = u.reason + ' Run /usage in any Claude Code session once, then refresh.';
    return;
  }

  // The selected window, or the all-time figures for a cached report written
  // before windows existed.
  const w = (u.windows && u.windows[analyticsRange]) || (u.windows && u.windows.all) || null;
  const label = RANGE_LABEL[analyticsRange] || 'all time';
  const ranged = Boolean(w) && analyticsRange !== 'all';

  stopRolling($('#usSessions'), humanCount(w ? w.totalSessions : u.totalSessions));
  $('#usSessionsFoot').textContent = ranged
    ? `sessions started, ${label}`
    : u.firstSessionAt ? `since ${new Date(u.firstSessionAt).toLocaleDateString()}` : 'all recorded history';
  stopRolling($('#usMessages'), humanCount(w ? w.totalMessages : u.totalMessages));
  $('#usMessagesFoot').textContent = `${humanCount(w ? w.totalToolCalls : u.totalToolCalls)} tool calls`;
  stopRolling($('#usTokens'), humanCount(w ? w.totalTokens : u.totalTokens));
  // Cache reads are the bulk of the count and a tenth of the price, so the split
  // is worth showing rather than one huge number.
  const split = ranged
    ? (w.models || []).reduce((acc, m) => ({ cacheRead: acc.cacheRead + m.tokens.cacheRead, output: acc.output + m.tokens.output }), { cacheRead: 0, output: 0 })
    : u.tokens;
  $('#usTokensFoot').textContent = `${humanCount(split.cacheRead)} cache read · ${humanCount(split.output)} output`;
  stopRolling($('#usCost'), money(w ? w.costUsd : u.costUsd));
  $('#usCostFoot').textContent = ranged
    ? `apportioned, ${label}`
    : u.estimatedRates ? 'fallback rates used' : 'tokens × published rate';

  // Three caveats worth stating outright: the cache lags live work, the money
  // column is ours because Claude Code reports 0 on a subscription plan, and a
  // windowed cost is apportioned rather than measured.
  const lag = u.computedFor ? `Claude Code last recomputed these on ${shortDate(u.computedFor)}, so today's work may be missing.` : '';
  const apportioned = ranged
    ? ` Cost for a range is apportioned: the cache stores the input/output/cache split only as an all-time total, so a window's cost is that model's total scaled by its share of tokens in the window.`
    : '';
  $('#usageNoteText').textContent = `${lag} Token counts are Claude Code's; the cost column is Lifeline's, because /usage reports $0 per model on subscription plans.${apportioned} Switch to "Your work" for time, projects, and per-session detail.`.trim();
  $('#usageNote').classList.toggle('warn', Boolean(u.estimatedRates) || ranged);

  renderUsageModels(w || u, label, ranged);
  renderUsageDaily(w || u, label);
  renderUsageHours(u);
  renderUsageRecords(u);
}

/** Per-model rows, cost-ordered, with an inline share-of-spend bar. */
function renderUsageModels(u, label = 'all time', ranged = false) {
  const body = $('#usModelBody');
  body.replaceChildren();
  const rows = u.models || [];
  $('#usModelTag').textContent = rows.length
    ? `${rows.length} model${rows.length === 1 ? '' : 's'} · ${label}`
    : `no usage in the ${label}`;

  const totalCost = rows.reduce((sum, m) => sum + m.costUsd, 0) || 1;
  for (const m of rows) {
    const tr = el('tr');

    const nameCell = el('td');
    nameCell.appendChild(el('div', 'cell-main', shortModel(m.model)));
    const sub = el('div', 'cell-sub');
    sub.textContent = m.estimatedRates ? 'no published rate — estimated' : `${humanCount(m.total)} tokens`;
    nameCell.appendChild(sub);
    nameCell.title = m.model;
    tr.appendChild(nameCell);

    const shareCell = el('td', 'share-cell');
    const share = (m.costUsd / totalCost) * 100;
    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = `${Math.max(1, Math.round(share))}%`;
    track.appendChild(fill);
    shareCell.appendChild(track);
    shareCell.appendChild(el('div', 'cell-sub', `${share.toFixed(share < 1 ? 2 : 0)}%`));
    tr.appendChild(shareCell);

    tr.appendChild(el('td', 'mono', humanCount(m.tokens.input)));
    tr.appendChild(el('td', 'mono', humanCount(m.tokens.output)));
    tr.appendChild(el('td', 'mono', humanCount(m.tokens.cacheRead)));
    const costCell = el('td', 'mono', money(m.costUsd));
    if (ranged) {
      // A tilde, because the figure is scaled from an all-time split rather than
      // measured over this window. Cheaper than a footnote nobody reads.
      costCell.textContent = `~${costCell.textContent}`;
      costCell.title = 'Apportioned from all-time totals by this window’s share of tokens.';
    }
    tr.appendChild(costCell);
    body.appendChild(tr);
  }
}

/**
 * Messages per day.
 *
 * Only the tail is charted: the cache keeps every day it has ever seen, and a
 * hundred 4px bars is not a chart anyone reads.
 */
function renderUsageDaily(u, label = 'all time') {
  const host = $('#usDailyChart');
  host.replaceChildren();
  const all = u.daily || [];
  // Still capped at 30 bars regardless of range: a 365-day window would draw
  // 365 columns 1px wide. The tag says what was dropped rather than implying
  // the chart is the whole window.
  const rows = all.slice(-30);
  const peak = rows.reduce((m, r) => Math.max(m, r.messages), 0);
  $('#usDailyTag').textContent = rows.length
    ? `last ${rows.length} day${rows.length === 1 ? '' : 's'}${all.length > rows.length ? ` of ${all.length} in the ${label}` : ''}`
    : `no daily data in the ${label}`;

  if (!peak) {
    const box = el('div', 'empty');
    box.appendChild(el('div', 'empty-art', '◌'));
    box.appendChild(el('p', null, 'No daily activity recorded.'));
    host.appendChild(box);
    return;
  }

  const grid = el('div', 'chart-bars');
  for (const r of rows) {
    const col = el('div', 'chart-col');
    col.title = `${r.date} — ${r.messages} messages, ${r.sessions} session${r.sessions === 1 ? '' : 's'}, ${humanCount(r.tokens)} tokens`;
    const track = el('div', 'chart-track');
    const bar = el('div', 'chart-bar');
    bar.style.height = r.messages ? `${Math.max(2, Math.round((r.messages / peak) * 100))}%` : '0';
    if (!r.messages) bar.classList.add('zero');
    track.appendChild(bar);
    col.appendChild(track);
    col.appendChild(el('div', 'chart-val', r.messages ? humanCount(r.messages) : ''));
    col.appendChild(el('div', 'chart-label', shortDate(r.date)));
    grid.appendChild(col);
  }
  host.appendChild(grid);
}

/**
 * Sessions started per hour of the day.
 *
 * All 24 columns are drawn even where the count is zero — the empty stretch is
 * the readable part of a working-hours shape. Labels every three hours, because
 * 24 of them would overlap.
 */
function renderUsageHours(u) {
  const host = $('#usHourChart');
  host.replaceChildren();
  const rows = u.hourly || [];
  const peak = rows.reduce((m, r) => Math.max(m, r.sessions), 0);
  const busiest = rows.reduce((best, r) => (r.sessions > (best ? best.sessions : -1) ? r : best), null);
  $('#usHourTag').textContent = peak && busiest ? `busiest ${String(busiest.hour).padStart(2, '0')}:00` : 'no data';

  if (!peak) {
    const box = el('div', 'empty');
    box.appendChild(el('div', 'empty-art', '◌'));
    box.appendChild(el('p', null, 'No hourly data recorded.'));
    host.appendChild(box);
    return;
  }

  const grid = el('div', 'chart-bars');
  for (const r of rows) {
    const col = el('div', 'chart-col');
    col.title = `${String(r.hour).padStart(2, '0')}:00 — ${r.sessions} session${r.sessions === 1 ? '' : 's'} started`;
    const track = el('div', 'chart-track');
    const bar = el('div', 'chart-bar');
    bar.style.height = r.sessions ? `${Math.max(3, Math.round((r.sessions / peak) * 100))}%` : '0';
    if (!r.sessions) bar.classList.add('zero');
    track.appendChild(bar);
    col.appendChild(track);
    col.appendChild(el('div', 'chart-label', r.hour % 3 === 0 ? String(r.hour).padStart(2, '0') : ''));
    grid.appendChild(col);
  }
  host.appendChild(grid);
}

/** Milestones: longest session, first session, peak day. */
function renderUsageRecords(u) {
  const host = $('#usRecords');
  host.replaceChildren();

  const peakDay = (u.daily || []).reduce((best, r) => (r.messages > (best ? best.messages : -1) ? r : best), null);
  const rows = [
    [u.longestSession ? humanDuration(u.longestSession.durationMs) : '—', 'longest session', u.longestSession ? `${u.longestSession.messageCount} messages` : ''],
    [u.firstSessionAt ? new Date(u.firstSessionAt).toLocaleDateString() : '—', 'first session', u.firstSessionAt ? relTime(u.firstSessionAt) : ''],
    [peakDay ? humanCount(peakDay.messages) : '—', 'busiest day', peakDay ? shortDate(peakDay.date) : ''],
    [humanCount(u.totalToolCalls), 'tool calls', 'across every session'],
  ];
  for (const [value, label, sub] of rows) {
    const box = el('div', 'hero-metric');
    box.appendChild(el('span', 'hero-metric-num', value));
    box.appendChild(el('span', 'hero-metric-label', label));
    if (sub) box.appendChild(el('span', 'hero-metric-sub', sub));
    host.appendChild(box);
  }
}

/* ================================ history ============================== */

/** Last grouped payload from main. Null until the tab has been opened once. */
let historyData = null;
/** The live search box contents, kept here so a re-render does not lose it. */
let historyQuery = '';
/** Which day sections the user has collapsed, by key. */
const historyCollapsed = new Set();
/** Session id currently being renamed inline, or null. */
let renamingId = null;

/**
 * Fetch and draw the history.
 *
 * Two steps, because they cost very different amounts: the analytics report is
 * what reads transcripts and can take seconds on a cold cache, while the grouping
 * is arithmetic over an array already in memory. So a keystroke in the search box
 * only redoes the second one.
 */
async function loadHistory({ force = false, scan = true } = {}) {
  const off = state && state.config.analytics && state.config.analytics.enabled === false;
  $('#historyOffBanner').classList.toggle('hidden', !off);
  $('#historyStats').classList.toggle('hidden', Boolean(off));
  if (off) {
    $('#historyList').replaceChildren();
    $('#historyEmpty').classList.add('hidden');
    return;
  }

  // Reuses the same scan the Analytics tab does, rather than a second one: both
  // read the same report, and analyticsReport() joins an in-flight scan.
  if (scan) {
    try {
      const res = await api.analyticsReport({ force });
      if (res && res.report) analytics = res.report;
    } catch {
      /* the grouping below will report the absence */
    }
  }

  try {
    historyData = await api.historyGroups({ query: historyQuery });
  } catch (err) {
    toast(`History failed: ${err.message}`, 'danger');
    return;
  }
  renderHistory();
}

function renderHistory() {
  const host = $('#historyList');
  host.replaceChildren();

  const data = historyData;
  const groups = (data && data.groups) || [];
  const totals = (data && data.totals) || null;

  // The counts read differently with a query in the box: "12" alone looks like
  // everything there is, when it is twelve of two hundred.
  const filtered = Boolean(historyQuery.trim());
  $('#histSessions').textContent = totals ? String(totals.sessions) : '—';
  $('#histSessionsFoot').textContent = filtered && data && data.total ? `of ${data.total} on disk` : ' ';
  $('#histTime').textContent = totals ? humanMs(totals.activeMs) : '—';
  $('#histCost').textContent = totals ? money(totals.costUsd) : '—';
  $('#histDays').textContent = totals ? String(totals.days) : '—';
  $('#histDaysFoot').textContent = groups.length ? `since ${groups[groups.length - 1].label}` : ' ';

  const empty = $('#historyEmpty');
  empty.classList.toggle('hidden', groups.length > 0);
  if (!groups.length) {
    // Three different nothings, and saying which one it is decides whether the
    // user waits, clears the box, or goes and starts a session.
    if (filtered) {
      $('#historyEmptyText').textContent = 'Nothing matches that search.';
      $('#historyEmptyHint').textContent = 'Project names, branches, titles and prompts are all searched.';
    } else if (data && data.empty) {
      $('#historyEmptyText').textContent = 'Reading transcripts…';
      $('#historyEmptyHint').textContent = 'The first scan reads every transcript on disk, which takes a moment.';
    } else {
      $('#historyEmptyText').textContent = 'No sessions on disk yet.';
      $('#historyEmptyHint').textContent = "Transcripts are read from Claude Code's own projects folder.";
    }
    return;
  }

  for (const group of groups) host.appendChild(dayGroup(group));
}

/** One day: a header with its totals, and the sessions under it. */
function dayGroup(group) {
  const wrap = el('section', 'day-group');
  const collapsed = historyCollapsed.has(group.key);
  wrap.classList.toggle('collapsed', collapsed);

  // A button, not a div: this toggles something, so it should be reachable by
  // keyboard and announced as a control.
  const head = el('button', 'day-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(!collapsed));
  head.appendChild(el('span', 'day-caret', collapsed ? '▸' : '▾'));
  head.appendChild(el('span', 'day-label', group.label));

  const meta = el('span', 'day-meta');
  meta.appendChild(el('span', 'day-stat', `${group.count} ${group.count === 1 ? 'session' : 'sessions'}`));
  const time = el('span', 'day-stat', humanMs(group.activeMs));
  if (group.overlapping) {
    // Honest about which figure this is. Without the intervals the total is a sum
    // of sessions that may have overlapped, so it can exceed the wall clock.
    time.classList.add('approx');
    time.title = 'Sessions overlapped and the per-session spans were unavailable, so this may double-count concurrent work.';
  }
  meta.appendChild(time);
  meta.appendChild(el('span', 'day-stat accent', money(group.costUsd)));
  head.appendChild(meta);

  head.addEventListener('click', () => {
    if (historyCollapsed.has(group.key)) historyCollapsed.delete(group.key);
    else historyCollapsed.add(group.key);
    renderHistory();
  });
  wrap.appendChild(head);

  const list = el('div', 'day-sessions');
  for (const s of group.sessions) list.appendChild(historyRow(s));
  wrap.appendChild(list);
  return wrap;
}

/**
 * A session's title, falling back through what is actually known.
 *
 * The chain matters: a custom title is what the user chose, an ai-title is what
 * Claude Code generated, and the first prompt is what they actually typed. A bare
 * session id is last because it identifies the row without describing it.
 */
function sessionTitle(s) {
  if (s.title) return s.title;
  const prompt = String(s.lastPrompt || '').trim();
  if (prompt) return prompt.length > 90 ? `${prompt.slice(0, 90)}…` : prompt;
  return `Session ${String(s.sessionId || '').slice(0, 8)}`;
}

function historyRow(s) {
  const row = el('div', 'hist-row');
  row.dataset.sessionId = s.sessionId;

  const main = el('div', 'hist-main');
  main.appendChild(el('div', 'hist-title', sessionTitle(s)));

  const sub = el('div', 'hist-sub');
  sub.appendChild(el('span', 'hist-project', projectName(s.cwd)));
  if (s.gitBranch) sub.appendChild(el('span', 'hist-branch', s.gitBranch));
  if (s.model) sub.appendChild(el('span', 'hist-model', s.model));
  sub.appendChild(el('span', 'hist-when', new Date(s.lastAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })));
  main.appendChild(sub);
  row.appendChild(main);

  const stats = el('div', 'hist-stats');
  stats.appendChild(el('span', 'hist-time', humanMs(s.activeMs)));
  stats.appendChild(el('span', 'hist-cost', money(s.costUsd)));
  row.appendChild(stats);

  const actions = el('div', 'hist-actions');

  const resume = el('button', 'btn ghost small', 'Resume');
  resume.title = 'Open this session again in a new terminal window';
  resume.addEventListener('click', () => resumeSession(s, resume));
  actions.appendChild(resume);

  const rename = el('button', 'btn ghost small', 'Rename');
  rename.addEventListener('click', () => startRename(row, s));
  actions.appendChild(rename);

  row.appendChild(actions);

  /**
   * The whole row resumes, not just the button.
   *
   * The user asked to press a session and have it open, so the row is the target.
   * Clicks originating inside `.hist-actions` are ignored here, or pressing Rename
   * would resume as well.
   */
  row.addEventListener('click', (e) => {
    if (e.target.closest('.hist-actions') || e.target.closest('input')) return;
    resumeSession(s, resume);
  });

  return row;
}

/** Ask main to reopen a session, and say what happened either way. */
async function resumeSession(s, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await api.resumeSession(s.sessionId);
    if (res && res.ok) toast(`Opening ${sessionTitle(s)}…`, 'ok');
    else toast((res && res.reason) || 'Could not resume that session.', 'warn');
  } catch (err) {
    toast(`Could not resume: ${err.message}`, 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Turn a row's title into an editable field.
 *
 * Whether a rename is even allowed is asked *first*, and a refusal is shown as a
 * message rather than as a rejected edit — being told after typing a name that the
 * session is still running would be the worse order.
 */
async function startRename(row, s) {
  if (renamingId && renamingId !== s.sessionId) renderHistory(); // close the other one
  renamingId = s.sessionId;

  let verdict = { ok: true };
  try {
    verdict = await api.canRenameSession(s.sessionId);
  } catch {
    verdict = { ok: false, reason: 'Could not check whether this session is still running.' };
  }
  if (!verdict.ok) {
    renamingId = null;
    toast(verdict.reason || 'This session cannot be renamed right now.', 'warn');
    return;
  }

  const titleNode = row.querySelector('.hist-title');
  if (!titleNode) return;

  const input = document.createElement('input');
  input.className = 'input rename-input';
  input.value = s.title || '';
  input.maxLength = 120;
  input.placeholder = 'A name you will recognise later';
  titleNode.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    renamingId = null;
    if (!save) {
      renderHistory();
      return;
    }
    try {
      const res = await api.renameSession(s.sessionId, input.value);
      if (res && res.ok) {
        // Empty means "go back to the generated title", which is a valid request
        // rather than a no-op, so it gets its own confirmation.
        toast(res.name ? `Renamed to “${res.name}”.` : 'Custom name removed.', 'ok');
        // The title comes from the analytics report, which main has just retired,
        // so this re-reads the one transcript that changed.
        await loadHistory({ force: true });
      } else {
        toast((res && res.reason) || 'Could not rename that session.', 'warn');
        renderHistory();
      }
    } catch (err) {
      toast(`Could not rename: ${err.message}`, 'danger');
      renderHistory();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
    // Otherwise the row's click handler would fire and resume the session.
    e.stopPropagation();
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', () => commit(true));
}

/**
 * Search, debounced.
 *
 * 160ms because the grouping is fast but not free, and re-running it on every
 * keystroke of a long query makes the box feel heavier than the work justifies.
 * No scan is triggered — `scan: false` — so typing never reads a transcript.
 */
let historyTimer = null;
$('#historySearch').addEventListener('input', (e) => {
  historyQuery = e.target.value;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => loadHistory({ scan: false }), 160);
});

$('#btnRefreshHistory').addEventListener('click', () => loadHistory({ force: true }));

/* =============================== launchpad ============================= */

/** Skill names from ~/.claude/skills. Fetched once when the tab first opens. */
let availableSkills = null;
/** The preset being edited, or null when the editor is closed. */
let editingPreset = null;

function presets() {
  return (state && state.config.launchpad && state.config.launchpad.presets) || [];
}

function renderLaunchpad() {
  const grid = $('#presetGrid');
  grid.replaceChildren();
  const list = presets();

  $('#presetEmpty').classList.toggle('hidden', list.length > 0 || Boolean(editingPreset));
  grid.classList.toggle('hidden', list.length === 0);

  for (const p of list) grid.appendChild(presetCard(p));
}

function presetCard(p) {
  const card = el('article', 'preset-card');

  // The card itself launches. It is the primary action, and making the user find a
  // small button inside a big clickable-looking tile is a worse version of this.
  const launch = el('button', 'preset-launch');
  launch.type = 'button';
  launch.title = 'Start a session with this configuration';
  launch.appendChild(el('span', 'preset-label', p.label));

  const bits = el('span', 'preset-bits');
  if (p.cwd) bits.appendChild(el('span', 'preset-chip', projectName(p.cwd)));
  if (p.model) bits.appendChild(el('span', 'preset-chip', p.model));
  if (p.permissionMode) bits.appendChild(el('span', 'preset-chip', p.permissionMode));
  for (const s of p.skills || []) bits.appendChild(el('span', 'preset-chip skill', `/${s}`));
  launch.appendChild(bits);

  if (p.prePrompt) {
    const preview = String(p.prePrompt).replace(/\s+/g, ' ').trim();
    launch.appendChild(el('span', 'preset-prompt', preview.length > 120 ? `${preview.slice(0, 120)}…` : preview));
  }
  if (p.accelerator) launch.appendChild(el('span', 'preset-accel', p.accelerator));

  launch.addEventListener('click', async () => {
    launch.disabled = true;
    try {
      const res = await api.launchPreset(p.id);
      if (res && res.ok) toast(`Starting “${p.label}”…`, 'ok');
      else toast((res && res.reason) || 'Could not start that session.', 'warn');
    } catch (err) {
      toast(`Could not start: ${err.message}`, 'danger');
    } finally {
      launch.disabled = false;
    }
  });
  card.appendChild(launch);

  const foot = el('div', 'preset-foot');

  const edit = el('button', 'btn ghost small', 'Edit');
  edit.addEventListener('click', () => openPresetEditor(p));
  foot.appendChild(edit);

  const desktop = el('button', 'btn ghost small', 'Send to desktop');
  desktop.title = 'Put an icon on your Desktop that starts this session';
  desktop.addEventListener('click', async () => {
    desktop.disabled = true;
    try {
      const res = await api.presetToDesktop(p.id);
      if (res && res.ok) toast('Shortcut added to your Desktop.', 'ok');
      else toast((res && res.reason) || 'Could not create the shortcut.', 'warn');
    } catch (err) {
      toast(`Could not create the shortcut: ${err.message}`, 'danger');
    } finally {
      desktop.disabled = false;
    }
  });
  foot.appendChild(desktop);

  card.appendChild(foot);
  return card;
}

/** Model choices: the aliases, plus whatever the preset already holds. */
const PRESET_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
/** Kept in step with launcher.js's allowlist, which the CLI's --help defines. */
const PRESET_MODES = ['manual', 'auto', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions'];

async function openPresetEditor(preset) {
  editingPreset = preset || { id: null, label: '', skills: [] };
  const isNew = !preset;

  $('#presetEditor').classList.remove('hidden');
  $('#presetEmpty').classList.add('hidden');
  $('#presetEditorTitle').textContent = isNew ? 'New shortcut' : `Editing “${preset.label}”`;
  $('#btnDeletePreset').classList.toggle('hidden', isNew);

  $('#presetLabel').value = editingPreset.label || '';
  $('#presetCwd').value = editingPreset.cwd || '';
  $('#presetAccel').value = editingPreset.accelerator || '';
  $('#presetPrompt').value = editingPreset.prePrompt || '';

  fillSelect($('#presetModel'), PRESET_MODELS, editingPreset.model, "Claude Code's default");
  fillSelect($('#presetMode'), PRESET_MODES, editingPreset.permissionMode, "Claude Code's default");

  // Fetched once: the skills directory does not change while the app is open, and
  // re-reading it on every editor open would be a directory walk per click.
  if (availableSkills === null) {
    try {
      availableSkills = await api.listSkills();
    } catch {
      availableSkills = [];
    }
  }
  renderSkillPicker();

  $('#presetLabel').focus();
  $('#presetEditor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Options plus a blank first entry, since "unset" is a real choice here. */
function fillSelect(select, values, current, blankLabel) {
  select.replaceChildren();
  const blank = el('option', null, blankLabel);
  blank.value = '';
  select.appendChild(blank);
  const all = [...values];
  // A preset saved with a full model id keeps it, rather than being silently
  // reset to an alias by opening the editor.
  if (current && !all.includes(current)) all.push(current);
  for (const v of all) {
    const opt = el('option', null, v);
    opt.value = v;
    select.appendChild(opt);
  }
  select.value = current || '';
}

/**
 * Checkboxes for the installed skills, plus any the preset names that are gone.
 *
 * A missing one is shown and flagged rather than dropped, because silently
 * removing it would make the shortcut quietly stop doing part of its job.
 */
function renderSkillPicker() {
  const host = $('#presetSkills');
  host.replaceChildren();
  const chosen = new Set(editingPreset.skills || []);
  const names = [...(availableSkills || [])];
  const missing = [...chosen].filter((s) => !names.includes(s));
  for (const s of missing) names.push(s);

  if (!names.length) {
    host.appendChild(el('p', 'field-hint', 'No skills found in ~/.claude/skills.'));
    return;
  }

  for (const name of names.sort()) {
    const label = el('label', 'skill-chip');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = chosen.has(name);
    box.addEventListener('change', () => {
      const next = new Set(editingPreset.skills || []);
      if (box.checked) next.add(name);
      else next.delete(name);
      editingPreset.skills = [...next];
    });
    label.appendChild(box);
    label.appendChild(el('span', null, `/${name}`));
    if (missing.includes(name)) {
      label.classList.add('missing');
      label.title = 'This skill is no longer installed, so it would have no effect.';
    }
    host.appendChild(label);
  }
}

function closePresetEditor() {
  editingPreset = null;
  $('#presetEditor').classList.add('hidden');
  renderLaunchpad();
}

$('#btnNewPreset').addEventListener('click', () => openPresetEditor(null));
$('#btnFirstPreset').addEventListener('click', () => openPresetEditor(null));
$('#btnCancelPreset').addEventListener('click', () => closePresetEditor());

$('#btnPickCwd').addEventListener('click', async () => {
  try {
    const res = await api.pickDirectory();
    if (res && res.ok) $('#presetCwd').value = res.path;
  } catch (err) {
    toast(`Could not open the folder picker: ${err.message}`, 'danger');
  }
});

$('#btnSavePreset').addEventListener('click', async () => {
  const preset = {
    id: editingPreset && editingPreset.id,
    label: $('#presetLabel').value,
    cwd: $('#presetCwd').value,
    model: $('#presetModel').value,
    permissionMode: $('#presetMode').value,
    accelerator: $('#presetAccel').value,
    prePrompt: $('#presetPrompt').value,
    skills: (editingPreset && editingPreset.skills) || [],
  };
  try {
    const res = await api.savePreset(preset);
    if (!res || !res.ok) {
      toast((res && res.reason) || 'Could not save that shortcut.', 'warn');
      return;
    }
    toast('Shortcut saved.', 'ok');
    closePresetEditor();
    await refresh();
  } catch (err) {
    toast(`Could not save: ${err.message}`, 'danger');
  }
});

$('#btnDeletePreset').addEventListener('click', async () => {
  if (!editingPreset || !editingPreset.id) return;
  try {
    await api.deletePreset(editingPreset.id);
    toast('Shortcut deleted.', 'ok');
    closePresetEditor();
    await refresh();
  } catch (err) {
    toast(`Could not delete: ${err.message}`, 'danger');
  }
});

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
  desktopNotifications: ['Desktop notifications', 'A Windows toast whenever a session is resumed or needs you.'],
  promptCompleteNotifications: ['Tell me when a prompt finishes', 'A toast when a session stops working and is waiting for you — so you can go and do something else while it runs.'],
  soundAlerts: ['Sound with notifications', 'Play the notification sound instead of showing it silently.'],
  respectNonRetryable: ['Never retry hopeless failures', 'Keep auth, billing, and org-policy errors on alert-only, even if you switch them on in Coverage. Turning this off lets you force retries that cannot succeed.'],
};

const LIMIT_COPY = {
  maxAttemptsPerPrompt: ['Attempts per prompt', 'Resumes for a single prompt before Lifeline gives up.', 1, 50],
  maxAttemptsPerHour: ['Attempts per hour', 'Per session, in a rolling hour.', 1, 200],
  maxAttemptsPerDay: ['Attempts per day', 'Across every session — the backstop against runaway spend.', 1, 5000],
  cooldownMs: ['Cooldown (ms)', 'Ignore a repeat failure that lands within this window.', 0, 600000],
  maxBackoffMs: ['Maximum backoff (ms)', 'Ceiling on the exponential wait between attempts.', 1000, 3600000],
  stalledAfterMs: ['Stalled after (ms)', 'Idle time before a working session counts as stalled.', 60000, 21600000],
};

const NOTIFY_KEYS = ['desktopNotifications', 'promptCompleteNotifications', 'soundAlerts'];

const ADVANCED_COPY = {
  debugLogging: ['Verbose hook logging', 'Write every hook decision to hook.log. Useful when diagnosing why a session was not resumed.'],
};

/** Settings sections, in page order, for the jump list. */
const SETTINGS_SECTIONS = [
  ['setInstall', 'Installation'],
  ['setSafety', 'Safety limits'],
  ['setPolicy', 'Per-failure tuning'],
  ['setAnalytics', 'Analytics & cost'],
  ['setNotify', 'Notifications'],
  ['setAppearance', 'Appearance'],
  ['setWidgets', 'Desktop widgets'],
  ['setScope', 'Project scope'],
  ['setAdvanced', 'Advanced'],
];

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

/** A number input that only commits a valid value. */
function numberField(label, hint, value, min, max, onCommit) {
  const field = el('label', 'field');
  field.appendChild(el('span', 'field-label', label));
  const input = document.createElement('input');
  input.className = 'input';
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  // Commit on blur/Enter, not per keystroke: a half-typed "1" in a max-attempts
  // field would otherwise be saved as a real limit of 1.
  input.addEventListener('change', () => {
    const n = Number(input.value);
    if (!Number.isFinite(n) || n < min || n > max) {
      input.value = String(value);
      toast(`${label} must be between ${min} and ${max}.`, 'warn');
      return;
    }
    onCommit(n);
  });
  field.appendChild(input);
  if (hint) field.appendChild(el('span', 'field-hint', hint));
  return field;
}

/**
 * The settings forms are rebuilt only when the structure could have changed,
 * not on every 5s poll — re-creating inputs under the cursor would fight the
 * user's typing.
 */
function renderSettings() {
  const cfg = state.config;

  renderSettingsNav();

  const limits = $('#limitFields');
  limits.replaceChildren();
  for (const [key, [label, hint, min, max]] of Object.entries(LIMIT_COPY)) {
    limits.appendChild(
      numberField(label, hint, cfg.limits[key], min, max, (n) => pushConfig(`limits.${key}`, Math.round(n)))
    );
  }

  renderPolicies();
  renderAnalyticsSettings();

  const notify = $('#notifyToggles');
  notify.replaceChildren();
  for (const key of NOTIFY_KEYS) {
    const [title, desc] = FEATURE_COPY[key];
    notify.appendChild(toggleRow(title, desc, cfg.features[key], (v) => pushConfig(`features.${key}`, v)));
  }
  // The safety guard lives here too: it is a notification-vs-retry decision, and
  // this is where someone looking for "why was I only told about this" lands.
  notify.appendChild(
    toggleRow(...FEATURE_COPY.respectNonRetryable, cfg.features.respectNonRetryable, (v) => {
      pushConfig('features.respectNonRetryable', v).then(() => refresh());
    })
  );

  $('#themeSelect').value = cfg.ui.theme;
  $('#accentSelect').value = cfg.ui.accent;

  const windowToggles = $('#windowToggles');
  windowToggles.replaceChildren();
  windowToggles.appendChild(
    toggleRow('Start minimised to tray', 'Open straight to the tray at logon instead of showing this window.', cfg.ui.startMinimised, (v) =>
      pushConfig('ui.startMinimised', v)
    )
  );

  renderWidgetSettings();
  renderScope();

  const adv = $('#advancedToggles');
  adv.replaceChildren();
  for (const [key, [title, desc]] of Object.entries(ADVANCED_COPY)) {
    adv.appendChild(toggleRow(title, desc, cfg.advanced[key], (v) => pushConfig(`advanced.${key}`, v)));
  }

  const advFields = $('#advancedFields');
  advFields.replaceChildren();
  advFields.appendChild(
    numberField(
      'Event log size',
      'Events kept in events.jsonl before the oldest are trimmed.',
      cfg.advanced.eventLogLimit,
      100,
      100000,
      (n) => pushConfig('advanced.eventLogLimit', Math.round(n))
    )
  );

  renderHookStatus();
  renderCoverage();
}

function renderSettingsNav() {
  const host = $('#settingsNav');
  host.replaceChildren();
  for (const [id, label] of SETTINGS_SECTIONS) {
    const btn = el('button', 'settings-nav-item', label);
    // Copy the group's rail colour onto its jump-list entry, so the two are
    // visibly paired. Read from the group rather than duplicated here — the
    // colours are defined once, in the stylesheet, keyed by the same id.
    const group = document.getElementById(id);
    if (group) {
      const rail = getComputedStyle(group).getPropertyValue('--rail').trim();
      if (rail) btn.style.setProperty('--rail', rail);
    }
    btn.addEventListener('click', () => {
      const target = document.getElementById(id);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Brief highlight: after a scroll the eye needs telling where it landed.
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1200);
    });
    host.appendChild(btn);
  }
}

/* ========================== desktop widgets ============================= */

/**
 * The two widgets, and what each is for.
 *
 * Described here rather than in the markup because the cards are generated: two
 * hand-written blocks of the same eleven controls would be two sets of ids to keep
 * in step, and the differences between the widgets are three lines of data.
 */
const WIDGET_COPY = [
  [
    'shortcuts',
    'Shortcuts',
    'Your Launchpad presets as a floating strip of buttons. One click starts the session.',
  ],
  [
    'status',
    'Status',
    'Whether Lifeline is running, what it is protecting, and anything that has gone wrong.',
  ],
];

/**
 * Theme swatches, previewing themselves.
 *
 * The colours are the panel colours from widget.css rather than arbitrary chips, so
 * the swatch is a sample of what the widget will look like. Duplicated here because
 * this stylesheet has no access to that one — and the alternative, a swatch that
 * does not match its theme, is worse than a duplicated hex.
 */
const WIDGET_THEME_SWATCHES = [
  ['system', 'linear-gradient(135deg, #0f1117 50%, #f6f7fb 50%)', 'Match Windows'],
  ['dark', '#151823', 'Dark'],
  ['light', '#ffffff', 'Light'],
  ['midnight', '#080a12', 'Midnight'],
  ['slate', '#2a2f3b', 'Slate'],
  ['glass', 'linear-gradient(135deg, #ffffff59, #12161f8c)', 'Glass'],
];

const WIDGET_ACCENT_SWATCHES = [
  ['violet', '#7c5cff'],
  ['blue', '#3b82f6'],
  ['emerald', '#10b981'],
  ['amber', '#f59e0b'],
];

/**
 * The shapes a widget can take, per widget.
 *
 * A look is a different widget, not a different colour: the card is the full
 * readout, the bar is one strip for the top of a screen, and the orb is the mark
 * with a single number on it. The shortcuts widget has no orb, because a disc
 * holding three buttons would either hide two of them or stop being a disc —
 * enforced in widgets.js as well, so a hand-edited config cannot produce one.
 */
const WIDGET_LOOK_OPTIONS = {
  shortcuts: [
    ['card', 'Card', 'A stacked list of your shortcuts.'],
    ['bar', 'Bar', 'One horizontal strip of buttons.'],
  ],
  status: [
    ['card', 'Card', 'Status, counts, and anything wrong.'],
    ['bar', 'Bar', 'One horizontal strip, for the top of a screen.'],
    ['orb', 'Orb', 'Just the mark and one number.'],
  ],
};

/**
 * The look picker: named buttons with a diagram, not swatches.
 *
 * A 17px colour chip cannot show the difference between a card and a bar. The glyph
 * carries the shape and the word carries the meaning, which is also what makes this
 * usable without colour.
 */
function lookRow(id, current, onPick) {
  const row = el('div', 'widget-row');
  row.appendChild(el('span', 'widget-row-label', 'Look'));
  const host = el('div', 'widget-looks');
  for (const [value, label, title] of WIDGET_LOOK_OPTIONS[id] || WIDGET_LOOK_OPTIONS.status) {
    const btn = el('button', 'widget-look');
    btn.type = 'button';
    btn.dataset.value = value;
    btn.title = title;
    btn.setAttribute('aria-pressed', String(value === (current || 'card')));
    const glyph = el('span', 'widget-look-glyph');
    glyph.dataset.look = value;
    btn.appendChild(glyph);
    btn.appendChild(el('span', null, label));
    btn.addEventListener('click', () => onPick(value));
    host.appendChild(btn);
  }
  row.appendChild(host);
  return row;
}

/**
 * A row of swatches acting as a single choice.
 *
 * Buttons with aria-pressed rather than radios, because the control is a colour and
 * a radio's own dot would sit on top of the colour it is selecting. The chosen one
 * is marked with a ring in CSS.
 */
function swatchRow(label, options, current, onPick) {
  const row = el('div', 'widget-row');
  row.appendChild(el('span', 'widget-row-label', label));
  const host = el('div', 'widget-swatches');
  for (const [value, background, title] of options) {
    const btn = el('button', 'widget-swatch');
    btn.type = 'button';
    btn.dataset.value = value;
    btn.style.background = background;
    btn.title = title || value;
    btn.setAttribute('aria-label', title || value);
    btn.setAttribute('aria-pressed', String(value === current));
    btn.addEventListener('click', () => onPick(value));
    host.appendChild(btn);
  }
  row.appendChild(host);
  return row;
}

/**
 * Whether one of the widget sliders is being dragged right now.
 *
 * Each drag step saves config, which comes back as `config-changed` and rebuilds
 * this group — replacing the very element the pointer is holding, so the drag ends
 * after one step. The same hazard `editingPreset` guards against, in a form that
 * cannot be solved by not re-rendering on a poll: here the render is caused by the
 * drag itself.
 */
let draggingWidgetSlider = false;

/** A slider with its value shown, since a bare slider says nothing about where it is. */
function sliderRow(label, { min, max, step = 1, value, format, onInput }) {
  const row = el('div', 'widget-row');
  row.appendChild(el('span', 'widget-row-label', label));
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const readout = el('span', 'widget-row-value', format(value));
  // On `input`, not `change`: these change something visible on screen, and the
  // point of dragging one is watching the widget follow.
  input.addEventListener('input', () => {
    readout.textContent = format(Number(input.value));
    onInput(Number(input.value));
  });
  // pointerdown/up rather than mousedown/up, so a touch or pen drag is covered
  // too. `pointercancel` matters: without it a drag interrupted by the OS would
  // leave the flag set and the group would stop updating for good.
  input.addEventListener('pointerdown', () => {
    draggingWidgetSlider = true;
  });
  for (const event of ['pointerup', 'pointercancel']) {
    input.addEventListener(event, () => {
      draggingWidgetSlider = false;
    });
  }
  // A keyboard user moves the same slider with the arrow keys, which fires `input`
  // without any pointer event at all — so the flag has to be raised for that too,
  // and lowered when the key comes up.
  input.addEventListener('keydown', () => {
    draggingWidgetSlider = true;
  });
  input.addEventListener('keyup', () => {
    draggingWidgetSlider = false;
  });
  input.addEventListener('blur', () => {
    draggingWidgetSlider = false;
  });
  row.appendChild(input);
  row.appendChild(readout);
  return row;
}

function checkRow(label, checked, onChange, hint) {
  const wrap = el('div');
  const row = el('label', 'widget-check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange(input.checked));
  row.appendChild(input);
  row.appendChild(el('span', null, label));
  wrap.appendChild(row);
  if (hint) wrap.appendChild(el('div', 'widget-check-hint', hint));
  return wrap;
}

/**
 * Build both widget cards.
 *
 * Rebuilt wholesale on every renderSettings, which is safe here because none of
 * these controls holds half-typed text — the risk renderSettings exists to avoid is
 * re-creating a text input under the cursor, and there is not one. A slider being
 * dragged is a real case, but a drag holds the pointer on an element that is
 * replaced only when config changes, which is what the drag is doing anyway.
 */
function renderWidgetSettings() {
  // Mid-drag the DOM is deliberately left alone — see draggingWidgetSlider. The
  // values on screen are already the ones being saved, so skipping the rebuild
  // costs nothing and keeps the pointer's grip on the slider.
  if (draggingWidgetSlider) return;

  const host = $('#widgetSettings');
  const all = (state.config && state.config.widgets) || {};
  host.replaceChildren();

  for (const [id, title, desc] of WIDGET_COPY) {
    const w = all[id] || {};
    const card = el('div', 'widget-card');
    card.dataset.widget = id;
    card.dataset.enabled = String(Boolean(w.enabled));

    const head = el('div', 'widget-card-head');
    const text = el('div');
    text.appendChild(el('div', 'widget-card-title', title));
    text.appendChild(el('div', 'widget-card-desc', desc));
    head.appendChild(text);
    // The enable switch is the one control that stays at full strength when the
    // widget is off, because it is the only one that does anything about that.
    head.appendChild(switchControl(w.enabled, (v) => pushConfig(`widgets.${id}.enabled`, v)));
    card.appendChild(head);

    const body = el('div', 'widget-card-body');

    // First, because it decides what the rest of the controls are for: the width
    // slider does nothing to a bar or an orb, both of which have a fixed width.
    body.appendChild(lookRow(id, w.look, (v) => pushConfig(`widgets.${id}.look`, v)));
    body.appendChild(
      swatchRow('Theme', WIDGET_THEME_SWATCHES, w.theme, (v) => pushConfig(`widgets.${id}.theme`, v))
    );
    body.appendChild(
      swatchRow('Accent', WIDGET_ACCENT_SWATCHES, w.accent, (v) => pushConfig(`widgets.${id}.accent`, v))
    );
    body.appendChild(
      sliderRow('Opacity', {
        min: 35,
        max: 100,
        step: 5,
        value: Math.round((w.opacity ?? 1) * 100),
        format: (n) => `${n}%`,
        onInput: (n) => pushConfig(`widgets.${id}.opacity`, n / 100),
      })
    );
    // Only the card has a settable width. The bar and the orb are sized by their
    // shape, so the slider would move and nothing would happen — which reads as a
    // broken control rather than an inapplicable one.
    if ((w.look || 'card') === 'card') {
      body.appendChild(
        sliderRow('Width', {
          min: 180,
          max: 520,
          step: 10,
          value: w.width ?? 260,
          format: (n) => `${n}px`,
          onInput: (n) => pushConfig(`widgets.${id}.width`, n),
        })
      );
    }

    const checks = el('div', 'widget-checks');
    checks.appendChild(
      checkRow('Always on top', w.alwaysOnTop !== false, (v) => pushConfig(`widgets.${id}.alwaysOnTop`, v))
    );
    checks.appendChild(
      checkRow('Compact', Boolean(w.compact), (v) => pushConfig(`widgets.${id}.compact`, v), 'Fewer details, less space.')
    );
    // Only the status widget: a panel of buttons that ignores clicks is a panel of
    // buttons that cannot be pressed.
    if (id === 'status') {
      checks.appendChild(
        checkRow('Click through', Boolean(w.clickThrough), (v) => pushConfig(`widgets.${id}.clickThrough`, v), 'Clicks pass to the window behind. You will not be able to drag it until you turn this off.')
      );
    }
    body.appendChild(checks);

    const foot = el('div', 'widget-foot');
    // Shown because the reset button below is meaningless without it: "reset
    // position" on a widget with no saved position does nothing, and this is what
    // says which case you are in.
    foot.appendChild(
      el('span', 'widget-where', w.x === null || w.x === undefined ? 'Default position' : `At ${Math.round(w.x)}, ${Math.round(w.y)}`)
    );
    const reset = el('button', 'btn ghost small', 'Reset position');
    reset.addEventListener('click', async () => {
      const res = await api.resetWidgetPosition(id);
      toast(res && res.ok ? `${title} widget moved back to its default corner.` : 'Could not move the widget.', res && res.ok ? 'ok' : 'danger');
    });
    foot.appendChild(reset);
    body.appendChild(foot);

    card.appendChild(body);
    host.appendChild(card);
  }
}

/** Free-text path lists. Committed on blur, one path per line. */
function renderScope() {
  const host = $('#scopeFields');
  const cfg = state.config;
  host.replaceChildren();

  const listField = (label, hint, key) => {
    const field = el('label', 'field');
    field.appendChild(el('span', 'field-label', label));
    const area = document.createElement('textarea');
    area.className = 'input area';
    area.rows = 4;
    area.spellcheck = false;
    area.value = (cfg.advanced[key] || []).join('\n');
    area.addEventListener('change', () => {
      const lines = area.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      pushConfig(`advanced.${key}`, lines);
    });
    field.appendChild(area);
    field.appendChild(el('span', 'field-hint', hint));
    return field;
  };

  host.appendChild(listField('Only these projects', 'Leave empty to protect every project.', 'projectAllowlist'));
  host.appendChild(listField('Never these projects', 'Checked first — a match here is never recovered.', 'projectDenylist'));
}

function renderAnalyticsSettings() {
  const cfg = state.config;
  const a = cfg.analytics || {};

  const toggles = $('#analyticsToggles');
  toggles.replaceChildren();
  toggles.appendChild(
    toggleRow(
      'Track sessions, time, and cost',
      'Reads Claude Code transcripts to report what you worked on and roughly what it cost. Read-only, and nothing leaves this machine.',
      a.enabled !== false,
      (v) => {
        pushConfig('analytics.enabled', v).then(() => {
          if (v) loadAnalytics({ force: true });
          else {
            analytics = null;
            renderDashWeek();
          }
        });
      }
    )
  );

  const fields = $('#analyticsFields');
  fields.replaceChildren();
  const symField = el('label', 'field');
  symField.appendChild(el('span', 'field-label', 'Currency symbol'));
  const symInput = document.createElement('input');
  symInput.className = 'input';
  symInput.type = 'text';
  symInput.maxLength = 3;
  symInput.value = a.currencySymbol || '$';
  symInput.addEventListener('change', () => {
    pushConfig('analytics.currencySymbol', symInput.value.slice(0, 3) || '$').then(() => renderAnalytics());
  });
  symField.appendChild(symInput);
  symField.appendChild(el('span', 'field-hint', 'Display only — rates below are always entered in USD.'));
  fields.appendChild(symField);

  renderRatesTable();
}

/**
 * Editable rate table.
 *
 * Shown because cost here is derived, not billed: published prices change, and a
 * subscription plan does not bill per token at all. A blank cell means "use the
 * built-in rate", so the table stays readable without a reset button per row.
 */
function renderRatesTable() {
  const body = $('#ratesBody');
  const cfg = state.config;
  const overrides = (cfg.analytics && cfg.analytics.rates) || {};
  body.replaceChildren();

  for (const model of state.pricingModels || []) {
    const tr = el('tr');
    const nameCell = el('td');
    nameCell.appendChild(el('div', 'cell-main', model));
    if (overrides[model]) nameCell.appendChild(el('div', 'cell-sub', 'custom rate'));
    tr.appendChild(nameCell);

    for (const kind of ['input', 'output', 'cacheWrite', 'cacheRead']) {
      const td = el('td');
      const input = document.createElement('input');
      input.className = 'input tiny';
      input.type = 'number';
      input.min = '0';
      input.step = '0.01';
      input.placeholder = 'default';
      const ov = overrides[model];
      if (ov && ov[kind] !== undefined) input.value = String(ov[kind]);
      input.addEventListener('change', () => {
        const n = Number(input.value);
        if (input.value === '' || !Number.isFinite(n) || n < 0) {
          input.value = '';
          toast('Rates must be a number of USD per million tokens.', 'warn');
          return;
        }
        // A partial override would price the other three kinds at the fallback,
        // so the row is filled from the current effective rates first.
        const current = { ...(defaultRateRow(model) || {}), ...(overrides[model] || {}) };
        current[kind] = n;
        pushConfig(`analytics.rates.${model}`, current).then(() => loadAnalytics({ force: true }));
      });
      td.appendChild(input);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

/**
 * The rates a row starts from when the user edits one cell.
 *
 * Taken from the table main sends rather than duplicating pricing.js here: a
 * second copy of the price table in the renderer would drift the moment either
 * side changed.
 */
function defaultRateRow(model) {
  const overrides = (state.config.analytics && state.config.analytics.rates) || {};
  if (overrides[model]) return overrides[model];
  const builtIn = (state.pricingRates || {})[model];
  if (builtIn) return builtIn;
  // A model with no built-in entry at all: zeros are honest here, because there
  // is no published rate to fall back to and inventing one would report spend
  // that was never charged.
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

$('#btnResetRates').addEventListener('click', async () => {
  // Its own channel, not a saveConfig patch: patches are deep-merged, so sending
  // an empty rates map recurses into it and clears nothing.
  await api.resetRates();
  await refresh();
  await loadAnalytics({ force: true });
  toast('Model rates restored to built-in prices.', 'ok');
});

function renderPolicies() {
  const host = $('#policyList');
  const cfg = state.config;
  host.replaceChildren();

  for (const meta of state.policyMeta || []) {
    const eff = (cfg.policies && cfg.policies[meta.key]) || {};
    const resolved = meta.effective || {};
    const row = el('div', 'policy-row');

    const nameBox = el('div');
    const name = el('div', 'policy-name');
    name.appendChild(el('span', null, meta.label));
    if (!resolved.resume) name.appendChild(el('span', 'chip warn', 'alert only'));
    else if (resolved.strategy === 'compact') name.appendChild(el('span', 'chip info', 'compact'));
    nameBox.appendChild(name);
    nameBox.appendChild(el('div', 'policy-why', meta.reason));
    row.appendChild(nameBox);

    const numField = (label, key, value, min, max) => {
      const f = el('div', 'policy-field');
      f.appendChild(el('label', null, label));
      const input = document.createElement('input');
      input.className = 'input';
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.value = String(value);
      // Disabled when the class will never fire: editing a wait time that can
      // never elapse is a control that lies about what it does.
      input.disabled = !resolved.resume;
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
    host.appendChild(row);
  }
}

function renderHookStatus() {
  const host = $('#hookStatus');
  const hooks = state.hooks || { events: [], expected: [] };
  host.replaceChildren();

  const chip = $('#installChip');
  if (hooks.complete) {
    chip.textContent = 'Installed';
    chip.className = 'group-chip ok';
  } else {
    chip.textContent = 'Not installed';
    chip.className = 'group-chip warn';
  }

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

const ABOUT_STEPS = [
  [
    'A turn dies',
    'An API error ends the turn. Claude Code fires StopFailure instead of the usual Stop, carrying the error class — rate_limit, overloaded, invalid_request, and so on.',
  ],
  [
    'Lifeline decides',
    'The hook looks up that class, checks your Coverage switches and safety limits, and either plans a resume or stops to tell you.',
  ],
  [
    'It waits',
    'For a rate limit or an overload the wait is the fix, not politeness — resuming instantly just reproduces the error. Backoff grows with each attempt, capped by your limit.',
  ],
  [
    'The session wakes itself',
    'The hook exits with code 2. With asyncRewake enabled, Claude Code injects the hook\'s message into the conversation and wakes the model, so the work continues where it stopped.',
  ],
];

const ABOUT_PRINCIPLES = [
  ['Works without this app', 'Recovery lives in the hook, inside Claude Code\'s own process. Quit the tray and every session stays protected.'],
  ['Never breaks a session', 'The hook has no dependencies, never throws, and falls back to doing nothing. It runs on Claude Code\'s critical path.'],
  ['Bounded by default', 'Attempt caps per prompt, per hour, and per day. A permanent failure cannot be retried forever.'],
  ['Reads, does not write', 'Session records and transcripts are read-only inputs. Lifeline writes only inside its own folder.'],
];

const ABOUT_RETRY = [
  ['ok', 'Retried automatically', ['Rate limits — the limit clears with time', 'Overload and 5xx — server-side and transient', 'Dropped connections and timeouts — the overnight failure case', 'Output truncation — continuing from the cut is valid', 'Context overflow — /compact first, then continue']],
  ['warn', 'Reported, never retried', ['Authentication failures — a wrong key fails identically forever', 'Billing problems — needs a billing change, not a retry', 'Org policy blocks — no retry can satisfy a policy', 'Unknown model id — a config error, identical every time']],
];

function renderAbout() {
  // Absent only if an older main process is somehow paired with this renderer —
  // which the dev workflow makes possible. Better a chip that reads "unknown"
  // than a crash on the tab that exists to answer "what am I running".
  const versions = state.versions || {};
  const appVersion = versions.app ? `v${versions.app}` : 'version unknown';

  const chips = $('#aboutChips');
  chips.replaceChildren();
  for (const [text, tone] of [
    // First chip, and accented: the version is the single most-asked question an
    // about page answers, so it leads rather than sitting among the build trivia.
    [appVersion, 'accent'],
    ['Windows 11', ''],
    [versions.electron ? `Electron ${versions.electron}` : 'Electron', ''],
    ['Zero runtime dependencies', 'ok'],
    ['MIT licensed', 'info'],
  ]) {
    chips.appendChild(el('span', `chip ${tone}`.trim(), text));
  }

  const metrics = $('#aboutMetrics');
  metrics.replaceChildren();
  const hooks = state.hooks || { events: [], expected: [] };
  const { enabled, total } = coverageCounts();
  const rows = [
    [`${(hooks.events || []).length}/${(hooks.expected || []).length}`, 'hooks registered'],
    [`${enabled}/${total}`, 'checks enabled'],
    // From the event log, like the dashboard's count — not from the ledger, which
    // is pruned to 48 hours and so read as zero next to a visible timeline.
    [String(state.stats.recoveredLogged ?? state.stats.recoveredToday ?? 0), 'recoveries logged'],
    [state.config.enabled ? 'Active' : 'Paused', 'protection'],
  ];
  for (const [value, label] of rows) {
    const box = el('div', 'hero-metric');
    box.appendChild(el('span', 'hero-metric-num', value));
    box.appendChild(el('span', 'hero-metric-label', label));
    metrics.appendChild(box);
  }

  const steps = $('#aboutSteps');
  steps.replaceChildren();
  for (const [title, body] of ABOUT_STEPS) {
    const li = el('li', 'step');
    li.appendChild(el('div', 'step-title', title));
    li.appendChild(el('div', 'step-body', body));
    steps.appendChild(li);
  }

  const principles = $('#aboutPrinciples');
  principles.replaceChildren();
  for (const [title, body] of ABOUT_PRINCIPLES) {
    const item = el('div', 'principle');
    item.appendChild(el('div', 'principle-title', title));
    item.appendChild(el('div', 'principle-body', body));
    principles.appendChild(item);
  }

  const retry = $('#aboutRetryCards');
  retry.replaceChildren();
  for (const [tone, title, items] of ABOUT_RETRY) {
    const card = el('div', `split-card ${tone}`);
    const head = el('div', 'split-card-head');
    head.appendChild(el('span', `chip ${tone}`, title));
    card.appendChild(head);
    const list = el('ul', 'split-list');
    for (const item of items) list.appendChild(el('li', null, item));
    card.appendChild(list);
    retry.appendChild(card);
  }

  const host = $('#aboutPaths');
  host.replaceChildren();
  const pathRows = [
    ['Data folder', state.paths.home, 'home'],
    ['Config', state.paths.config, 'config'],
    ['Event log', state.paths.events, 'events'],
    ['Hook script', state.paths.hook, null],
    ['Claude settings', state.paths.settings, 'settings'],
  ];
  for (const [label, value, target] of pathRows) {
    const row = el(target ? 'button' : 'div', 'path-row');
    row.appendChild(el('span', 'path-label', label));
    row.appendChild(el('span', 'path-value', value || '—'));
    if (target) {
      row.appendChild(el('span', 'path-open', 'Open'));
      row.addEventListener('click', () => api.openPath(target));
    }
    host.appendChild(row);
  }

  const foot = $('#aboutFoot');
  foot.replaceChildren();
  // The full build string, in the place a build string conventionally goes. The
  // chip above answers "which version" at a glance; this answers the follow-up
  // that an issue report needs, so it is selectable text rather than a chip.
  const build = [
    `Claude Lifeline ${appVersion}`,
    versions.electron ? `Electron ${versions.electron}` : null,
    versions.chrome ? `Chromium ${versions.chrome}` : null,
    versions.node ? `Node ${versions.node}` : null,
    versions.schema != null ? `config schema v${versions.schema}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  foot.appendChild(el('span', 'about-build', build));
  foot.appendChild(
    el(
      'span',
      null,
      'An unofficial companion for Claude Code, built with Claude Opus 5 in Claude Code. Not affiliated with Anthropic.'
    )
  );
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
$('#btnOpenData').addEventListener('click', () => api.openPath('home'));
$('#btnOpenEvents').addEventListener('click', () => api.openPath('events'));
$('#btnOpenConfig').addEventListener('click', () => api.openPath('config'));

$('#btnClearAttention').addEventListener('click', async () => {
  await api.clearAttention();
  toast('Acknowledged. History is kept.', 'ok');
  await refresh();
});

$('#btnResetConfig').addEventListener('click', async () => {
  const cfg = await api.resetConfig();
  state.config = cfg;
  applyTheme(cfg.ui.theme, cfg.ui.accent);
  await refresh();
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
  // Presets live in config, so a save or an external edit has to redraw the grid.
  // Skipped while the editor is open, or a poll would discard a half-typed preset.
  if (!editingPreset) renderLaunchpad();
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

// Static chrome, built once before any state arrives.
renderRangePicker();

api.getState().then(async (s) => {
  apply(s, { full: true });
  // Picks up a report an earlier launch already cached, without forcing a scan.
  try {
    const snap = await api.analyticsSnapshot();
    if (snap && snap.report) {
      analytics = snap.report;
      renderAnalytics();
      renderDashWeek();
      // The cost column reads the same report.
      renderSessions();
    }
  } catch {
    /* analytics is optional; the rest of the UI does not depend on it */
  }
});
