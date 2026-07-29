'use strict';
/**
 * The desktop widgets' renderer.
 *
 * Both widgets run this file; `window.widget.id` says which one, and the document
 * is switched by a data attribute rather than by building two renderers. What they
 * share is everything structural — theme, drag handle, settings popover, height
 * reporting — and only the middle block differs.
 *
 * ## Height
 *
 * The window is not resizable, so the content decides how tall it is: a
 * ResizeObserver on the panel reports the measured height to main, which resizes
 * the window around it. That is the opposite of the usual arrangement and it is
 * what makes "six shortcuts" and "one shortcut" both look deliberate rather than
 * leaving a widget with a pane of empty space or a scrollbar.
 *
 * ## Text
 *
 * Every string that reaches the DOM goes through textContent. The status widget
 * renders event details, which are error messages and model output — untrusted
 * text that has already been through a transcript — and the shortcuts widget
 * renders labels the user typed. Neither has any business being parsed as markup,
 * and the CSP would only stop the subset of that which tries to execute.
 */

const api = window.widget;

/** The last settings and state pushed from main. Null until the first push. */
let settings = null;
let appState = null;

/** Height last reported, so an unchanged measurement is not sent again. */
let sentHeight = 0;

/** Whether the settings popover is open. Not persisted: it is a transient. */
let settingsOpen = false;

/**
 * Presets currently mid-launch, by id.
 *
 * A launch opens a terminal, which takes a second or two to appear. Without a
 * pressed state the click looks like it did nothing, and the natural response to
 * that is to click again — which is two sessions.
 */
const launching = new Set();

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

/* ============================== chrome ================================== */

function applySettings(next) {
  settings = next;
  const body = document.body;
  const root = document.documentElement;

  root.dataset.theme = settings.theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : settings.theme;
  root.dataset.accent = settings.accent;
  body.dataset.widget = api.id;
  body.dataset.look = settings.look;
  body.dataset.compact = String(settings.compact);
  body.dataset.clickThrough = String(settings.clickThrough);

  $('title').textContent = api.id === 'status' ? 'Lifeline' : 'Shortcuts';

  /**
   * Switching to the orb closes the popover.
   *
   * The orb has no popover — the gear opens the main Settings tab instead — so a
   * popover left open would be hidden by CSS while `settingsOpen` still said true,
   * and the next click on the gear would toggle an invisible panel. Since the switch
   * itself is made *from* the popover, this is the normal path, not an edge case.
   */
  if (settings.look === 'orb' && settingsOpen) {
    settingsOpen = false;
    $('settings').classList.add('hidden');
    $('btnSettings').dataset.on = 'false';
  }

  // The window's own opacity is set by main; setting it here as well would
  // multiply the two.
  syncSettingsForm();
  render();
}

/**
 * Follow Windows live.
 *
 * Reading the preference once at startup would leave a widget in yesterday's
 * theme until it was toggled off and on — and unlike the main window, a widget is
 * often on screen across a whole day, including the point where Windows switches
 * itself at sunset.
 */
systemDark.addEventListener('change', () => {
  if (settings && settings.theme === 'system') applySettings(settings);
});

/* ============================= identity ================================= */

/**
 * The app's mark and the status, applied wherever they appear.
 *
 * Shared by both widgets and all three looks, because the logo is not decoration
 * here: it is drawn at runtime in the status colour, so it is simultaneously the
 * identity and the fastest-to-read part of the readout. The status also lands on
 * <body>, which is what drives the breathing ring in CSS — an animation keyed off a
 * data attribute rather than a class the renderer has to remember to remove.
 */
function applyIdentity() {
  const st = appState || {};
  const logo = st.logo || {};
  document.body.dataset.status = st.status || 'unknown';

  // Only assigned when there is something to assign: setting src to '' makes
  // Chromium re-request the document URL, which on a file:// page is a wasted load
  // and a broken-image glyph where the mark should be.
  if (logo.small) {
    $('gripLogo').src = logo.small;
    $('heroLogo').src = logo.small;
  }
  if (logo.large) $('orbLogo').src = logo.large;
}

/* ============================ shortcuts ================================= */

function renderShortcuts() {
  const presets = (appState && appState.presets) || [];
  const host = $('presetList');
  const empty = $('presetEmpty');

  host.replaceChildren();
  empty.classList.toggle('hidden', presets.length > 0);
  if (!presets.length) return;

  for (const preset of presets) {
    const chip = el('button', 'chip');
    chip.type = 'button';
    chip.dataset.busy = String(launching.has(preset.id));
    // The hover title carries the detail the chip has no room for — the working
    // directory, the model, the skills. describe() builds the same line the
    // desktop shortcut's tooltip uses, so the two agree.
    chip.title = preset.description || preset.label;

    /**
     * The hotkey, when there is one.
     *
     * Shown as the last chord rather than the whole accelerator: "Ctrl+Alt+1" does
     * not fit and the modifiers are the same on every preset, so the digit is the
     * part that identifies it.
     */
    if (preset.accelerator) {
      const parts = preset.accelerator.split('+');
      chip.appendChild(el('span', 'chip-key', parts[parts.length - 1]));
    }

    const text = el('div', 'chip-text');
    text.appendChild(el('div', 'chip-label', preset.label));
    if (preset.subtitle) text.appendChild(el('div', 'chip-sub', preset.subtitle));
    chip.appendChild(text);

    chip.addEventListener('click', () => launch(preset.id, chip));
    host.appendChild(chip);
  }
}

async function launch(id, chip) {
  // Guarded rather than debounced: the window it opens is the feedback, and a
  // second click before that appears would start a second session.
  if (launching.has(id)) return;
  launching.add(id);
  chip.dataset.busy = 'true';

  try {
    const res = await api.launchPreset(id);
    if (!res || !res.ok) {
      // No toast system in a widget — there is nowhere to put one that is not
      // covering the content. The failure goes in the hint line instead.
      showHint($('presetEmpty'), (res && res.reason) || 'That shortcut could not start.');
    }
  } catch (err) {
    showHint($('presetEmpty'), err.message);
  } finally {
    // Long enough to read as a press, short enough not to look stuck. The launch
    // itself has already returned by here; this is purely the visible state.
    setTimeout(() => {
      launching.delete(id);
      chip.dataset.busy = 'false';
    }, 900);
  }
}

/** Show a message in a hint line for a few seconds, then put the hint back. */
function showHint(node, message) {
  const was = node.textContent;
  const wasHidden = node.classList.contains('hidden');
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(showHint.timer);
  showHint.timer = setTimeout(() => {
    node.textContent = was;
    node.classList.toggle('hidden', wasHidden);
    measure();
  }, 5000);
  measure();
}

/* ============================== status ================================== */

/**
 * What each status means, in the fewest words that are still true.
 *
 * Deliberately not the tray's wording. The tray tooltip has one line for
 * everything; here the counts are on screen underneath, so the sentence says what
 * the *state* is and lets the numbers say how much.
 */
const STATUS_TEXT = {
  running: 'Protecting active sessions',
  waiting: 'Watching for sessions',
  paused: 'Paused — nothing is protected',
  attention: 'Something needs you',
  error: 'Error — see the log',
  unknown: 'Starting…',
};

/**
 * The same five states as a single word, for the hero.
 *
 * Beside a 34px mark there is room for one strong line, and the sentence above is
 * too long to be that line at 13.5px semibold. The detail moves to the second line,
 * which is where the counts already point — so the hero says *what*, and everything
 * under it says *how much*.
 */
const STATUS_WORD = {
  running: 'Protecting',
  waiting: 'Watching',
  paused: 'Paused',
  attention: 'Needs you',
  error: 'Error',
  unknown: 'Starting…',
};

function renderStatus() {
  const st = appState || {};
  const status = st.status || 'unknown';
  const summary = st.summary || {};
  const stats = st.stats || {};

  $('dot').dataset.status = status;

  /**
   * The sentence on the card, the word on the bar.
   *
   * Same element, because it is the same fact — but on one line beside three count
   * tiles the sentence is the thing that loses, and losing means an ellipsis through
   * the only word the widget exists to say ("Protecting active sessi…"). The bar gets
   * the word and lets the tiles say the rest; the full sentence stays as the title so
   * hovering still spells it out.
   */
  const line = $('statusLine');
  const bar = document.body.dataset.look === 'bar';
  line.textContent = (bar ? STATUS_WORD[status] : STATUS_TEXT[status]) || status;
  line.title = STATUS_TEXT[status] || status;
  line.style.color = status === 'error' ? 'var(--danger)' : status === 'attention' ? 'var(--warn)' : '';

  /**
   * The hero.
   *
   * The word says the state; the line under it says the one number that makes the
   * state concrete, and *which* number depends on the state — "2 sessions" is the
   * useful detail while running and a lie about a paused Lifeline, where the useful
   * detail is that the count does not matter.
   */
  $('heroStatus').textContent = STATUS_WORD[status] || status;
  $('heroStatus').style.color = line.style.color;
  $('heroSub').textContent = heroSub(status, summary, stats);

  /**
   * Three numbers, and these three because they answer the three questions the
   * request asked: is it running, is anything wrong, and is it doing its job.
   */
  const counts = [
    ['live', summary.alive || 0, 'Sessions', 'accent'],
    ['busy', summary.busy || 0, 'Working', 'ok'],
    ['saved', stats.recoveredToday || stats.today || 0, 'Saved', 'ok'],
  ];
  // A stalled or dead session is more worth the third slot than today's recovery
  // count, because it is the thing that will not fix itself.
  const bad = (summary.stalled || 0) + (summary.dead || 0);
  if (bad > 0) counts[2] = ['bad', bad, summary.dead ? 'Dead' : 'Stalled', 'warn'];

  const host = $('counts');
  host.replaceChildren();
  for (const [key, value, label, tone] of counts) {
    const cell = el('div', 'count');
    cell.dataset.tone = tone;
    cell.dataset.zero = String(!value);
    cell.dataset.key = key;
    cell.appendChild(el('div', 'count-value', value));
    cell.appendChild(el('div', 'count-label', label));
    host.appendChild(cell);
  }

  renderAlerts();
  renderOrb(status, counts);

  /**
   * The footer says when the last poll was, but only once it is old.
   *
   * "Checked 3 seconds ago" on a five-second poll is a line that is always there
   * and never says anything. A minute-old poll, on the other hand, means the
   * monitor has stopped — which is exactly what a status widget exists to reveal.
   */
  const age = st.lastPollAt ? Date.now() - st.lastPollAt : null;
  const foot = $('statusFoot');
  if (age !== null && age > 30_000) {
    foot.textContent = `Last checked ${relative(age)} ago — Lifeline may have stopped.`;
  } else if (!st.hooksInstalled) {
    // The one setup problem worth permanent space: without hooks the app is
    // running and protecting nothing, which no other number on the widget shows.
    foot.textContent = 'Recovery hooks are not installed — nothing is protected.';
  } else {
    foot.textContent = '';
  }
}

/** The one line of detail under the hero word. */
function heroSub(status, summary, stats) {
  if (status === 'paused') return 'Recovery is off';
  const bad = (summary.stalled || 0) + (summary.dead || 0);
  if (bad > 0) return `${bad} ${summary.dead ? 'not responding' : 'stalled'}`;
  const alive = summary.alive || 0;
  if (alive) return `${alive} session${alive === 1 ? '' : 's'} · ${summary.busy || 0} working`;
  const saved = stats.recoveredToday || 0;
  // Nothing running is the normal resting state, so it gets the fact that makes the
  // widget worth having rather than the word "none".
  return saved ? `${saved} recovered today` : 'Nothing to protect yet';
}

/**
 * The orb: the mark, and one number.
 *
 * Which number is whichever count matters most right now, taken from the same array
 * the card lays out — so the orb cannot disagree with the card about what is
 * important. The badge is what is wrong if anything is, and the live session count
 * otherwise.
 */
function renderOrb(status, counts) {
  const bad = counts.find(([key]) => key === 'bad');
  const [, value, label, tone] = bad || counts[0];
  const badge = $('orbValue');
  badge.textContent = String(value);
  badge.dataset.tone = bad ? tone : 'accent';
  badge.dataset.zero = String(!value);
  // The disc is the whole widget, so the only place a tooltip can go.
  $('bodyOrb').title = `${STATUS_TEXT[status] || status} — ${value} ${label.toLowerCase()}`;
}

function renderAlerts() {
  const items = (appState && appState.alerts) || [];
  const host = $('alerts');
  host.replaceChildren();
  host.classList.toggle('hidden', items.length === 0);

  for (const item of items) {
    const row = el('button', 'alert');
    row.type = 'button';
    row.dataset.tone = item.tone || 'info';
    row.appendChild(el('span', 'alert-text', item.text));
    if (item.at) row.appendChild(el('span', 'alert-when', relative(Date.now() - item.at)));
    // The widget has no room to explain an error, so it hands off to the window
    // that does. Named as a tab, not a URL.
    row.addEventListener('click', () => api.openMain('activity'));
    host.appendChild(row);
  }
}

/** Coarse relative time. A widget has no room for "1 hour and 12 minutes". */
function relative(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/* ============================ settings form ============================= */

/** Theme swatches, drawn from the theme's own panel colour so they preview it. */
const THEME_SWATCHES = [
  ['system', 'linear-gradient(135deg, #0f1117 50%, #f6f7fb 50%)', 'Match Windows'],
  ['dark', '#151823', 'Dark'],
  ['light', '#ffffff', 'Light'],
  ['midnight', '#080a12', 'Midnight'],
  ['slate', '#2a2f3b', 'Slate'],
  ['glass', 'linear-gradient(135deg, #ffffff59, #12161f8c)', 'Glass'],
];

const ACCENT_SWATCHES = [
  ['violet', '#7c5cff'],
  ['blue', '#3b82f6'],
  ['emerald', '#10b981'],
  ['amber', '#f59e0b'],
];

/**
 * The looks each widget offers, and what to call them.
 *
 * The orb is missing from the shortcuts widget on purpose: it is a mark and one
 * number, which is a whole status readout and no use at all for a list of buttons.
 * The same restriction is enforced in widgets.js, so a hand-edited config cannot
 * produce a shortcuts orb with nothing in it — this list is only what is *offered*.
 */
const LOOKS = {
  shortcuts: [
    ['card', 'Card', 'A stacked list of shortcuts'],
    ['bar', 'Bar', 'One strip, for the top of a screen'],
  ],
  status: [
    ['card', 'Card', 'The full readout'],
    ['bar', 'Bar', 'One strip, for the top of a screen'],
    ['orb', 'Orb', 'Just the mark and one number'],
  ],
};

function buildLooks() {
  const host = $('lookButtons');
  for (const [value, label, title] of LOOKS[api.id] || LOOKS.status) {
    const btn = el('button', 'look-btn');
    btn.type = 'button';
    btn.dataset.value = value;
    btn.title = title;
    const glyph = el('span', 'look-glyph');
    glyph.dataset.look = value;
    btn.appendChild(glyph);
    btn.appendChild(el('span', null, label));
    btn.addEventListener('click', () => patch({ look: value }));
    host.appendChild(btn);
  }
}

function buildSwatches() {
  const themes = $('themeSwatches');
  for (const [value, background, label] of THEME_SWATCHES) {
    const btn = el('button', 'swatch');
    btn.type = 'button';
    btn.dataset.value = value;
    btn.style.background = background;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', () => patch({ theme: value }));
    themes.appendChild(btn);
  }

  const accents = $('accentSwatches');
  for (const [value, colour] of ACCENT_SWATCHES) {
    const btn = el('button', 'swatch');
    btn.type = 'button';
    btn.dataset.value = value;
    btn.style.background = colour;
    btn.title = value;
    btn.setAttribute('aria-label', value);
    btn.addEventListener('click', () => patch({ accent: value }));
    accents.appendChild(btn);
  }
}

/** Reflect the live settings into the form, without firing its handlers. */
function syncSettingsForm() {
  if (!settings) return;
  for (const btn of document.querySelectorAll('#lookButtons .look-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.value === settings.look));
  }
  for (const btn of document.querySelectorAll('#themeSwatches .swatch')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.value === settings.theme));
  }
  for (const btn of document.querySelectorAll('#accentSwatches .swatch')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.value === settings.accent));
  }
  $('opacity').value = String(Math.round(settings.opacity * 100));
  $('width').value = String(settings.width);
  // The bar and the orb have a fixed width, so the slider would visibly do nothing.
  // Hidden rather than disabled: a greyed-out control still asks to be understood.
  $('widthRow').classList.toggle('hidden', settings.look !== 'card');
  $('onTop').checked = settings.alwaysOnTop;
  $('compact').checked = settings.compact;
  $('clickThrough').checked = settings.clickThrough;
  // Shown only while it is on: as a warning it is worth the space, as a
  // description of a checkbox nobody ticked it is not.
  $('clickThroughHint').classList.toggle('hidden', !settings.clickThrough || api.id !== 'status');
  $('btnSettings').dataset.on = String(settingsOpen);
}

/**
 * Write a settings change.
 *
 * Optimistically applied first, then sent. Main normalises and pushes the result
 * back, so a value it rejects corrects itself within a frame — but dragging the
 * opacity slider has to move the widget *now*, not after a round trip per step.
 */
function patch(next) {
  if (settings) applySettings({ ...settings, ...next });
  api.patch(next);
}

function bindSettingsForm() {
  $('btnSettings').addEventListener('click', () => {
    /**
     * The orb has nowhere to put a popover.
     *
     * It is 92px across and the panel needs about 210, and unlike the card it cannot
     * grow to fit one: its width is its shape. So the gear hands off to the main
     * Settings tab, which has every control the popover has — including the look
     * picker, which is how the user gets back out of the orb.
     */
    if (settings && settings.look === 'orb') {
      api.openMain('settings');
      return;
    }
    settingsOpen = !settingsOpen;
    $('settings').classList.toggle('hidden', !settingsOpen);
    $('btnSettings').dataset.on = String(settingsOpen);
    measure();
  });

  $('btnHide').addEventListener('click', () => api.hide());
  // The shortcuts widget goes to its own tab, where the presets are edited; the
  // status widget goes to the dashboard, which is the fuller version of itself.
  $('btnOpen').addEventListener('click', () => api.openMain(api.id === 'shortcuts' ? 'launchpad' : 'dashboard'));

  /**
   * Clicking the orb opens the dashboard.
   *
   * The orb has no room for the open button, and a widget that reports a problem
   * with no way to reach the explanation is a dead end. `dblclick` rather than
   * `click`, because the whole disc is the drag region: a single click is how the
   * user grabs it to move it, and opening a window every time they nudge it would
   * make it unmovable in practice.
   */
  $('bodyOrb').addEventListener('dblclick', () => api.openMain('dashboard'));

  // `input` rather than `change` for the sliders: the point of dragging one is
  // watching the widget follow.
  $('opacity').addEventListener('input', (e) => patch({ opacity: Number(e.target.value) / 100 }));
  $('width').addEventListener('input', (e) => patch({ width: Number(e.target.value) }));
  $('onTop').addEventListener('change', (e) => patch({ alwaysOnTop: e.target.checked }));
  $('compact').addEventListener('change', (e) => patch({ compact: e.target.checked }));
  $('clickThrough').addEventListener('change', (e) => patch({ clickThrough: e.target.checked }));

  /**
   * Escape closes the popover.
   *
   * The only keyboard shortcut a widget gets. It has no menu bar and it is not
   * focused most of the time, so anything more would be a global hotkey — which is
   * the Launchpad's job, not a widget's.
   */
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !settingsOpen) return;
    settingsOpen = false;
    $('settings').classList.add('hidden');
    $('btnSettings').dataset.on = 'false';
    measure();
  });
}

/* ============================== plumbing ================================ */

function render() {
  applyIdentity();
  if (api.id === 'shortcuts') renderShortcuts();
  else renderStatus();
  measure();
}

/**
 * Tell main how tall the content is.
 *
 * Rounded up, because a fractional layout height truncated to an integer window
 * height clips the last pixel of the border — which on a rounded panel is visible
 * as a flat edge.
 */
function measure() {
  const panel = $('panel');
  if (!panel) return;
  const height = Math.ceil(panel.getBoundingClientRect().height) + 2 * gutter();
  if (!height || height === sentHeight) return;
  sentHeight = height;
  api.setHeight(height);
}

/** The transparent margin around the panel, read from CSS rather than repeated. */
function gutter() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--gutter');
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 8;
}

/**
 * Re-measure whenever the content changes shape for a reason the renderer did not
 * cause — a font that finished loading, a label that wrapped to two lines at this
 * width. The explicit measure() calls cover the changes we know about; this covers
 * the ones we do not.
 */
const observer = new ResizeObserver(() => measure());

async function start() {
  buildLooks();
  buildSwatches();
  bindSettingsForm();

  api.onSettings((next) => applySettings(next));
  api.onState((next) => {
    appState = next;
    render();
  });

  /**
   * Ask for the current values rather than waiting to be pushed.
   *
   * Main cannot push before the preload has run, so a widget that only listened
   * would show its default theme and an empty body until the next poll — up to
   * five seconds of a visibly wrong window. This is also what tells main the
   * renderer is alive, which is what reveals the window.
   */
  const first = await api.ready();
  if (first) {
    if (first.settings) applySettings(first.settings);
    if (first.state) {
      appState = first.state;
      render();
    }
  }
  observer.observe($('panel'));
  measure();
}

start();
