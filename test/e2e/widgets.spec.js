'use strict';
/**
 * The two desktop widgets, driven as real windows.
 *
 * A widget is the one part of this app that can put itself somewhere the user
 * cannot reach. It has no taskbar button and no alt-tab entry, so a window opened
 * at coordinates that are off every display is not merely misplaced — it is gone,
 * and turning it off and on again restores the same bad position. Most of what
 * these tests check is that the window is *reachable*: on a display, inside the
 * work area, and closable by something other than itself.
 *
 * The window properties that make a widget behave like furniture rather than a
 * stray dialog are asserted through `app.evaluate`, against the real BrowserWindow.
 * They cannot be checked from the page: `skipTaskbar` and `frame` are not visible
 * to a renderer, and they are exactly the settings whose absence is invisible in a
 * screenshot and obvious the moment somebody presses alt-tab.
 *
 * Nothing here spawns a terminal — `LIFELINE_NO_SPAWN=1`, as in history.spec.js —
 * so a test that clicks a shortcut on the widget asserts the launch spec on disk
 * rather than starting a real session against the user's work.
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fx = require('./fixtures');

const LAUNCH_PREFIX = 'claude-lifeline-launch';

/** The debounce widget-windows.js uses before writing a moved position. */
const SAVE_DEBOUNCE_MS = 600;

let ctx = null;

test.afterEach(async () => {
  await fx.close(ctx);
  ctx = null;
});

function widgetSandbox(label) {
  const sandbox = fx.makeSandbox(label);
  sandbox.desktop = path.join(sandbox.root, 'desktop');
  fs.mkdirSync(sandbox.desktop, { recursive: true });
  return sandbox;
}

function launchApp(sandbox) {
  return fx.launch(sandbox, { LIFELINE_NO_SPAWN: '1', LIFELINE_DESKTOP_DIR: sandbox.desktop });
}

/** Three presets, enough for the widget to have something to lay out. */
function presets() {
  return [
    { id: 'aaaaaa', label: 'Lifeline dev', cwd: 'C:/work/lifeline', model: 'opus', accelerator: 'Control+Alt+1' },
    { id: 'bbbbbb', label: 'Notes triage', cwd: 'C:/work/notes', skills: ['triage'] },
    // `prePrompt`, which is what launchpad.js stores and launcher.js reads. The
    // field name matters: a stray `prompt` key is dropped by normalisation, and the
    // preset would launch with no opening message and nothing to say it had not.
    { id: 'cccccc', label: 'Nightly sweep', cwd: 'C:/work/sweep', prePrompt: 'Run the sweep.\nReport at the end.' },
  ];
}

/**
 * The widget page, once its renderer has drawn.
 *
 * Found by its own `window.widget.id` rather than by window order or by title.
 * Order is not guaranteed — both widgets are created in the same tick — and a
 * title is a string a future change could reword without anything failing here.
 *
 * Polled rather than awaited once, because `firstWindow`-style helpers give the
 * main window and a widget appears a moment later, after main has read config.
 */
async function widgetPage(app, id, { timeout = 15_000 } = {}) {
  let found = null;
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          try {
            const which = await page.evaluate(() => (window.widget ? window.widget.id : null));
            if (which === id) {
              found = page;
              return true;
            }
          } catch {
            /* a window mid-navigation; try the next */
          }
        }
        return false;
      },
      { timeout }
    )
    .toBe(true);
  // The panel is what the height measurement and every assertion below read.
  await found.waitForSelector('#panel');
  return found;
}

/** How many widget windows exist right now. */
async function widgetCount(app) {
  let n = 0;
  for (const page of app.windows()) {
    try {
      if (await page.evaluate(() => Boolean(window.widget))) n++;
    } catch {
      /* gone */
    }
  }
  return n;
}

/** The real BrowserWindow properties for a widget, read in main. */
function widgetWindowInfo(app, id) {
  return app.evaluate(async ({ BrowserWindow }, widgetId) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.getURL().includes(`widget=${widgetId}`)) continue;
      const [x, y] = win.getPosition();
      const [width, height] = win.getSize();
      return {
        x,
        y,
        width,
        height,
        visible: win.isVisible(),
        alwaysOnTop: win.isAlwaysOnTop(),
        resizable: win.isResizable(),
        opacity: win.getOpacity(),
      };
    }
    return null;
  }, id);
}

/**
 * A widget's height, once it has stopped changing.
 *
 * The height is a round trip — the renderer measures, main resizes — so reading it
 * straight after an assertion about the content catches whichever value happened to
 * be current. That is not a hypothetical: the height arrives at least twice on
 * startup, once from the placeholder and once from the measured content, and a test
 * that captures a baseline between the two compares against a number that never
 * existed for longer than a frame.
 */
async function settledHeight(app, id, { quiet = 700, timeout = 10_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  let since = Date.now();
  while (Date.now() < deadline) {
    const info = await widgetWindowInfo(app, id);
    const height = info && info.height;
    if (height !== last) {
      last = height;
      since = Date.now();
    } else if (Date.now() - since >= quiet) {
      return height;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

/** Every display's work area, so a position can be checked for reachability. */
function workAreas(app) {
  return app.evaluate(({ screen }) => screen.getAllDisplays().map((d) => d.workArea));
}

/** Whether a rectangle has a usable amount of itself on some display. */
function mostlyVisible(rect, areas) {
  let seen = 0;
  for (const wa of areas) {
    const w = Math.min(rect.x + rect.width, wa.x + wa.width) - Math.max(rect.x, wa.x);
    const h = Math.min(rect.y + rect.height, wa.y + wa.height) - Math.max(rect.y, wa.y);
    if (w > 0 && h > 0) seen += w * h;
  }
  return seen / (rect.width * rect.height);
}

const launchSpecs = () =>
  new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(LAUNCH_PREFIX) && f.endsWith('.json')));

async function newLaunchSpec(before) {
  let name = null;
  await expect
    .poll(
      () => {
        name = [...launchSpecs()].find((f) => !before.has(f)) || null;
        return Boolean(name);
      },
      { timeout: 10_000 }
    )
    .toBe(true);
  return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), name), 'utf8'));
}

/* ============================ off by default ============================= */

test.describe('widgets are opt-in', () => {
  test('no widget window exists until one is enabled', async () => {
    const sandbox = widgetSandbox('widget-off');
    ctx = await launchApp(sandbox);

    // Given a moment, so this is not passing merely because nothing has opened yet.
    await ctx.page.waitForTimeout(1200);
    expect(await widgetCount(ctx.app)).toBe(0);

    // And nothing was written to config either: a default is not a saved setting,
    // and writing one on first launch would mean an upgrade could not change it.
    expect(fx.savedValue(sandbox, 'widgets.shortcuts.enabled')).toBeUndefined();
  });

  test('the settings group offers both widgets, off, with their own controls', async () => {
    const sandbox = widgetSandbox('widget-settings-ui');
    ctx = await launchApp(sandbox);

    await ctx.page.click('.nav-item[data-tab="settings"]');
    const cards = ctx.page.locator('#widgetSettings .widget-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAttribute('data-widget', 'shortcuts');
    await expect(cards.nth(1)).toHaveAttribute('data-widget', 'status');
    for (const i of [0, 1]) await expect(cards.nth(i)).toHaveAttribute('data-enabled', 'false');

    // Six themes and four accents, per widget. A theme the widget stylesheet does
    // not define would produce an unstyled window, so the two lists have to agree —
    // widgets.test.js asserts the other half of that.
    await expect(cards.nth(0).locator('.widget-swatches').nth(0).locator('.widget-swatch')).toHaveCount(6);
    await expect(cards.nth(0).locator('.widget-swatches').nth(1).locator('.widget-swatch')).toHaveCount(4);

    /**
     * Click-through is offered on the status widget only.
     *
     * The shortcuts widget is a panel of buttons, and a panel of buttons that
     * ignores the mouse is a panel of buttons that cannot be pressed — an option
     * whose only effect is to break the thing it is attached to.
     */
    await expect(cards.nth(0).getByText('Click through')).toHaveCount(0);
    await expect(cards.nth(1).getByText('Click through')).toHaveCount(1);
  });
});

/* ============================== lifecycle =============================== */

test.describe('turning a widget on and off', () => {
  test('enabling the shortcuts widget opens a frameless, taskbar-less window on screen', async () => {
    const sandbox = widgetSandbox('widget-enable');
    fx.writeConfig(sandbox, { launchpad: { presets: presets() } });
    ctx = await launchApp(sandbox);

    await ctx.page.click('.nav-item[data-tab="settings"]');
    await ctx.page.locator('.widget-card[data-widget="shortcuts"] .switch input').check();

    const widget = await widgetPage(ctx.app, 'shortcuts');

    /**
     * The four properties that make this furniture rather than a window.
     *
     * Checked in main because none of them is observable from the page, and each
     * one's absence is invisible until the moment it is not: a widget with a
     * taskbar button doubles the app's entries and joins the alt-tab cycle, and a
     * resizable frameless window offers a drag border for a layout problem that
     * should not exist.
     */
    const props = await ctx.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('widget=shortcuts'));
      return {
        // `isResizable` and friends are the accessors; the constructor options are
        // not readable back, so these are the observable form of the same thing.
        resizable: win.isResizable(),
        minimizable: win.isMinimizable(),
        maximizable: win.isMaximizable(),
        alwaysOnTop: win.isAlwaysOnTop(),
      };
    });
    expect(props.resizable).toBe(false);
    expect(props.minimizable).toBe(false);
    expect(props.maximizable).toBe(false);
    // On by default: a widget that hides behind the editor is not always available,
    // which was the whole point of asking for one.
    expect(props.alwaysOnTop).toBe(true);

    // Shown only once the renderer reported it had painted — a transparent
    // frameless window revealed before its first paint flashes black.
    const info = await widgetWindowInfo(ctx.app, 'shortcuts');
    expect(info.visible).toBe(true);

    // And it landed somewhere the user can actually reach and grab.
    const fraction = mostlyVisible(info, await workAreas(ctx.app));
    expect(fraction).toBeGreaterThan(0.9);

    expect(await widget.locator('.chip').count()).toBe(3);
    expect(fx.savedValue(sandbox, 'widgets.shortcuts.enabled')).toBe(true);
  });

  test('the widget close button turns the widget off rather than hiding it', async () => {
    const sandbox = widgetSandbox('widget-close');
    fx.writeConfig(sandbox, { widgets: { shortcuts: { enabled: true } }, launchpad: { presets: presets() } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'shortcuts');
    await widget.click('#btnHide');

    /**
     * Off, not hidden.
     *
     * A hidden window with `enabled: true` would come back at the next sync, and
     * pressing × on a desktop widget means "I do not want this", not "not now".
     */
    await expect.poll(() => fx.savedValue(sandbox, 'widgets.shortcuts.enabled'), { timeout: 8_000 }).toBe(false);
    await expect.poll(() => widgetCount(ctx.app), { timeout: 8_000 }).toBe(0);

    // And the main window's settings agree, without needing a reopen.
    await ctx.page.click('.nav-item[data-tab="settings"]');
    await expect(ctx.page.locator('.widget-card[data-widget="shortcuts"]')).toHaveAttribute('data-enabled', 'false');
  });

  test('click-through has a way out that does not require clicking the widget', async () => {
    const sandbox = widgetSandbox('widget-clickthrough');
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true } } });
    ctx = await launchApp(sandbox);
    let widget = await widgetPage(ctx.app, 'status');

    /**
     * Click-through is the one setting that can lock the user out of the widget it
     * is set on: the window stops accepting the click that would turn it off again.
     * It is reachable from the widget's own popover, so the escape hatch is not
     * optional — and it cannot be the widget.
     *
     * The tray menu is where it lives for real, and a native menu cannot be clicked
     * from Playwright. Settings is the other route to the same config field and the
     * same `syncWidgets`, so exercising it proves the field is reachable from a
     * window that is not the affected widget.
     */
    await widget.click('#btnSettings');
    await widget.locator('#clickThrough').check();

    await expect.poll(() => fx.savedValue(sandbox, 'widgets.status.clickThrough'), { timeout: 8_000 }).toBe(true);
    await expect(widget.locator('body')).toHaveAttribute('data-click-through', 'true');
    // Dimmed, so a window that silently swallows no clicks is distinguishable from a
    // broken one — and the hint that says how to undo it is shown.
    await expect(widget.locator('#clickThroughHint')).toBeVisible();

    await ctx.page.click('.nav-item[data-tab="settings"]');
    const card = ctx.page.locator('.widget-card[data-widget="status"]');
    await expect(card.locator('.widget-check input').nth(2)).toBeChecked();
    await card.locator('.widget-check input').nth(2).uncheck();

    await expect.poll(() => fx.savedValue(sandbox, 'widgets.status.clickThrough'), { timeout: 8_000 }).toBe(false);
    widget = await widgetPage(ctx.app, 'status');
    await expect(widget.locator('body')).toHaveAttribute('data-click-through', 'false');
  });

  test('both widgets can be open at once, and do not open on top of each other', async () => {
    const sandbox = widgetSandbox('widget-both');
    fx.writeConfig(sandbox, {
      widgets: { shortcuts: { enabled: true }, status: { enabled: true } },
      launchpad: { presets: presets() },
    });
    ctx = await launchApp(sandbox);

    await widgetPage(ctx.app, 'shortcuts');
    await widgetPage(ctx.app, 'status');
    expect(await widgetCount(ctx.app)).toBe(2);

    const a = await widgetWindowInfo(ctx.app, 'shortcuts');
    const b = await widgetWindowInfo(ctx.app, 'status');
    // Opposite default corners. Landing one exactly on the other would look like
    // only one widget opened.
    expect(a.y).not.toBe(b.y);
    const areas = await workAreas(ctx.app);
    expect(mostlyVisible(a, areas)).toBeGreaterThan(0.9);
    expect(mostlyVisible(b, areas)).toBeGreaterThan(0.9);
  });
});

/* ============================== placement =============================== */

test.describe('placement', () => {
  test('a position saved on a monitor that no longer exists opens somewhere reachable', async () => {
    const sandbox = widgetSandbox('widget-lost');
    /**
     * The failure this whole design exists for.
     *
     * These coordinates are far outside any real display — the state after a second
     * monitor is unplugged. Windows accepts a window there without complaint, and
     * because a widget has no taskbar button and no alt-tab entry, the result is one
     * the user cannot see, drag, or close. Turning it off and on again would restore
     * the same coordinates, so the app has to refuse them.
     */
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true, x: -6000, y: -4200 } } });
    ctx = await launchApp(sandbox);

    await widgetPage(ctx.app, 'status');
    const info = await widgetWindowInfo(ctx.app, 'status');
    const areas = await workAreas(ctx.app);

    expect(mostlyVisible(info, areas)).toBeGreaterThanOrEqual(0.25);
    expect(info.x).toBeGreaterThan(-6000);
    expect(info.visible).toBe(true);
  });

  test('a position on screen is honoured exactly, not tidied up', async () => {
    const sandbox = widgetSandbox('widget-honoured');
    // A modest offset from the origin is inside the primary work area on any machine
    // that can run this suite at all, so it does not need the display list to pick.
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true, x: 220, y: 180 } } });
    ctx = await launchApp(sandbox);

    await widgetPage(ctx.app, 'status');
    const info = await widgetWindowInfo(ctx.app, 'status');
    /**
     * Unchanged. A widget deliberately parked somewhere must stay there: the
     * placement rule is a minimum visible fraction, not containment, precisely so
     * that the app does not overrule a position the user chose.
     */
    expect(info.x).toBe(220);
    expect(info.y).toBe(180);
  });

  test('a drag is remembered, once the drag settles', async () => {
    const sandbox = widgetSandbox('widget-drag');
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true } } });
    ctx = await launchApp(sandbox);
    await widgetPage(ctx.app, 'status');

    /**
     * Moved with setPosition rather than by dragging the header.
     *
     * The drag itself is the compositor's — `-webkit-app-region: drag` is handled
     * outside the page, so a synthesised mouse gesture in the renderer does not move
     * the window at all. What this test is actually for is the save path: `move`
     * fires, the write is debounced, and the position lands in config. It also
     * covers the case `moved` would miss, since `moved` does not fire for a
     * programmatic move.
     */
    const target = await ctx.app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('widget=status'));
      const wa = screen.getPrimaryDisplay().workArea;
      const to = { x: wa.x + 140, y: wa.y + 260 };
      win.setPosition(to.x, to.y);
      return to;
    });

    // Debounced: dragging fires dozens of `move` events a second, and config is
    // written with an atomic replace on a file the recovery hook reads.
    await expect
      .poll(() => fx.savedValue(sandbox, 'widgets.status.x'), { timeout: SAVE_DEBOUNCE_MS + 8_000 })
      .toBe(target.x);
    expect(fx.savedValue(sandbox, 'widgets.status.y')).toBe(target.y);
  });

  test('reset position clears the saved coordinates and re-places the window', async () => {
    const sandbox = widgetSandbox('widget-reset');
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true, x: 300, y: 320 } } });
    ctx = await launchApp(sandbox);
    await widgetPage(ctx.app, 'status');

    await ctx.page.click('.nav-item[data-tab="settings"]');
    const card = ctx.page.locator('.widget-card[data-widget="status"]');
    // The readout is what makes the button meaningful: "reset position" on a widget
    // with no saved position does nothing at all.
    await expect(card.locator('.widget-where')).toHaveText('At 300, 320');

    await card.getByRole('button', { name: 'Reset position' }).click();

    /**
     * Null, not a corner.
     *
     * The stored value has to be absent rather than a computed position, because a
     * saved corner would be re-validated against the display layout on every launch
     * as though the user had chosen it — and the point of the reset is to go back to
     * "wherever is sensible now".
     */
    await expect.poll(() => fx.savedValue(sandbox, 'widgets.status.x'), { timeout: 8_000 }).toBe(null);
    await expect(card.locator('.widget-where')).toHaveText('Default position');

    // The window came back, rather than the reset closing it for good.
    await widgetPage(ctx.app, 'status');
    const info = await widgetWindowInfo(ctx.app, 'status');
    expect(info.x).not.toBe(300);
    expect(mostlyVisible(info, await workAreas(ctx.app))).toBeGreaterThan(0.9);
  });
});

/* ========================== the shortcuts widget ======================== */

test.describe('the shortcuts widget', () => {
  test('lists every preset with its hotkey, and explains itself when there are none', async () => {
    const sandbox = widgetSandbox('widget-empty');
    fx.writeConfig(sandbox, { widgets: { shortcuts: { enabled: true } } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'shortcuts');
    await expect(widget.locator('.chip')).toHaveCount(0);
    // An empty widget that says nothing is indistinguishable from a broken one.
    await expect(widget.locator('#presetEmpty')).toBeVisible();
    await expect(widget.locator('#presetEmpty')).toContainText('Launchpad');
  });

  test('a preset chip carries the label, the folder, and the hotkey digit', async () => {
    const sandbox = widgetSandbox('widget-chips');
    fx.writeConfig(sandbox, { widgets: { shortcuts: { enabled: true } }, launchpad: { presets: presets() } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'shortcuts');
    const first = widget.locator('.chip').first();
    await expect(first.locator('.chip-label')).toHaveText('Lifeline dev');
    // The last chord only. "Ctrl+Alt+1" does not fit, and the modifiers are the same
    // on every preset, so the digit is the part that identifies it.
    await expect(first.locator('.chip-key')).toHaveText('1');
    // The folder, then the model — the model is the fallback for a preset with no
    // skills, since "which folder, as what" is the pair that identifies a session.
    await expect(first.locator('.chip-sub')).toHaveText('lifeline · opus');

    // The detail that has no room on the chip is on the hover title, built by the
    // same describe() the desktop shortcut's tooltip uses.
    await expect(first).toHaveAttribute('title', /Lifeline dev/);

    // A preset with skills shows those instead of the model: they change what the
    // session does, and the model does not.
    await expect(widget.locator('.chip').nth(1).locator('.chip-sub')).toHaveText('notes · /triage');
  });

  test('clicking a chip launches that preset, with its prompt and cwd', async () => {
    const sandbox = widgetSandbox('widget-launch');
    fx.writeConfig(sandbox, { widgets: { shortcuts: { enabled: true } }, launchpad: { presets: presets() } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'shortcuts');
    const before = launchSpecs();
    await widget.locator('.chip').nth(2).click();

    const spec = await newLaunchSpec(before);
    expect(spec.cwd).toBe('C:/work/sweep');
    /**
     * The multi-line prompt survives as the last positional argument.
     *
     * It is in the JSON rather than on a command line, which is the whole point of
     * the two-file split: cmd truncates an argument at a newline, so a prompt like
     * this one would arrive as "Run the sweep." with the second line lost or, worse,
     * run as a command.
     */
    expect(spec.args[spec.args.length - 1]).toBe('Run the sweep.\nReport at the end.');
    // Unattended, because a launch from a widget has no terminal the user is
    // watching for a permission prompt.
    expect(spec.args).toContain('--dangerously-skip-permissions');
  });

  test('a chip shows it was pressed, and refuses a second click while launching', async () => {
    const sandbox = widgetSandbox('widget-double');
    fx.writeConfig(sandbox, { widgets: { shortcuts: { enabled: true } }, launchpad: { presets: presets() } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'shortcuts');
    const before = launchSpecs();
    const chip = widget.locator('.chip').first();

    /**
     * Two clicks in quick succession must be one session.
     *
     * A launch opens a terminal, which takes a second or two to appear, so the
     * natural response to a click that looks like it did nothing is another click —
     * and without the guard that is two `claude` processes.
     */
    await chip.click();
    await expect(chip).toHaveAttribute('data-busy', 'true');
    await chip.click();
    await chip.click();

    await newLaunchSpec(before);
    // Settled: give the guard's own window time to expire so a late spec would
    // still be counted here rather than after the assertion.
    await widget.waitForTimeout(1500);
    const written = [...launchSpecs()].filter((f) => !before.has(f));
    expect(written).toHaveLength(1);
  });

  test('a preset deleted in the main window disappears from the widget', async () => {
    const sandbox = widgetSandbox('widget-sync');
    fx.writeConfig(sandbox, { widgets: { shortcuts: { enabled: true } }, launchpad: { presets: presets() } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'shortcuts');
    await expect(widget.locator('.chip')).toHaveCount(3);

    await ctx.page.click('.nav-item[data-tab="launchpad"]');
    // Deleting goes through the editor, which is where the delete button lives.
    await ctx.page.locator('.preset-foot button', { hasText: 'Edit' }).first().click();
    await ctx.page.click('#btnDeletePreset');

    /**
     * The widget is a second view of the same config, so it has to hear about the
     * change. A stale chip is worse than a missing one: it launches nothing and
     * reports the failure in a window with no room to explain it.
     */
    await expect(widget.locator('.chip')).toHaveCount(2, { timeout: 12_000 });
  });
});

/* ============================ the status widget ========================= */

test.describe('the status widget', () => {
  test('reports what Lifeline is doing, with a status dot that matches', async () => {
    const sandbox = widgetSandbox('widget-status');
    fx.writeSession(sandbox, { pid: process.pid, status: 'busy', cwd: 'C:/work/demo' });
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true } } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'status');
    // A live, working session is the "running" case — and the widget's dot has to
    // agree with the sentence next to it.
    await expect(widget.locator('#dot')).toHaveAttribute('data-status', 'running', { timeout: 12_000 });
    await expect(widget.locator('#statusLine')).toHaveText('Protecting active sessions');

    const counts = widget.locator('.count');
    await expect(counts).toHaveCount(3);
    await expect(counts.nth(0).locator('.count-value')).toHaveText('1');
    await expect(counts.nth(1).locator('.count-value')).toHaveText('1');
  });

  test('a paused Lifeline says so, because every other number looks healthy', async () => {
    const sandbox = widgetSandbox('widget-paused');
    fx.writeConfig(sandbox, { enabled: false, widgets: { status: { enabled: true } } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'status');
    await expect(widget.locator('#dot')).toHaveAttribute('data-status', 'paused', { timeout: 12_000 });
    await expect(widget.locator('#statusLine')).toContainText('Paused');
    /**
     * And an alert, not only a dot.
     *
     * "Paused" is the state where the counts are all fine and nothing is protected,
     * which is the most misleading thing this widget can show — so it gets a line
     * that says what the consequence is.
     */
    await expect(widget.locator('.alert').first()).toContainText('no session will be recovered');
  });

  test('errors and attention items surface, capped, and lead to the activity log', async () => {
    const sandbox = widgetSandbox('widget-errors');
    fx.writeEvents(sandbox, [
      { kind: 'blocked', detail: 'Billing limit reached — resume refused.', needsAttention: true },
      { kind: 'error', detail: 'Could not read settings.json.' },
      { kind: 'error', detail: 'Could not read settings.json.' },
      { kind: 'error', detail: 'Hook exited non-zero.' },
      { kind: 'error', detail: 'A fourth distinct problem.' },
      { kind: 'recovered', detail: 'Resumed after a server error.' },
    ]);
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true } } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'status');
    const alerts = widget.locator('.alert');

    // Capped at three. A scrolling list of problems in a desktop corner is a list
    // nobody reads, and the Activity tab is the place that holds all of them.
    await expect(alerts).toHaveCount(3, { timeout: 12_000 });
    // The attention item first: it is the one that will not resolve on its own.
    await expect(alerts.first()).toContainText('Billing limit');
    await expect(alerts.first()).toHaveAttribute('data-tone', 'danger');

    // The duplicate detail appears once. A failure on a loop writes the same line
    // repeatedly, and five copies of it would fill the widget.
    const texts = await alerts.locator('.alert-text').allTextContents();
    expect(new Set(texts).size).toBe(texts.length);

    // Clicking hands off to the window that has room to explain it.
    await alerts.first().click();
    await expect(ctx.page.locator('.tab[data-tab="activity"]')).toHaveClass(/active/, { timeout: 8_000 });
  });

  test('missing recovery hooks are called out, since no count would reveal it', async () => {
    const sandbox = widgetSandbox('widget-hooks');
    /**
     * Hooks are auto-installed unless the user opted out, so the opt-out is what
     * produces the "running but protecting nothing" state — the one case where
     * every number on the widget looks fine and nothing at all is protected.
     */
    fx.writeConfig(sandbox, {
      hooks: { autoInstall: false, optedOut: true },
      widgets: { status: { enabled: true } },
    });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'status');
    await expect(widget.locator('#statusFoot')).toContainText('not installed', { timeout: 12_000 });
  });

  test('a stalled session takes the third slot from the recovery count', async () => {
    const sandbox = widgetSandbox('widget-stalled');
    // Busy, and untouched for far longer than the stall threshold. A live pid is
    // used so the session counts as alive rather than dead.
    fx.writeSession(sandbox, {
      pid: process.pid,
      status: 'busy',
      updatedAt: Date.now() - 3_600_000,
    });
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true } }, limits: { stalledAfterMs: 60_000 } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'status');
    /**
     * A stalled session is worth more than today's recovery count, because it is
     * the thing that will not fix itself. The slot is shared rather than added: a
     * fourth number would not fit a 240px panel.
     */
    await expect(widget.locator('.count').nth(2).locator('.count-label')).toHaveText('Stalled', { timeout: 15_000 });
    await expect(widget.locator('.count').nth(2)).toHaveAttribute('data-tone', 'warn');
  });
});

/* ============================ theming and size ========================== */

test.describe('appearance', () => {
  test('a theme chosen in the widget popover is applied and saved', async () => {
    const sandbox = widgetSandbox('widget-theme');
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true } } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'status');
    await widget.click('#btnSettings');
    await widget.locator('#themeSwatches .swatch[data-value="midnight"]').click();

    // Applied to the document, so the window actually changes appearance...
    await expect(widget.locator('html')).toHaveAttribute('data-theme', 'midnight');
    // ...and persisted, so it survives a restart. A theme that only lives in the
    // DOM is one the user has to set again every launch.
    await expect.poll(() => fx.savedValue(sandbox, 'widgets.status.theme'), { timeout: 8_000 }).toBe('midnight');

    // The main window's own theme is untouched: these are separate choices, because
    // what reads against a wallpaper is not what reads inside an app frame.
    expect(fx.savedValue(sandbox, 'ui.theme')).not.toBe('midnight');
  });

  test('a widget cannot change the other widget’s settings', async () => {
    const sandbox = widgetSandbox('widget-isolation');
    fx.writeConfig(sandbox, { widgets: { shortcuts: { enabled: true }, status: { enabled: true } } });
    ctx = await launchApp(sandbox);

    const shortcuts = await widgetPage(ctx.app, 'shortcuts');
    await widgetPage(ctx.app, 'status');

    /**
     * The id in a widget message is ignored in favour of the sending window's.
     *
     * Every widget channel could reasonably trust the id, since main put it in the
     * query string itself. Attributing it to the webContents instead is what makes
     * the two windows independent in fact rather than by convention — so a message
     * claiming to be the status widget, sent from the shortcuts widget, changes the
     * shortcuts widget.
     */
    await shortcuts.evaluate(async () => {
      // eslint-disable-next-line no-undef
      await window.widget.patch({ theme: 'slate' });
    });
    await expect.poll(() => fx.savedValue(sandbox, 'widgets.shortcuts.theme'), { timeout: 8_000 }).toBe('slate');
    expect(fx.savedValue(sandbox, 'widgets.status.theme')).not.toBe('slate');
  });

  test('the window height follows the content rather than the reverse', async () => {
    const sandbox = widgetSandbox('widget-height');
    fx.writeConfig(sandbox, { widgets: { shortcuts: { enabled: true } }, launchpad: { presets: presets() } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'shortcuts');
    await expect(widget.locator('.chip')).toHaveCount(3);
    // Settled, not merely current: the height arrives at least twice on startup, and
    // a baseline snatched between the placeholder and the measured content is a
    // number the window held for one frame.
    const closed = await settledHeight(ctx.app, 'shortcuts');

    /**
     * Opening the settings popover makes the content taller, and the window has to
     * follow: it is not resizable, so if the window did not grow the popover would
     * simply be cut off — a settings panel the user can half see.
     */
    await widget.click('#btnSettings');
    await expect
      .poll(async () => (await widgetWindowInfo(ctx.app, 'shortcuts')).height, { timeout: 8_000 })
      .toBeGreaterThan(closed);

    // And back down when it closes, rather than leaving a pane of empty panel.
    await widget.click('#btnSettings');
    await expect
      .poll(async () => (await widgetWindowInfo(ctx.app, 'shortcuts')).height, { timeout: 8_000 })
      .toBe(closed);
  });

  test('width and opacity from the main window reach the live widget', async () => {
    const sandbox = widgetSandbox('widget-width');
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true, width: 260 } } });
    ctx = await launchApp(sandbox);
    await widgetPage(ctx.app, 'status');

    /**
     * Set through config rather than by dragging the slider.
     *
     * A range input is dragged, not typed, and Playwright's `fill` on one does not
     * produce the `input` event the handler listens for. What is worth asserting is
     * the path from a saved setting to the live window — which is the same path the
     * slider uses once it has fired.
     */
    await ctx.page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      await window.lifeline.saveConfig({ widgets: { status: { width: 400, opacity: 0.6 } } });
    });

    await expect.poll(async () => (await widgetWindowInfo(ctx.app, 'status')).width, { timeout: 8_000 }).toBe(400);
    const info = await widgetWindowInfo(ctx.app, 'status');
    expect(info.opacity).toBeCloseTo(0.6, 1);

    // A width beyond the allowed range is clamped, not obeyed: a widget wider than
    // the screen has no frame to grab and cannot be resized back.
    await ctx.page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      await window.lifeline.saveConfig({ widgets: { status: { width: 5000 } } });
    });
    await expect.poll(async () => (await widgetWindowInfo(ctx.app, 'status')).width, { timeout: 8_000 }).toBe(520);
  });

  test('the app mark is shown, drawn in the current status colour', async () => {
    const sandbox = widgetSandbox('widget-logo');
    fx.writeSession(sandbox, { pid: process.pid, status: 'busy' });
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true } } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'status');

    /**
     * A data URL, not a file.
     *
     * The icon is generated at runtime rather than shipped, because its colour *is*
     * the status — so the logo on the widget is part of the readout and not only
     * branding. Asserted as a PNG data URL because that is the thing a static asset
     * could not be, and because the CSP permits `data:` images for exactly this.
     */
    const src = await widget.locator('#heroLogo').getAttribute('src');
    expect(src).toMatch(/^data:image\/png;base64,/);
    // Not the 1x1 placeholder a broken generator would produce.
    expect(src.length).toBeGreaterThan(400);

    // And it is loaded, rather than a broken-image glyph where the mark should be.
    const drawn = await widget.locator('#heroLogo').evaluate((img) => img.naturalWidth > 0);
    expect(drawn).toBe(true);
  });

  test('a look changes the shape of the window, not only its contents', async () => {
    const sandbox = widgetSandbox('widget-looks');
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true, width: 300 } } });
    ctx = await launchApp(sandbox);

    let widget = await widgetPage(ctx.app, 'status');
    await expect(widget.locator('body')).toHaveAttribute('data-look', 'card');
    const card = await settledHeight(ctx.app, 'status');
    expect((await widgetWindowInfo(ctx.app, 'status')).width).toBe(300);

    // The card is the full readout: the hero, the counts, and the sentence.
    await expect(widget.locator('.hero')).toBeVisible();
    await expect(widget.locator('.count')).toHaveCount(3);

    await widget.click('#btnSettings');
    await widget.locator('#lookButtons .look-btn[data-value="orb"]').click();

    /**
     * The orb is a disc, so its width is fixed and its height matches it.
     *
     * Sizing has to be per look. The same 300px that suits a card makes an orb a wide
     * empty rectangle, and a 92px card is too narrow to read — so the width the
     * window gets comes from the look rather than from the slider.
     */
    widget = await widgetPage(ctx.app, 'status');
    await expect(widget.locator('body')).toHaveAttribute('data-look', 'orb');
    const orbHeight = await settledHeight(ctx.app, 'status');
    const orb = await widgetWindowInfo(ctx.app, 'status');
    expect(orb.width).toBeLessThan(180);
    // Square, within the transparent gutter that surrounds the panel on both axes.
    expect(Math.abs(orbHeight - orb.width)).toBeLessThanOrEqual(4);
    expect(orbHeight).toBeLessThan(card);

    // Just the mark and one number — the counts and the sentence are gone.
    await expect(widget.locator('.orb-logo')).toBeVisible();
    await expect(widget.locator('#orbValue')).toBeVisible();
    await expect(widget.locator('.body.status')).toBeHidden();

    /**
     * The saved width survives the round trip.
     *
     * The *saved* width is the card width and the look decides what the window
     * actually gets, so switching to an orb must not overwrite a setting the user
     * chose — there would be nothing to restore when they switched back.
     */
    expect(fx.savedValue(sandbox, 'widgets.status.width')).toBe(300);
    await expect.poll(() => fx.savedValue(sandbox, 'widgets.status.look'), { timeout: 8_000 }).toBe('orb');
  });

  test('the orb has a way back, since it is too small to hold the popover', async () => {
    const sandbox = widgetSandbox('widget-orb-escape');
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true, look: 'orb' } } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'status');
    await expect(widget.locator('body')).toHaveAttribute('data-look', 'orb');

    /**
     * The orb is 92px across and the popover needs about 210, and unlike the card it
     * cannot grow to fit one — its width is its shape. So the gear opens the main
     * Settings tab instead. Without that the orb would be a widget with no way to
     * become anything else, which is the same trap click-through sets.
     */
    await widget.click('#btnSettings');
    await expect(ctx.page.locator('.tab[data-tab="settings"]')).toHaveClass(/active/, { timeout: 8_000 });
    await expect(widget.locator('#settings')).toBeHidden();

    // And the look picker there gets it back to a card.
    await ctx.page.locator('.widget-card[data-widget="status"] .widget-look[data-value="card"]').click();
    await expect.poll(() => fx.savedValue(sandbox, 'widgets.status.look'), { timeout: 8_000 }).toBe('card');
    await expect((await widgetPage(ctx.app, 'status')).locator('.hero')).toBeVisible();
  });

  test('the bar is one strip, and its popover still fits under it', async () => {
    const sandbox = widgetSandbox('widget-bar');
    fx.writeConfig(sandbox, { widgets: { status: { enabled: true, look: 'bar' } } });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'status');
    await expect(widget.locator('body')).toHaveAttribute('data-look', 'bar');

    const strip = await settledHeight(ctx.app, 'status');
    const info = await widgetWindowInfo(ctx.app, 'status');
    // Long and short: the point of the bar is that it fits along the top of a screen
    // where a tall panel would cover the work underneath.
    expect(info.width).toBeGreaterThan(info.height);
    expect(strip).toBeLessThan(110);

    // The sentence takes the space the hero block has on the card.
    await expect(widget.locator('#statusLine')).toBeVisible();
    await expect(widget.locator('.hero')).toBeHidden();

    /**
     * And the popover grows the window rather than being clipped.
     *
     * On the bar it wraps to a second row instead of overhanging, because the panel
     * clips its children and the window is only as tall as the strip — so an
     * absolutely positioned popover would be cut off at both.
     */
    await widget.click('#btnSettings');
    await expect
      .poll(async () => (await widgetWindowInfo(ctx.app, 'status')).height, { timeout: 8_000 })
      .toBeGreaterThan(strip);
    await expect(widget.locator('#lookButtons')).toBeVisible();
  });

  test('the shortcuts widget is not offered an orb, in either place it is chosen', async () => {
    const sandbox = widgetSandbox('widget-no-orb');
    // Asked for in config, which is the case the UI cannot prevent.
    fx.writeConfig(sandbox, {
      widgets: { shortcuts: { enabled: true, look: 'orb' } },
      launchpad: { presets: presets() },
    });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'shortcuts');
    /**
     * A disc holding three buttons would either hide two of them or stop being a
     * disc, and the orb has no popover to change the look back from — so a shortcuts
     * orb is a widget with nothing in it and no way out. Refused in the model, not
     * only left out of the picker.
     */
    await expect(widget.locator('body')).toHaveAttribute('data-look', 'card');
    await expect(widget.locator('.chip')).toHaveCount(3);

    // Two looks in the widget's own popover, and two in Settings.
    await widget.click('#btnSettings');
    await expect(widget.locator('#lookButtons .look-btn')).toHaveCount(2);

    await ctx.page.click('.nav-item[data-tab="settings"]');
    const cards = ctx.page.locator('#widgetSettings .widget-card');
    await expect(cards.nth(0).locator('.widget-look')).toHaveCount(2);
    await expect(cards.nth(1).locator('.widget-look')).toHaveCount(3);
  });

  test('compact mode drops detail rather than shrinking the text', async () => {
    const sandbox = widgetSandbox('widget-compact');
    fx.writeConfig(sandbox, {
      widgets: { shortcuts: { enabled: true, compact: true } },
      launchpad: { presets: presets() },
    });
    ctx = await launchApp(sandbox);

    const widget = await widgetPage(ctx.app, 'shortcuts');
    await expect(widget.locator('body')).toHaveAttribute('data-compact', 'true');
    // The labels stay; the folder line goes. Compact is fewer things, not smaller
    // things — a widget with 9px text is a widget that cannot be read.
    await expect(widget.locator('.chip-label').first()).toBeVisible();
    await expect(widget.locator('.chip-sub').first()).toBeHidden();
  });
});
