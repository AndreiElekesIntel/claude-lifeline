'use strict';
/**
 * The only bridge between the renderer and Node.
 *
 * The renderer runs with contextIsolation on and nodeIntegration off, so it gets
 * this explicit surface and nothing more — it can ask for state and save config,
 * but it cannot touch the filesystem or spawn anything.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lifeline', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  resetConfig: () => ipcRenderer.invoke('reset-config'),
  /** Clear model rate overrides. Separate because a merged patch cannot delete. */
  resetRates: () => ipcRenderer.invoke('reset-rates'),
  installHooks: () => ipcRenderer.invoke('install-hooks'),
  uninstallHooks: () => ipcRenderer.invoke('uninstall-hooks'),
  clearAttention: () => ipcRenderer.invoke('clear-attention'),
  openPath: (which) => ipcRenderer.invoke('open-path', which),
  /**
   * Open one of Lifeline's own links in the system browser.
   *
   * Takes a key, not a URL: handing the renderer an open-anything channel would
   * turn any injected string into a way to launch a browser at an attacker's
   * address. Main owns the list (see LINKS in main.js).
   */
  openLink: (which) => ipcRenderer.invoke('open-link', which),
  /** Free: whatever analytics already knows, with no scan. */
  analyticsSnapshot: () => ipcRenderer.invoke('analytics-snapshot'),
  /** May read every transcript on disk, so it is only called on demand. */
  analyticsReport: (opts) => ipcRenderer.invoke('analytics-report', opts || {}),

  /**
   * Past sessions grouped by day, filtered by `query`.
   *
   * Grouped in main rather than here because a day's total has to union the
   * sessions' intervals — summing them triple-counts an hour with three agents in
   * it — and that arithmetic is unit-tested where it lives. Never scans: it groups
   * the last report, so typing in the search box costs nothing.
   */
  historyGroups: (opts) => ipcRenderer.invoke('history-groups', opts || {}),

  /**
   * Open a past session again, in a new terminal window.
   *
   * Takes an id, and main checks that id against the sessions and transcripts
   * actually on disk before any of it reaches a command line — the same "name a
   * key, never a path" rule as openPath and openLink. It matters more here: these
   * ids come from the analytics scan, which reads transcripts, so they are
   * model-authored text rather than something the app chose.
   */
  resumeSession: (sessionId) => ipcRenderer.invoke('resume-session', sessionId),
  /** Whether a rename is allowed *now*, so the UI can disable the control first. */
  canRenameSession: (sessionId) => ipcRenderer.invoke('can-rename-session', sessionId),
  renameSession: (sessionId, name) => ipcRenderer.invoke('rename-session', sessionId, name),

  /**
   * Launchpad presets.
   *
   * Launching names a preset by id rather than sending a configuration, so the
   * renderer cannot ask for a session that was never saved — the argv is always
   * built from config by main.
   */
  launchPreset: (id) => ipcRenderer.invoke('launch-preset', id),
  savePreset: (preset) => ipcRenderer.invoke('save-preset', preset),
  deletePreset: (id) => ipcRenderer.invoke('delete-preset', id),
  reorderPresets: (ids) => ipcRenderer.invoke('reorder-presets', ids),
  /** Write a real `.lnk` on the Desktop for this preset. */
  presetToDesktop: (id) => ipcRenderer.invoke('preset-to-desktop', id),
  /** Pick a working directory with the native dialog, since the renderer has no fs. */
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  /** Skill names found in ~/.claude/skills, to offer in the preset editor. */
  listSkills: () => ipcRenderer.invoke('list-skills'),

  onState: (cb) => {
    const h = (_e, state) => cb(state);
    ipcRenderer.on('state', h);
    return () => ipcRenderer.removeListener('state', h);
  },
  onNavigate: (cb) => {
    const h = (_e, tab) => cb(tab);
    ipcRenderer.on('navigate', h);
    return () => ipcRenderer.removeListener('navigate', h);
  },
  onConfigChanged: (cb) => {
    const h = (_e, cfg) => cb(cfg);
    ipcRenderer.on('config-changed', h);
    return () => ipcRenderer.removeListener('config-changed', h);
  },

  window: {
    minimise: () => ipcRenderer.send('window-control', 'minimise'),
    maximise: () => ipcRenderer.send('window-control', 'maximise'),
    close: () => ipcRenderer.send('window-control', 'close'),
  },
});
