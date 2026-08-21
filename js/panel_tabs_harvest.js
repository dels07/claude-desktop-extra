/*
 * panel_tabs_harvest.js - resolves every anchor the panel tabs feature needs out
 * of remote claude.ai markup and its React fiber.
 *
 * Anchors live-confirmed 1.24012.9 (see the anchors doc): pane roots carry
 * [data-pane-root]; tile identity is an ancestor's memoizedProps.tileId; the
 * chrome-row controls are buttons whose aria-label is Expand / Collapse / Close.
 *
 * v2 (2026-08-04) removed the two most fragile things in here:
 *  - onLayoutChange (and the exact-name fiber-prop walker that found it). We no
 *    longer write upstream's tileLayout at all, so the feature no longer depends
 *    on an exact prop name sitting next to minified code.
 *  - the per-tileId handler CACHE. An inactive panel is now MOUNTED (just hidden
 *    by CSS), so its own chrome-row buttons are in the document and can simply be
 *    clicked - display:none does not prevent a programmatic .click(). Nothing
 *    needs a handler that outlives its tile any more.
 *
 * v3 (2026-08-06) removed the `+` menu's whole support layer with the menu itself:
 *  - openActions / syntheticEvent (the harvested React onClick openers) and the
 *    __reactProps$ walker they needed.
 *  - the entire `Session actions` machinery - sessionButton / sessionItems /
 *    sessionMenuOpen / livePortal / pressPointer / poll / openPanelViaSessionMenu /
 *    probeSessionItems / probeBlockedBecause / closeSessionMenu - plus the probe's
 *    injected hide stylesheet, its data-cdb-probe-hidden attribute on <html>, its
 *    watchdog and its generation token.
 * This module is now READ-ONLY: it queries the DOM and nothing else. Panels are
 * opened by upstream's own controls and the reconciler adopts whatever appears.
 *
 * THE remaining rule, still load-bearing: never a hardcoded hop count. Observed
 * hops were 1 / 39 / 51 on one build and are per-deploy; we SEARCH ancestors.
 */
(function () {
  "use strict";
  if (window.__cdbTabsHarvest) return;

  var PANE_SELECTOR = "[data-pane-root]";
  var PANE_FALLBACK = ".epitaxy-view-panel";
  var CLOSE_CONTROL = ".epitaxy-pane-close-control";
  var MAX_HOPS = 80;

  function keyFor(node, prefix) {
    for (var k in node) if (k.indexOf(prefix) === 0) return k;
    return null;
  }
  function fiberOf(node) {
    var k = node && keyFor(node, "__reactFiber$");
    return k ? node[k] : null;
  }
  function panes() {
    var list = document.querySelectorAll(PANE_SELECTOR);
    if (list.length) return Array.prototype.slice.call(list);
    // Fallback path only: skip aria-hidden view panels. Upstream renders an
    // aria-hidden="true" .epitaxy-view-panel GHOST inside the chat shell
    // (measured 2026-08-21 on 1.32352.1) - it has no fiber tileId, so counting
    // it here would report a pane that can never resolve and trip the
    // anchor-rot warning the moment [data-pane-root] goes away.
    var out = [], all = document.querySelectorAll(PANE_FALLBACK), i;
    for (i = 0; i < all.length; i++) {
      if (all[i].getAttribute && all[i].getAttribute("aria-hidden") === "true") continue;
      out.push(all[i]);
    }
    return out;
  }

  function tileIdOf(el) {
    var f = fiberOf(el), i = 0;
    while (f && i++ < MAX_HOPS) {
      var p = f.memoizedProps;
      if (p && typeof p.tileId === "string") return p.tileId;
      f = f.return;
    }
    return null;
  }

  function chromeRow(el) {
    var cc = el.querySelector(CLOSE_CONTROL);
    if (cc && cc.parentElement) return cc.parentElement;
    var btn = el.querySelector('button[aria-label="Close"]');
    return btn ? btn.parentElement : null;
  }

  function chromeButtons(el) {
    var row = chromeRow(el), out = { expand: null, collapse: null, close: null };
    if (!row) return out;
    var btns = row.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var label = btns[i].getAttribute("aria-label");
      if (label === "Expand") out.expand = btns[i];
      else if (label === "Collapse") out.collapse = btns[i];
      else if (label === "Close") out.close = btns[i];
    }
    return out;
  }

  // READ-ONLY, BY CONSTRUCTION. Every export here only queries the DOM; nothing in
  // this module presses a button, dispatches an event, injects a stylesheet or sets
  // an attribute on <html>. That was not true while the `+` menu existed - it needed
  // upstream's `Session actions` menu driven behind the user's back to find out what
  // a session offered - and the whole of that machinery was removed on 2026-08-06
  // when the menu was dropped. Panels are opened by upstream's own controls and the
  // reconciler adopts whatever appears, so nothing needs to synthesise input.
  //
  // Keep it that way: an export that mutates upstream's UI belongs in the page module
  // where the reconciler can see it, not in the harvester.
  window.__cdbTabsHarvest = {
    panes: panes, tileIdOf: tileIdOf, chromeButtons: chromeButtons };
})();
