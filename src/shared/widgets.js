'use strict';
/**
 * Desktop widgets: the small always-there windows that sit outside the main app.
 *
 * There are two — a shortcuts panel with the Launchpad presets in it, and a status
 * readout — and they share everything except their contents: both can be turned on
 * and off, dragged anywhere, themed, and made more or less opaque. This file owns
 * that shared shape: validating the saved settings, and deciding where a widget is
 * actually allowed to appear.
 *
 * ## Why placement is the interesting part
 *
 * A widget remembers where it was put, and a remembered position is a promise the
 * display layout can break. Unplug the second monitor and the saved coordinates
 * point into space; Windows will accept the window there quite happily and the
 * user has a widget they cannot see, cannot drag, and — because it has no taskbar
 * button — cannot alt-tab to. Turning it off and on again would restore the same
 * bad position. So a saved position is treated as a *request*: `placeOn` checks it
 * against the displays that exist right now and falls back to a corner of the
 * primary work area when it does not fit.
 *
 * The check is against `workArea` rather than `bounds`, so a widget cannot be
 * parked underneath the taskbar, and it demands a real overlap rather than a
 * containing display: dragging a widget half off the edge of a monitor is normal,
 * and snapping it back would be more annoying than leaving it. What is refused is
 * a position with nothing visible on any screen.
 *
 * Every function here is pure and takes the display list as an argument, because
 * the interesting cases — a monitor that vanished, a negative-origin display to
 * the left of the primary, a position saved at a resolution nobody is running any
 * more — are ones a test has to be able to construct.
 */

/** The two widgets. Ids are stable: they key config and window bookkeeping. */
const WIDGET_IDS = ['shortcuts', 'status'];

/**
 * Themes a widget can wear.
 *
 * More than the main window's dark/light pair, because a widget sits on the
 * user's wallpaper rather than in an app frame — the choice is about what reads
 * against that wallpaper, which is not a question the app can answer. 'system'
 * follows the OS so a widget matches everything else by default.
 */
const WIDGET_THEMES = ['system', 'dark', 'light', 'midnight', 'slate', 'glass'];

/** Accents, the same set the main window offers so the two agree. */
const WIDGET_ACCENTS = ['violet', 'blue', 'emerald', 'amber'];

/**
 * Shapes a widget can take — a different *look*, not a different colour.
 *
 * A theme changes what a widget is made of; a look changes what it is. The three
 * are answers to genuinely different questions:
 *
 *   - `card` — the full readout. The status, the numbers, and anything wrong.
 *   - `bar` — one horizontal strip. For along the top of a screen, where a tall
 *     panel would cover work but a 40px line would not.
 *   - `orb` — the logo and a single number. Nearly nothing, for someone who wants
 *     to know it is alive and does not want a dashboard on their wallpaper.
 *
 * Sizing is per look rather than one shared width, because the same 260px that
 * suits a card makes an orb a wide empty rectangle — see `widthFor`.
 */
const WIDGET_LOOKS = ['card', 'bar', 'orb'];

/**
 * Which looks each widget actually offers.
 *
 * The orb is a logo and one number, which is a complete readout for a status and
 * nothing at all for a list of buttons: a disc holding three shortcuts would either
 * hide two of them or stop being a disc. So the shortcuts widget gets the two looks
 * that can hold a list, and the restriction lives here rather than only in the UI —
 * a hand-edited config should not be able to produce a window with no way to use it.
 */
const LOOKS_BY_WIDGET = {
  shortcuts: ['card', 'bar'],
  status: ['card', 'bar', 'orb'],
};

/** The looks a given widget offers. An unknown id gets all of them. */
function looksFor(id) {
  return LOOKS_BY_WIDGET[id] || WIDGET_LOOKS;
}

/** How wide a widget may be, in px. Narrow enough to sit beside real work. */
const MIN_WIDTH = 180;
const MAX_WIDTH = 520;

/** Opacity floor. Below this a widget is invisible, which is what "off" is for. */
const MIN_OPACITY = 0.35;

/** Defaults for one widget, merged over whatever config holds. */
const WIDGET_DEFAULTS = {
  /**
   * Off by default. A window that appears on the desktop uninvited is the kind of
   * thing people uninstall an app over, and both widgets are additions to a UI
   * that already works without them.
   */
  enabled: false,
  /** null means "put it in the default corner", which is what a first run wants. */
  x: null,
  y: null,
  width: 260,
  theme: 'system',
  accent: 'violet',
  /**
   * The full card by default: it is the only look that explains itself. An orb is
   * lovely once you know what it means and opaque before that.
   */
  look: 'card',
  opacity: 1,
  /**
   * Stay above other windows.
   *
   * On by default because a widget that hides behind the editor is not a widget —
   * the whole request was for something always available. Off is still offered:
   * always-on-top is exactly wrong when screen-sharing a full-screen app.
   */
  alwaysOnTop: true,
  /**
   * Ignore the mouse entirely, so clicks land on whatever is underneath.
   *
   * Only meaningful for the status widget, which is a readout rather than a
   * control panel. Kept in the shared shape anyway: the setting is per widget, and
   * one of them ignoring it is cheaper than two nearly identical schemas.
   */
  clickThrough: false,
  /** Compact hides the labels and shows only what a glance needs. */
  compact: false,
};

/** Clamp a number into a range, with a fallback for anything unnumeric. */
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * A finite number, or null.
 *
 * `Number()` is not enough on its own here: `Number(null)` is 0 and `Number('')`
 * is 0, both finite, so a coordinate that was never set would read as a real
 * position at the very top-left of the screen.
 */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise one widget's settings.
 *
 * Unknown values fall back to the default rather than being kept: these end up as
 * a CSS attribute selector and a `setOpacity` call, and a theme name that matches
 * no stylesheet produces an unstyled window that looks broken.
 *
 * Position is deliberately *not* validated here — a coordinate is only wrong
 * relative to a display layout, which this function does not know. That is
 * `placeOn`'s job, and keeping the two separate is what lets a position survive a
 * monitor being temporarily unplugged instead of being rewritten to a corner the
 * moment config is read.
 *
 * `id` is optional and only narrows the allowed looks. Optional rather than
 * required because every other field is genuinely shared, and demanding an id to
 * validate an opacity would make the common case worse to serve the one field that
 * differs.
 */
function normaliseWidget(input, id = null) {
  const raw = input && typeof input === 'object' ? input : {};
  const d = WIDGET_DEFAULTS;

  const x = finiteOrNull(raw.x);
  const y = finiteOrNull(raw.y);
  const placed = x !== null && y !== null;

  return {
    enabled: raw.enabled === true,
    // Both or neither: half a coordinate is not a position, and treating a missing
    // y as 0 would pin the widget to the top of the screen for no stated reason.
    x: placed ? Math.round(x) : null,
    y: placed ? Math.round(y) : null,
    width: Math.round(clampNumber(raw.width, MIN_WIDTH, MAX_WIDTH, d.width)),
    theme: WIDGET_THEMES.includes(raw.theme) ? raw.theme : d.theme,
    accent: WIDGET_ACCENTS.includes(raw.accent) ? raw.accent : d.accent,
    look: looksFor(id).includes(raw.look) ? raw.look : d.look,
    opacity: clampNumber(raw.opacity, MIN_OPACITY, 1, d.opacity),
    alwaysOnTop: raw.alwaysOnTop !== false,
    clickThrough: raw.clickThrough === true,
    compact: raw.compact === true,
  };
}

/** Every widget's settings, whatever config happens to contain. */
function listWidgets(config) {
  const raw = (config && config.widgets) || {};
  const out = {};
  for (const id of WIDGET_IDS) out[id] = normaliseWidget(raw[id], id);
  return out;
}

/** One widget's settings. Unknown ids get defaults rather than an error. */
function widgetSettings(config, id) {
  if (!WIDGET_IDS.includes(id)) return normaliseWidget(null);
  return listWidgets(config)[id];
}

/**
 * Fixed widths for the looks that have one.
 *
 * An orb is a disc: its width is its height, and letting the user set it to 400
 * would produce a 400px circle covering a quarter of the screen. A bar is the
 * opposite — it wants to be long, and 180px of bar fits nothing. The card is the
 * only look where "how wide" is a real preference, so it is the only one that keeps
 * the slider.
 */
const LOOK_WIDTHS = { orb: 92, bar: 480 };

/**
 * The width a widget should actually be, given its look.
 *
 * Separate from `normaliseWidget` on purpose: the *saved* width is the card width
 * and stays whatever the user chose, so switching to an orb and back does not lose
 * it. This is the width the window gets.
 */
function widthFor(settings) {
  const fixed = LOOK_WIDTHS[settings && settings.look];
  if (!fixed) return settings.width;
  /**
   * Bounded by MAX_WIDTH but *not* by MIN_WIDTH.
   *
   * MIN_WIDTH is a floor on what the user may drag the slider to, and it exists so
   * a card cannot be made too narrow to read. An orb has no text in it to squeeze,
   * so applying that floor here would inflate a 92px disc to 180px — the bug this
   * comment replaces. The absolute floor is small enough to still be grabbable.
   */
  return Math.min(MAX_WIDTH, Math.max(64, fixed));
}

/**
 * How much of a rectangle is visible on a set of displays.
 *
 * Summed across displays rather than taken from the best one, because a widget
 * straddling two monitors is fully visible even though neither contains it. Areas
 * cannot double-count: display work areas do not overlap.
 */
function visibleArea(rect, displays) {
  let total = 0;
  for (const d of displays || []) {
    const wa = (d && d.workArea) || null;
    if (!wa) continue;
    const w = Math.min(rect.x + rect.width, wa.x + wa.width) - Math.max(rect.x, wa.x);
    const h = Math.min(rect.y + rect.height, wa.y + wa.height) - Math.max(rect.y, wa.y);
    if (w > 0 && h > 0) total += w * h;
  }
  return total;
}

/**
 * Where a widget should actually open.
 *
 * Returns `{x, y, reason}`. `reason` is `'saved'` when the remembered position was
 * usable, `'clamped'` when it existed but had to be pulled back onto a screen, and
 * `'default'` when there was nothing to honour.
 *
 * The rule is a *minimum visible fraction* rather than full containment. Hanging a
 * widget off the right edge of a monitor is a thing people do on purpose, and
 * snapping it flush would be the app overruling a deliberate choice; a widget with
 * a sliver showing, or none at all, is unusable and gets moved. A quarter of it is
 * the line — enough to grab and drag back.
 */
function placeOn(settings, displays, { corner = 'top-right', margin = 24, minVisible = 0.25 } = {}) {
  const list = (displays || []).filter((d) => d && d.workArea);
  const primary = list.find((d) => d.primary) || list[0] || null;
  const size = { width: settings.width || WIDGET_DEFAULTS.width, height: settings.height || 200 };

  if (!primary) {
    // No displays at all is not a real state, but returning the saved position
    // unchanged is better than returning NaN.
    return { x: settings.x || 0, y: settings.y || 0, reason: settings.x == null ? 'default' : 'saved' };
  }

  if (settings.x != null && settings.y != null) {
    const rect = { x: settings.x, y: settings.y, width: size.width, height: size.height };
    const fraction = visibleArea(rect, list) / (size.width * size.height);
    if (fraction >= minVisible) return { x: rect.x, y: rect.y, reason: 'saved' };

    /**
     * It was somewhere once. Pull it onto the nearest display's work area rather
     * than jumping it to a corner: the user's arrangement is partly preserved, and
     * a widget that reappears near where it was left is easier to recognise.
     *
     * "Nearest" is by centre distance, not by overlap. Overlap is the obvious
     * measure and it is useless here: this branch only runs when barely any of the
     * widget is on screen, so the overlap with every display is usually zero and
     * comparing zeroes just returns whichever was first in the list.
     */
    const centre = { x: rect.x + size.width / 2, y: rect.y + size.height / 2 };
    const distance = (d) => {
      const wa = d.workArea;
      const dx = Math.max(wa.x - centre.x, 0, centre.x - (wa.x + wa.width));
      const dy = Math.max(wa.y - centre.y, 0, centre.y - (wa.y + wa.height));
      return dx * dx + dy * dy;
    };
    const target = list.reduce((best, d) => (distance(d) < distance(best) ? d : best), primary);
    const wa = target.workArea;
    return {
      x: Math.round(Math.min(Math.max(rect.x, wa.x + margin), wa.x + wa.width - size.width - margin)),
      y: Math.round(Math.min(Math.max(rect.y, wa.y + margin), wa.y + wa.height - size.height - margin)),
      reason: 'clamped',
    };
  }

  const wa = primary.workArea;
  const right = corner.endsWith('right');
  const bottom = corner.startsWith('bottom');
  return {
    x: Math.round(right ? wa.x + wa.width - size.width - margin : wa.x + margin),
    y: Math.round(bottom ? wa.y + wa.height - size.height - margin : wa.y + margin),
    reason: 'default',
  };
}

/**
 * Merge a settings patch into config's widget branch, returning the new branch.
 *
 * Pure, and it normalises the result, so a renderer cannot write a theme or an
 * opacity that the window layer would then have to defend itself against.
 */
function patchWidget(config, id, patch) {
  if (!WIDGET_IDS.includes(id)) return { ok: false, reason: 'There is no widget by that name.' };
  const all = listWidgets(config);
  all[id] = normaliseWidget({ ...all[id], ...(patch && typeof patch === 'object' ? patch : {}) }, id);
  return { ok: true, widgets: all, settings: all[id] };
}

module.exports = {
  WIDGET_IDS,
  WIDGET_THEMES,
  WIDGET_ACCENTS,
  WIDGET_LOOKS,
  LOOKS_BY_WIDGET,
  WIDGET_DEFAULTS,
  MIN_WIDTH,
  MAX_WIDTH,
  MIN_OPACITY,
  looksFor,
  normaliseWidget,
  listWidgets,
  widgetSettings,
  widthFor,
  visibleArea,
  placeOn,
  patchWidget,
};
