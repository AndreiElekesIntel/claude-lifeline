'use strict';
/**
 * The desktop widget windows.
 *
 * Two frameless, transparent, always-on-top windows that sit on the wallpaper: a
 * shortcuts panel and a status readout. This file owns their *lifecycle* — creating
 * them, placing them, keeping their position and settings in step with config, and
 * closing them — while the shared rules about what a valid setting or a reachable
 * position is live in widgets.js, where they can be unit-tested without a display.
 *
 * ## Why a widget is not just a small BrowserWindow
 *
 * Four things make one behave like a desktop widget rather than a stray dialog, and
 * getting any of them wrong is what makes this kind of window feel broken:
 *
 *   - **`skipTaskbar`.** A widget is not a window you switch to, it is furniture.
 *     Without this, two taskbar buttons appear and alt-tab cycles through them.
 *   - **No frame, transparent background.** The rounded panel is drawn in CSS, so
 *     the window itself has to contribute nothing — a frame would put a title bar
 *     above a widget that already has its own handle.
 *   - **A drag region, in CSS, not JavaScript.** `-webkit-app-region: drag` lets
 *     the compositor move the window, which is smooth. Moving it from a mousemove
 *     handler means a round trip per frame and a widget that lags the cursor.
 *   - **`resizable: false` with the height driven by content.** A widget with a
 *     resize border invites the user to fix a layout problem the app should not
 *     have; instead the renderer reports how tall it needs to be and the window
 *     follows.
 *
 * ## Why the position is saved on a debounce
 *
 * Dragging a window fires `move` continuously — dozens of events per second — and
 * config is written with an atomic replace. Saving on every event would mean
 * hundreds of file writes for one drag, on a file the recovery hook reads on every
 * failure. So the position is recorded in memory as it moves and written once the
 * drag has been still for a moment.
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const widgets = require('../shared/widgets');

/** How long the position must be still before it is written to config, in ms. */
const SAVE_DEBOUNCE_MS = 600;

/**
 * The live windows, by widget id. A closed widget has no entry rather than a
 * destroyed one, so `get` never hands back a window that cannot be spoken to.
 */
const open = new Map();

/** Pending debounced saves, by widget id. */
const saveTimers = new Map();

/**
 * The settings each open widget was last given, by id.
 *
 * Needed because `setHeight` arrives from the renderer with nothing but a number,
 * and the height cache is keyed by look — so the window layer has to remember which
 * look the measurement belongs to.
 */
const applied = new Map();

/**
 * Where each open widget was *put* by the app, by id — not where the user dragged it.
 *
 * This exists to tell a placement apart from a drag. `move` fires for a programmatic
 * position and for a resize, so without it every widget saved its opening coordinates
 * 600ms after appearing, which quietly turned "no saved position" into a saved one.
 * Reset-position was the visible symptom: clearing the coordinates re-created the
 * window, and the corner it happened to open in was written straight back.
 *
 * The entry is dropped the first time a real move is saved — after that the window is
 * where the user put it and there is nothing left to suppress.
 */
const placed = new Map();

/**
 * Height each widget last asked for, keyed by id *and look*.
 *
 * Kept across a close and reopen because it is a much better first guess than a
 * constant: reopening the shortcuts widget with six presets in it should not flash
 * at a default height and then jump.
 *
 * Keyed by look as well as id because the looks differ in height by a factor of
 * five. Remembering one height per widget would open an orb at the card's 400px and
 * then snap it to 92 — exactly the flash the cache exists to avoid.
 */
const heights = new Map();

/** The cache key for a remembered height. */
function heightKey(id, settings) {
  return `${id}:${(settings && settings.look) || 'card'}`;
}

/**
 * Resize a non-resizable window.
 *
 * `resizable: false` does more than remove the drag border: Windows takes it as a
 * fixed size, so Electron pins the *minimum* size to whatever the window currently
 * is. The window can then grow and never shrink — `setSize` to anything smaller is
 * silently ignored, with no error and no event.
 *
 * That is invisible until it is not. The height is driven by the content, so closing
 * the settings popover left a pane of empty panel that could not be reclaimed, and
 * switching from a 300px card to a 92px orb produced a 300px-wide orb. Dropping the
 * flag for the duration of the call is the fix; it is synchronous, so there is no
 * window in which a resize border exists to be grabbed.
 */
function resize(id, win, width, height) {
  const [w, h] = win.getSize();
  if (w === width && h === height) return;
  const shrinking = width < w || height < h;
  if (shrinking) win.setResizable(true);
  try {
    win.setSize(width, height, false);
  } finally {
    // In a finally so a throw mid-resize cannot leave a widget with a drag border
    // and a maximise-on-double-click title area it is not supposed to have.
    if (shrinking) win.setResizable(false);
  }
  if (width > w || height > h) keepOnScreen(id, win, { width: w, height: h });
}

/**
 * Pull a window back inside the work area if *growing* is what pushed it out.
 *
 * A window grows from its top-left corner, so a widget in a bottom or right corner
 * grows towards the edge it is against. That interacts badly with a height the
 * content decides: the window opens at a guessed height, placed a margin clear of
 * the taskbar, and then the renderer reports the real height and the extra pixels go
 * underneath the taskbar — where they cannot be seen, and where a widget with no
 * taskbar button of its own cannot be grabbed to fix it.
 *
 * The correction is deliberately narrow: it only applies on the axis where the
 * window *did* fit before the resize and no longer does. Hanging a widget off an
 * edge on purpose is normal — placeOn goes out of its way to preserve it — so
 * anything already overhanging is left exactly as the user left it.
 */
function keepOnScreen(id, win, before) {
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  const display = screen.getDisplayMatching({ x, y, width: w, height: h });
  const wa = (display && display.workArea) || null;
  if (!wa) return;

  let nx = x;
  let ny = y;
  if (x + before.width <= wa.x + wa.width && x + w > wa.x + wa.width) {
    nx = Math.max(wa.x, wa.x + wa.width - w);
  }
  if (y + before.height <= wa.y + wa.height && y + h > wa.y + wa.height) {
    ny = Math.max(wa.y, wa.y + wa.height - h);
  }
  if (nx === x && ny === y) return;

  win.setPosition(nx, ny, false);
  /**
   * Still the app's placement, not the user's.
   *
   * Without this the nudge would look like a drag to the debounced save and every
   * widget would acquire a saved position moments after opening — including one whose
   * position had just been reset.
   */
  const from = placed.get(id);
  if (from && from.x === x && from.y === y) placed.set(id, { x: nx, y: ny });
}

/**
 * Create, update, or close a widget so it matches its settings.
 *
 * The single entry point, called on startup and after any config change. It is
 * idempotent: calling it with unchanged settings applies the same values again and
 * does nothing visible, which is what makes "just call it after every change" a
 * safe rule rather than one with exceptions.
 */
function sync(id, settings, deps) {
  if (!widgets.WIDGET_IDS.includes(id)) return null;

  if (!settings.enabled) {
    close(id);
    return null;
  }

  const existing = open.get(id);
  if (existing && !existing.isDestroyed()) {
    apply(existing, id, settings, deps);
    return existing;
  }

  return create(id, settings, deps);
}

/** Build the window. Only called when there is not already one. */
function create(id, settings, deps) {
  const width = widgets.widthFor(settings);
  const height = heights.get(heightKey(id, settings)) || defaultHeight(id, settings);
  const at = widgets.placeOn(
    { ...settings, width, height },
    screen.getAllDisplays(),
    // The status widget defaults to the opposite corner from the shortcuts panel,
    // so enabling both does not stack one exactly on the other.
    { corner: id === 'status' ? 'bottom-right' : 'top-right' }
  );

  const win = new BrowserWindow({
    width,
    height,
    x: at.x,
    y: at.y,
    frame: false,
    transparent: true,
    // The rounded panel is drawn in CSS over a transparent window, so any window
    // background at all would show as a square behind it.
    backgroundColor: '#00000000',
    resizable: false,
    // Furniture, not a window you switch to. Without this there are two taskbar
    // buttons and alt-tab cycles through the widget.
    skipTaskbar: true,
    // Minimising or maximising a widget makes no sense, and Windows will animate a
    // frameless window into a corner if asked.
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    /**
     * Not shown until the renderer says it has painted.
     *
     * A transparent frameless window that is shown before its first paint appears
     * as a black rectangle for a frame or two. On a widget that lands on top of
     * everything else, that flash is very visible.
     */
    show: false,
    title: id === 'status' ? 'Lifeline status' : 'Lifeline shortcuts',
    webPreferences: {
      preload: path.join(__dirname, 'widget-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'widget.html'), { query: { widget: id } });

  /**
   * Where this window was put, so a `move` back to the same place is not a drag.
   *
   * Recorded before `apply`, because applying settings resizes the window and a
   * resize emits `move`.
   */
  placed.set(id, { x: at.x, y: at.y });

  apply(win, id, settings, deps);

  /**
   * Position, remembered.
   *
   * `move` fires continuously while dragging, so the coordinates are kept in
   * memory and written once the window has been still — see the header. `moved`
   * would be the obvious event to use instead, but it does not fire for a
   * programmatic `setPosition`, and a widget nudged back on screen by placeOn
   * needs its corrected position saved too or it is nudged again next launch.
   */
  win.on('move', () => scheduleSave(id, win, deps));

  /**
   * A corrected position is saved; a default one is not.
   *
   * The distinction matters and it is not cosmetic. `clamped` means the saved
   * coordinates were unreachable and had to be pulled back — writing the correction
   * is what stops the widget being nudged again on every launch. `default` means
   * there was no saved position at all, and writing the corner placeOn picked would
   * turn "wherever is sensible now" into a coordinate that gets re-validated as
   * though the user had chosen it. That is what broke reset-position: clearing the
   * coordinates immediately re-saved the corner the window then opened at, so the
   * readout went straight back to showing a position.
   */
  if (at.reason === 'clamped' && deps && deps.savePosition) deps.savePosition(id, { x: at.x, y: at.y });

  win.on('closed', () => {
    // Dropped rather than kept as a destroyed handle, so nothing can try to talk
    // to it afterwards.
    if (open.get(id) === win) open.delete(id);
  });

  open.set(id, win);
  return win;
}

/** Apply every live-changeable setting to an existing window. */
function apply(win, id, settings, deps) {
  const previous = applied.get(id);
  applied.set(id, settings);
  const lookChanged = Boolean(previous) && previous.look !== settings.look;

  try {
    win.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
    /**
     * `forward: true` keeps mouse *move* events coming even while clicks pass
     * through. Without it the widget cannot know the cursor is over it, so it
     * cannot show the hint explaining how to get control back — which for a
     * click-through window is the only way out.
     */
    win.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
    win.setOpacity(settings.opacity);

    const width = widgets.widthFor(settings);
    const [currentW, currentH] = win.getSize();
    /**
     * A look change resizes both axes at once.
     *
     * Height is normally the renderer's business — it measures itself and reports
     * back. But going from a 400px card to a 92px orb would leave the window at 400
     * for the round trip, and a transparent window that tall shows as a column of
     * empty space with a small orb at the top of it. Guessing the new height here
     * closes that gap; the renderer's measurement lands a frame later and corrects
     * whatever the guess got wrong.
     */
    const height = lookChanged
      ? heights.get(heightKey(id, settings)) || defaultHeight(id, settings)
      : currentH;
    resize(id, win, width, height);
  } catch {
    /* the window went away mid-update, which the next sync will notice */
  }

  // The renderer needs the settings too, for the theme attributes and the layout.
  send(id, 'widget-settings', settings);
  if (deps && deps.state) send(id, 'widget-state', deps.state());
}

/** Set the height the renderer measured, keeping the window's own position. */
function setHeight(id, height) {
  const win = open.get(id);
  const h = Math.round(Number(height));
  if (!win || win.isDestroyed() || !Number.isFinite(h)) return;
  // Bounded: a renderer bug that reported a huge height would otherwise produce a
  // window taller than the screen with no frame to grab.
  const clamped = Math.min(1200, Math.max(64, h));
  heights.set(heightKey(id, applied.get(id)), clamped);
  const [w] = win.getSize();
  resize(id, win, w, clamped);
}

/** Show a widget once its renderer has painted, avoiding the black-flash frame. */
function reveal(id) {
  const win = open.get(id);
  if (!win || win.isDestroyed() || win.isVisible()) return;
  // showInactive, not show: a widget appearing must not steal focus from whatever
  // the user is typing in.
  win.showInactive();
}

/**
 * A first height, used only before the renderer has measured itself.
 *
 * Per look, because the looks are not near each other in height: an orb is square
 * and a bar is a single line, so the card's guess would be wrong by hundreds of
 * pixels. These are close enough that the correction is invisible.
 */
function defaultHeight(id, settings) {
  const look = (settings && settings.look) || 'card';
  if (look === 'orb') return widgets.widthFor(settings) + 16;
  if (look === 'bar') return 74;
  return id === 'status' ? 150 : 220;
}

/** Record a moved position and write it once the drag settles. */
function scheduleSave(id, win, deps) {
  clearTimeout(saveTimers.get(id));
  saveTimers.set(
    id,
    setTimeout(() => {
      saveTimers.delete(id);
      if (!win || win.isDestroyed() || !deps || !deps.savePosition) return;
      const [x, y] = win.getPosition();
      /**
       * Still where the app put it, so this `move` was the placement or a resize —
       * not a drag. Saving here is what made a reset position come straight back.
       */
      const from = placed.get(id);
      if (from && from.x === x && from.y === y) return;
      placed.delete(id);
      deps.savePosition(id, { x, y });
    }, SAVE_DEBOUNCE_MS)
  );
}

/** Send to one widget if it is open. Silently does nothing if it is not. */
function send(id, channel, payload) {
  const win = open.get(id);
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* mid-teardown */
  }
}

/** Send to every open widget — used for the state broadcast. */
function broadcast(channel, payload) {
  for (const id of open.keys()) send(id, channel, payload);
}

/** Which widget a given webContents belongs to, or null. Used to attribute IPC. */
function idFor(webContents) {
  for (const [id, win] of open) {
    if (!win.isDestroyed() && win.webContents === webContents) return id;
  }
  return null;
}

function close(id) {
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  // `heights` deliberately survives: it is a rendering hint, and keeping it is what
  // makes a reopened widget appear at the right size straight away.
  applied.delete(id);
  placed.delete(id);
  const win = open.get(id);
  open.delete(id);
  if (win && !win.isDestroyed()) win.close();
}

function closeAll() {
  for (const id of [...open.keys()]) close(id);
}

/** Whether a widget is currently open. */
function isOpen(id) {
  const win = open.get(id);
  return Boolean(win && !win.isDestroyed());
}

/**
 * Where a widget is right now, or null if it is not open.
 *
 * Exists for the quit path. The position save is debounced, so a widget dragged
 * and then quit within that window would forget where it was put — the one thing a
 * widget is expected to remember. Reading it straight from the window at shutdown
 * is more reliable than trying to flush a timer.
 *
 * Null for a widget still sitting where the app put it, for the same reason
 * `scheduleSave` skips one: that is not a position the user chose, and writing it on
 * quit would give every widget a saved position after its first run — including one
 * whose position had just been reset.
 */
function position(id) {
  const win = open.get(id);
  if (!win || win.isDestroyed()) return null;
  try {
    const [x, y] = win.getPosition();
    const from = placed.get(id);
    if (from && from.x === x && from.y === y) return null;
    return { x, y };
  } catch {
    return null;
  }
}

module.exports = {
  SAVE_DEBOUNCE_MS,
  sync,
  setHeight,
  reveal,
  send,
  broadcast,
  idFor,
  close,
  closeAll,
  isOpen,
  position,
};
