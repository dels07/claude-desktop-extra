/*
 * files_quick_open_page.js - the renderer half of the Files quick open feature.
 * Injected into the claude.ai page (main world) on dom-ready by
 * js/files_quick_open_main.js, which patches/community/add_feature_files_quick_open.nim
 * embeds. Talks to main ONLY through window.cdbQuickOpen (the preload bridge,
 * js/files_quick_open_bridge.js) and to upstream ONLY through APIs upstream itself
 * exposes to this page: window["claude.web"].Resources.fetchMentionOptions and the
 * Files tree's own React onPreview handler.
 *
 * WHAT IT DOES: Ctrl+P on the Code tab opens a VS Code-style quick-open box over
 * the Files tile. Typing queries upstream's fuzzy file index (the same one behind
 * the tile's own filter and the composer's @ picker); ArrowUp/Down + Enter or a
 * mouse click opens the pick as a file tab INSIDE the Files tile by calling the
 * tree's onPreview(absPath, line) - exactly what a click on a tree row does.
 * "path:42" opens at a line. An empty query lists recently opened files (MRU,
 * per tile root, in localStorage) - VS Code's "recently opened" section. With no
 * derivable tile root the MRU is disabled outright (see the MRU section).
 *
 * ANCHORS (remote claude.ai markup, measured 2026-08-29 on 1.37937.3; inventoried
 * in baseline/FILES_QUICK_OPEN_ANCHORS.md). Every one degrades to a no-op plus a
 * single console.warn per key - never a throw:
 *   PANE_SEL    the Files pane root
 *   FILTER_SEL  its filter box (only used as a fiber entry point of last resort)
 *   TREE_SEL / ROW_SEL   the tree and its (virtualized) rows
 *   SHOW_TREE_SEL  the toolbar button that brings a hidden tree back
 *   MENU_SEEDS -> SESSION_MENU_SEL  the session ⋮ (climbed to from a toolbar
 *                        button), and its "Files" entry - the only way to create
 *                        a Files pane when none is open
 *   fiber ancestor with memoizedProps.onPreview: function (path, line, findQuery)
 *                        (its memoizedProps.root, when a string, IS the tile root)
 *   row fiber ancestor with memoizedProps.entry {absPath, relativePath} -> tile root
 *                        (absent -> root null, MRU disabled, warning no-entry)
 *
 * THE TREE CAN BE HIDDEN. The Files pane showing an open file with its tree
 * collapsed has no tree, no rows, no filter box and NOTHING exposing onPreview
 * anywhere in its fibers (measured live 2026-08-29 on 1.40609.0). Upstream's own
 * "Show file tree" button restores all of it, so Ctrl+P clicks that button and
 * waits before harvesting. The modal still mounts synchronously - only the
 * harvest waits - and the tree is left visible afterwards.
 *
 * THE HARVEST IS THE WAIT CONDITION, not the DOM. The component that owns
 * onPreview is found by DESCENDING from the pane root (depth 10, ~55 fibers on
 * 1.40609.0) - the only strategy that works while the tree has rendered no rows,
 * which is exactly how a freshly opened pane starts. Walking UP still works from
 * a [role=treeitem] ROW and is kept as the fallback; up from the tree or the
 * filter box returns null, so "a tree exists" is not "we can open a file". The
 * page polls findPreviewProps() itself and keeps polling while it returns null,
 * up to TREE_WAIT_MS (PANE_WAIT_MS when a pane still has to be created).
 *
 * THE PANE CAN BE CLOSED ENTIRELY. Then nothing in the page exposes onPreview and
 * there is no "Show file tree" button either - the only way in is upstream's own
 * session menu (⋮ -> Files, its own Ctrl+F). Ctrl+P drives that menu: the user
 * asked to open a file, so opening the panel they would have opened by hand is
 * the point. The entry is a TOGGLE, so it is only ever pressed when there is no
 * pane - pressing it with one open would close the pane we need. Upstream's own
 * accelerator cannot be used instead: a synthetic Ctrl+F is untrusted and does
 * nothing (measured 1.40609.0). No menu is ever left hanging over the app.
 */
;(function () {
  "use strict";
  if (window.__cdbQuickOpenPage) return;

  var STATE_POLL_MS = (typeof window.__cdbQoTestPollMs === "number") ? window.__cdbQoTestPollMs : 5000;
  var MAX_RESULTS = 15;
  var MAX_MRU = 15;
  var DEBOUNCE_MS = 120;
  var MAX_HOPS = 60;
  // Descent bounds: the handler sits at depth 10 after ~55 fibers on 1.40609.0.
  var MAX_DESCEND_DEPTH = 40;
  var MAX_FIBER_VISITS = 4000;
  var PANE_SEL = '[data-pane-root][data-perf-screen="file"]';
  var FILTER_SEL = 'input[aria-label="Filter files"]';
  var TREE_SEL = '[role="tree"]';
  var ROW_SEL = '[role="treeitem"]';
  var SHOW_TREE_SEL = 'button[aria-label="Show file tree"]';
  // No pane at all: upstream's session ⋮ menu carries a Files entry (labelled
  // "Files" + its own Ctrl+F shortcut, rendered without a separator). The ⋮ is
  // NOT a sibling of the Terminal/Diff/Browser toolbar buttons - measured
  // 1.40609.0, it sits 2 parents above one of them, in the single ancestor that
  // holds exactly one "More options for …" button. That climb is the anchor: a
  // bare document query would hit any of the ~76 per-session ⋮ in the sidebar.
  var MENU_SEEDS = ['button[aria-label^="Diff ("]', 'button[aria-label="Terminal"]',
    'button[aria-label="Browser"]'];
  var SESSION_MENU_SEL = 'button[aria-label^="More options for "]';
  var MENU_ITEM_SEL = '[role="menuitem"],[role="menuitemcheckbox"]';
  // The rendered label runs the shortcut straight onto the word ("FilesCtrlF" on
  // 1.40609.0 - no separator, so \b would not match), hence a bare prefix test.
  var FILES_ITEM_RE = /^files/i;
  var MENU_CLIMB_HOPS = 6;
  var TREE_POLL_MS = 50;
  // The budget for the whole harvest, click included. A cold render was measured
  // at ~700 ms on 1.40609.0; 1500 was tight and the failure mode is silent.
  var TREE_WAIT_MS = 3000;
  // Opening a pane from scratch adds two upstream stages before the harvest can
  // even start: the menu renders, then the pane mounts (~900 ms end to end live).
  var MENU_WAIT_MS = 1500;
  var MENU_TIDY_MS = 400;
  var PANE_WAIT_MS = 5000;
  var ROOT_ID = "cdb-qopen";
  var STYLE_ID = "cdb-qopen-style";
  var MRU_PREFIX = "cdb-qopen-mru:";
  var HINT_NO_PANE = "Open the Files panel first (Session actions → Files)";
  var HINT_NO_HANDLER = "Cannot open files: the Files panel changed (onPreview anchor missing)";
  var HINT_OTHER_ROOT = "Results are for another session's folder - click into this session first";
  var HINT_EMPTY = "Type to search files in this session's folder";
  var HINT_NO_MATCH = "No matching files";
  var HINT_MRU = "Recently opened";
  var HINT_SHOWING_TREE = "Showing the file tree…";
  var HINT_OPENING_PANE = "Opening the Files panel…";
  var HINT_KEYS = "↑↓ to select · Enter to open · :<line> to jump";

  var warned = {};
  function warnOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    try { console.warn("[cdb-qopen] " + key + ": " + msg); } catch (e) {}
  }

  // ---- pref -------------------------------------------------------------------
  var enabled = false;
  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (!on) close();
  }
  function pollPref() {
    var b = window.cdbQuickOpen, p;
    if (!b || typeof b.state !== "function") { setEnabled(false); return; }
    try { p = b.state(); } catch (e) { warnOnce("pref-threw", "cdbQuickOpen.state() threw: " + ((e && e.message) || e)); return; }
    if (!p || typeof p.then !== "function") { warnOnce("pref-shape", "cdbQuickOpen.state() did not return a promise"); return; }
    p.then(function (r) { setEnabled(!!(r && r.ok === true && r.enabled === true)); }, function () {});
  }

  // ---- anchors ----------------------------------------------------------------
  function fiberOf(node) {
    if (!node) return null;
    for (var k in node) if (k.indexOf("__reactFiber$") === 0) return node[k];
    return null;
  }
  function filesPane() { return document.querySelector(PANE_SEL); }
  // A folder path with exactly one trailing slash, or null. The tile root is
  // concatenated with a relative path, so the slash has to be certain.
  function normRoot(r) {
    if (typeof r !== "string" || !r) return null;
    return r.charAt(r.length - 1) === "/" ? r : r + "/";
  }
  // The tree's open handler, plus the root it was rendered for. A ROW is the only
  // start that was ever measured to work (hop ~12, the list component just above
  // the rows); the walk up from the tree and from the filter box returned null on
  // 1.40609.0. The tree and the filter box are kept as fallback starts - harmless,
  // and cheap insurance if upstream moves the handler down - but the CALLER must
  // never treat "a tree exists" as "the harvest is done" (see awaitProbe).
  // The owning component carries the folder the tile shows as a string `root`
  // prop (measured alongside sessionId/scope/reveal), which is more direct than
  // deriving it from a row.
  // Returns { onPreview: function, root: string|null } or null.
  // DESCEND from the pane root. This is the primary strategy because it is the
  // only one that works when the tree has rendered NO rows - measured 1.40609.0
  // on a pane opened from scratch: the tree element is there, rows are still
  // empty, and walking UP from the tree or the filter box finds nothing, because
  // the component that owns onPreview is not their ancestor. Descending finds it
  // at depth 10 after ~55 fibers, and it carries the tile's `root` prop directly.
  function descendPreviewProps(pane) {
    var root = fiberOf(pane);
    if (!root) return null;
    var queue = [[root, 0]], visits = 0;
    while (queue.length && visits < MAX_FIBER_VISITS) {
      var entry = queue.shift(), f = entry[0], depth = entry[1];
      if (!f || depth > MAX_DESCEND_DEPTH) continue;
      visits++;
      var p = f.memoizedProps;
      if (p && typeof p === "object" && typeof p.onPreview === "function")
        return { onPreview: p.onPreview, root: normRoot(p.root) };
      if (f.child) queue.push([f.child, depth + 1]);
      if (f.sibling) queue.push([f.sibling, depth]);
    }
    return null;
  }
  function findPreviewProps(pane) {
    var down = descendPreviewProps(pane);
    if (down) return down;
    var starts = [pane.querySelector(ROW_SEL), pane.querySelector(TREE_SEL), pane.querySelector(FILTER_SEL)];
    for (var s = 0; s < starts.length; s++) {
      var f = fiberOf(starts[s]), i = 0;
      while (f && i++ < MAX_HOPS) {
        var p = f.memoizedProps;
        if (p && typeof p.onPreview === "function") return { onPreview: p.onPreview, root: normRoot(p.root) };
        f = f.return;
      }
    }
    return null;
  }
  // absPath minus relativePath of any rendered row = the folder the tile shows.
  function tileRoot(pane) {
    var rows = pane.querySelectorAll(ROW_SEL);
    for (var r = 0; r < rows.length; r++) {
      var f = fiberOf(rows[r]), i = 0;
      while (f && i++ < MAX_HOPS) {
        var p = f.memoizedProps, e = p && p.entry;
        if (e && typeof e.absPath === "string" && typeof e.relativePath === "string" &&
            e.absPath.length > e.relativePath.length &&
            e.absPath.slice(e.absPath.length - e.relativePath.length) === e.relativePath) {
          return e.absPath.slice(0, e.absPath.length - e.relativePath.length);
        }
        f = f.return;
      }
    }
    // Rows are rendered but none of them carries a usable entry -> the anchor
    // moved. Zero rows is NOT a warning: the pane is simply empty or filtered
    // down to nothing, and there is nothing to derive a root from either way.
    if (rows.length)
      warnOnce("no-entry", "no rendered row exposes entry.absPath/relativePath - tile root unknown, MRU disabled");
    return null;
  }
  // ONE harvest attempt over the pane's REMOTE fibers. Returns
  //   { onPreview, root } - the handler is reachable now
  //   null              - it is not there (yet); the caller may retry
  //   false             - a memoizedProps accessor THREW. That is not a "not
  //                       yet": remote code we do not control blew up, so the
  //                       caller stops retrying and reports the anchor as gone.
  // The fiber's own `root` prop wins; the row-derived root is the fallback (and
  // only then can the no-entry warning fire, since only then is it needed).
  function probe(pane) {
    if (!pane) return null;
    try {
      var hit = findPreviewProps(pane);
      if (!hit) return null;
      return { onPreview: hit.onPreview, root: hit.root || tileRoot(pane) };
    } catch (e) {
      warnOnce("open-threw", "harvesting the Files pane threw: " + ((e && e.message) || e));
      return false;
    }
  }
  // Writes a probe result into ctx. `final` = no further attempt is coming, so a
  // miss is now worth a warning (a miss on the FIRST attempt is routine: the pane
  // is still rendering).
  function settle(pane, hit, final) {
    if (!ctx) return;
    ctx.onPreview = hit ? hit.onPreview : null;
    ctx.root = (hit && hit.root) || null;
    if (final && pane && !ctx.onPreview)
      warnOnce("no-onpreview", "no fiber ancestor with an onPreview function under the Files pane");
  }
  // The pane can be showing an open file with the tree collapsed: no tree, no
  // rows, no filter box - and nothing anywhere in its fibers exposing onPreview
  // (measured 1.40609.0). Everything we need comes back when upstream's own
  // toolbar button is clicked, so click it rather than giving up.
  function treeHidden(pane) { return !pane.querySelector(TREE_SEL) && !pane.querySelector(ROW_SEL); }
  function showTreeButton(pane) { return pane ? pane.querySelector(SHOW_TREE_SEL) : null; }
  // Runs upstream's own toggle. false = the click threw, so nothing is coming and
  // there is nothing to wait for. The tree is left visible either way: it is
  // upstream's own toggle and the user asked for a file.
  function clickShowTree(btn) {
    try { btn.click(); return true; }
    catch (e) {
      warnOnce("show-tree-threw", "clicking the \"Show file tree\" button threw: " + ((e && e.message) || e));
      return false;
    }
  }
  // The session ⋮ button, found by climbing from a toolbar button it shares an
  // ancestor with (see MENU_SEEDS). More than one match means the climb left the
  // header and reached the sidebar's per-session menus, so it refuses instead of
  // opening a menu on some unrelated session.
  function sessionMenuButton() {
    for (var s = 0; s < MENU_SEEDS.length; s++) {
      var seed = document.querySelector(MENU_SEEDS[s]);
      var node = seed, hops = 0;
      while (node && hops++ < MENU_CLIMB_HOPS) {
        var found = node.querySelectorAll(SESSION_MENU_SEL);
        if (found.length === 1) return found[0];
        if (found.length > 1) break;             // ambiguous - try the next seed
        node = node.parentElement;
      }
    }
    return null;
  }
  // Upstream's menu renders after its own click, so the entry is polled for. The
  // label carries the shortcut ("Files" + Ctrl+F), hence a prefix match.
  function clickFilesMenuItem() {
    var items = document.querySelectorAll(MENU_ITEM_SEL);
    for (var i = 0; i < items.length; i++) {
      var text = (items[i].textContent || "").replace(/[^\x20-\x7e]/g, "").trim();
      if (!FILES_ITEM_RE.test(text)) continue;
      try { items[i].click(); return true; }
      catch (e) {
        warnOnce("files-item-threw", "clicking the session menu's Files entry threw: " + ((e && e.message) || e));
        return false;
      }
    }
    return false;
  }
  // Leaves no menu open over the app when we could not use it.
  function dismissMenu() {
    try { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (e) {}
  }
  // Drives ⋮ → Files and calls done(ok) exactly once. ok=false means no pane is
  // coming, so the caller stops rather than waiting out the harvest budget.
  function openFilesPane(opener, done) {
    var finished = false, waited = 0;
    function finish(ok) {
      if (finished) return;
      finished = true;
      // Upstream closes its own menu when an entry is chosen; if some menu is
      // still up shortly after, it is ours to clear - never leave one hanging
      // over the app.
      window.setTimeout(function () { if (document.querySelector(MENU_ITEM_SEL)) dismissMenu(); }, MENU_TIDY_MS);
      done(ok);
    }
    // Start from a known state: a menu already open (the user's, or one left by a
    // previous attempt) would make the click below TOGGLE it shut, and the entry
    // we then find would belong to a menu nobody asked for.
    if (document.querySelector(MENU_ITEM_SEL)) dismissMenu();
    try { opener.click(); }
    catch (e) {
      warnOnce("session-menu-threw", "clicking the session menu button threw: " + ((e && e.message) || e));
      finish(false);
      return;
    }
    var timer = window.setInterval(function () {
      waited += TREE_POLL_MS;
      if (!isOpen()) { clearInterval(timer); dismissMenu(); finish(false); return; }
      if (clickFilesMenuItem()) { clearInterval(timer); finish(true); return; }
      if (waited >= MENU_WAIT_MS) {
        clearInterval(timer);
        warnOnce("no-files-menu-item", "the session menu has no Files entry within " + MENU_WAIT_MS + "ms");
        dismissMenu();
        finish(false);
      }
    }, TREE_POLL_MS);
  }
  // Polls the HARVEST - not the DOM - until it yields a handler, and calls
  // done(hit|null, pane) exactly once. Waiting on `!treeHidden(pane)` instead was
  // the 1.40609.0 open-path bug: the tree element commits before its rows, the
  // first tick saw a tree, harvested nothing and never tried again.
  //
  // `pane` may be null: the pane is then re-queried every tick, which is what the
  // ⋮ → Files path needs (it is still mounting). A pane that arrives with its tree
  // collapsed gets upstream's own toggle pressed once, so both stages are covered
  // by this one loop.
  function awaitProbe(pane, done) {
    var finished = false, waited = 0, clickedShowTree = false;
    var budget = pane ? TREE_WAIT_MS : PANE_WAIT_MS;
    function finish(hit, p) { if (!finished) { finished = true; done(hit, p); } }
    var timer = window.setInterval(function () {
      waited += TREE_POLL_MS;
      if (!isOpen()) { clearInterval(timer); finish(null, pane); return; }   // the caller's own guard drops it
      var p = pane || filesPane();
      if (p) {
        if (!clickedShowTree && treeHidden(p)) {
          var btn = showTreeButton(p);
          if (btn) { clickedShowTree = true; clickShowTree(btn); }
        }
        var hit = probe(p);
        if (hit) { clearInterval(timer); finish(hit, p); return; }
        if (hit === false) { clearInterval(timer); finish(null, p); return; }   // threw: final, already warned
      }
      if (waited >= budget) {
        clearInterval(timer);
        warnOnce("harvest-timeout", "no onPreview handler appeared under the Files pane within " +
          budget + "ms");
        finish(null, p);
      }
    }, TREE_POLL_MS);
  }
  function resources() {
    var cw = window["claude.web"];
    return (cw && cw.Resources && typeof cw.Resources.fetchMentionOptions === "function") ? cw.Resources : null;
  }

  // ---- query + search ---------------------------------------------------------
  // "text:42" -> { text: "text", line: 42 }. Only a TRAILING :<digits> is a line.
  function parseQuery(raw) {
    var m = /^(.*?)(?::(\d+))?\s*$/.exec(String(raw || ""));
    return { text: (m ? m[1] : "").trim(), line: (m && m[2]) ? parseInt(m[2], 10) : undefined };
  }
  function search(text, cb) {
    var api = resources();
    if (!api) { cb(null, "bridge"); return; }
    var p;
    try { p = api.fetchMentionOptions(text, "files"); } catch (e) { cb(null, "threw"); return; }
    if (!p || typeof p.then !== "function") { cb(null, "shape"); return; }
    p.then(function (list) { cb(Array.isArray(list) ? list : [], null); }, function () { cb(null, "rejected"); });
  }
  // Upstream's mention option -> { rel, abs, positions }; directories skipped.
  function toItems(list) {
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX_RESULTS; i++) {
      var e = list[i];
      if (!e || typeof e.id !== "string" || e.id.indexOf("file-") !== 0) continue;
      var meta = {};
      if (typeof e.metadata === "string") { try { meta = JSON.parse(e.metadata) || {}; } catch (x) { meta = {}; } }
      else if (e.metadata && typeof e.metadata === "object") meta = e.metadata;
      if (meta.isDirectory === true) continue;
      var rel = typeof meta.path === "string" ? meta.path : String(e.label || "");
      if (!rel) continue;
      out.push({ rel: rel, abs: e.id.slice(5), positions: Array.isArray(meta.positions) ? meta.positions : [] });
    }
    return out;
  }

  // ---- MRU --------------------------------------------------------------------
  // The MRU is keyed by the tile root and stores RELATIVE paths, so it is only
  // meaningful with a known root. With no root (empty pane, or the entry anchor
  // moved) the whole MRU is disabled rather than falling back to a root-less
  // key: reading it would render rows whose absolute path is just the relative
  // one (upstream's onPreview does e.startsWith(...) and would throw or open
  // nothing), and writing it would hide the real MRU under a second key.
  function haveRoot() { return !!(ctx && ctx.root); }
  function mruKey() { return MRU_PREFIX + (ctx && ctx.root ? ctx.root : ""); }
  function readMru() {
    try { var v = JSON.parse(window.localStorage.getItem(mruKey()) || "[]"); return Array.isArray(v) ? v.filter(function (s) { return typeof s === "string"; }) : []; }
    catch (e) { return []; }
  }
  function remember(rel) {
    if (!haveRoot()) return;
    try {
      var list = readMru().filter(function (s) { return s !== rel; });
      list.unshift(rel);
      window.localStorage.setItem(mruKey(), JSON.stringify(list.slice(0, MAX_MRU)));
    } catch (e) {}
  }
  function mruItems() {
    if (!haveRoot()) return [];
    var root = ctx.root;
    return readMru().slice(0, MAX_RESULTS).map(function (rel) { return { rel: rel, abs: root + rel, positions: [] }; });
  }

  // ---- modal ------------------------------------------------------------------
  var rootEl = null, inputEl = null, listEl = null, hintEl = null;
  var items = [], sel = 0, seq = 0, debounceTimer = null, ctx = null;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent =
      "#" + ROOT_ID + "{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;background:rgba(0,0,0,.25)}" +
      "#" + ROOT_ID + " .cdb-qopen-box{width:min(62vw,600px);max-height:70vh;display:flex;flex-direction:column;border-radius:10px;overflow:hidden;" +
        "background:var(--cds-surface-2,var(--cds-page-bg,#232323));color:var(--cds-text-primary,#eee);box-shadow:0 12px 40px rgba(0,0,0,.45);border:1px solid var(--cds-border-tertiary,rgba(255,255,255,.12));font:13px/1.4 var(--font-sans,system-ui,sans-serif)}" +
      "#" + ROOT_ID + " .cdb-qopen-input{all:unset;display:block;box-sizing:border-box;width:100%;padding:10px 12px;font:14px/1.4 inherit;color:inherit;border-bottom:1px solid var(--cds-border-tertiary,rgba(255,255,255,.12))}" +
      "#" + ROOT_ID + " .cdb-qopen-list{list-style:none;margin:0;padding:4px 0;overflow:hidden}" +
      "#" + ROOT_ID + " .cdb-qopen-row{display:flex;gap:8px;align-items:baseline;padding:5px 12px;cursor:pointer;white-space:nowrap;overflow:hidden}" +
      "#" + ROOT_ID + " .cdb-qopen-row[aria-selected=true]{background:var(--cds-fill-accent,#3b82f6);color:#fff}" +
      "#" + ROOT_ID + " .cdb-qopen-name{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}" +
      "#" + ROOT_ID + " .cdb-qopen-dir{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;opacity:.6;font-size:12px}" +
      "#" + ROOT_ID + " mark{background:transparent;color:inherit;font-weight:700;text-decoration:underline}" +
      "#" + ROOT_ID + " .cdb-qopen-hint{padding:6px 12px 8px;font-size:12px;opacity:.7;min-height:1em}";
    (document.head || document.documentElement).appendChild(st);
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function isOpen() { return !!rootEl && !!rootEl.parentNode; }

  function open() {
    if (!enabled) return;
    if (isOpen()) { close(); return; }
    var pane = filesPane();
    ctx = { pane: pane, onPreview: null, root: null };
    // No pane at all: upstream's ⋮ → Files makes one. The user pressed Ctrl+P to
    // open a file, so opening the panel they would have opened by hand is the
    // point - but only when there is genuinely no pane (the entry is a TOGGLE, so
    // pressing it with a pane open would close the one we need).
    var opener = pane ? null : sessionMenuButton();
    // Hidden tree: the harvest has to wait for upstream's button to do its work.
    // The modal itself does NOT wait - Ctrl+P stays instant.
    var showBtn = (pane && treeHidden(pane)) ? showTreeButton(pane) : null;
    var first = (pane && !showBtn) ? probe(pane) : null;
    var hit = first || null;                                  // `false` (threw) -> null
    // Retry while the pane may still be rendering (or is still being created).
    // A throw is final, not "not yet".
    var retry = (!!pane || !!opener) && !hit && first !== false;
    settle(pane, hit, !retry);
    ensureStyle();
    rootEl = el("div"); rootEl.id = ROOT_ID; rootEl.className = "cdb-qopen-backdrop";
    var box = el("div", "cdb-qopen-box");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Quick open");
    inputEl = el("input", "cdb-qopen-input");
    inputEl.type = "text";
    inputEl.setAttribute("aria-label", "Quick open file");
    inputEl.placeholder = "Type a file name  (Ctrl+P again to close)";
    inputEl.autocomplete = "off"; inputEl.spellcheck = false;
    listEl = el("ul", "cdb-qopen-list");
    listEl.setAttribute("role", "listbox");
    hintEl = el("div", "cdb-qopen-hint", "");
    box.appendChild(inputEl); box.appendChild(listEl); box.appendChild(hintEl);
    rootEl.appendChild(box);
    rootEl.addEventListener("mousedown", function (ev) { if (ev.target === rootEl) close(); });
    box.addEventListener("mousedown", function (ev) { if (ev.target !== inputEl) ev.preventDefault(); }); // keep focus in the input
    inputEl.addEventListener("input", function () {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(run, DEBOUNCE_MS);
    });
    inputEl.addEventListener("keydown", onInputKey);
    document.body.appendChild(rootEl);
    if (!pane) hint(opener ? HINT_OPENING_PANE : HINT_NO_PANE);
    else if (showBtn) hint(HINT_SHOWING_TREE);
    // A retry with the tree already visible keeps the honest hint meanwhile: the
    // handler is missing RIGHT NOW. It is cleared the moment the retry lands.
    else if (!ctx.onPreview) hint(HINT_NO_HANDLER);
    inputEl.focus();
    run();                       // results render regardless of the harvest state
    if (!retry) return;
    if (showBtn && !clickShowTree(showBtn)) { settle(pane, null, true); hint(HINT_NO_HANDLER); return; }
    // ctx identity is the guard: a close (which nulls ctx) or a re-open while the
    // pane is still rendering must not have its results written by this pass.
    var mine = ctx;
    // This lands from a setInterval tick, NOT from the keydown handler, so it is
    // outside onKeyCapture's try/catch - probe() carries its own guard so a
    // throwing remote memoizedProps getter degrades to a warning + a hint instead
    // of escaping as an unhandled page error.
    function harvest() {
      awaitProbe(pane, function (late, resolved) {
        if (ctx !== mine || !isOpen()) return;
        ctx.pane = resolved || pane;          // the ⋮ path resolves it only now
        settle(ctx.pane, late, true);
        hint(ctx.onPreview ? "" : (ctx.pane ? HINT_NO_HANDLER : HINT_NO_PANE));
        // Clicking "Show file tree" (or the menu entry) ran upstream's own React
        // handler, which can move focus into what it just rendered (the "Filter
        // files" box). Take it back, or everything typed after lands there.
        if (inputEl && document.activeElement !== inputEl) inputEl.focus();
        run();
      });
    }
    if (!opener) { harvest(); return; }
    openFilesPane(opener, function (ok) {
      if (ctx !== mine || !isOpen()) return;
      if (!ok) { settle(null, null, false); hint(HINT_NO_PANE); return; }
      harvest();
    });
  }
  function close() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    seq++;
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = inputEl = listEl = hintEl = null;
    items = []; sel = 0; ctx = null;
  }
  function hint(text) { if (hintEl) hintEl.textContent = text || ""; }

  function run() {
    if (!isOpen()) return;
    var q = parseQuery(inputEl.value);
    var my = ++seq;
    if (!q.text) { render(mruItems()); return; }
    search(q.text, function (list, err) {
      if (my !== seq || !isOpen()) return;
      if (err) { warnOnce("search-" + err, "fetchMentionOptions unavailable (" + err + ")"); hint("Search unavailable (" + err + ")"); render([]); return; }
      render(toItems(list));
    });
  }
  // Positions index the RELATIVE path; split them across dir and basename.
  function highlighted(text, positions, offset) {
    var frag = document.createDocumentFragment(), last = 0, set = {};
    for (var i = 0; i < positions.length; i++) { var p = positions[i] - offset; if (p >= 0 && p < text.length) set[p] = true; }
    for (var c = 0; c < text.length; c++) {
      if (!set[c]) continue;
      if (c > last) frag.appendChild(document.createTextNode(text.slice(last, c)));
      var m = document.createElement("mark"); m.textContent = text.charAt(c); frag.appendChild(m);
      last = c + 1;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }
  function render(arr) {
    if (!isOpen()) return;
    items = arr; sel = 0;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    for (var i = 0; i < items.length; i++) {
      var it = items[i], slash = it.rel.lastIndexOf("/");
      var name = it.rel.slice(slash + 1), dir = slash >= 0 ? it.rel.slice(0, slash) : "";
      var li = el("li", "cdb-qopen-row");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === sel ? "true" : "false");
      li.setAttribute("data-index", String(i));
      var nameEl = el("span", "cdb-qopen-name"); nameEl.appendChild(highlighted(name, it.positions, slash + 1));
      var dirEl = el("span", "cdb-qopen-dir"); dirEl.appendChild(highlighted(dir, it.positions, 0));
      li.appendChild(nameEl); li.appendChild(dirEl);
      li.addEventListener("click", onRowClick);
      li.addEventListener("mousemove", onRowHover);
      listEl.appendChild(li);
    }
    if (ctx && ctx.pane && ctx.onPreview) {
      var q = parseQuery(inputEl.value);
      if (!q.text) hint(items.length ? HINT_MRU : HINT_EMPTY);
      else if (!items.length) hint(HINT_NO_MATCH);
      else if (ctx.root && items[0].abs.indexOf(ctx.root) !== 0) hint(HINT_OTHER_ROOT);
      else hint(HINT_KEYS);
    }
  }
  function select(i) {
    if (!items.length) return;
    sel = (i + items.length) % items.length;
    var rows = listEl.children;
    for (var k = 0; k < rows.length; k++) rows[k].setAttribute("aria-selected", k === sel ? "true" : "false");
  }
  function onRowHover(ev) { var i = parseInt(ev.currentTarget.getAttribute("data-index"), 10); if (i !== sel) select(i); }
  function onRowClick(ev) { ev.preventDefault(); pick(parseInt(ev.currentTarget.getAttribute("data-index"), 10)); }
  function pick(i) {
    var it = items[i];
    if (!it || !ctx || !ctx.onPreview) return;
    // Prefer the tile's own root: the index follows the FOCUSED session's cwd,
    // which can differ from the folder this tile shows (measured 2026-08-29).
    var abs = ctx.root ? ctx.root + it.rel : it.abs;
    var line = parseQuery(inputEl.value).line;
    try { ctx.onPreview(abs, line); }
    catch (e) { warnOnce("onpreview-threw", "onPreview threw: " + ((e && e.message) || e)); hint("Could not open " + it.rel); return; }
    remember(it.rel);
    close();
  }
  function onInputKey(ev) {
    // Enter, Escape and the arrow keys all belong to the IME while a
    // composition is open: Enter commits the candidate, the arrows walk the
    // candidate list. Acting on them would open a file the user never chose and
    // close the box mid-word - the one path in this feature that produces a
    // WRONG ACTION rather than a no-op, which its own contract forbids.
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === "ArrowDown") { ev.preventDefault(); select(sel + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); select(sel - 1); }
    else if (ev.key === "Enter") { ev.preventDefault(); pick(sel); }
    else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); }
  }

  // ---- global hotkey ------------------------------------------------------------
  function inTerminal(node) {
    try { return !!(node && node.closest && node.closest(".xterm")); } catch (e) { return false; }
  }
  function onCodeTab() { return /^\/epitaxy(\/|$)/.test(window.location.pathname); }
  function onKeyCapture(ev) {
    if (!enabled) return;
    // A held key auto-repeats keydown, and open() is a TOGGLE - without this,
    // holding Ctrl+P strobes the modal open/closed ~15x a second, each cycle
    // re-running a full synchronous probe and re-driving the session menu
    // (which is itself a toggle). Bail BEFORE preventDefault: a repeat is never
    // treated as "handled". Same rule and rationale as js/panel_tabs_page.js.
    if (ev.repeat) return;
    // During an IME composition the keyboard belongs to the IME, and Chromium
    // reports key "Process" here - so this is belt and braces for the hotkey,
    // and the real guard is the one in onInputKey below.
    if (ev.isComposing || ev.keyCode === 229) return;
    if (!ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
    if (ev.key !== "p" && ev.key !== "P") return;
    if (!onCodeTab()) return;
    if (inTerminal(ev.target) || inTerminal(document.activeElement)) return;
    ev.preventDefault();
    ev.stopPropagation();
    // open() walks REMOTE React fibers; a getter on memoizedProps that throws
    // must not surface as an unhandled error inside claude.ai's own keydown path.
    try { open(); }
    catch (e) { warnOnce("open-threw", "open() threw while harvesting the Files pane: " + ((e && e.message) || e)); }
  }

  // ---- lifecycle ---------------------------------------------------------------
  var prefTimer = null, started = false;
  function start() {
    if (started) return;
    started = true;
    window.addEventListener("keydown", onKeyCapture, true);
    pollPref();
    prefTimer = window.setInterval(pollPref, STATE_POLL_MS);
  }
  function stop() {
    window.removeEventListener("keydown", onKeyCapture, true);
    if (prefTimer) { clearInterval(prefTimer); prefTimer = null; }
    close(); started = false;
  }
  function state() { return { enabled: enabled, open: isOpen(), items: items.map(function (i) { return i.rel; }), sel: sel, root: ctx ? ctx.root : null }; }

  window.__cdbQuickOpenPage = { start: start, stop: stop, open: open, close: close, state: state, pollPref: pollPref };
})();
