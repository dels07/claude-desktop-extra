/*
 * panel_tabs_bridge.js - the ONLY channel the claude.ai page can use to reach
 * the panel tabs backend. Injected into .vite/build/mainView.js by
 * patches/add_feature_panel_tabs_bridge.nim.
 *
 * SECURITY: the page behind this preload is REMOTE code. Fixed wrappers around
 * fixed channel names - no generic invoke passthrough. Argument shapes are
 * re-validated on the main side (js/panel_tabs_main.js).
 */
"use strict";
(function () {
  // __cdb_panel_tabs_bridge
  var electron = require("electron");
  var contextBridge = electron.contextBridge;
  var ipcRenderer = electron.ipcRenderer;
  if (!contextBridge || !ipcRenderer) return;

  contextBridge.exposeInMainWorld("cdbTabs", {
    version: 1,
    state: function () { return ipcRenderer.invoke("cdb-tabs:state"); },
    prefRead: function () { return ipcRenderer.invoke("cdb-tabs:pref-read"); },
    prefSet: function (enabled) { return ipcRenderer.invoke("cdb-tabs:pref-set", enabled === true); }
  });
})();
