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
const { drawIcon, iconDataUrl } = require('./tray-icon');
const { loadConfig, saveConfig, defaultConfig, deepMerge } = require('../shared/config');
const { ERROR_CLASSES, POLICIES } = require('../shared/policy');
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
  if (!cfg.ui.startMinimised || isDev || isE2E) showWindow('dashboard');
});

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
    // Descriptive half of the policy table. The renderer needs the labels and
    // rationales to explain each class; shipping them from here keeps one
    // source of truth instead of a second copy in the UI.
    policyMeta: ERROR_CLASSES.map((cls) => ({
      key: cls,
      label: POLICIES[cls].label,
      reason: POLICIES[cls].reason,
      strategy: POLICIES[cls].strategy,
      defaultResume: POLICIES[cls].resume,
    })),
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

ipcMain.handle('install-hooks', () => {
  const res = installer.install();
  refreshTray();
  return res;
});

ipcMain.handle('uninstall-hooks', () => {
  const res = installer.uninstall();
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

ipcMain.on('window-control', (_e, action) => {
  if (!win) return;
  if (action === 'minimise') win.minimize();
  else if (action === 'maximise') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.hide();
});
