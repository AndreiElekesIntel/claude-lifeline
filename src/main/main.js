'use strict';
/**
 * Electron main process: tray icon, window lifecycle, IPC.
 *
 * A note on "Windows service": a real service runs in session 0 and cannot draw
 * a tray icon, so a tray agent must be a logon-scoped app. Autostart is handled
 * by a Scheduled Task at logon (see scripts/install-autostart.ps1), which is the
 * supported way to get service-like behaviour with a UI.
 *
 * The app is optional. Recovery lives in the hook, inside Claude Code's own
 * process — quitting the tray leaves every session protected.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, shell, dialog, globalShortcut, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const { Monitor } = require('./monitor');
const { AnalyticsService } = require('./analytics-service');
const { drawIcon, iconDataUrl } = require('./tray-icon');
const { registerToastIdentity, APP_USER_MODEL_ID } = require('./toast-identity');
const { loadConfig, saveConfig, defaultConfig, deepMerge } = require('../shared/config');
const { SCHEMA_VERSION } = require('../shared/migrate');
const { ERROR_CLASSES, POLICIES, effectivePolicy } = require('../shared/policy');
const { RATES } = require('../shared/pricing');
const installer = require('../shared/installer');
const eventlog = require('../shared/eventlog');
const ledger = require('../shared/ledger');
const paths = require('../shared/paths');
const launcher = require('../shared/launcher');
const launchpad = require('../shared/launchpad');
const sessionRename = require('../shared/session-rename');
const history = require('../shared/history');
const widgets = require('../shared/widgets');
const completion = require('../shared/completion');
const widgetWindows = require('./widget-windows');

const isDev = process.argv.includes('--dev');
/**
 * Under test the window must be shown regardless of the saved preference: a
 * hidden window gets throttled by the compositor, which makes UI assertions
 * flaky for reasons that have nothing to do with the app.
 */
const isE2E = process.env.LIFELINE_E2E === '1';

/**
 * Write the launch pair but do not spawn a terminal.
 *
 * The one seam the launch tests need. Everything worth checking about a launch —
 * that the id was validated, that a live session is refused, that the argv and cwd
 * came out right — is decided before `spawn`, and the spawn itself is already
 * round-trip tested in launcher.test.js by running the batch file directly. A test
 * suite that actually spawned would open a terminal window per assertion on the
 * developer's desktop, and each of those is a real `claude` process competing with
 * the sessions the user asked not to be disturbed.
 */
const noSpawn = process.env.LIFELINE_NO_SPAWN === '1';

/**
 * Launch, or — under LIFELINE_NO_SPAWN — write the files and report what would
 * have run. Same return shape either way, so no caller needs to know which.
 */
function launchSession(preset, opts = {}) {
  if (!noSpawn) return launcher.launch(preset, { node: launcherNode(), ...opts });
  const { spec, script } = launcher.writeLaunchFiles(preset, { node: launcherNode(), ...opts });
  const cmd = launcher.resolveCommand(script);
  return { pid: null, via: cmd.via, script, spec, spawned: false };
}

let tray = null;
let win = null;
let monitor = null;
let analytics = null;
let quitting = false;
let lastNotifiedAt = 0;
/**
 * Each session's status as of the previous poll, for spotting the busy → idle edge
 * that means a prompt finished. Owned here rather than in the monitor because it is
 * notification state: what the user has already been told about.
 */
let lastSessionStatus = new Map();

/** Single instance: a second tray icon would double every notification. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    show: false,
    frame: false,
    // Matches the dark shell so there is no white flash before CSS applies.
    backgroundColor: '#0f1117',
    title: 'Claude Lifeline',
    icon: nativeImage.createFromBuffer(drawIcon(256, 'running')),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Closing the window hides it: the app's job is to keep watching.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function showWindow(tab = null) {
  if (!win) createWindow();
  if (tab) win.webContents.send('navigate', tab);
  win.show();
  win.focus();
}

/* =============================== widgets ================================= */

/**
 * Open, update, or close both widgets to match config.
 *
 * Called from one place per reason it could change — startup, a config save, and a
 * widget's own patch — rather than on the monitor poll. `sync` is idempotent, so
 * calling it too often is harmless; the reason not to put it on the poll is that a
 * poll fires every five seconds forever, and re-applying `setAlwaysOnTop` on a
 * timer is a good way to steal a raise from whatever the user just clicked.
 */
function syncWidgets(cfg = loadConfig()) {
  const all = widgets.listWidgets(cfg);
  for (const id of widgets.WIDGET_IDS) {
    widgetWindows.sync(id, all[id], {
      state: () => widgetState(id),
      savePosition: saveWidgetPosition,
    });
  }
}

/**
 * Remember where a widget was dragged to.
 *
 * Reached from the debounced `move` handler, so it re-reads config rather than
 * patching a copy held from earlier: a drag can finish long after the last save,
 * and writing a stale object back would undo whatever was changed in between.
 *
 * Deliberately does *not* call syncWidgets. The window is already at these
 * coordinates — it is where the user put it — and pushing them back through
 * `setPosition` would fight a drag that is still in progress.
 */
function saveWidgetPosition(id, { x, y }) {
  const cfg = loadConfig();
  const res = widgets.patchWidget(cfg, id, { x, y });
  if (!res.ok) return;
  cfg.widgets = res.widgets;
  saveConfig(cfg);
  // The settings UI shows the position, so it has to hear about a drag.
  if (win) win.webContents.send('config-changed', cfg);
}

/**
 * What a widget needs to draw itself.
 *
 * Built per widget rather than sending one shared blob, because the two need
 * almost disjoint slices: the shortcuts panel wants presets and nothing else, and
 * the status widget wants counts and alerts. It also keeps the sessions array —
 * which carries cwds and transcript paths — out of a window that has no use for it.
 */
function widgetState(id) {
  const state = monitor.getState();

  /**
   * The app's own mark, drawn at runtime in the tray's status colour.
   *
   * Sent to both widgets, and as a data URL rather than a file: the icon is
   * generated, not shipped, and its colour *is* the status — so a widget showing it
   * is showing something a static asset could not. The CSP allows `data:` images for
   * exactly this. Two sizes because the orb is nearly all logo and the card's grip
   * has 18px for one; scaling a 64px PNG down to 18 is soft where redrawing it is
   * not, and both are cached in tray-icon.js.
   */
  const logo = {
    small: iconDataUrl(36, state.status),
    large: iconDataUrl(96, state.status),
  };

  if (id === 'shortcuts') {
    return {
      logo,
      status: state.status,
      presets: launchpad.listPresets(loadConfig()).map((p) => ({
        id: p.id,
        label: p.label,
        accelerator: p.accelerator || null,
        /** The one-line detail, built where the desktop shortcut's tooltip is. */
        description: launchpad.describe(p),
        subtitle: presetSubtitle(p),
      })),
    };
  }

  return {
    logo,
    status: state.status,
    summary: state.summary,
    stats: state.stats,
    lastPollAt: state.lastPollAt,
    /**
     * Whether recovery is actually wired up.
     *
     * The one setup fact worth a permanent line on the widget: with the hooks
     * missing, every count on it can look healthy while nothing at all is
     * protected. Read from installer rather than config, because config records
     * the intent and settings.json records the reality.
     */
    hooksInstalled: hooksComplete(),
    alerts: widgetAlerts(state),
  };
}

/** A short second line for a preset chip: where it runs, and as what. */
function presetSubtitle(preset) {
  const bits = [];
  if (preset.cwd) bits.push(path.basename(String(preset.cwd).replace(/[\\/]+$/, '')) || preset.cwd);
  if (preset.skills && preset.skills.length) bits.push(preset.skills.map((s) => `/${s}`).join(' '));
  else if (preset.model) bits.push(preset.model);
  return bits.join(' · ');
}

function hooksComplete() {
  try {
    return installer.status().complete;
  } catch {
    // Unreadable settings.json is not the same as "not installed", so it does not
    // claim either way — the banner in the main window explains that case.
    return true;
  }
}

/**
 * The "any errors?" part of the status widget.
 *
 * Attention items first, because those are the ones that will not resolve on their
 * own, then recent errors from the log. Capped at three: this is a widget, and a
 * scrolling list of problems in a corner of the desktop is a list nobody reads.
 */
function widgetAlerts(state) {
  const out = [];
  const seen = new Set();

  const push = (event, tone) => {
    const text = event.detail || event.label || event.errorClass || 'Something went wrong.';
    // Same detail twice — a failure that recurs on a loop — is one line, not five.
    if (seen.has(text)) return;
    seen.add(text);
    out.push({ tone, text: String(text).slice(0, 300), at: event.at || null });
  };

  for (const item of state.attention || []) push(item, item.kind === eventlog.KINDS.BLOCKED ? 'danger' : 'warn');
  for (const event of state.events || []) {
    if (out.length >= 3) break;
    if (event.kind !== eventlog.KINDS.ERROR) continue;
    // Older than an hour is history rather than status; the Activity tab has it.
    if (Date.now() - event.at > 3_600_000) continue;
    push(event, 'danger');
  }

  if (!state.config.enabled) {
    out.unshift({ tone: 'warn', text: 'Protection is paused — no session will be recovered.', at: null });
  }

  return out.slice(0, 3);
}

function buildTrayMenu() {
  const state = monitor.getState();
  const st = installer.status();

  const statusLabels = {
    running: 'Protecting active sessions',
    waiting: 'Waiting for Claude sessions',
    paused: 'Paused — sessions unprotected',
    attention: 'Needs attention',
    error: 'Error — see dashboard',
  };

  return Menu.buildFromTemplate([
    { label: `Claude Lifeline — ${statusLabels[state.status] || state.status}`, enabled: false },
    {
      label: `${state.summary.alive} live · ${state.summary.busy} working · ${state.stats.today} recovered today`,
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Open dashboard', click: () => showWindow('dashboard') },
    { label: 'Open config', click: () => showWindow('settings') },
    { label: 'Activity log', click: () => showWindow('activity') },
    {
      /**
       * Widget toggles, in the tray.
       *
       * Not only in Settings, because a widget can be turned off from a place the
       * user cannot get back to. Set click-through on the status widget and it stops
       * accepting the click that would turn it off again; the tray is the way out,
       * and it is also the fastest way to put one back after hiding it.
       */
      label: 'Desktop widgets',
      submenu: widgets.WIDGET_IDS.map((id) => ({
        label: id === 'status' ? 'Status widget' : 'Shortcuts widget',
        type: 'checkbox',
        checked: widgets.widgetSettings(state.config, id).enabled,
        click: () => toggleWidget(id),
      })),
    },
    { type: 'separator' },
    {
      label: state.config.enabled ? 'Pause protection' : 'Resume protection',
      click: () => {
        const cfg = loadConfig();
        cfg.enabled = !cfg.enabled;
        saveConfig(cfg);
        eventlog.append({
          kind: eventlog.KINDS.INFO,
          detail: cfg.enabled ? 'Protection resumed from the tray.' : 'Protection paused from the tray.',
        });
        monitor.poll();
        refreshTray();
        if (win) win.webContents.send('config-changed', cfg);
      },
    },
    {
      label: st.complete ? 'Hooks installed ✓' : 'Install recovery hooks…',
      enabled: !st.complete,
      click: async () => {
        try {
          const res = installer.install();
          showWindow('dashboard');
          dialog.showMessageBox({
            type: 'info',
            title: 'Recovery hooks installed',
            message: `Installed for: ${res.installed.join(', ')}`,
            detail:
              'New Claude Code sessions are protected immediately. Sessions already running load hooks at startup, so restart them to pick this up.' +
              (res.backup ? `\n\nBackup: ${res.backup}` : ''),
          });
          refreshTray();
        } catch (err) {
          dialog.showErrorBox('Could not install hooks', err.message);
        }
      },
    },
    { type: 'separator' },
    { label: 'Open data folder', click: () => shell.openPath(paths.lifelineHome()) },
    { label: 'View source on GitHub', click: () => shell.openExternal(LINKS.repo) },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

/**
 * Turn a widget on or off, from the tray or anywhere else.
 *
 * One function rather than an inline handler because both the tray and the
 * widget's own close button end here, and the ordering matters: config is written
 * first so that a `sync` reads the state that was just saved, and the tray is
 * rebuilt last so its checkmark reflects what happened rather than what was asked.
 */
function toggleWidget(id, enabled = null) {
  const cfg = loadConfig();
  const current = widgets.widgetSettings(cfg, id);
  const next = enabled === null ? !current.enabled : Boolean(enabled);
  const res = widgets.patchWidget(cfg, id, { enabled: next });
  if (!res.ok) return false;
  cfg.widgets = res.widgets;
  saveConfig(cfg);
  syncWidgets(cfg);
  refreshTray();
  if (win) win.webContents.send('config-changed', cfg);
  return next;
}

function refreshTray() {
  if (!tray) return;
  const state = monitor.getState();
  tray.setImage(nativeImage.createFromBuffer(drawIcon(16, state.status)));
  tray.setToolTip(monitor.tooltip());
  tray.setContextMenu(buildTrayMenu());
}

function notifyRecovery(state) {
  const cfg = state.config;
  if (!cfg.features.desktopNotifications || !Notification.isSupported()) return;

  const newest = state.events[0];
  if (!newest || newest.at <= lastNotifiedAt) return;
  // Only surface events worth interrupting for.
  if (![eventlog.KINDS.RECOVERED, eventlog.KINDS.NOTIFIED, eventlog.KINDS.BLOCKED].includes(newest.kind)) return;
  lastNotifiedAt = newest.at;

  const titles = {
    recovered: 'Session resumed',
    notified: 'Action needed',
    blocked: 'Recovery stopped',
  };
  new Notification({
    title: `Claude Lifeline — ${titles[newest.kind] || 'Update'}`,
    body: newest.detail || newest.label || newest.errorClass || '',
    silent: !cfg.features.soundAlerts,
    icon: nativeImage.createFromBuffer(drawIcon(64, newest.kind === 'recovered' ? 'running' : 'attention')),
  }).show();
}

/**
 * Toast when a session finishes working.
 *
 * The transition is detected against the previous poll (see completion.js), so this
 * fires once per finished prompt rather than continuously while a session sits idle.
 * The state map is updated even when the feature is off — otherwise switching it on
 * mid-session would treat every already-idle session as having just finished, and
 * announce a screenful of stale prompts.
 */
function notifyCompletions(state) {
  const { completed, next } = completion.findCompleted(state.sessions, lastSessionStatus);
  lastSessionStatus = next;

  const cfg = state.config;
  if (!cfg.features.promptCompleteNotifications || !Notification.isSupported()) return;

  for (const session of completed) {
    const label = completion.sessionLabel(session);
    new Notification({
      title: 'Claude Lifeline — Session finished',
      body: `${label} has finished working and is waiting for you.`,
      silent: !cfg.features.soundAlerts,
      icon: nativeImage.createFromBuffer(drawIcon(64, 'running')),
    }).show();
  }
}

app.whenReady().then(() => {
  // Hide from the taskbar switcher; the tray is the entry point.
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    /**
     * Setting the id is only half of it: Windows reads the *name* to show on a
     * toast from the registry, and with nothing registered it prints the raw id.
     * Not awaited — a toast needs a recovery to happen first, so there is time,
     * and startup should not block on a cosmetic registry write.
     */
    registerToastIdentity();
  }

  monitor = new Monitor({ pollMs: 5_000 }).start();
  analytics = new AnalyticsService({ loadConfig });
  createWindow();

  tray = new Tray(nativeImage.createFromBuffer(drawIcon(16, monitor.getState().status)));
  tray.setToolTip(monitor.tooltip());
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => showWindow('dashboard'));

  monitor.on('update', (state) => {
    refreshTray();
    if (win) win.webContents.send('state', serialisableState(state));
    // The status widget's whole job is being current, so it hears every poll. Sent
    // per widget rather than broadcast with one payload, because the two get
    // different slices — see widgetState.
    for (const id of widgets.WIDGET_IDS) {
      if (widgetWindows.isOpen(id)) widgetWindows.send(id, 'widget-state', widgetState(id));
    }
    notifyRecovery(state);
    notifyCompletions(state);
  });

  const cfg = loadConfig();

  // An upgrade that carried settings forward is worth a line in the log — it is
  // the only evidence the user has that their config was rewritten, and where the
  // backup went if it went wrong.
  const mig = loadConfig.lastMigration;
  if (mig && mig.migrated) {
    eventlog.append({
      kind: eventlog.KINDS.INFO,
      detail: `Settings upgraded from schema v${mig.from} to v${mig.to}.${mig.backup ? ` A copy of the old file was kept at ${mig.backup}.` : ''}`,
    });
    // Persist the upgraded shape so the next launch has nothing to do.
    saveConfig(cfg);
  } else if (mig && mig.newer) {
    eventlog.append({
      kind: eventlog.KINDS.INFO,
      detail: `Settings were written by a newer Lifeline (schema v${mig.from}); this version understands v${SCHEMA_VERSION}. Unknown settings are preserved but ignored.`,
    });
  }

  autoInstallHooks(cfg);
  // Launchpad hotkeys are global, so they work whether or not the window is open —
  // which is the point of a shortcut you press instead of going to find a button.
  registerPresetShortcuts();
  // Both off unless the user turned them on, so on most machines this does nothing.
  syncWidgets(cfg);

  /**
   * Re-place the widgets when the display layout changes.
   *
   * This is the case the placement logic exists for: undock the laptop and a widget
   * that was on the second monitor is at coordinates that no longer exist. It has no
   * taskbar button and no alt-tab entry, so there is no way for the user to go and
   * find it — the app has to notice. `sync` alone would not do it, because the
   * window is already open and `apply` does not touch position, so the widgets are
   * closed and rebuilt, which sends them back through placeOn.
   */
  for (const event of ['display-removed', 'display-added', 'display-metrics-changed']) {
    screen.on(event, () => {
      const current = loadConfig();
      widgetWindows.closeAll();
      syncWidgets(current);
    });
  }

  if (!cfg.ui.startMinimised || isDev || isE2E) showWindow('dashboard');
});

/**
 * Release the global hotkeys on the way out.
 *
 * Electron does this at exit anyway, but only for a clean one. Doing it explicitly
 * means a relaunch after a crash can rebind them rather than finding them held by
 * a process that is gone.
 */
app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* nothing was registered */
  }
});

/**
 * Register any missing hooks at startup, without being asked.
 *
 * Lifeline can recover nothing until its hooks are in Claude Code's
 * settings.json, so leaving that as a manual step means the common case is an app
 * that looks installed and does nothing. Doing it automatically is safe because
 * installer.install() backs the file up, merges rather than replaces, and is
 * idempotent — a second run upgrades our entries in place.
 *
 * Two things hold it back, and both are deliberate:
 *
 *   - `hooks.optedOut`, set when the user uninstalls from the UI. An explicit
 *     removal outranks a default, or the two would fight on every launch.
 *   - Any error at all. A malformed settings.json makes install() throw rather
 *     than overwrite, and a startup path is exactly where that must stay quiet
 *     and visible in the log rather than becoming a modal the user cannot act on.
 *
 * Already-running sessions are unaffected: Claude Code reads hooks at startup, so
 * this only changes what happens in sessions started from here on. That is what
 * makes it safe to do while other sessions are working.
 */
function autoInstallHooks(cfg) {
  const opts = cfg.hooks || {};
  if (opts.autoInstall === false || opts.optedOut) return;

  let st;
  try {
    st = installer.status();
  } catch {
    return; // unreadable settings — the banner in the UI will say so
  }
  if (st.complete) return;

  try {
    const res = installer.install();
    eventlog.append({
      kind: eventlog.KINDS.INFO,
      detail:
        `Recovery hooks installed automatically for ${res.installed.join(', ')}. ` +
        'Claude Code loads hooks at session start, so sessions already running are unchanged — restart them to be protected.' +
        (res.backup ? ` A backup of settings.json was saved to ${res.backup}.` : ''),
    });
    if (win) win.webContents.send('hooks-changed', installer.status());
    refreshTray();
  } catch (err) {
    eventlog.append({
      kind: eventlog.KINDS.ERROR,
      detail: `Could not install recovery hooks automatically: ${err.message}`,
    });
  }
}

app.on('window-all-closed', () => {
  // Deliberately empty: the tray keeps the app alive.
});

app.on('before-quit', () => {
  quitting = true;
  if (monitor) monitor.stop();
  /**
   * Widgets close with the app.
   *
   * They have no `close` guard of their own, so without this they would be
   * destroyed by Electron anyway — but that skips the debounced position save. A
   * widget dragged and then quit within the debounce window would forget where it
   * was put, which is the one thing a widget is expected to remember.
   */
  for (const id of widgets.WIDGET_IDS) {
    if (!widgetWindows.isOpen(id)) continue;
    const pos = widgetWindows.position(id);
    if (pos) saveWidgetPosition(id, pos);
  }
  widgetWindows.closeAll();
});

/** Trim the state to what the UI renders; transcripts and paths stay in main. */
function serialisableState(state) {
  return {
    status: state.status,
    config: state.config,
    summary: state.summary,
    stats: state.stats,
    sessions: state.sessions.map((s) => ({
      sessionId: s.sessionId,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      kind: s.kind,
      alive: s.alive,
      stale: s.stale,
      idleMs: s.idleMs,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      /**
       * When the transcript was last written, and the later of that and
       * `updatedAt`.
       *
       * Both are carried because they answer different questions and the UI shows
       * both: `updatedAt` is when the *status* last changed, which is what the
       * Sessions table's "Last update" column has always meant, while `activeAt`
       * is when the session last actually did something. Reporting only the former
       * is what made working sessions display as stalled — see sessions.js.
       */
      touchedAt: s.touchedAt,
      activeAt: s.activeAt,
      pid: s.pid,
    })),
    events: state.events,
    attention: state.attention,
    lastPollAt: state.lastPollAt,
    hooks: installer.status(),
    iconUrl: iconDataUrl(64, state.status),
    paths: {
      home: paths.lifelineHome(),
      settings: paths.claudeSettingsFile(),
      config: paths.configFile(),
      events: paths.eventLogFile(),
      hook: paths.hookEntry(),
    },
    // Descriptive half of the policy table, plus the *resolved* outcome for each
    // class. The renderer needs the labels and rationales to explain each class;
    // shipping them from here keeps one source of truth instead of a second copy
    // in the UI. `effective` matters because the answer is not just the switch:
    // the non-retryable guard can override it, and the UI has to say so rather
    // than showing a toggle that looks on but is not.
    policyMeta: ERROR_CLASSES.map((cls) => {
      const eff = effectivePolicy(cls, state.config);
      return {
        key: cls,
        label: POLICIES[cls].label,
        reason: POLICIES[cls].reason,
        strategy: POLICIES[cls].strategy,
        defaultResume: POLICIES[cls].resume,
        effective: {
          resume: eff.resume,
          strategy: eff.strategy,
          blockedBy: eff.blockedBy || null,
        },
      };
    }),
    /**
     * What version of everything is actually running.
     *
     * From `app.getVersion()` rather than a `require` of package.json, because in
     * a packaged build those are two different files: electron-builder writes the
     * version into the app metadata, and a stale bundled package.json would have
     * the About page confidently name a version the user is not running. The
     * runtime versions come along because "which Electron" is the first question
     * asked on any rendering bug report, and `schema` because a config written by
     * a newer Lifeline is a real situation the app already warns about.
     */
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      schema: SCHEMA_VERSION,
    },
    /** Model ids with built-in rates, so the UI can offer them for overriding. */
    pricingModels: Object.keys(RATES),
    /**
     * The built-in rates themselves.
     *
     * Sent rather than duplicated in the renderer, and needed rather than merely
     * nice: editing one cell has to write a whole row (a partial override prices
     * the other three kinds at the generic fallback), so the UI needs the real
     * starting values. It used to guess them as zeros, which quietly made one
     * edited cell zero out the rest of the row.
     */
    pricingRates: RATES,
  };
}

// ---- IPC ----

ipcMain.handle('get-state', () => serialisableState(monitor.getState()));

ipcMain.handle('save-config', (_e, patch) => {
  // Merged, not replaced: the UI sends only the fields it changed, so a partial
  // patch must never blank out settings it did not know about.
  const cfg = saveConfig(deepMerge(loadConfig(), patch));
  monitor.poll();
  refreshTray();
  // Unconditional rather than only when the patch mentions widgets: `sync` is
  // idempotent, and a check on the patch shape is one more thing to get wrong than
  // a call that costs nothing when nothing changed.
  syncWidgets(cfg);
  if (win) win.webContents.send('config-changed', cfg);
  return cfg;
});

ipcMain.handle('reset-config', () => {
  const cfg = saveConfig(defaultConfig());
  monitor.poll();
  refreshTray();
  // Defaults have both widgets off, so this closes them — which is the right
  // reading of "reset to defaults" even though it makes two windows disappear.
  syncWidgets(cfg);
  return cfg;
});

/**
 * Drop every model rate override.
 *
 * A dedicated channel because save-config cannot express this. Patches are
 * deep-merged so that a partial save never blanks out a setting it did not know
 * about — which means `{analytics: {rates: {}}}` recurses into the empty object
 * and changes nothing at all. The right fix is a handler that says "remove", not
 * a merge that can be talked into deleting keys.
 */
ipcMain.handle('reset-rates', () => {
  const cfg = loadConfig();
  cfg.analytics = { ...(cfg.analytics || {}), rates: {} };
  saveConfig(cfg);
  monitor.poll();
  return cfg;
});

ipcMain.handle('install-hooks', () => {
  const res = installer.install();
  // Installing by hand also clears an earlier opt-out, so the next launch keeps
  // them in place rather than leaving them to rot if they are ever removed
  // out-of-band.
  saveConfig(deepMerge(loadConfig(), { hooks: { optedOut: false } }));
  refreshTray();
  return res;
});

ipcMain.handle('uninstall-hooks', () => {
  const res = installer.uninstall();
  // Remembered, so startup does not put back what the user just removed.
  saveConfig(deepMerge(loadConfig(), { hooks: { optedOut: true } }));
  refreshTray();
  return res;
});

ipcMain.handle('clear-attention', () => {
  // Acknowledgement, not deletion: history stays, the badge clears.
  eventlog.append({ kind: eventlog.KINDS.INFO, detail: 'Attention items acknowledged.', acknowledgesUntil: Date.now() });
  monitor.poll();
  return true;
});

ipcMain.handle('ledger-stats', () => ledger.stats());

/**
 * Analytics. Split in two on purpose:
 *
 *   'analytics-snapshot' never scans — the renderer calls it on every state push,
 *   so it has to be free.
 *   'analytics-report' may scan, and is only reached when the user opens the tab
 *   or presses Refresh.
 */
ipcMain.handle('analytics-snapshot', () => (analytics ? analytics.snapshot() : null));

ipcMain.handle('analytics-report', async (_e, opts) => {
  if (!analytics) return null;
  return analytics.get({ force: Boolean(opts && opts.force) });
});

ipcMain.handle('open-path', (_e, which) => {
  // Allowlisted targets only — the renderer never gets to name an arbitrary path.
  const targets = {
    settings: paths.claudeSettingsFile(),
    config: paths.configFile(),
    events: paths.eventLogFile(),
    home: paths.lifelineHome(),
  };
  return shell.openPath(targets[which] || targets.home);
});

/**
 * The only URLs Lifeline will ever open, keyed rather than passed.
 *
 * Same reasoning as open-path: an open-anything channel is a way to turn injected
 * text — and transcripts are full of untrusted text — into a browser launch at
 * someone else's address.
 */
const LINKS = {
  repo: 'https://github.com/AndreiElekesIntel/claude-lifeline',
  issues: 'https://github.com/AndreiElekesIntel/claude-lifeline/issues',
  releases: 'https://github.com/AndreiElekesIntel/claude-lifeline/releases/latest',
};

ipcMain.handle('open-link', (_e, which) => {
  const url = LINKS[which];
  if (!url) return false;
  shell.openExternal(url);
  return true;
});

/**
 * Past sessions, grouped into days and optionally filtered.
 *
 * Grouped here rather than in the renderer because the day totals have to union
 * overlapping intervals — run three agents for an hour and summing their durations
 * reports three hours — and that logic lives in history.js where it is unit-tested
 * against fixed timestamps. Doing it in main also keeps the raw `intervals` arrays
 * out of the renderer, which is most of the payload's weight and none of its use.
 *
 * Never scans: it groups whatever the last analytics report holds, so typing in the
 * search box cannot trigger a transcript read. The tab asks for a report first.
 */
ipcMain.handle('history-groups', (_e, opts) => {
  const snap = analytics ? analytics.snapshot() : null;
  if (!snap || snap.disabled) return { disabled: true, groups: [], totals: null };
  if (!snap.report) return { disabled: false, groups: [], totals: null, empty: true };

  const query = String((opts && opts.query) || '').slice(0, 200);
  const groups = history.groupByDay(snap.report.recent, { query });

  return {
    disabled: false,
    generatedAt: snap.generatedAt,
    /** Before filtering, so the UI can say "3 of 214" rather than just "3". */
    total: snap.report.recent.length,
    totals: history.summarise(groups),
    groups: groups.map((g) => ({
      key: g.key,
      label: g.label,
      count: g.count,
      activeMs: g.activeMs,
      overlapping: g.overlapping,
      costUsd: g.costUsd,
      tokens: g.tokens,
      sessions: g.sessions.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        lastPrompt: s.lastPrompt,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        model: s.model,
        firstAt: s.firstAt,
        lastAt: s.lastAt,
        activeMs: s.activeMs,
        userMessages: s.userMessages,
        costUsd: s.costUsd,
        // `intervals` deliberately dropped — see above.
      })),
    })),
  };
});

/* ===================== launching and renaming sessions ==================== */

/**
 * Where the generated launch pairs for *presets* live.
 *
 * Lifeline's own data directory rather than TEMP, because a desktop shortcut
 * points at one of these files and outlives every cleanup TEMP is subject to. A
 * one-off resume still goes to TEMP: nothing keeps a reference to it.
 */
function presetLaunchDir() {
  return path.join(paths.lifelineHome(), 'launch');
}

/**
 * Which Node binary the generated batch file should run.
 *
 * In a packaged build there is no `node.exe` to rely on, so Electron's own
 * executable is used with ELECTRON_RUN_AS_NODE — which the batch file sets.
 */
function launcherNode() {
  return process.execPath;
}

/**
 * Resume a session in a new terminal window.
 *
 * The session id is checked against what is actually on disk before it reaches a
 * command line. That is the same rule as `open-path` and `open-link`: the renderer
 * names something, main decides whether it exists. The ids here are especially
 * worth checking because they arrive from the analytics scan, which reads
 * transcripts — files full of model output — so treating one as a trusted string
 * would mean transcript content choosing what gets executed.
 *
 * Two independent sources count as proof of existence: a live session record, or a
 * transcript file in the projects tree. Anything else is refused, and the cwd is
 * taken from whichever record matched rather than from the renderer, so a resume
 * cannot be redirected into a directory the user never had a session in.
 */
ipcMain.handle('resume-session', (_e, sessionId) => {
  const id = String(sessionId || '');
  if (!launcher.SESSION_ID_RE.test(id)) return { ok: false, reason: 'That is not a session id.' };

  const live = monitor.getState().sessions.find((s) => s.sessionId === id);
  const transcript = sessionRename.findTranscript(id);
  if (!live && !transcript) {
    return { ok: false, reason: 'Lifeline could not find that session on disk — its transcript may have been pruned.' };
  }

  /**
   * Resuming a session that is still running is refused.
   *
   * `claude --resume` on a live session opens a second process against the same
   * transcript, and both then append to it. That is exactly the interleaving
   * session-rename.js refuses a rename for, except worse: this one keeps writing.
   * The user's standing instruction is that Lifeline must not disturb ongoing work.
   */
  if (live && live.alive) {
    return { ok: false, reason: 'That session is still running. Resuming it would start a second process writing to the same transcript.' };
  }

  // From the record, never from the renderer — see above.
  const cwd = (live && live.cwd) || (transcript ? cwdForTranscript(transcript) : null);

  try {
    const res = launchSession({ resumeId: id, cwd: cwd || undefined, label: `Resume ${id.slice(0, 8)}` });
    eventlog.append({ kind: eventlog.KINDS.INFO, detail: `Resumed session ${id.slice(0, 8)} in a new window.`, sessionId: id });
    return { ok: true, via: res.via, spec: res.spec };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

/**
 * Recover a working directory from a transcript path.
 *
 * The project directory name is the cwd with every non-alphanumeric character
 * replaced by a dash, which is not reversible — `C--Users-a-b` could have been
 * `C:\Users\a\b` or `C:\Users\a-b`. So rather than guess, the transcript's own
 * `cwd` field is read: Claude Code records it on the records it writes.
 */
function cwdForTranscript(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 64_000);
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
      } catch {
        /* a partial line; try the next */
      }
    }
  } catch {
    /* unreadable: launch without a cwd rather than not at all */
  }
  return null;
}

/**
 * Whether a session can be renamed, and why not if it cannot.
 *
 * Exposed separately so the UI can disable the control *before* the user types a
 * name, rather than taking the input and then rejecting it.
 */
ipcMain.handle('can-rename-session', (_e, sessionId) => {
  const res = sessionRename.canRename(String(sessionId || ''), monitor.getState().sessions);
  // The file path stays in main; the renderer only needs the verdict.
  return { ok: res.ok, reason: res.reason || null };
});

ipcMain.handle('rename-session', (_e, sessionId, name) => {
  const res = sessionRename.rename(String(sessionId || ''), name, { liveSessions: monitor.getState().sessions });
  // The title the History tab shows comes from the analytics report, so the cached
  // one has to be retired or the rename looks like it did nothing.
  if (res.ok && analytics) analytics.stale();
  return { ok: res.ok, reason: res.reason || null, name: res.name || null };
});

/* ================================ launchpad =============================== */

/** Launch a saved preset. Named by id, so the renderer sends no launch details. */
ipcMain.handle('launch-preset', (_e, id) => {
  const preset = launchpad.findPreset(loadConfig(), id);
  if (!preset) return { ok: false, reason: 'That shortcut no longer exists.' };
  try {
    const res = launchSession(preset);
    return { ok: true, via: res.via, spec: res.spec };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

/** Create or update a preset. Validation lives in launchpad.js, not here. */
ipcMain.handle('save-preset', (_e, input) => {
  const cfg = loadConfig();
  const res = launchpad.upsertPreset(cfg, input);
  if (!res.ok) return { ok: false, reason: res.reason };
  cfg.launchpad = { ...(cfg.launchpad || {}), presets: res.presets };
  saveConfig(cfg);
  registerPresetShortcuts();
  if (win) win.webContents.send('config-changed', cfg);
  return { ok: true, preset: res.preset };
});

ipcMain.handle('delete-preset', (_e, id) => {
  const cfg = loadConfig();
  const gone = launchpad.findPreset(cfg, id);
  cfg.launchpad = { ...(cfg.launchpad || {}), presets: launchpad.removePreset(cfg, id) };
  saveConfig(cfg);
  registerPresetShortcuts();
  // A desktop icon left pointing at a deleted preset would fail on click, so it
  // goes too. Best-effort: the preset is gone either way.
  if (gone) launchpad.removeDesktopShortcut(gone, { desktopDir: desktopDir() });
  if (win) win.webContents.send('config-changed', cfg);
  return { ok: true };
});

ipcMain.handle('reorder-presets', (_e, ids) => {
  const cfg = loadConfig();
  cfg.launchpad = { ...(cfg.launchpad || {}), presets: launchpad.reorderPresets(cfg, ids) };
  saveConfig(cfg);
  if (win) win.webContents.send('config-changed', cfg);
  return { ok: true };
});

/**
 * Choose a working directory with the native picker.
 *
 * The renderer has no filesystem access, so a preset's cwd would otherwise have to
 * be typed from memory — and a typo produces a shortcut that fails on click, in a
 * window that closes. The dialog also means the path is one that exists.
 */
ipcMain.handle('pick-directory', async () => {
  const res = await dialog.showOpenDialog(win || undefined, {
    title: 'Choose a project folder',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  return { ok: true, path: res.filePaths[0] };
});

/**
 * The skills installed for this user, to offer in the preset editor.
 *
 * Read from disk rather than typed, because a skill that does not exist becomes a
 * `/name` line in the prompt that Claude Code reads as prose — the session starts,
 * does the wrong thing, and nothing reports an error. Names only; the contents are
 * none of the renderer's business.
 */
ipcMain.handle('list-skills', () => {
  const out = [];
  const roots = [path.join(paths.claudeHome(), 'skills')];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // no skills installed, which is normal
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // A skill is a directory with a SKILL.md in it. Checking means the list holds
      // real skills rather than every stray folder under ~/.claude/skills.
      try {
        if (!fs.statSync(path.join(root, entry.name, 'SKILL.md')).isFile()) continue;
      } catch {
        continue;
      }
      if (launcher.SKILL_RE.test(entry.name) && !out.includes(entry.name)) out.push(entry.name);
    }
  }
  return out.sort();
});

/** The user's Desktop, from Electron rather than assembled from a home path. */
function desktopDir() {
  // A test must never write an icon to the developer's real Desktop, and it also
  // cannot assert on one it is not allowed to look at.
  if (process.env.LIFELINE_DESKTOP_DIR) return process.env.LIFELINE_DESKTOP_DIR;
  try {
    // Asked of the OS because it is not `~/Desktop` on this class of machine: a
    // OneDrive-redirected profile puts it under the sync root, and writing to the
    // wrong one produces a shortcut the user never sees.
    return app.getPath('desktop');
  } catch {
    return null;
  }
}

ipcMain.handle('preset-to-desktop', (_e, id) => {
  const preset = launchpad.findPreset(loadConfig(), id);
  if (!preset) return { ok: false, reason: 'That shortcut no longer exists.' };
  const res = launchpad.writeDesktopShortcut(preset, {
    desktopDir: desktopDir(),
    launchDir: presetLaunchDir(),
    launcher,
    iconPath: shortcutIconPath(),
  });
  return res.ok ? { ok: true, lnk: res.lnk } : { ok: false, reason: res.reason };
});

/**
 * An icon for the desktop shortcuts.
 *
 * The app's own `.ico` if it shipped one, so the shortcut is recognisable rather
 * than wearing cmd.exe's icon. Null when it cannot be found, which just means the
 * shortcut looks like its target — not a failure worth reporting.
 */
function shortcutIconPath() {
  for (const p of [path.join(process.resourcesPath || '', 'icon.ico'), path.join(__dirname, '..', '..', 'build', 'icon.ico')]) {
    try {
      if (p && fs.statSync(p).isFile()) return p;
    } catch {
      /* try the next */
    }
  }
  return null;
}

/**
 * Bind each preset's accelerator as a global hotkey.
 *
 * Global, because the point of a shortcut dashboard is starting a session without
 * going to find a window first. Re-registered wholesale on every change rather
 * than diffed: the set is tiny, and a diff that gets it wrong leaves a hotkey
 * bound to a preset that no longer exists.
 *
 * A registration that fails is reported once in the event log and otherwise
 * ignored — another app owning Ctrl+Alt+1 is normal, and it must not stop the
 * other presets from binding.
 */
function registerPresetShortcuts() {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* nothing was registered */
  }
  for (const preset of launchpad.listPresets(loadConfig())) {
    if (!preset.accelerator) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(preset.accelerator, () => {
        try {
          launcher.launch(preset, { node: launcherNode() });
        } catch {
          /* the window it would have opened is the error report */
        }
      });
    } catch {
      ok = false;
    }
    if (!ok) {
      eventlog.append({
        kind: eventlog.KINDS.INFO,
        detail: `Could not bind ${preset.accelerator} for "${preset.label}" — another app may already own it.`,
      });
    }
  }
}

/* ============================= widget IPC ================================ */

/**
 * A widget's id, taken from the window rather than from the message.
 *
 * Every widget channel could just trust the id the renderer sends — it comes from
 * the query string main itself put there. Attributing it to the sending webContents
 * instead means a widget can only ever change its own settings and its own height,
 * which keeps the two windows genuinely independent rather than independent by
 * convention.
 */
function widgetIdOf(event, claimed) {
  const actual = widgetWindows.idFor(event.sender);
  if (actual) return actual;
  // Under a test that drives the page directly there is no registered window; the
  // claimed id is still checked against the known set before it is used.
  return widgets.WIDGET_IDS.includes(claimed) ? claimed : null;
}

/**
 * First paint. Returns everything the renderer needs and reveals the window.
 *
 * The reveal happens here rather than at create time because a transparent
 * frameless window shown before its first paint flashes black — and a widget sits
 * on top of everything, so that flash is about as visible as a flash can be.
 */
ipcMain.handle('widget-ready', (event, id) => {
  const widgetId = widgetIdOf(event, id);
  if (!widgetId) return null;
  widgetWindows.reveal(widgetId);
  return {
    settings: widgets.widgetSettings(loadConfig(), widgetId),
    state: widgetState(widgetId),
  };
});

/** The height the content measured. Clamped in widget-windows. */
ipcMain.handle('widget-height', (event, id, px) => {
  const widgetId = widgetIdOf(event, id);
  if (!widgetId) return false;
  widgetWindows.setHeight(widgetId, px);
  return true;
});

/**
 * A settings change made from the widget's own popover.
 *
 * Normalised by widgets.js on the way in, then applied and echoed back — so a
 * value the renderer optimistically applied and main rejected corrects itself
 * rather than persisting only in the DOM.
 */
ipcMain.handle('widget-patch', (event, id, patch) => {
  const widgetId = widgetIdOf(event, id);
  if (!widgetId) return null;

  const cfg = loadConfig();
  const res = widgets.patchWidget(cfg, widgetId, patch);
  if (!res.ok) return null;
  cfg.widgets = res.widgets;
  saveConfig(cfg);
  syncWidgets(cfg);
  // The Settings tab shows the same values, so it hears about a change made from
  // the widget — otherwise the two disagree until the tab is reopened.
  if (win) win.webContents.send('config-changed', cfg);
  return res.settings;
});

/**
 * The widget's own close button.
 *
 * Turns the widget *off* rather than merely hiding the window: a hidden widget with
 * `enabled: true` would come back on the next sync, and the close button on a
 * desktop widget means "I do not want this", not "not now". The tray and Settings
 * both put it back.
 */
ipcMain.handle('widget-hide', (event, id) => {
  const widgetId = widgetIdOf(event, id);
  if (!widgetId) return false;
  toggleWidget(widgetId, false);
  return true;
});

/** Bring the main window up on a named tab. A key, never a path. */
ipcMain.handle('widget-open-main', (_e, tab) => {
  const tabs = ['dashboard', 'sessions', 'history', 'launchpad', 'analytics', 'coverage', 'activity', 'settings', 'about'];
  showWindow(tabs.includes(tab) ? tab : 'dashboard');
  return true;
});

/**
 * Forget a widget's saved position.
 *
 * For the case the placement logic cannot fix on its own: a widget the user has
 * lost track of, on a layout where it is technically visible. Clearing the
 * coordinates and reopening sends it back through placeOn's default corner.
 */
ipcMain.handle('reset-widget-position', (_e, id) => {
  if (!widgets.WIDGET_IDS.includes(id)) return { ok: false };
  const cfg = loadConfig();
  const res = widgets.patchWidget(cfg, id, { x: null, y: null });
  if (!res.ok) return { ok: false, reason: res.reason };
  cfg.widgets = res.widgets;
  saveConfig(cfg);
  // Closed and rebuilt rather than synced: `apply` deliberately does not move a
  // window that is already open, so a reset would otherwise take effect only at
  // the next launch.
  widgetWindows.close(id);
  syncWidgets(cfg);
  if (win) win.webContents.send('config-changed', cfg);
  return { ok: true };
});

ipcMain.on('window-control', (_e, action) => {
  if (!win) return;
  if (action === 'minimise') win.minimize();
  else if (action === 'maximise') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.hide();
});
