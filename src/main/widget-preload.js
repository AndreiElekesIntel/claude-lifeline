'use strict';
/**
 * The widgets' bridge to Node — deliberately much smaller than the main window's.
 *
 * A widget sits on the desktop with no frame and no title bar, which means it is
 * the easiest window in the app to mistake for part of something else. It gets only
 * what it needs to draw itself and start a session: no config writing beyond its own
 * settings, no filesystem, no analytics, no history.
 *
 * As in the main preload, anything that names something names a *key* — a widget id
 * or a preset id — never a path, a URL, or an argv. Main looks the id up and decides
 * what it means, so a string appearing in a widget cannot become a command.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Which widget this window is, from the query string main loaded it with. */
const widgetId = new URLSearchParams(location.search).get('widget') || 'status';

contextBridge.exposeInMainWorld('widget', {
  id: widgetId,

  /** Settings and state, pushed by main. Both arrive again on every change. */
  onSettings: (cb) => {
    const h = (_e, settings) => cb(settings);
    ipcRenderer.on('widget-settings', h);
    return () => ipcRenderer.removeListener('widget-settings', h);
  },
  onState: (cb) => {
    const h = (_e, state) => cb(state);
    ipcRenderer.on('widget-state', h);
    return () => ipcRenderer.removeListener('widget-state', h);
  },

  /** Ask for the current values, for the first paint before any push arrives. */
  ready: () => ipcRenderer.invoke('widget-ready', widgetId),

  /**
   * Report the height the content needs.
   *
   * The window is not resizable — a resize border on a widget invites the user to
   * fix a layout problem the app should not have — so the renderer measures itself
   * and the window follows. Main clamps the number.
   */
  setHeight: (px) => ipcRenderer.invoke('widget-height', widgetId, px),

  /** Change one of this widget's own settings. Cannot touch the other widget's. */
  patch: (patch) => ipcRenderer.invoke('widget-patch', widgetId, patch),

  /** Turn this widget off from its own close button. */
  hide: () => ipcRenderer.invoke('widget-hide', widgetId),

  /** Start a saved preset. Named by id: the argv is built in main from config. */
  launchPreset: (id) => ipcRenderer.invoke('launch-preset', id),

  /** Bring the main window up, optionally on a named tab. */
  openMain: (tab) => ipcRenderer.invoke('widget-open-main', tab),
});
