'use strict';
/**
 * Desktop widget settings and placement.
 *
 * The placement tests are the point of this file. A widget has no taskbar button
 * and no alt-tab entry, so a window opened at coordinates that are no longer on any
 * screen is not merely misplaced — it is unreachable, and toggling it off and on
 * restores the same bad position. That makes "the second monitor was unplugged" a
 * failure the app has to survive rather than an edge case, and it is a failure that
 * only reproduces with a display layout a test can construct.
 *
 * Everything here is pure. No window is created and no config is written.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const widgets = require('../../src/shared/widgets');

/** A display list shaped like Electron's `screen.getAllDisplays()`. */
function display(x, y, width, height, { primary = false, taskbar = 0 } = {}) {
  return {
    primary,
    bounds: { x, y, width, height },
    // The taskbar is what makes workArea differ from bounds, and a widget parked
    // under it is invisible, so the two are kept distinct throughout.
    workArea: { x, y, width, height: height - taskbar },
  };
}

/** One 1920x1080 primary with a 40px taskbar. The common case. */
const SINGLE = [display(0, 0, 1920, 1080, { primary: true, taskbar: 40 })];

/** A second monitor to the *left*, so its origin is negative — as Windows does. */
const DUAL_LEFT = [display(0, 0, 1920, 1080, { primary: true, taskbar: 40 }), display(-1920, 0, 1920, 1080)];

/* ============================== normaliseWidget ============================== */

test('a widget is off until it is asked for', () => {
  // A window appearing on someone's desktop uninvited is the kind of thing an app
  // gets uninstalled over.
  assert.equal(widgets.normaliseWidget(null).enabled, false);
  assert.equal(widgets.normaliseWidget({}).enabled, false);
  // Only a real boolean turns it on — a truthy string from a hand-edited config
  // should not.
  assert.equal(widgets.normaliseWidget({ enabled: 'yes' }).enabled, false);
  assert.equal(widgets.normaliseWidget({ enabled: 1 }).enabled, false);
  assert.equal(widgets.normaliseWidget({ enabled: true }).enabled, true);
});

test('an unknown theme or accent falls back rather than producing an unstyled window', () => {
  // These become an attribute selector. A name matching no stylesheet rule is a
  // widget that renders with no colours at all, which reads as a broken app.
  assert.equal(widgets.normaliseWidget({ theme: 'hot-pink' }).theme, 'system');
  assert.equal(widgets.normaliseWidget({ theme: null }).theme, 'system');
  assert.equal(widgets.normaliseWidget({ accent: 'chartreuse' }).accent, 'violet');
  for (const theme of widgets.WIDGET_THEMES) {
    assert.equal(widgets.normaliseWidget({ theme }).theme, theme);
  }
  for (const accent of widgets.WIDGET_ACCENTS) {
    assert.equal(widgets.normaliseWidget({ accent }).accent, accent);
  }
});

test('opacity has a floor, because invisible is what disabling is for', () => {
  assert.equal(widgets.normaliseWidget({ opacity: 0 }).opacity, widgets.MIN_OPACITY);
  assert.equal(widgets.normaliseWidget({ opacity: -5 }).opacity, widgets.MIN_OPACITY);
  assert.equal(widgets.normaliseWidget({ opacity: 0.6 }).opacity, 0.6);
  assert.equal(widgets.normaliseWidget({ opacity: 4 }).opacity, 1);
  assert.equal(widgets.normaliseWidget({ opacity: 'half' }).opacity, 1);
});

test('width is clamped to a range a widget can usefully be', () => {
  assert.equal(widgets.normaliseWidget({ width: 10 }).width, widgets.MIN_WIDTH);
  assert.equal(widgets.normaliseWidget({ width: 9000 }).width, widgets.MAX_WIDTH);
  assert.equal(widgets.normaliseWidget({ width: 300.7 }).width, 301);
  assert.equal(widgets.normaliseWidget({ width: NaN }).width, widgets.WIDGET_DEFAULTS.width);
  assert.equal(widgets.normaliseWidget({ width: Infinity }).width, widgets.WIDGET_DEFAULTS.width);
});

test('always-on-top is on unless explicitly turned off', () => {
  // A widget that hides behind the editor is not a widget. But the setting exists,
  // because always-on-top is exactly wrong while screen-sharing.
  assert.equal(widgets.normaliseWidget({}).alwaysOnTop, true);
  assert.equal(widgets.normaliseWidget({ alwaysOnTop: undefined }).alwaysOnTop, true);
  assert.equal(widgets.normaliseWidget({ alwaysOnTop: false }).alwaysOnTop, false);
});

test('half a coordinate is not a position', () => {
  // Treating a missing y as 0 would pin the widget to the top of the screen for
  // no reason the user could explain.
  assert.equal(widgets.normaliseWidget({ x: 400 }).x, null);
  assert.equal(widgets.normaliseWidget({ y: 400 }).x, null);
  assert.equal(widgets.normaliseWidget({ x: 400, y: null }).y, null);
  assert.equal(widgets.normaliseWidget({ x: 'left', y: 4 }).x, null);

  const both = widgets.normaliseWidget({ x: 400.4, y: -12.8 });
  assert.equal(both.x, 400);
  assert.equal(both.y, -13);
});

test('a negative position is kept, because a monitor can sit left of the primary', () => {
  // Windows gives a display to the left of the primary a negative origin. Rejecting
  // negatives would make the left-hand monitor unusable for widgets.
  const s = widgets.normaliseWidget({ x: -1800, y: 40 });
  assert.equal(s.x, -1800);
  assert.equal(s.y, 40);
});

test('unknown fields are dropped rather than reaching the window layer', () => {
  const s = widgets.normaliseWidget({ enabled: true, frame: true, webPreferences: { nodeIntegration: true } });
  assert.deepEqual(
    Object.keys(s).sort(),
    ['accent', 'alwaysOnTop', 'clickThrough', 'compact', 'enabled', 'look', 'opacity', 'theme', 'width', 'x', 'y']
  );
});

/* ================================= looks ================================= */

test('an unknown look falls back to the card, which is the one that explains itself', () => {
  assert.equal(widgets.normaliseWidget({}).look, 'card');
  assert.equal(widgets.normaliseWidget({ look: 'hexagon' }).look, 'card');
  assert.equal(widgets.normaliseWidget({ look: null }).look, 'card');
  for (const look of widgets.WIDGET_LOOKS) {
    assert.equal(widgets.normaliseWidget({ look }, 'status').look, look);
  }
});

test('the shortcuts widget cannot be an orb, even from a hand-edited config', () => {
  /**
   * The orb is the mark and one number, which is a complete status readout and no
   * use at all for a list of buttons: a 92px disc holding three shortcuts would
   * either hide two of them or stop being a disc. The UI does not offer it, but the
   * restriction has to live in the model too — otherwise editing config.json by hand
   * produces a widget with no way to use it and, in the orb's case, no popover to
   * change it back from.
   */
  assert.equal(widgets.normaliseWidget({ look: 'orb' }, 'shortcuts').look, 'card');
  assert.equal(widgets.normaliseWidget({ look: 'bar' }, 'shortcuts').look, 'bar');
  assert.equal(widgets.normaliseWidget({ look: 'orb' }, 'status').look, 'orb');

  // And through the paths the app actually uses, not only the raw normaliser.
  const cfg = { widgets: { shortcuts: { look: 'orb' }, status: { look: 'orb' } } };
  assert.equal(widgets.listWidgets(cfg).shortcuts.look, 'card');
  assert.equal(widgets.listWidgets(cfg).status.look, 'orb');
  assert.equal(widgets.patchWidget({}, 'shortcuts', { look: 'orb' }).settings.look, 'card');
});

test('looksFor answers for both widgets and does not throw on a stranger', () => {
  assert.deepEqual(widgets.looksFor('shortcuts'), ['card', 'bar']);
  assert.deepEqual(widgets.looksFor('status'), ['card', 'bar', 'orb']);
  // An unknown id gets everything rather than nothing: an empty list would mean no
  // look validates and every widget silently became a card.
  assert.deepEqual(widgets.looksFor('not-a-widget'), widgets.WIDGET_LOOKS);
});

test('the fixed-width looks ignore the saved width, and the card keeps it', () => {
  assert.equal(widgets.widthFor({ look: 'card', width: 300 }), 300);
  // Not 180. MIN_WIDTH is a floor on what the slider may reach so a *card* stays
  // readable; applying it to an orb would inflate a 92px disc to a 180px one.
  assert.ok(widgets.widthFor({ look: 'orb', width: 500 }) < widgets.MIN_WIDTH);
  // The bar's own constant, not the saved 180 — a 180px bar fits nothing on one line.
  assert.ok(widgets.widthFor({ look: 'bar', width: 180 }) > 400);
  // Still bounded above: a look with a silly constant cannot produce a window wider
  // than the screen, which would have no frame to grab.
  assert.ok(widgets.widthFor({ look: 'bar', width: 9000 }) <= widgets.MAX_WIDTH);
});

test('switching look and back does not lose the chosen card width', () => {
  /**
   * The saved width is the *card* width, always. `widthFor` decides what the window
   * gets. Collapsing the two — writing 92 into config when the user picks the orb —
   * would silently discard a setting they chose, and there would be nothing to
   * restore when they switched back.
   */
  let cfg = {};
  cfg.widgets = widgets.patchWidget(cfg, 'status', { width: 380 }).widgets;
  cfg.widgets = widgets.patchWidget(cfg, 'status', { look: 'orb' }).widgets;
  assert.equal(cfg.widgets.status.width, 380);
  assert.ok(widgets.widthFor(cfg.widgets.status) < 180);

  cfg.widgets = widgets.patchWidget(cfg, 'status', { look: 'card' }).widgets;
  assert.equal(widgets.widthFor(cfg.widgets.status), 380);
});

test('placement uses the look’s real width, so an orb is not placed as a card', () => {
  /**
   * `placeOn` takes the size it is given, which is why widget-windows passes
   * `widthFor(settings)` rather than `settings.width`. Placing a 92px orb using the
   * card's 520 would push it 428px further left than the corner it belongs in — and
   * on the clamping path it would be pulled onto a screen it already fitted on.
   */
  const displays = [{ primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  const settings = widgets.normaliseWidget({ look: 'orb', width: 520 }, 'status');
  const asCard = widgets.placeOn({ ...settings, height: 92 }, displays);
  const asOrb = widgets.placeOn({ ...settings, width: widgets.widthFor(settings), height: 92 }, displays);
  assert.notEqual(asCard.x, asOrb.x);
  assert.equal(asOrb.x, 1920 - widgets.widthFor(settings) - 24);
});

/* ============================== listWidgets ============================== */

test('both widgets always have settings, whatever config holds', () => {
  for (const cfg of [null, {}, { widgets: null }, { widgets: 'nope' }, { widgets: { shortcuts: 'nope' } }]) {
    const all = widgets.listWidgets(cfg);
    assert.deepEqual(Object.keys(all).sort(), ['shortcuts', 'status']);
    for (const id of widgets.WIDGET_IDS) assert.equal(all[id].enabled, false);
  }
});

test('a widget name that does not exist gets defaults rather than throwing', () => {
  assert.equal(widgets.widgetSettings({}, 'not-a-widget').enabled, false);
  assert.equal(widgets.widgetSettings({ widgets: { shortcuts: { enabled: true } } }, 'shortcuts').enabled, true);
  assert.equal(widgets.widgetSettings({ widgets: { shortcuts: { enabled: true } } }, 'status').enabled, false);
});

/* ============================== visibleArea ============================== */

test('area is summed across displays, so straddling two still counts as visible', () => {
  // Neither monitor contains this rectangle, but all of it is on screen.
  const rect = { x: -100, y: 200, width: 200, height: 100 };
  assert.equal(widgets.visibleArea(rect, DUAL_LEFT), 200 * 100);
});

test('nothing on any display is zero, not a negative overlap', () => {
  assert.equal(widgets.visibleArea({ x: 5000, y: 5000, width: 200, height: 100 }, SINGLE), 0);
  assert.equal(widgets.visibleArea({ x: 0, y: 0, width: 100, height: 100 }, []), 0);
  assert.equal(widgets.visibleArea({ x: 0, y: 0, width: 100, height: 100 }, [{ }, null]), 0);
});

test('the area under the taskbar does not count as visible', () => {
  // workArea, not bounds: a widget parked under the taskbar cannot be seen or
  // grabbed, which is the same problem as being off-screen.
  const rect = { x: 100, y: 1040, width: 200, height: 40 };
  assert.equal(widgets.visibleArea(rect, SINGLE), 0);
});

/* ============================== placeOn ============================== */

test('a saved position that is still on screen is honoured exactly', () => {
  const s = { ...widgets.normaliseWidget({ x: 300, y: 300, width: 260 }), height: 200 };
  const at = widgets.placeOn(s, SINGLE);
  assert.deepEqual(at, { x: 300, y: 300, reason: 'saved' });
});

test('a position on a monitor that has been unplugged is pulled back on screen', () => {
  // The failure this whole function exists for: a widget has no taskbar button and
  // no alt-tab entry, so off-screen means gone — and toggling it off and on would
  // restore the same coordinates.
  const s = { ...widgets.normaliseWidget({ x: -1700, y: 300, width: 260 }), height: 200 };
  assert.equal(widgets.placeOn(s, DUAL_LEFT).reason, 'saved'); // fine while it exists

  const at = widgets.placeOn(s, SINGLE);
  assert.equal(at.reason, 'clamped');
  // And what came back is genuinely reachable.
  assert.ok(widgets.visibleArea({ x: at.x, y: at.y, width: 260, height: 200 }, SINGLE) > 0);
  assert.ok(at.x >= 0 && at.y >= 0);
  assert.ok(at.x + 260 <= 1920);
  assert.ok(at.y + 200 <= 1040);
});

test('a widget hanging deliberately off an edge is left where it was put', () => {
  // People do this on purpose. Snapping it flush would be the app overruling a
  // choice the user made with the mouse.
  const s = { ...widgets.normaliseWidget({ x: 1800, y: 300, width: 260 }), height: 200 };
  const at = widgets.placeOn(s, SINGLE);
  assert.equal(at.reason, 'saved');
  assert.equal(at.x, 1800);
});

test('a widget with only a sliver showing is moved, since it cannot be grabbed', () => {
  const s = { ...widgets.normaliseWidget({ x: 1910, y: 300, width: 260 }), height: 200 };
  assert.equal(widgets.placeOn(s, SINGLE).reason, 'clamped');
});

test('the fallback corner is inside the work area, clear of the taskbar', () => {
  const s = { ...widgets.normaliseWidget({ width: 260 }), height: 200 };

  const topRight = widgets.placeOn(s, SINGLE);
  assert.equal(topRight.reason, 'default');
  assert.equal(topRight.x, 1920 - 260 - 24);
  assert.equal(topRight.y, 24);

  // The bottom corner has to respect workArea's shortened height or the widget
  // opens behind the taskbar.
  const bottomRight = widgets.placeOn(s, SINGLE, { corner: 'bottom-right' });
  assert.equal(bottomRight.y, 1040 - 200 - 24);
  assert.equal(widgets.placeOn(s, SINGLE, { corner: 'top-left' }).x, 24);
});

test('the fallback uses the primary display, not whichever came back first', () => {
  // getAllDisplays() does not promise an order, and defaulting a widget onto the
  // secondary monitor would put it where the user is not looking.
  const secondaryFirst = [display(-1920, 0, 1920, 1080), display(0, 0, 1920, 1080, { primary: true, taskbar: 40 })];
  const s = { ...widgets.normaliseWidget({ width: 260 }), height: 200 };
  const at = widgets.placeOn(s, secondaryFirst);
  assert.equal(at.x, 1920 - 260 - 24);
  assert.ok(at.x > 0);
});

test('a clamped widget lands on the display it was nearest, not always the primary', () => {
  // Its position is partly preserved, so it reappears somewhere recognisable
  // rather than jumping across the desk to a corner.
  const s = { ...widgets.normaliseWidget({ x: -1900, y: 2000, width: 260 }), height: 200 };
  const at = widgets.placeOn(s, DUAL_LEFT);
  assert.equal(at.reason, 'clamped');
  // Still on the left-hand monitor, pulled up into its work area.
  assert.ok(at.x < 0);
  assert.ok(widgets.visibleArea({ x: at.x, y: at.y, width: 260, height: 200 }, DUAL_LEFT) > 0);
});

test('no displays at all returns a usable number rather than NaN', () => {
  const saved = { ...widgets.normaliseWidget({ x: 10, y: 20, width: 260 }), height: 200 };
  assert.deepEqual(widgets.placeOn(saved, []), { x: 10, y: 20, reason: 'saved' });
  const fresh = { ...widgets.normaliseWidget({ width: 260 }), height: 200 };
  const at = widgets.placeOn(fresh, null);
  assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y));
});

test('a display list with no workArea is ignored rather than trusted', () => {
  const broken = [{ primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
  const s = { ...widgets.normaliseWidget({ width: 260 }), height: 200 };
  const at = widgets.placeOn(s, broken);
  assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y));
});

/* ============================== patchWidget ============================== */

test('a patch merges over the current settings and leaves the other widget alone', () => {
  const cfg = { widgets: { shortcuts: { enabled: true, x: 100, y: 100, theme: 'dark' } } };
  const res = widgets.patchWidget(cfg, 'shortcuts', { theme: 'glass' });
  assert.equal(res.ok, true);
  assert.equal(res.widgets.shortcuts.theme, 'glass');
  // The drag position survives a theme change — it is not part of the patch.
  assert.equal(res.widgets.shortcuts.x, 100);
  assert.equal(res.widgets.shortcuts.enabled, true);
  assert.equal(res.widgets.status.enabled, false);
});

test('a patch is normalised, so the window layer never sees a bad value', () => {
  const res = widgets.patchWidget({}, 'status', { theme: '"><script>', opacity: 99, width: -3 });
  assert.equal(res.widgets.status.theme, 'system');
  assert.equal(res.widgets.status.opacity, 1);
  assert.equal(res.widgets.status.width, widgets.MIN_WIDTH);
});

test('patching a widget that does not exist is refused with a reason', () => {
  const res = widgets.patchWidget({}, 'clippy', { enabled: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no widget/i);
});

test('a patch does not mutate the config it was given', () => {
  const cfg = { widgets: { shortcuts: { enabled: true, theme: 'dark' } } };
  widgets.patchWidget(cfg, 'shortcuts', { theme: 'glass', enabled: false });
  assert.equal(cfg.widgets.shortcuts.theme, 'dark');
  assert.equal(cfg.widgets.shortcuts.enabled, true);
});
