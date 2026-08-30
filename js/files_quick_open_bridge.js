/*
 * files_quick_open_bridge.js - the ONLY channel the claude.ai page can use to
 * reach the Files quick open backend. Injected into .vite/build/mainView.js by
 * patches/community/add_feature_files_quick_open_bridge.nim.
 *
 * SECURITY: the page behind this preload is REMOTE code. Fixed wrappers around
 * fixed channel names - no generic invoke passthrough. Argument shapes are
 * re-validated on the main side (js/files_quick_open_main.js).
 */
"use strict";
(function () {
  // __cdb_files_quick_open_bridge
  var electron = require("electron");
  var contextBridge = electron.contextBridge;
  var ipcRenderer = electron.ipcRenderer;
  if (!contextBridge || !ipcRenderer) return;

  contextBridge.exposeInMainWorld("cdbQuickOpen", {
    version: 1,
    state: function () { return ipcRenderer.invoke("cdb-qopen:state"); },
    prefRead: function () { return ipcRenderer.invoke("cdb-qopen:pref-read"); },
    prefSet: function (enabled) { return ipcRenderer.invoke("cdb-qopen:pref-set", enabled === true); }
  });
})();
