/*
 * diff_views_page.js - injected into the claude.ai page (Code tab) by
 * js/diff_views_main.js on dom-ready. Adds a diff-scope dropdown to the
 * epitaxy diff view: Working tree / Branch changes / Latest turn.
 *
 * ============================================================
 * ARCHITECTURE (2026-07-31 pivot - see the ADDENDUM at the end of
 * docs/superpowers/specs/2026-07-31-diff-view-modes-design.md)
 * ============================================================
 * This file NO LONGER RENDERS ANYTHING but the dropdown. The stock diff panel
 * gets its data from local, patchable main-process handlers registered on the
 * PER-WEBCONTENTS ipc (electron's `webContents.ipc`, NOT the global ipcMain -
 * see the interception note in js/diff_views_main.js): LocalSessions
 * getGitDiff / getGitDiffStats / getGitDiffFilePatch / getDiffFileContent. The
 * three modes are therefore ARGUMENT REWRITES applied main-side, not custom
 * rendering. The stock renderer then draws every mode - syntax highlighting,
 * virtualisation, theming and line comments all come back for free.
 *
 * Deleted with the pivot (do not reintroduce here): the unified-diff parser,
 * the line-number gutters, the --diffs-* row palette, our own body element,
 * and the hide/restore/re-point machinery that used to swap the stock file
 * list out. Nothing in this file hides, moves or restyles stock DOM any more;
 * the only mutation is inserting one <select> into the chrome row.
 *
 * DOM facts this still depends on (live-confirmed 2026-07-31, claude.ai-web.log):
 *   - ".epitaxy-pane-close-control" is the per-view chrome handle; its
 *     parentElement is the breadcrumb row ("master -> branch", ⤢, ✕).
 *   - "button.epitaxy-panel-subheader" is the sticky PER-FILE header button and
 *     "div.epitaxy-diff-panel" its content; a view has N such pairs. The
 *     presence of ANY diff marker under the same container is what
 *     distinguishes the diff view from Terminal / the in-app browser (both of
 *     which also have a close control).
 *   - QUALIFICATION IS ANY-OF, NOT ALL-OF (fixed 2026-08-01). Requiring BOTH the
 *     header button and ".epitaxy-diff-panel" was a live bug: ".epitaxy-diff-panel"
 *     is the EXPANDED per-file content, and a large diff renders every file
 *     COLLAPSED ("Files are collapsed for large diffs. Select a file to expand
 *     it."), so the element does not exist at all. Log evidence 2026-08-01
 *     00:40:46-00:42:57, four identical dumps: "headers=12 panels=0
 *     hasViewPanelWrapper=true stepsToFirstPair=3" - a real, fully chromed,
 *     12-file diff view that the gate rejected. Earlier rounds only ever looked
 *     right because a small diff auto-expands. See VIEW_MARKERS.
 *   - The dropdown goes to the LEFT of the whole trailing control cluster.
 *   - The EXPANDED (⤢) panel has its own chrome row, so a view can present two
 *     rows at different times. Only one of them is on screen, so the "one
 *     dropdown per view" guard is visibility-aware (viewServedByDisplayedRow)
 *     rather than presence-in-document-aware; the latter left the fullscreen
 *     header with no dropdown while the mode still applied.
 *   - AN INSTALL IS RE-VALIDATED ON EVERY SWEEP (added 2026-08-04). Upstream
 *     REUSES the chrome-row DOM when it swaps which tile owns that row, and our
 *     <select> is a foreign node React does not manage - so it survived the
 *     row's contents being replaced and ended up in the in-app browser panel
 *     (measured: "tileId=preview markers: [] wouldQualify: false ourDropdown:
 *     TRUE"). revalidateInstalls() re-resolves each install's view through the
 *     SAME resolveView()/qualifiesAsView() path the install used and removes any
 *     dropdown whose containing view no longer qualifies. It only ever REMOVES;
 *     it never tightens the ANY-OF marker rule above.
 *
 * HONEST AVAILABILITY (2026-07-31): "Latest turn" is only offered when the main
 * process reports a turn snapshot FOR THIS REPO (state().hasTurnSnapshot, now a
 * per-cwd answer). Otherwise the <option> is disabled with the title
 * "no turn recorded in this repo yet" and a low-frequency state() poll re-enables
 * it the moment one is recorded. The dropdown must never offer a mode that would
 * silently render something else - that was the reported bug.
 *
 * FEATURE SWITCH (2026-07-31): the feature is OPT-IN - Settings -> Extra ->
 * Features -> "Diff view modes", off by default. The pref lives main-side and is
 * reported by state().enabled, which this file polls slowly for the life of the
 * page - so flipping the switch removes the <select> from every chrome row (stock
 * header, untouched) or puts it back at Working tree, in both directions, without
 * an app restart. Until it is turned on nothing is injected at all. Main makes
 * its own interception a pass-through and stops taking turn snapshots at the
 * same time.
 *
 * A claude.ai redeploy that renames these classes degrades this to a no-op
 * (the sweep finds nothing, the mandatory diagnostic fires) - it must never
 * break the stock view.
 *
 * DIAGNOSTICS CHANNEL: every [cdb-dv] line uses console.warn, never
 * console.log - verified live that ~/.config/Claude/logs/claude.ai-web.log
 * forwards only console.warn/console.error, so console.log would have been
 * silently unrecoverable for field debugging.
 */
(function () {
  if (window.__cdbDiffViewsPage) return;
  window.__cdbDiffViewsPage = true;

  var hasBridge = !!(window.cdbDiffViews && typeof window.cdbDiffViews.setMode === "function");
  console.warn("[cdb-dv] page script injected (bridge: " + (hasBridge ? "yes" : "no") + ")");
  if (!hasBridge) return; // bridge missing (or pre-pivot v1 bridge): not our build

  // LIVE-CONFIRMED selectors.
  var CLOSE_CONTROL_SELECTOR = ".epitaxy-pane-close-control"; // per-view chrome handle
  // DUPLICATED ON PURPOSE: the same literal is HEADER_SELECTOR in
  // js/diff_views_expand.js (which classifies these headers on its own, without
  // importing anything from here). A claude.ai redeploy that renames this class
  // MUST change BOTH sites.
  var FILE_HEADER_SELECTOR = "button.epitaxy-panel-subheader"; // PER-FILE header button
  var FILE_CONTENT_SELECTOR = ".epitaxy-diff-panel";           // EXPANDED per-file content
  var VIEW_CONTAINER_SELECTOR = ".epitaxy-view-panel";         // generic side-panel wrapper

  // ANY ONE of these under the resolved view container means "this is the diff
  // view". Deliberately independent of FILE-EXPANSION STATE: the first two are
  // the epitaxy per-file pair, the last two belong to the vendored diff-viewer
  // library the panel embeds. `name` is what the diagnostic prints, so a future
  // breakage names the marker that went missing instead of making the reader
  // diff two 30-item class lists by eye.
  var VIEW_MARKERS = [
    { name: "panel-subheader", sel: FILE_HEADER_SELECTOR },
    { name: "diff-panel", sel: FILE_CONTENT_SELECTOR },
    { name: "diffs-header", sel: "[data-diffs-header]" },
    { name: "diffs-container", sel: ".diffs-container" }
  ];

  // NEGATIVE discriminator, used ONLY by the empty-diff fallback below (never on
  // the marker path). A Terminal tile is an xterm surface and the in-app browser
  // is an embedded frame; the diff panel renders neither, in any mode, empty or
  // not. This exists so the fallback cannot reach a non-diff tile.
  var NON_DIFF_SURFACE_SELECTOR = 'canvas,iframe,webview,[class*="xterm"],[class*="terminal"]';
  var MAX_VIEW_WALK = 8; // only used when there is no view-panel ancestor

  // ---- FIBER IDENTITY: which tile does a panel actually belong to? ----------
  // React leaves its fiber on every rendered node under a __reactFiber$<hash>
  // key, and an ANCESTOR fiber's memoizedProps carries the tile's identity as a
  // plain string prop `tileId` ("diff", "preview", "terminal", "chat", ...).
  // Measured live 2026-08-21 on 1.32352.1: from the .epitaxy-view-panel node the
  // prop resolves within 3-5 hops; panel tabs' harvester has used the same walk
  // (bounded, SEARCHED - never a hardcoded hop count) since 2026-08-04.
  // Returns null when the fiber key or the prop cannot be found - callers must
  // treat null as "unknown", never as "not a diff".
  var DIFF_TILE_ID = "diff";
  var MAX_FIBER_HOPS = 120;

  function fiberTileIdOf(el) {
    try {
      var key = null;
      for (var k in el) { if (k.indexOf("__reactFiber$") === 0) { key = k; break; } }
      if (!key) return null;
      var f = el[key], hops = 0;
      while (f && hops++ < MAX_FIBER_HOPS) {
        var p = f.memoizedProps;
        if (p && typeof p.tileId === "string") return p.tileId;
        f = f.return;
      }
    } catch (e) { /* a foreign fiber shape must never break qualification */ }
    return null;
  }
  var SWEEP_MS = 500;
  var NO_PANEL_SWEEP_THRESHOLD = 10;
  var PENDING_CUE_MS = 600;
  // state() poll interval. dom-ready fires at app start, before any Code
  // session/cwd exists, so a ONE-SHOT state() check (the original bug) saw
  // available:false permanently and never re-checked. We poll until the gate
  // passes once, then stop for good. window.__cdbDvTestPollMs is a TEST-ONLY
  // override so the jsdom smoke test needn't wait real 5s per poll.
  var STATE_POLL_MS = (typeof window.__cdbDvTestPollMs === "number") ? window.__cdbDvTestPollMs : 5000;

  // Only the dropdown is styled now. Theme tokens hold bare HSL TRIPLETS in
  // this app (see baseline/THEME_TOKEN_MAP.md), so every token use is wrapped
  // in hsl() with the fallback expressed as a triplet INSIDE the var().
  var CSS = [
    ".cdb-dv-select{background:hsl(var(--bg-100,0 0% 16%));color:hsl(var(--text-100,0 0% 93%));",
    "border:1px solid hsl(var(--border-300,0 0% 40%) / 0.35);border-radius:6px;",
    "padding:2px 6px;font-size:12px}",
    ".cdb-dv-select-inline{margin-left:8px;margin-right:8px;height:22px;line-height:20px;padding:1px 4px}",
    // Transient cue while the main process applies the mode. Opacity only - no
    // layout surgery, nothing that could shift the stock chrome row.
    ".cdb-dv-select[data-cdb-dv-pending=\"1\"]{opacity:.6}",
    // Armed (sticky expand) look. Background only - never a metric, or we would
    // be re-styling the control we cloned precisely to inherit its metrics.
    ".cdb-dv-toggle[data-cdb-dv-armed=\"1\"]{background:hsl(var(--bg-300,0 0% 25%) / 0.9)}"
  ].join("");

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // The module half logs through us, so every line lands on the one channel
  // ~/.config/Claude/logs/claude.ai-web.log actually forwards.
  function dvLog(m) { console.warn("[cdb-dv] " + m); }

  // ------------------------------------------------------------------ //
  // Topology resolution                                                  //
  // ------------------------------------------------------------------ //

  // Which of VIEW_MARKERS are present under `node`, in VIEW_MARKERS order. A
  // node that cannot be queried reads as all-absent rather than throwing.
  function markerHits(node) {
    var hits = [];
    for (var i = 0; i < VIEW_MARKERS.length; i++) {
      var hit = false;
      if (node && node.querySelector) {
        try { hit = !!node.querySelector(VIEW_MARKERS[i].sel); } catch (e) { hit = false; }
      }
      hits.push(hit);
    }
    return hits;
  }

  function anyMarker(node) {
    var hits = markerHits(node);
    for (var i = 0; i < hits.length; i++) { if (hits[i]) return true; }
    return false;
  }

  // "panel-subheader=yes diff-panel=no diffs-header=no diffs-container=no"
  function describeMarkers(node) {
    var hits = markerHits(node);
    var parts = [];
    for (var i = 0; i < hits.length; i++) {
      parts.push(VIEW_MARKERS[i].name + "=" + (hits[i] ? "yes" : "no"));
    }
    return parts.join(" ");
  }

  // ---- THE EMPTY DIFF: A SCOPE WE APPLIED WITH NOTHING TO SHOW --------------
  // (2026-08-01) "Branch changes" on a branch with zero commits, or "Latest
  // turn" for a turn that changed nothing, renders "No changes to show": the
  // tile is chrome only, with ZERO of the four markers in the document (live
  // evidence: main.log "-> 0 files" at 2026-07-31 18:29:43 and 22:40:26, against
  // claude.ai-web.log "epitaxy-view-panel,epitaxy-code-surface,
  // epitaxy-pane-close-control" with no subheader and no diff panel at the same
  // second). Marker qualification therefore CANNOT rescue it, and without a
  // dropdown an empty scope is a dead end: no way back to Working tree short of
  // turning the whole feature off.
  //
  // That state is DOM-INDISTINGUISHABLE from a Terminal tile on the evidence we
  // have (no Terminal-tile DOM was ever captured, and no positive Terminal
  // marker is known to exist), so the fallback is gated on something outside the
  // DOM instead - our own applied mode - plus, since 2026-08-21, the React
  // fiber's own tile identity (GATE 3), plus a negative surface check. The
  // four gates are documented individually below; between them, the fallback
  // cannot fire in the default Working tree scope at all, which is the only
  // scope a user who never touched our dropdown is ever in.
  function looksLikeNonDiffSurface(node) {
    if (!node || !node.querySelector) return true;
    try { return !!node.querySelector(NON_DIFF_SURFACE_SELECTOR); } catch (e) { return true; }
  }

  function qualifiesAsEmptyDiffView(node) {
    // GATE 1 - a non-default scope must actually be applied to this repo right
    // now. lastKnownMode mirrors state().mode, which is main's EFFECTIVE mode: a
    // mode bound to another repo, or bound to a repo our spawn hook never
    // observed, already collapses to "working" there. So this reads true only
    // when an empty panel could be OUR doing - exactly the dead end - and reads
    // false for every stock-scope panel, Terminal included.
    if (lastKnownMode === MODES.WORKING) return false;
    // GATE 2 - the node must BE the side-panel wrapper. resolveView's bounded
    // walk (used only when there is no wrapper at all) can therefore never reach
    // this path and "qualify" some shared ancestor.
    if (!node || !node.matches) return false;
    try { if (!node.matches(VIEW_CONTAINER_SELECTOR)) return false; } catch (e) { return false; }
    // GATE 3 - POSITIVE IDENTITY (2026-08-21, the dropdown-leak fix). The
    // paragraph above says the empty state is DOM-indistinguishable from other
    // tiles - it no longer has to be: the React fiber's memoizedProps.tileId
    // names the owning tile outright. Measured live on 1.32352.1: an EMPTY
    // in-app browser tab ("New tab", no iframe mounted yet) sailed through
    // gates 1 and 2 and the negative surface check below (nothing to match!),
    // and our dropdown landed in its chrome row - tileId said "preview" the
    // whole time. A resolvable tileId that is not "diff" is a hard no. A null
    // (unreadable fiber - a React internals rename) falls through to the old
    // gates, so the dead-end rescue cannot be lost to an upstream refactor;
    // the leak can only return in that degraded state, and the "leak" DOM
    // scenario pins both directions.
    var tid = fiberTileIdOf(node);
    if (tid !== null && tid !== DIFF_TILE_ID) return false;
    // GATE 4 - and it must not be a terminal / embedded-browser surface.
    if (looksLikeNonDiffSurface(node)) return false;
    return true;
  }

  // A container is "the diff view" when it holds ANY ONE of the diff markers -
  // see VIEW_MARKERS for why ALL-of was the reported bug - or when it is an
  // empty panel that our own scope emptied (qualifiesAsEmptyDiffView). Terminal
  // and in-app browser panels have a close control but no marker, and are
  // excluded from the fallback by its gates.
  function qualifiesAsView(node) {
    if (!node || !node.querySelector) return false;
    if (anyMarker(node)) return true;
    return qualifiesAsEmptyDiffView(node);
  }

  // From a close control, find the diff-view container it belongs to.
  // Preferred: the enclosing ".epitaxy-view-panel". If that wrapper exists but
  // does NOT qualify we reject outright - walking past it could "qualify" a
  // Terminal's close control off a diff view sharing a distant ancestor. Only
  // when there is no such wrapper at all do we do a short bounded walk up.
  function resolveView(closeControl) {
    var wrapper = closeControl.closest ? closeControl.closest(VIEW_CONTAINER_SELECTOR) : null;
    if (wrapper) return qualifiesAsView(wrapper) ? wrapper : null;
    var node = closeControl.parentElement;
    var depth = 0;
    while (node && depth++ < MAX_VIEW_WALK && node !== document.body && node !== document.documentElement) {
      if (qualifiesAsView(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  // DIAGNOSTICS ONLY (nothing is hidden any more): the lowest ancestor of the
  // first per-file header button that contains EVERY header button - i.e. the
  // element holding all the file pairs. Logged once so a future breakage can
  // be diagnosed from the log without another guess-and-rebuild cycle.
  function resolveAllPairsContainer(view, firstHeader) {
    var headers = view.querySelectorAll(FILE_HEADER_SELECTOR);
    var node = firstHeader.parentElement;
    var depth = 0;
    while (node && depth++ < 24) {
      var holdsAll = true;
      for (var i = 0; i < headers.length; i++) {
        if (!node.contains(headers[i])) { holdsAll = false; break; }
      }
      if (holdsAll) return node;
      if (node === view) break;
      node = node.parentElement;
    }
    return null;
  }

  // Is this element actually on screen? Used to decide whether an existing
  // install can still serve the user (see viewServedByDisplayedRow).
  //
  // jsdom (and any DOM without a layout engine) reports no client rects for
  // ANYTHING, so a bare rect test would read every element as hidden there. We
  // therefore probe <body> first: no rects on body means "no layout information
  // available", and in that case everything attached to the document counts as
  // displayed. Deliberately not cached - body has no rects yet at dom-ready.
  function layoutAvailable() {
    try {
      return !!(document.body && document.body.getClientRects &&
        document.body.getClientRects().length > 0);
    } catch (e) { return false; }
  }

  function isDisplayed(el) {
    if (!el || !document.contains(el)) return false;
    if (!layoutAvailable()) return true;
    try { return el.getClientRects().length > 0; } catch (e) { return true; }
  }

  // Parent steps from `a` up to the first ancestor that also contains `b`.
  // -1 when there is none within the bound. Diagnostics only.
  function sharedAncestorDepth(a, b) {
    if (!a || !b) return -1;
    var node = a.parentElement;
    var depth = 1;
    while (node && depth <= 24) {
      if (node.contains(b)) return depth;
      node = node.parentElement;
      depth++;
    }
    return -1;
  }

  function describeNode(node) {
    var cls = String(node.getAttribute ? (node.getAttribute("class") || "") : "");
    return node.tagName.toLowerCase() +
      (cls ? "." + cls.trim().replace(/\s+/g, ".") : "") +
      "(" + node.childElementCount + ")";
  }

  // "Button-like" chrome control: a real <button>, a role=button, an
  // epitaxy-*-control, or any wrapper whose only job is to hold an <svg> icon.
  function isControlLike(e) {
    if (!e) return false;
    if (e.tagName === "BUTTON") return true;
    try {
      if (e.matches && e.matches('button,[role="button"],[class*="control"]')) return true;
      if (e.querySelector && e.querySelector("svg")) return true;
    } catch (err) { /* exotic node - treat as non-control */ }
    return false;
  }

  // The dropdown must sit to the LEFT of the whole trailing control cluster
  // (fullscreen ⤢ then close ✕), not wedged between them. Walk backwards from
  // the close control over the contiguous run of button-like siblings and
  // return the FIRST element of that run - our insertion reference. Resulting
  // order: breadcrumb ... [select] [⤢] [✕].
  function controlClusterStart(closeControl) {
    var first = closeControl;
    var prev = first.previousElementSibling;
    while (prev && isControlLike(prev)) {
      first = prev;
      prev = first.previousElementSibling;
    }
    return first;
  }

  // ONE-SHOT (per page load) structural diagnostics, fired at INSTALL time so
  // a mis-placement is diagnosable from the log alone, without the user
  // touching anything.
  var topologyLogged = false;

  function logTopologyOnce(view) {
    if (topologyLogged) return;
    var firstHeader = view.querySelector(FILE_HEADER_SELECTOR);
    if (!firstHeader) return;
    topologyLogged = true;

    var pairsRoot = resolveAllPairsContainer(view, firstHeader);
    if (pairsRoot) {
      var parts = [];
      for (var i = 0; i < pairsRoot.children.length && i < 12; i++) {
        parts.push(describeNode(pairsRoot.children[i]));
      }
      if (pairsRoot.children.length > 12) parts.push("...+" + (pairsRoot.children.length - 12) + " more");
      console.warn("[cdb-dv] panel children: " + parts.join(" | "));
    }

    var chain = [];
    var node = firstHeader;
    var depth = 0;
    while (node && depth++ < 12) {
      chain.push(describeNode(node));
      if (node === view) break;
      node = node.parentElement;
    }
    console.warn("[cdb-dv] view ancestry: " + chain.join(" | "));
  }

  // FULLSCREEN DIAGNOSTIC (2026-07-31, BUG: no dropdown in the expanded ⤢ view
  // while the mode kept applying - a silent desync).
  //
  // Two candidate causes, indistinguishable from the log we had:
  //   (a) the side panel's chrome row stays in the document but HIDDEN when the
  //       panel expands, so the per-view "already served" guard suppressed the
  //       fullscreen mount. That one is FIXED (viewServedByDisplayedRow).
  //   (b) the expanded panel renders its file pairs in a separate subtree /
  //       portal, so resolveView()'s .epitaxy-view-panel wrapper does not
  //       qualify and the close control is rejected.
  // This dump is the ground truth for (b) - if the next live test shows it,
  // resolveView needs the portal case, not the visibility case. A close control
  // whose class differs entirely in fullscreen shows up instead as a
  // "no qualified panel" line (hasLiveInstall is visibility-aware now).
  var unqualifiedLogged = false;

  function logUnqualifiedOnce(closeControl) {
    if (unqualifiedLogged) return;
    unqualifiedLogged = true;
    var chain = [];
    var node = closeControl;
    var depth = 0;
    while (node && depth++ < 14) { chain.push(describeNode(node)); node = node.parentElement; }
    console.warn("[cdb-dv] unqualified close control ancestry: " + chain.join(" | "));
    var row = closeControl.parentElement;
    if (row) {
      var kids = [];
      for (var i = 0; i < row.children.length && i < 10; i++) kids.push(describeNode(row.children[i]));
      console.warn("[cdb-dv] unqualified row children: " + kids.join(" | "));
    }
    var anyPair = document.querySelector(FILE_CONTENT_SELECTOR) ||
      document.querySelector(FILE_HEADER_SELECTOR);
    console.warn("[cdb-dv] unqualified context: headers=" +
      document.querySelectorAll(FILE_HEADER_SELECTOR).length +
      " panels=" + document.querySelectorAll(FILE_CONTENT_SELECTOR).length +
      " hasViewPanelWrapper=" +
      (closeControl.closest ? !!closeControl.closest(VIEW_CONTAINER_SELECTOR) : "n/a") +
      " stepsToFirstPair=" + sharedAncestorDepth(closeControl, anyPair) +
      " displayed=" + isDisplayed(closeControl));
    // WHICH MARKER WAS MISSING (2026-08-01). The class dump above was not enough
    // to see the collapsed-diff bug: it took reading a 30-item class list
    // character by character to notice `epitaxy-panel-subheader` was present and
    // `epitaxy-diff-panel` was not. Name all four markers, for the resolved
    // wrapper and for the whole document, and say why the fallback did not fire.
    var wrapper = closeControl.closest ? closeControl.closest(VIEW_CONTAINER_SELECTOR) : null;
    console.warn("[cdb-dv] unqualified markers: in-view-panel[" +
      (wrapper ? describeMarkers(wrapper) : "no view-panel wrapper") +
      "] document[" + describeMarkers(document) +
      "] appliedMode=" + lastKnownMode +
      " emptyDiffFallback=" + (wrapper ? qualifiesAsEmptyDiffView(wrapper) : false) +
      " nonDiffSurface=" + (wrapper ? looksLikeNonDiffSurface(wrapper) : "n/a") +
      " tileId=" + (wrapper ? fiberTileIdOf(wrapper) : "n/a"));
  }

  var setModeFailLogged = false;
  var noRefreshLogged = false;
  var emptyFallbackLogged = false;

  // Last mode the MAIN PROCESS reported (its `mode` field is already scoped to
  // the repo of the panel that is fetching, so it is what will actually be
  // rendered). A dropdown is a fresh DOM node per view mount, so without this
  // a remounted <select> always reads "Working tree" while the panel may be
  // rendering Branch changes - the live desync bug.
  // ---- THE MODE VOCABULARY ---------------------------------------------------
  // The mirror of the block by the same name in js/diff_views_main.js. These
  // VALUES are the bridge contract between the two files; the labels are this
  // side's business alone. Having the list in one place here means the dropdown
  // options, the change handler's validation and applyMode() cannot disagree
  // about which modes exist - they used to repeat the three literals separately.
  var MODES = { WORKING: "working", BRANCH: "branch", TURN: "turn" };
  var MODE_OPTIONS = [
    { value: MODES.WORKING, label: "Working tree" },
    { value: MODES.BRANCH, label: "Branch changes" },
    { value: MODES.TURN, label: "Latest turn" }
  ];
  function isMode(v) {
    for (var i = 0; i < MODE_OPTIONS.length; i++) { if (MODE_OPTIONS[i].value === v) return true; }
    return false;
  }
  function labelForMode(mode) {
    for (var i = 0; i < MODE_OPTIONS.length; i++) {
      if (MODE_OPTIONS[i].value === mode) return MODE_OPTIONS[i].label;
    }
    return mode;
  }

  var lastKnownMode = MODES.WORKING;

  function labelOf(select) {
    var opt = select.options[select.selectedIndex];
    return opt ? opt.text : select.value;
  }

  function applyMode(select, mode) {
    if (!isMode(mode)) return;
    select.value = mode;
    select.title = "Diff scope: " + labelOf(select);
  }

  // ------------------------------------------------------------------ //
  // "Latest turn" availability - THE DROPDOWN MUST NEVER OFFER A MODE    //
  // THAT WOULD SILENTLY SHOW SOMETHING ELSE                              //
  // ------------------------------------------------------------------ //
  // Reported bug (2026-07-31): selecting "Latest turn" rendered exactly the
  // Working tree view. The main-side cause was a global snapshot slot (fixed
  // there, per repo now), but the UI was complicit: it offered the mode
  // unconditionally, so a repo with no recorded turn boundary looked identical
  // to one with a real turn diff. state().hasTurnSnapshot is now answered PER
  // REPO, and the option is disabled until it is true.
  //
  // Default is DISABLED, deliberately: "we have not been told a turn exists" and
  // "no turn exists" are the same thing as far as what we can actually render.
  // The activation gate already requires a successful state() call before the
  // dropdown mounts at all, so this cannot strand a working feature.
  var TURN_UNAVAILABLE_TITLE = "no turn recorded in this repo yet";
  var lastKnownTurnAvailable = false;
  var turnAvailabilityLogged = null;

  function optionFor(select, value) {
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === value) return select.options[i];
    }
    return null;
  }

  function setTurnAvailability(select, has) {
    var opt = optionFor(select, MODES.TURN);
    if (!opt) return;
    opt.disabled = !has;
    if (has) opt.removeAttribute("title");
    else opt.title = TURN_UNAVAILABLE_TITLE;
  }

  // Applied to EVERY live dropdown, so a later poll re-enables the option in the
  // side panel and the fullscreen row alike.
  function applyTurnAvailabilityToAll(has) {
    if (has === lastKnownTurnAvailable && turnAvailabilityLogged !== null) return;
    lastKnownTurnAvailable = has;
    pruneInstalls();
    var affected = 0;
    for (var i = 0; i < installs.length; i++) {
      var ui = installs[i].row && installs[i].row.__cdbDvUi;
      if (ui && ui.select) { setTurnAvailability(ui.select, has); affected++; }
    }
    // ONLY LOG A TRANSITION THE USER COULD SEE (2026-08-01). The live log carried
    // "[cdb-dv] Latest turn ENABLED" at 00:44:06 while no dropdown had ever been
    // installed - a line describing an <option> that did not exist, which reads
    // as "the feature is working" next to the real failure. The VALUE is still
    // remembered (a dropdown mounted later is seeded from it); only the log line
    // waits for something to be enabled. turnAvailabilityLogged stays null while
    // nothing is mounted, so the early return above cannot swallow the first
    // real transition once a dropdown appears.
    if (affected > 0 && turnAvailabilityLogged !== has) {
      turnAvailabilityLogged = has;
      console.warn("[cdb-dv] Latest turn " + (has ? "ENABLED" : "disabled") +
        " (main reports hasTurnSnapshot=" + has + " for this repo)");
    }
  }

  // Authoritative re-read, once per install: the DOM default is only a guess.
  // Answers BOTH questions in one round trip - which mode is really applied, and
  // whether this repo has a turn snapshot at all.
  function syncFromState(select) {
    var p;
    try { p = window.cdbDiffViews.state(); } catch (e) { return; }
    Promise.resolve(p).then(function (st) {
      if (!st || st.ok !== true) return;
      // Covers the narrow race where the switch went off between two pref polls
      // and a view mounted in between: the dropdown we just made is removed again.
      applyPrefState(st);
      if (!prefOn) return;
      applyTurnAvailabilityToAll(st.hasTurnSnapshot === true);
      if (typeof st.mode !== "string") return;
      lastKnownMode = st.mode;
      if (document.contains(select)) applyMode(select, st.mode);
    }, function () { /* state() is best-effort; the default stands */ });
  }

  // Turn snapshots appear WHILE the panel is open (the user sends a message and
  // a boundary is recorded), so a one-shot check at install time would leave the
  // option greyed out for the rest of the page's life. A low-frequency poll runs
  // only while at least one dropdown is mounted, and it touches ONLY the option's
  // disabled state - never select.value, which would fight a user mid-selection.
  var turnPollTimer = 0;

  function pollTurnAvailability() {
    pruneInstalls();
    if (!installs.length) {
      // Nothing mounted: stop rather than tick forever. createUi restarts the
      // poll on the next install, so a view remount resumes it.
      clearInterval(turnPollTimer);
      turnPollTimer = 0;
      return;
    }
    var p;
    try { p = window.cdbDiffViews.state(); } catch (e) { return; }
    Promise.resolve(p).then(function (st) {
      if (!st || st.ok !== true) return;
      applyTurnAvailabilityToAll(st.hasTurnSnapshot === true);
    }, function () {});
  }

  function startTurnPoll() {
    if (turnPollTimer) return;
    turnPollTimer = setInterval(pollTurnAvailability, STATE_POLL_MS);
  }

  // Appended to the tooltip AFTER a mode switch settles. The refetch cannot be
  // proven to happen (see nudgeRevalidate), so the UI must not imply it did.
  var REFRESH_HINT = " - if the panel looks unchanged, reopen the diff view";

  // ------------------------------------------------------------------ //
  // Refetch nudge (renderer half)                                        //
  // ------------------------------------------------------------------ //
  // EVIDENCE, and its limits, so the next release need not re-derive this:
  //  - The SPA uses TanStack Query v5. Confirmed from the persisted cache
  //    envelope {buster,timestamp,clientState:{mutations,queries}} under the
  //    localStorage key "react-query-cache-ls" (= persistQueryClient +
  //    createSyncStoragePersister); `gcTime` present and `cacheTime` absent
  //    pins it to v5. Real queryKeys there look like
  //    ["sessions_api_list_sessions",{orgUuid},{params}].
  //  - v5's focusManager revalidates on "visibilitychange", so a synthetic one
  //    can make a STALE query refetch. We CANNOT prove that reaches the diff
  //    query: the chunk that fetches it is not recoverable locally (the HTTP
  //    cache bodies are zstd/br compressed), so refetchOnWindowFocus and
  //    staleTime for that query are unknown, and NO queryKey containing
  //    "diff" exists in any readable cache. getGitDiff* appears only as an
  //    eipc channel name in the preload, never in SPA code.
  //  - There is NO invalidation hook to call: enumerating window.__* across the
  //    caches yields only __coworkHtmlReviewGuest and the React devtools hook,
  //    and globalThis.__* yields nothing at all.
  //  - The PRIMARY nudge is therefore MAIN-SIDE: js/diff_views_main.js replays
  //    upstream's own { type:"git_state_changed", sessionId } on the
  //    LocalSessions onEvent channel (a real webContents.send push path,
  //    verified in the bundle). This function is the harmless second half.
  // NOT DONE ON PURPOSE - the DOM-level last resort: the close control is
  // reliably identifiable but nothing that reliably REOPENS the diff view is,
  // so a synthetic close would just leave the user staring at a shut panel.
  function nudgeRevalidate() {
    // v5 listens on window for visibilitychange; dispatch it both directly and
    // bubbling from document, and a plain focus event for a v4-era manager.
    try { window.dispatchEvent(new Event("focus")); } catch (e) {}
    try { window.dispatchEvent(new Event("visibilitychange")); } catch (e) {}
    try { document.dispatchEvent(new Event("visibilitychange", { bubbles: true })); } catch (e) {}
  }

  // ------------------------------------------------------------------ //
  // The dropdown                                                         //
  // ------------------------------------------------------------------ //

  function createUi(mount, view, closeControl) {
    var select = el("select", "cdb-dv-select cdb-dv-select-inline");
    MODE_OPTIONS.forEach(function (o) {
      var opt = el("option", null, o.label);
      opt.value = o.value;
      select.appendChild(opt);
    });
    select.title = "Diff scope: " + labelForMode(MODES.WORKING);

    // The expand/collapse-all half is optional by construction: if the module
    // is missing or refuses to mount, the dropdown still works alone.
    var expand = null;
    if (window.__cdbDvExpandAll && typeof window.__cdbDvExpandAll.create === "function") {
      try {
        expand = window.__cdbDvExpandAll.create(view, closeControl, dvLog);
      } catch (e) {
        expand = null;
        console.warn("[cdb-dv] expand-all threw while mounting: " + String(e));
      }
      if (!expand) console.warn("[cdb-dv] expand-all not mounted");
    }

    mount(select, expand && expand.button);

    // A dropdown is a fresh DOM node per view mount, so its value is only a
    // guess: seed it from the last mode the main process reported, then re-read
    // the authoritative one. Without this the panel can render Branch changes
    // while a remounted dropdown claims Working tree.
    applyMode(select, lastKnownMode);
    // Seed the option's disabled state from what main last told us, THEN re-read
    // authoritatively. Seeding matters because applyTurnAvailabilityToAll is
    // change-driven: a fresh dropdown mounted while the answer is unchanged
    // would otherwise never be told.
    setTurnAvailability(select, lastKnownTurnAvailable);
    syncFromState(select);
    startTurnPoll();

    // Minimal, layout-free cue: the select dims and its tooltip says
    // "(updating…)" until the main process has applied the mode. We never touch
    // the stock panel's DOM.
    var pendingSince = 0;
    function setPending(on, settledSuffix) {
      if (on) {
        pendingSince = Date.now();
        select.setAttribute("data-cdb-dv-pending", "1");
        select.title = "Diff scope: " + labelOf(select) + " (updating…)";
        return;
      }
      var wait = Math.max(0, PENDING_CUE_MS - (Date.now() - pendingSince));
      setTimeout(function () {
        select.removeAttribute("data-cdb-dv-pending");
        select.title = "Diff scope: " + labelOf(select) + (settledSuffix || "");
      }, wait);
    }

    select.addEventListener("change", function () {
      var mode = select.value;
      // Disarm before anything async: the new file list must not be mass-expanded.
      if (expand) { try { expand.notifyModeChange(); } catch (e) {} }
      // Belt and braces: a disabled <option> is not selectable in any browser we
      // ship on, but if one ever were, sending the mode would reproduce exactly
      // the silent "looks like Working tree" bug. Refuse and say why.
      if (mode === MODES.TURN && !lastKnownTurnAvailable) {
        applyMode(select, lastKnownMode);
        console.warn("[cdb-dv] refusing Latest turn: " + TURN_UNAVAILABLE_TITLE);
        return;
      }
      lastKnownMode = mode;
      setPending(true);
      var p;
      try {
        p = window.cdbDiffViews.setMode(mode);
      } catch (e) {
        p = Promise.reject(e);
      }
      Promise.resolve(p).then(function (r) {
        var ok = !!(r && r.ok === true);
        // Revalidation nudge, only after the main side has actually switched.
        if (ok) nudgeRevalidate();
        // HONESTY: the refetch is not provable (see nudgeRevalidate), so the
        // settled tooltip tells the user what to do if nothing changed. Never
        // claim a refresh happened.
        setPending(false, ok ? REFRESH_HINT : "");
        if (ok) {
          if (!noRefreshLogged) {
            noRefreshLogged = true;
            console.warn("[cdb-dv] refetch nudge: main-side git_state_changed " +
              (r.nudged === true ? "sent" : "NOT sent") +
              ", plus synthetic focus/visibilitychange; reopen the diff view if the panel does not change");
          }
          return;
        }
        if (!setModeFailLogged) {
          setModeFailLogged = true;
          console.warn("[cdb-dv] set-mode rejected: " + ((r && r.error) || "unknown"));
        }
      }, function (e) {
        setPending(false, "");
        if (!setModeFailLogged) {
          setModeFailLogged = true;
          console.warn("[cdb-dv] set-mode failed: " + String(e));
        }
      });
    });

    return { select: select, expand: expand };
  }

  // ------------------------------------------------------------------ //
  // Install bookkeeping                                                  //
  // ------------------------------------------------------------------ //

  // Live installs, keyed by the chrome row we mounted into, with the view they
  // belong to. Entries whose row has left the document are pruned - that is
  // exactly what a view unmount looks like, and it re-enables the
  // fruitless-sweep counter.
  var installs = [];

  function pruneInstalls() {
    var out = [];
    for (var i = 0; i < installs.length; i++) {
      if (document.contains(installs[i].row)) { out.push(installs[i]); continue; }
      // The row is gone: tear the WHOLE install down, not just the expand half,
      // or two things break independently. Leaving the expand half wired would
      // keep its observer living on `view`, and an armed instance goes on
      // clicking headers open with no button left on screen to stop it. Leaving
      // the <select> in place would orphan it beside a second dropdown the next
      // time this exact row node gets re-attached (a detach/reattach cycle, not
      // a genuine unmount, still leaves `document.contains()` false in between).
      // This is the ORDINARY unmount path; removeAllUi() and the reinstall
      // branch are the exceptional ones. teardownRow() may reach destroy()
      // again afterwards, which is safe: destroy() is idempotent (see
      // js/diff_views_expand.js).
      teardownRow(installs[i].row);
    }
    installs = out;
  }

  // Remove BOTH of our nodes from one chrome row and tear the expand half down
  // (observer disconnected, pending repaint cancelled, button unmounted).
  // Returns true when a dropdown was really on screen, so callers can report an
  // honest count. Leaves the row in the same state a never-installed row is in,
  // so a later sweep reinstalls cleanly instead of adding a second dropdown
  // beside an orphaned one.
  function teardownRow(row) {
    var ui = row && row.__cdbDvUi;
    var removed = false;
    if (ui && ui.select && ui.select.parentNode) {
      ui.select.parentNode.removeChild(ui.select);
      removed = true;
    }
    if (ui && ui.expand) { try { ui.expand.destroy(); } catch (e) {} }
    if (row) { row.__cdbDv = false; row.__cdbDvUi = null; }
    return removed;
  }

  function recordInstall(row, view) {
    for (var i = 0; i < installs.length; i++) {
      if (installs[i].row === row) { installs.splice(i, 1); break; }
    }
    installs.push({ row: row, view: view });
  }

  // "Live" means an install the user can actually SEE. A row that is still in
  // the document but hidden (what the side panel becomes when the diff expands
  // to fullscreen) serves nobody, so it must not suppress the fruitless-sweep
  // diagnostic either.
  function hasLiveInstall() {
    pruneInstalls();
    for (var i = 0; i < installs.length; i++) {
      if (isDisplayed(installs[i].row)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ //
  // The feature switch (Settings -> Extra -> Features)                   //
  // ------------------------------------------------------------------ //
  // The pref lives MAIN SIDE and rides on state().enabled, so there is one
  // source of truth.
  //
  // THE FEATURE IS OPT-IN, so this starts FALSE and only an explicit
  // `enabled === true` turns it on: anything else - the field missing entirely
  // (a main half that predates the switch), a state() call that failed, a
  // malformed answer - leaves the stock diff panel alone. That is the safe
  // direction for a feature that reshapes a first-party surface.
  //
  // Off means the injected <select> is REMOVED from every chrome row, leaving the
  // stock header exactly as Anthropic renders it. The style tag stays (it styles
  // nothing but our own select) and the sweep stops installing, so the
  // MutationObserver cannot put one back while the switch is off.
  var prefOn = false;
  var prefSeen = false;    // have we had an answer from main at all yet?

  // Returns how many rows it cleared, so the diagnostic can be honest whether
  // the switch went off with UI on screen or before any was mounted.
  function removeAllUi() {
    pruneInstalls();
    var n = 0;
    for (var i = 0; i < installs.length; i++) {
      if (teardownRow(installs[i].row)) n++;
    }
    installs = [];
    return n;
  }

  // One line per TRANSITION, never per poll: the flag comparison is the guard.
  // The FIRST answer is reported too even when it agrees with the opt-in default,
  // because "the feature is off because nobody turned it on" is the single most
  // useful line in the log for a user wondering where the dropdown is.
  function applyPrefState(st) {
    var on = !!(st && st.enabled === true);
    if (prefSeen && on === prefOn) return;
    var first = !prefSeen;
    prefSeen = true;
    prefOn = on;
    if (!on) {
      var removed = removeAllUi();
      console.warn(first
        ? "[cdb-dv] disabled by preference - the feature is opt-in and not switched on; " +
          "the diff panel stays exactly as Anthropic ships it"
        : "[cdb-dv] disabled by preference - removed " + removed +
          " dropdown(s); the diff panel is stock again");
      return;
    }
    // Main resets every remembered mode to "working" when the switch goes off, so
    // a dropdown born after a re-enable must read Working tree, not whatever was
    // selected before.
    lastKnownMode = MODES.WORKING;
    console.warn(first
      ? "[cdb-dv] enabled by preference - mounting the dropdown"
      : "[cdb-dv] re-enabled by preference - restoring the dropdown");
    if (activated) sweep();
  }

  // ONE dropdown per view: a second close control inside an already-served view
  // must not add another - UNLESS the serving row is no longer displayed.
  //
  // FULLSCREEN FIX (2026-07-31): expanding the diff panel (⤢) mounts a SECOND
  // chrome row for the same view while the side panel's row stays in the
  // document, merely hidden. document.contains() still reported it, so the view
  // counted as served and the fullscreen header got no dropdown at all - while
  // the mode kept applying main-side, i.e. exactly the silent desync reported.
  // An install in a hidden row cannot serve anyone, so it must not block a
  // visible one.
  // TWO LIVE INSTANCES ON ONE VIEW FIGHT EACH OTHER. viewServedByDisplayedRow()
  // deliberately lets a second install through when the serving row is hidden
  // (the fullscreen fix above) - but neither instance knows about the other, and
  // both expand halves observe the SAME `view`. Reproduced: A is armed, the user
  // collapses via B (B disarms and closes everything), the next per-file patch
  // lands, and still-armed A re-expands it. The hidden row is the one that has
  // to go: nothing on screen can disarm it.
  //
  // Torn down WHOLE, not just destroy()'d, so the row is left exactly as a
  // never-installed row - otherwise the orphaned <select> would still be sitting
  // there when the row is displayed again and the reinstall would put a second
  // one next to it.
  function dropHiddenInstallsForView(view, row) {
    var out = [];
    for (var i = 0; i < installs.length; i++) {
      var rec = installs[i];
      if (rec.view !== view || rec.row === row || isDisplayed(rec.row)) {
        out.push(rec);
        continue;
      }
      teardownRow(rec.row);
    }
    installs = out;
  }

  function viewServedByDisplayedRow(view, row) {
    pruneInstalls();
    for (var i = 0; i < installs.length; i++) {
      if (installs[i].view !== view) continue;
      // This very row is being (re)installed - recordInstall de-dupes it.
      if (installs[i].row === row) continue;
      if (isDisplayed(installs[i].row)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ //
  // Re-validation: a dropdown must not outlive its diff view              //
  // ------------------------------------------------------------------ //
  // DEFECT B (2026-08-04, measured live): the diff-scope dropdown turned up in
  // the in-app browser/preview panel's toolbar row. With `preview` as the only
  // mounted side tile the probe read
  //     panel tileId=preview  markers: []  wouldQualify: false  ourDropdown: TRUE
  // - i.e. the <select> was sitting in a panel our OWN qualification check
  // rejects, so it was never mis-installed by a bad gate. It is a STALE
  // LEFTOVER: upstream REUSES the chrome-row DOM when it swaps which tile owns
  // that row, and our <select> is a foreign node React does not manage, so it
  // survives the row's contents being replaced and rides along into whatever
  // view now owns the row. Panel tabs made it easy to hit (one row serves
  // several tiles in quick succession) but the bug is entirely ours.
  //
  // Nothing already here could catch it:
  //   - pruneInstalls() only asks whether the row is still in the DOCUMENT,
  //     and it is - it was reused, not removed.
  //   - installOnCloseControl() settles an already-served row (row.__cdbDv with
  //     both our nodes still inside it) BEFORE it re-resolves the view at all.
  //     That is deliberate and must stay: a mode switch can legitimately empty
  //     the diff, and re-qualifying there would read the emptied panel as "not
  //     a diff view".
  // So the re-validation belongs where the install LIST is - the sweep - and it
  // has to be a POSITIVE re-qualification, never a "the node is still in the
  // document" proxy, which is exactly what already failed.
  //
  // The view is re-resolved from the row's own live close control through the
  // SAME resolveView() the install used, so the qualification rule stays in
  // ONE place: no second marker set, no separate notion of "is a diff view".
  //
  // DELIBERATELY NOT TIGHTENED (this is the edge case that motivated the loose
  // marker, see VIEW_MARKERS): qualification is ANY-OF, because a LARGE diff
  // renders every file COLLAPSED and ".epitaxy-diff-panel" then does not exist
  // at all - a real 12-file diff view legitimately shows only the per-file
  // header marker. The empty-diff fallback (qualifiesAsEmptyDiffView) still
  // counts as qualifying too. This function only ever removes an install whose
  // containing view fails that EXISTING gate; it never adds a requirement.
  //
  // A row whose close control has gone is left alone: that is a half-rendered
  // row, not a wrong one, and pruneInstalls() already owns the "row is gone"
  // case. Torn down WHOLE via teardownRow(), so the row is left exactly as a
  // never-installed row and a later sweep can reinstall cleanly if the view
  // becomes a diff view again.
  var staleDropLogs = 0;
  var MAX_STALE_DROP_LOGS = 3;

  function revalidateInstalls() {
    pruneInstalls();
    var out = [], dropped = 0, lastDesc = "";
    for (var i = 0; i < installs.length; i++) {
      var rec = installs[i];
      // Our own expand button is a CLONE of the close control with that class
      // stripped precisely so it is never re-discovered as one (see
      // js/diff_views_expand.js), so this cannot pick up our own node.
      var control = rec.row && rec.row.querySelector
        ? rec.row.querySelector(CLOSE_CONTROL_SELECTOR) : null;
      if (!control) { out.push(rec); continue; }
      if (resolveView(control)) { out.push(rec); continue; }
      var host = rec.row.closest ? rec.row.closest(VIEW_CONTAINER_SELECTOR) : null;
      lastDesc = describeMarkers(host || document);
      teardownRow(rec.row);
      dropped++;
    }
    installs = out;
    if (dropped && staleDropLogs < MAX_STALE_DROP_LOGS) {
      staleDropLogs++;
      console.warn("[cdb-dv] removed " + dropped + " stale dropdown(s): the view now holding " +
        "the chrome row no longer qualifies as a diff view (upstream reused the row for " +
        "another tile) - markers there: " + lastDesc + "; appliedMode=" + lastKnownMode);
    }
    return dropped;
  }

  // ------------------------------------------------------------------ //
  // Install                                                             //
  // ------------------------------------------------------------------ //

  // Returns "close-control-row" when this close control's row actually got the
  // dropdown, false otherwise. CRITICAL: a close control whose view does not
  // qualify is NEVER marked - Terminal and the in-app browser have close
  // controls too, and a real diff view's file list mounts late, so it must be
  // re-examined on every later sweep.
  function installOnCloseControl(closeControl) {
    var row = closeControl.parentElement;
    if (!row) return false;

    // An ALREADY-SERVED row is settled before anything is re-qualified. A mode
    // switch can legitimately empty the diff (zero per-file pairs), which makes
    // qualifiesAsView() reject the very view we are already serving; checking
    // the row first keeps that from being treated as "not a diff view".
    if (row.__cdbDv) {
      var prev = row.__cdbDvUi;
      // Healthy install: BOTH our nodes are still inside this chrome row. A
      // partial re-render that kept one and dropped the other has to reinstall
      // both, or the survivor is left orphaned next to a fresh copy.
      if (prev && prev.select && row.contains(prev.select) &&
          (!prev.expand || row.contains(prev.expand.button))) return false;
      if (prev && prev.select && prev.select.parentNode) {
        prev.select.parentNode.removeChild(prev.select);
      }
      if (prev && prev.expand) { try { prev.expand.destroy(); } catch (e) {} }
      row.__cdbDv = false;
    }

    var view = resolveView(closeControl);
    if (!view) { logUnqualifiedOnce(closeControl); return false; }

    if (viewServedByDisplayedRow(view, row)) return false;

    // We are about to serve this view from THIS row, so no OTHER row may keep a
    // live install for it. Only hidden rows can be in that position (a displayed
    // one would have returned above), and a hidden row's armed expand half is
    // exactly the instance that fights this one.
    dropHiddenInstallsForView(view, row);

    // Name the path once, so a field log distinguishes "installed on a real diff
    // view" from "installed on an empty panel our own scope emptied".
    if (!emptyFallbackLogged && !anyMarker(view)) {
      emptyFallbackLogged = true;
      console.warn("[cdb-dv] installed via the EMPTY-DIFF fallback: no diff marker present, " +
        "but appliedMode=" + lastKnownMode + " for this repo, so this panel is empty because of " +
        "OUR scope - the dropdown has to stay reachable or the scope cannot be changed back");
    }

    row.__cdbDv = true;

    var ui = createUi(function (select, button) {
      // [select] [toggle] [⤢] [✕]. Our own button is control-like, so a later
      // controlClusterStart() walk goes PAST it and keeps putting the select on
      // its left - which is the order we want, by construction.
      var ref = controlClusterStart(closeControl);
      if (button) row.insertBefore(button, ref);
      row.insertBefore(select, button || ref);
    }, view, closeControl);

    row.__cdbDvUi = ui;
    recordInstall(row, view);
    logTopologyOnce(view);
    return "close-control-row";
  }

  // ------------------------------------------------------------------ //
  // Sweep + diagnostics                                                  //
  // ------------------------------------------------------------------ //

  // Deduped "epitaxy-*" class list currently present in the live DOM, for the
  // no-panel diagnostic fallback (§DOM mandatory contract).
  function liveEpitaxyClasses() {
    var seen = {};
    var out = [];
    var els = document.querySelectorAll('[class*="epitaxy"]');
    for (var i = 0; i < els.length; i++) {
      var raw = els[i].getAttribute("class") || "";
      var parts = raw.split(/\s+/);
      for (var j = 0; j < parts.length; j++) {
        var c = parts[j];
        if (c.indexOf("epitaxy") === 0 && !seen[c]) {
          seen[c] = true;
          out.push(c);
        }
      }
    }
    return out;
  }

  // A "fruitless" sweep is one where nothing of ours is installed and nothing
  // got installed this round - regardless of how many raw selector matches
  // there were. (Counting only "selector matched nothing" was an old dead-end
  // bug: one Terminal match froze the counter forever.)
  var noQualifiedSweeps = 0;
  var installLogged = false;
  // The fullscreen panel is a SECOND install, so the first-install one-shot
  // would hide it. A few extra lines (bounded) record additional mounts.
  var extraInstallLogs = 0;
  var MAX_EXTRA_INSTALL_LOGS = 3;
  // The no-qualified dump repeats when the live epitaxy class set CHANGES, so
  // entering fullscreen produces a fresh dump instead of being swallowed by a
  // one-shot latched at app start. Bounded so it can never spam the log.
  var noQualifiedDumps = 0;
  var MAX_NO_QUALIFIED_DUMPS = 3;
  var lastNoQualifiedKey = null;

  function sweep() {
    if (!prefOn) return;    // switched off: nothing of ours may (re)appear
    // DEFECT B (2026-08-04): re-validate what is ALREADY installed before
    // installing anything new, so a dropdown left behind in a reused chrome row
    // is gone within one sweep instead of staying on screen indefinitely.
    // Before the install loop on purpose: dropping a stale install also frees
    // that row to be re-served in this very pass if its view does qualify.
    revalidateInstalls();
    var controls = document.querySelectorAll(CLOSE_CONTROL_SELECTOR);
    var rawMatchCount = controls.length;
    var installedKind = null;

    for (var i = 0; i < controls.length; i++) {
      var r = installOnCloseControl(controls[i]);
      if (r && !installedKind) installedKind = r;
    }

    if (installedKind) {
      if (!installLogged) {
        installLogged = true;
        console.warn("[cdb-dv] installed: " + installedKind);
      } else if (extraInstallLogs < MAX_EXTRA_INSTALL_LOGS) {
        // A remount (close/reopen) and a fullscreen expand look the same from
        // here; either way, knowing a second dropdown appeared is what the
        // fullscreen bug needed and could not get from the log.
        extraInstallLogs++;
        console.warn("[cdb-dv] installed an additional dropdown; live rows=" + installs.length +
          " (expanded/fullscreen panel or a remount)");
      }
      return;
    }

    if (hasLiveInstall()) return; // installed earlier and still visible - not fruitless

    noQualifiedSweeps++;
    if (noQualifiedSweeps >= NO_PANEL_SWEEP_THRESHOLD && noQualifiedDumps < MAX_NO_QUALIFIED_DUMPS) {
      var classes = liveEpitaxyClasses().join(",");
      var key = rawMatchCount + "|" + classes;
      if (key !== lastNoQualifiedKey) {
        lastNoQualifiedKey = key;
        noQualifiedDumps++;
        console.warn("[cdb-dv] no qualified panel; rawMatches=" + rawMatchCount +
          "; markers document-wide: " + describeMarkers(document) +
          "; appliedMode=" + lastKnownMode +
          "; epitaxy classes seen: " + classes);
      }
    }
  }

  // Poll state() until the folder is a git repo AND a Code session is
  // available; log the (available, isGitRepo) pair only when it CHANGES from
  // what was last logged, then activate exactly once and stop polling for good
  // - only bother showing the dropdown when the folder is a git repo.
  var lastLoggedStatePair = null;
  var activated = false;

  function onState(st) {
    var ok = !!(st && st.ok);
    var available = !!(st && st.available);
    var isGitRepo = !!(st && st.isGitRepo);
    // Before the gate, so a build that starts with the switch off never activates
    // and the poll below keeps running until it is turned on.
    applyPrefState(st);
    var pairKey = available + "," + isGitRepo;
    if (pairKey !== lastLoggedStatePair) {
      lastLoggedStatePair = pairKey;
      console.warn("[cdb-dv] state: available=" + available + " isGitRepo=" + isGitRepo);
    }
    if (ok && available && isGitRepo && prefOn) {
      activate();
      startPrefPoll();
      return; // stop THIS poll - the slow pref poll takes over from here
    }
    setTimeout(pollState, STATE_POLL_MS);
  }

  function pollState() {
    window.cdbDiffViews.state().then(onState, function () { onState(null); });
  }

  // AFTER activation the activation poll stops for good, so without this a pref
  // change made in the settings dialog would only be noticed at the next app
  // start. Slow (STATE_POLL_MS), and silent unless an answer CHANGES:
  // applyPrefState and applyTurnAvailabilityToAll are both transition-logged.
  var prefPollTimer = 0;

  function startPrefPoll() {
    if (prefPollTimer) return;
    prefPollTimer = setInterval(function () {
      var p;
      try { p = window.cdbDiffViews.state(); } catch (e) { return; }
      Promise.resolve(p).then(function (st) {
        if (!st || st.ok !== true) return;
        applyPrefState(st);
        // Only meaningful while the dropdown exists; asking about turn snapshots
        // with the feature off would log an availability flip nobody can see.
        if (!prefOn) return;
        applyTurnAvailabilityToAll(st.hasTurnSnapshot === true);
        // THE APPLIED MODE MUST BE TRACKED EVEN WITH NO DROPDOWN MOUNTED
        // (2026-08-01). syncFromState only runs per install, so after our own
        // scope emptied a panel and the remounted chrome row lost the <select>,
        // nothing refreshed lastKnownMode - and qualifiesAsEmptyDiffView, which
        // is gated on it, would have stayed shut forever. Re-sweep on a change so
        // the fallback is not left waiting for the next unrelated DOM mutation.
        if (isMode(st.mode) && st.mode !== lastKnownMode) {
          lastKnownMode = st.mode;
          if (activated) sweep();
        }
      }, function () {});
    }, STATE_POLL_MS);
  }

  function activate() {
    if (activated) return;   // re-enabling must not stack a second style tag
    activated = true;
    var style = document.createElement("style");
    style.textContent = CSS;
    document.documentElement.appendChild(style);
    console.warn("[cdb-dv] activated");
    sweep();
    var t = 0;
    new MutationObserver(function () {
      if (t) return;
      t = setTimeout(function () { t = 0; sweep(); }, SWEEP_MS);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  pollState();
})();
