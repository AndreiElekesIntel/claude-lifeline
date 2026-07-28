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
  installHooks: () => ipcRenderer.invoke('install-hooks'),
  uninstallHooks: () => ipcRenderer.invoke('uninstall-hooks'),
  clearAttention: () => ipcRenderer.invoke('clear-attention'),
  openPath: (which) => ipcRenderer.invoke('open-path', which),

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
