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
  // Analytics can take seconds on a cold cache, so it is only scanned when the
  // tab is actually opened rather than on every poll.
  if (tab === 'analytics') loadAnalytics();
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
    stateCell.appendChild(el('span', `chip ${tone}`, text));
    tr.appendChild(stateCell);

    tr.appendChild(el('td', 'mono', relTime(s.updatedAt)));
    tr.appendChild(el('td', 'mono', s.pid));
    body.appendChild(tr);
  }
}

/* =============================== analytics ============================= */

const RANGE_LABEL = { week: 'past 7 days', month: 'past 30 days', year: 'past 12 months', all: 'all time' };

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
    return;
  }
  applyAnalyticsView();

  analyticsLoading = true;
  const btn = $('#btnRefreshAnalytics');
  btn.disabled = true;
  // A cold scan reads hundreds of megabytes; without this the tab looks broken
  // for a couple of seconds on first open.
  if (!analytics) $('#chartTag').textContent = 'reading transcripts…';
  try {
    const res = await api.analyticsReport({ force });
    if (res && res.error) toast(`Analytics: ${res.error}`, 'warn');
    if (res && res.report) analytics = res.report;
    renderAnalytics();
    renderDashWeek();
  } catch (err) {
    toast(`Analytics failed: ${err.message}`, 'danger');
  } finally {
    analyticsLoading = false;
    btn.disabled = false;
  }
}

$('#btnRefreshAnalytics').addEventListener('click', () => loadAnalytics({ force: true }));
$('#analyticsRange').addEventListener('change', (e) => {
  analyticsRange = e.target.value;
  renderAnalytics();
});

$$('#analyticsViews .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    analyticsView = btn.dataset.view;
    $$('#analyticsViews .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    applyAnalyticsView();
  });
});

/**
 * Show one of the two Analytics views.
 *
 * The range selector only applies to the transcript-derived view — Claude Code's
 * stats are whole-history totals with no window to slice — so it is hidden
 * rather than left present and inert.
 */
function applyAnalyticsView() {
  const usage = analyticsView === 'usage';
  $('#analyticsBody').classList.toggle('hidden', usage);
  $('#usageBody').classList.toggle('hidden', !usage);
  $('#analyticsRange').classList.toggle('hidden', usage);
  if (usage) renderUsage();
}

/** Dashboard's week strip. Reuses whatever analytics already has — never scans. */
function renderDashWeek() {
  const hint = $('#dashWeekHint');
  if (state.config.analytics && state.config.analytics.enabled === false) {
    $('#dashWeekHours').textContent = '—';
    $('#dashWeekSessions').textContent = '—';
    $('#dashWeekCost').textContent = '—';
    hint.textContent = 'Analytics is turned off.';
    return;
  }
  if (!analytics) {
    hint.textContent = 'Open Analytics to read your transcripts.';
    return;
  }
  const w = analytics.totals.week;
  $('#dashWeekHours').textContent = humanDuration(w.activeMs);
  $('#dashWeekSessions').textContent = w.sessions;
  $('#dashWeekCost').textContent = money(w.costUsd);
  hint.textContent = `${w.projects} project${w.projects === 1 ? '' : 's'} · cost is an estimate from token counts.`;
}

function renderAnalytics() {
  if (!analytics) return;
  const t = analytics.totals[analyticsRange] || analytics.totals.week;
  const label = RANGE_LABEL[analyticsRange];

  $('#anHours').textContent = humanDuration(t.activeMs);
  $('#anHoursFoot').textContent = `active time, ${label}`;
  $('#anSessions').textContent = t.sessions;
  $('#anSessionsFoot').textContent = `${t.projects} project${t.projects === 1 ? '' : 's'} · ${t.userMessages} prompts`;
  $('#anCost').textContent = money(t.costUsd);
  $('#anCostFoot').textContent = 'estimated from tokens';
  $('#anTokens').textContent = humanCount(t.tokens);
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
  return { rows: (analytics.monthly && analytics.monthly.year) || [], title: 'Monthly activity', fmt: shortMonth };
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
  for (const r of rows) {
    const col = el('div', 'chart-col');
    col.title = `${r.key} — ${humanDuration(r.activeMs)}, ${r.sessions} session${r.sessions === 1 ? '' : 's'}, ${money(r.costUsd)}`;

    const track = el('div', 'chart-track');
    const bar = el('div', 'chart-bar');
    // Floor at 2% so a short-but-real day is still visible next to a long one.
    bar.style.height = r.activeMs ? `${Math.max(2, Math.round((r.activeMs / peak) * 100))}%` : '0';
    if (!r.activeMs) bar.classList.add('zero');
    track.appendChild(bar);
    col.appendChild(track);

    col.appendChild(el('div', 'chart-val', r.activeMs ? humanDuration(r.activeMs) : ''));
    col.appendChild(el('div', 'chart-label', fmt(r.key, r.at)));
    grid.appendChild(col);
  }
  host.appendChild(grid);
}

function renderProjectBars() {
  const host = $('#projectBars');
  const rows = (analyticsRange === 'all' && analytics.projectsAllTime) || analytics.projects || [];
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
  const spans = { week: 7, month: 30, year: 365, all: Number.MAX_SAFE_INTEGER };
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

  $('#usSessions').textContent = humanCount(u.totalSessions);
  $('#usSessionsFoot').textContent = u.firstSessionAt ? `since ${new Date(u.firstSessionAt).toLocaleDateString()}` : 'all recorded history';
  $('#usMessages').textContent = humanCount(u.totalMessages);
  $('#usMessagesFoot').textContent = `${humanCount(u.totalToolCalls)} tool calls`;
  $('#usTokens').textContent = humanCount(u.totalTokens);
  // Cache reads are the bulk of the count and a tenth of the price, so the split
  // is worth showing rather than one huge number.
  $('#usTokensFoot').textContent = `${humanCount(u.tokens.cacheRead)} cache read · ${humanCount(u.tokens.output)} output`;
  $('#usCost').textContent = money(u.costUsd);
  $('#usCostFoot').textContent = u.estimatedRates ? 'fallback rates used' : 'tokens × published rate';

  // Two caveats worth stating outright: the cache lags live work, and the money
  // column is ours, because Claude Code reports 0 on a subscription plan.
  const lag = u.computedFor ? `Claude Code last recomputed these on ${shortDate(u.computedFor)}, so today's work may be missing.` : '';
  $('#usageNoteText').textContent = `${lag} Token counts are Claude Code's; the cost column is Lifeline's, because /usage reports $0 per model on subscription plans. Switch to "Your work" for time, projects, and per-session detail.`.trim();
  $('#usageNote').classList.toggle('warn', Boolean(u.estimatedRates));

  renderUsageModels(u);
  renderUsageDaily(u);
  renderUsageHours(u);
  renderUsageRecords(u);
}

/** Per-model rows, cost-ordered, with an inline share-of-spend bar. */
function renderUsageModels(u) {
  const body = $('#usModelBody');
  body.replaceChildren();
  const rows = u.models || [];
  $('#usModelTag').textContent = rows.length ? `${rows.length} model${rows.length === 1 ? '' : 's'}` : 'no usage yet';

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
    tr.appendChild(el('td', 'mono', money(m.costUsd)));
    body.appendChild(tr);
  }
}

/**
 * Messages per day.
 *
 * Only the tail is charted: the cache keeps every day it has ever seen, and a
 * hundred 4px bars is not a chart anyone reads.
 */
function renderUsageDaily(u) {
  const host = $('#usDailyChart');
  host.replaceChildren();
  const all = u.daily || [];
  const rows = all.slice(-30);
  const peak = rows.reduce((m, r) => Math.max(m, r.messages), 0);
  $('#usDailyTag').textContent = rows.length
    ? `last ${rows.length} day${rows.length === 1 ? '' : 's'}${all.length > rows.length ? ` of ${all.length}` : ''}`
    : 'no daily data';

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

const NOTIFY_KEYS = ['desktopNotifications', 'soundAlerts'];

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
  const chips = $('#aboutChips');
  chips.replaceChildren();
  for (const [text, tone] of [
    ['Windows 11', ''],
    ['Electron', ''],
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
  foot.appendChild(
    el(
      'span',
      null,
      'Claude Lifeline — an unofficial companion for Claude Code, built with Claude Opus 5 in Claude Code. Not affiliated with Anthropic.'
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

api.getState().then(async (s) => {
  apply(s, { full: true });
  // Picks up a report an earlier launch already cached, without forcing a scan.
  try {
    const snap = await api.analyticsSnapshot();
    if (snap && snap.report) {
      analytics = snap.report;
      renderAnalytics();
      renderDashWeek();
    }
  } catch {
    /* analytics is optional; the rest of the UI does not depend on it */
  }
});
