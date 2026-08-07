/*
 * panel_tabs_layout.js - PURE tile-tree READERS for the panel tabs feature.
 * No DOM, no fiber, no side effects: this is the piece most likely to need
 * editing when upstream's node shape moves, so it is isolated and unit-tested
 * by scripts/tests/community/test-panel-tabs-layout.mjs.
 *
 * v2 (2026-08-04): the tree BUILDERS are gone. We no longer write upstream's
 * tileLayout at all - tabs are switched by toggling a CSS attribute on the
 * column wrappers, so build()/buildSplit() (and the structural signature that
 * existed purely as a loop guard for our own writes) had no callers left. What
 * remains is read-only: the layout is upstream's, we only interpret it.
 *
 * Upstream node shapes (1.24012.9):
 *   {kind:"stack", id, direction:"row"|"column", flex, children:[...]}
 *   {kind:"tile",  tileId, flex}
 */
(function () {
  "use strict";
  if (window.__cdbTabsLayout) return;

  var STORE_KEY = "epitaxy.sidePaneStore.v1";

  function tileIds(node) {
    var out = [];
    (function walk(n) {
      if (!n || typeof n !== "object") return;
      if (n.kind === "tile" && typeof n.tileId === "string") { out.push(n.tileId); return; }
      var kids = n.children;
      if (Object.prototype.toString.call(kids) === "[object Array]") {
        for (var i = 0; i < kids.length; i++) walk(kids[i]);
      }
    })(node);
    return out;
  }

  // Tab MEMBERSHIP and ORDER in v2: every panel the user has open is in
  // upstream's layout, so this list IS the tab strip (see panel_tabs_page.js,
  // which unions it with the columns it can actually resolve in the DOM).
  function sideTileIds(node) {
    var all = tileIds(node), out = [];
    for (var i = 0; i < all.length; i++) if (all[i] !== "chat") out.push(all[i]);
    return out;
  }

  // chatFlex = the chat tile's own flex; sideFlex = the SUM of the other
  // top-level children. In v2 sideFlex is the flex the ONE visible side column
  // is given (the hidden ones are display:none and take no space), so the
  // chat/side boundary lands exactly where upstream has it. Used only as the
  // FALLBACK for the DOM's own inline flex values - see sideFlexOf() in
  // panel_tabs_page.js.
  function geometry(node) {
    var chatFlex = 0, sideFlex = 0;
    var kids = (node && node.children) || [];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      var flex = typeof k.flex === "number" ? k.flex : 1;
      if (k.kind === "tile" && k.tileId === "chat") chatFlex += flex;
      else sideFlex += flex;
    }
    return { chatFlex: chatFlex, sideFlex: sideFlex };
  }

  function readStore() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var st = JSON.parse(raw).state;
      if (!st || !st.tileLayout) return null;
      return { tileLayout: st.tileLayout, tileLayoutBySession: st.tileLayoutBySession || {},
        currentSessionId: st.currentSessionId || null };
    } catch (e) { return null; }
  }

  window.__cdbTabsLayout = { tileIds: tileIds, sideTileIds: sideTileIds, geometry: geometry,
    readStore: readStore, STORE_KEY: STORE_KEY };
})();
