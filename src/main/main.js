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

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, shell, dialog } = require('electron');
const path = require('path');

const { Monitor } = require('./monitor');
const { AnalyticsService } = require('./analytics-service');
const { drawIcon, iconDataUrl } = require('./tray-icon');
const { loadConfig, saveConfig, defaultConfig, deepMerge } = require('../shared/config');
const { SCHEMA_VERSION } = require('../shared/migrate');
const { ERROR_CLASSES, POLICIES, effectivePolicy } = require('../shared/policy');
const { RATES } = require('../shared/pricing');
const installer = require('../shared/installer');
const eventlog = require('../shared/eventlog');
const ledger = require('../shared/ledger');
const paths = require('../shared/paths');

const isDev = process.argv.includes('--dev');
/**
 * Under test the window must be shown regardless of the saved preference: a
 * hidden window gets throttled by the compositor, which makes UI assertions
 * flaky for reasons that have nothing to do with the app.
 */
const isE2E = process.env.LIFELINE_E2E === '1';

let tray = null;
let win = null;
let monitor = null;
let analytics = null;
let quitting = false;
let lastNotifiedAt = 0;

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

app.whenReady().then(() => {
  // Hide from the taskbar switcher; the tray is the entry point.
  if (process.platform === 'win32') app.setAppUserModelId('com.aelekes.claudelifeline');

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
    notifyRecovery(state);
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

  if (!cfg.ui.startMinimised || isDev || isE2E) showWindow('dashboard');
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
  if (win) win.webContents.send('config-changed', cfg);
  return cfg;
});

ipcMain.handle('reset-config', () => {
  const cfg = saveConfig(defaultConfig());
  monitor.poll();
  refreshTray();
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

ipcMain.on('window-control', (_e, action) => {
  if (!win) return;
  if (action === 'minimise') win.minimize();
  else if (action === 'maximise') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.hide();
});
