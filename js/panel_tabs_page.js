/*
 * panel_tabs_page.js - the panel tabs orchestrator, injected into the claude.ai
 * page by js/panel_tabs_main.js on dom-ready.
 *
 * MECHANISM v2 (2026-08-04). INVARIANT while enabled: upstream's tileLayout
 * holds chat + EVERY tab's tile, exactly as upstream left it. We never write it.
 * Switching tabs is ONE attribute toggle on the column wrappers, which a
 * stylesheet acts on:
 *
 *   [data-cdb-col]:not([data-cdb-col-active]) { display:none !important }
 *   [data-cdb-col-active]                     { flex:<sideFlex> 1 0% !important }
 *
 * Every panel therefore stays MOUNTED. That is the whole point: v1 rewrote the
 * layout to hold chat + one side tile, so the others unmounted, which discarded
 * their React state (the diff panel's expand/collapse) and cost ~900ms of
 * upstream re-render per switch. Measured live 2026-08-04: state survives
 * hide -> reveal, a switch is ~5ms, and upstream's stored flex values do not
 * drift while a column is hidden.
 *
 * WHAT IS DERIVED FROM WHAT
 *  - tab MEMBERSHIP + ORDER: order always from upstream's tileLayout (via the
 *    localStorage mirror). MEMBERSHIP is CONDITIONAL on whether a tile is
 *    expanded, and the condition is the whole reason the strip stays usable:
 *      * nothing expanded -> a tile needs a resolvable COLUMN. A close is then
 *        instant, because the column goes and the tab goes with it instead of
 *        lingering as a ghost tab for the mirror's ~1s debounce.
 *      * an expand active -> the UNION of the mirror's side tiles and the
 *        resolvable columns. Measured live 2026-08-04: expanding tears the other
 *        columns down entirely - wrappers included - so the DOM cannot tell
 *        "unmounted because expanded" from "closed", and a column-only test
 *        collapsed the strip to the single expanded tab with nothing to switch to.
 *        The mirror keeps every tile across an expand, so there it is the better
 *        witness. Gating on the expanded state is what confines the mirror's
 *        staleness to the one state where the DOM has no answer.
 *    Either way a column that the mirror has not caught up with still gets a tab,
 *    so a just-opened panel is never missing.
 *  - EXPANDED TILE: the live chrome row only - the pane whose control reads
 *    "Collapse". Measured live: `expandedTile` is NEVER persisted (absent from the
 *    mirror at every sample), so there is nothing in the store to read.
 *  - GEOMETRY: the columns' own inline flex (fresh), falling back to the mirror.
 *  - ACTIVE TAB: the only thing we persist (js/panel_tabs_store.js). An active id
 *    naming a tile that is no longer there falls back to the first side tile that
 *    HAS a column - a union tab has none, and picking one would show nothing.
 *
 * A "column" is a wrapper that either holds a mounted non-chat pane OR still
 * carries our own data-cdb-col tag. A tab can therefore exist with NO column at
 * all (a union tab while an expand is active): rendering one must not require a
 * wrapper, it is never treated as the active column to tag, and its per-tab ✕ is
 * omitted because upstream's own Close control is not in the document either.
 *
 * The chat column is never tagged and therefore never hidden, and we never hide
 * every side column - both are structural, see resolveColumns()/applyView().
 *
 * NO LAYOUT WRITES ANYWHERE. Enable adopts the split that already exists, closing
 * clicks the pane's own Close control (an inactive panel is mounted, just hidden, and
 * display:none does not prevent a programmatic .click()), and disable just removes our
 * attributes and stylesheet. So the harvested onLayoutChange callback - the feature's
 * most fragile anchor, an exact-name match on a prop next to minified code - is gone.
 *
 * WE DO NOT OPEN PANELS (2026-08-06). The `+` open-panel menu and its whole support
 * layer were removed at the user's request - "remove the + menu code and the flag".
 * Panels are opened with upstream's own controls (its Terminal / Diff / Browser header
 * buttons and its Session actions menu) and the reconciler adopts whatever appears as a
 * new tab, exactly as it already did for a panel upstream opened by itself. Gone with
 * it: the availability probe that drove upstream's Session actions menu behind the
 * user's back, and every trace of the attribute it set on <html>. The bar is now the
 * chip strip plus ⤢, and nothing in this feature synthesises input. Recoverable from
 * git history if it is ever wanted again.
 *
 * TWO DELIBERATE BEHAVIOUR CHANGES that fall out of keeping panels mounted, both
 * worth a CHANGELOG line:
 *  - HIDDEN PANELS KEEP RUNNING. A live preview or a browser page carries on in
 *    the background where v1 tore it down. That is usually what a tab should do,
 *    but it is a real CPU cost and a real change.
 *  - FULL-WIDTH IS STICKY ACROSS A SWITCH, BUT THE INCOMING PANEL REMOUNTS.
 *    Upstream unmounts every other tile's pane while one is expanded, so the
 *    incoming column cannot simply be revealed - there is nothing in it. So a
 *    switch made while expanded runs collapse -> wait for the remount -> re-tag
 *    -> expand again (see the switching section). The cost is that the incoming
 *    panel's React state is FRESH. That is inherent and NOT the sequence's
 *    fault: upstream discarded that state when the user expanded, before we did
 *    anything at all. A switch made while NOT expanded keeps every panel's state
 *    - that is the whole point of v2 - and a switch made while expanded cannot.
 *
 * Diagnostics are console.warn ONLY - claude.ai-web.log drops console.log.
 *
 * NOTHING here runs on its own until start() is called: it wires the debounced
 * MutationObserver, the slow sweep and the pref poll that drive apply() and
 * renderBar() for the life of the page (see the live loop section at the end).
 */
(function () {
  "use strict";
  if (window.__cdbTabsPage) return;

  var L = window.__cdbTabsLayout;
  var S = window.__cdbTabsStore;
  var H = window.__cdbTabsHarvest;
  if (!L || !S || !H) return;

  var PANE_SELECTOR = "[data-pane-root]";
  // Upstream's own fallback, kept in step with panel_tabs_harvest.js's PANE_FALLBACK.
  var PANE_FALLBACK_SELECTOR = ".epitaxy-view-panel";
  var SHELL_SELECTOR = ".tiles-shell";
  // IDENTITY, not mechanism (since 2026-08-05). These two say WHICH tile a leaf
  // wrapper belongs to and which leaf is active; no stylesheet rule keys off them
  // any more. Hiding and flex are decided structurally - see the structure section
  // - because the side region is a nested tree, not a flat row of these wrappers.
  var COL_ATTR = "data-cdb-col";
  var ACTIVE_ATTR = "data-cdb-col-active";
  // MECHANISM. Applied to whatever element the structure resolves to, at whatever
  // depth: HIDE_ATTR is display:none, SIDE_ATTR carries the chat/side flex share on
  // the ROW-LEVEL element, FILL_ATTR makes an inner chain element take all of its
  // parent. ROW_ATTR and CHAIN_ATTR are markers only - no rules - so the shape we
  // resolved is inspectable from a live page and from the tests.
  var HIDE_ATTR = "data-cdb-hide";
  var SIDE_ATTR = "data-cdb-side";
  var FILL_ATTR = "data-cdb-fill";
  var CHAIN_ATTR = "data-cdb-chain";
  var ROW_ATTR = "data-cdb-row";
  // HIDING BY ABSENCE, and the interlock that makes it safe. See the CSS note: the
  // default for a child of an ARMED container is hidden, so an element upstream has
  // only just inserted is hidden before it can paint rather than visible until we
  // notice it. CHAT_ATTR and KEEP_ATTR are the two positive exemptions.
  var ARMED_ATTR = "data-cdb-armed";
  var CHAT_ATTR = "data-cdb-chat";
  var KEEP_ATTR = "data-cdb-keep";
  // The three positive exemptions from hiding-by-absence, as a selector suffix. Shared
  // by both halves of that rule so the two can never drift apart.
  var ABSENCE_EXEMPT =
    ":not([" + CHAIN_ATTR + "]):not([" + CHAT_ATTR + "]):not([" + KEEP_ATTR + "])";
  // The row resolved by the last structural pass, for columnsRoot(). Kept rather
  // than re-resolved because both observers ask for it on every tick. lastChatCol /
  // lastRowChild are the two elements the flex rule is computed from, kept so the
  // drag tracker can recompute without a full pass.
  var lastRow = null;
  // Did the last structural pass REFUSE (no row, or no single chat column)? The refuse
  // state is layout-clean - nothing armed, hidden or tagged, upstream's own split intact -
  // but it must not leave OUR bar up. See renderBar().
  var structRefused = false;
  var lastChatCol = null;
  var lastRowChild = null;
  var lastHandle = null;
  var lastSid = null;
  // When the reconciler first found itself with no resolvable active column, so the
  // watchdog below can give up on it. 0 means "not holding".
  var holdSince = 0;
  var HOLD_UNARM_MS = 1500;
  // The active column's flex lives in a custom property rather than being baked
  // into the rule text, so the value can track upstream's own geometry without
  // ever rewriting the stylesheet.
  var FLEX_VAR = "--cdb-side-flex";

  var enabled = false;
  var warned = {};

  function warn(msg) {
    window.__cdbTabsWarnCount = (window.__cdbTabsWarnCount || 0) + 1;
    console.warn("[cdb-tabs] " + msg);
  }
  function warnOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    warn(msg);
  }

  function sessionId() {
    var st = L.readStore();
    if (st && st.currentSessionId) return st.currentSessionId;
    var m = /\/epitaxy\/([A-Za-z0-9_-]+)/.exec(location.pathname || "");
    return m ? m[1] : "__no-session__";
  }

  // Unwraps to the tree node itself: readStore().tileLayout is the {root: <node>}
  // wrapper, but L.sideTileIds/geometry operate on the node.
  function liveLayout() {
    var st = L.readStore();
    return st && st.tileLayout ? st.tileLayout.root : null;
  }

  // The active tab is now the ONLY persisted state, so a failed persist costs
  // exactly one thing: the active tab is not remembered across a reload. It can
  // no longer lose a panel (v1's tab set was the sole record of a hidden panel),
  // which is why this warns once and moves on.
  //
  // Lazy pruning rides along: upstream's own tileLayoutBySession is the set of
  // sessions that still exist. An EMPTY set is "we do not know what exists", NOT
  // "nothing exists" - pruning on it would delete every other session's entry.
  function persist(sid, activeId) {
    activeMemo[sid] = typeof activeId === "string" ? activeId : null;
    var st = L.readStore();
    var valid = st && st.tileLayoutBySession ? Object.keys(st.tileLayoutBySession) : null;
    if (!valid || !valid.length) valid = null;
    // The held chat/side SHARE rides along, so a reload does not jump the boundary.
    //
    // shareMemoOrStored, NOT shareMemo[sid]: the memo is only populated by
    // applyStructure(), and a switch taken from the `hold` path never runs it. Writing
    // the raw undefined there stored chatShare:null and the next applied pass
    // recaptured from whatever the live flexes happened to be - measured, a remembered
    // 0.7 silently became 0.6667. Falling back to what is already on disk means a
    // persist can never DESTROY a boundary it simply does not know yet.
    if (!S.write(sid, activeId, valid, shareMemoOrStored(sid))) {
      // LATCHED, so the share-only re-persist in applyView() stops retrying. Its
      // condition ("stored share differs from the one we hold") can never be satisfied
      // while writes fail, so without this every pass - the 2Hz sweep plus every
      // observer tick - burned a readBlob + setItem for nothing, hidden behind the
      // warnOnce. A user ACTION still retries: activeId changes are rare and storage
      // may have been freed since.
      persistBlocked = true;
      warnOnce("persist-failed",
        "could not persist the active tab (localStorage full or blocked) - tabs still " +
        "work, the active one just will not be remembered across a reload");
      return false;
    }
    persistBlocked = false;
    return true;
  }

  // ---- columns ---------------------------------------------------------------
  // A column wrapper is the pane's .tiles-shell's parentElement. There is one
  // .tiles-shell PER COLUMN and document.querySelector(".tiles-shell") returns
  // the CHAT column's, which holds no tiles at all - so a shell is only ever
  // reached from a pane, never by a bare query.

  function isNonChatPane(pane) {
    var tid = H.tileIdOf(pane);
    return !!tid && tid !== "chat";
  }

  function taggedWrappers() {
    return Array.prototype.slice.call(document.querySelectorAll("[" + COL_ATTR + "]"));
  }

  function indexOfWrapper(cols, wrapper) {
    for (var i = 0; i < cols.length; i++) if (cols[i].wrapper === wrapper) return i;
    return -1;
  }

  function colFor(cols, tileId) {
    if (!tileId) return null;
    for (var i = 0; i < cols.length; i++) if (cols[i].tileId === tileId) return cols[i];
    return null;
  }

  function inDocumentOrder(a, b) {
    if (a === b || !a.compareDocumentPosition) return 0;
    // DOCUMENT_POSITION_FOLLOWING === 4
    return (a.compareDocumentPosition(b) & 4) ? -1 : 1;
  }

  // Every side column, in document order, as {tileId, wrapper, shell, pane}.
  // `pane` is null for a column that exists only because it still carries our
  // tag - upstream unmounts non-expanded panes while a tile is expanded, and
  // dropping those columns would make the tab strip collapse to one chip for as
  // long as the user stayed expanded.
  //
  // sidePanes is reported so the caller can tell "no side panel is open" (the
  // ordinary state, silent) from "there are side panes but no wrapper resolves"
  // (the §7 failure rule: render no bar, warn once, touch nothing).
  function resolveColumns(sideIds) {
    var list = H.panes(), i, tid, shell, wrapper;
    var paneOf = [], chatPanes = [], sidePanes = 0;
    for (i = 0; i < list.length; i++) {
      tid = H.tileIdOf(list[i]);
      if (tid === "chat") chatPanes.push(list[i]);
      else if (tid) { paneOf.push({ pane: list[i], tileId: tid }); sidePanes++; }
    }

    function holdsChat(w) {
      for (var j = 0; j < chatPanes.length; j++) if (w.contains(chatPanes[j])) return true;
      return false;
    }

    var cols = [], dup;
    for (i = 0; i < paneOf.length; i++) {
      shell = paneOf[i].pane.closest ? paneOf[i].pane.closest(SHELL_SELECTOR) : null;
      wrapper = shell ? shell.parentElement : null;
      if (!wrapper) {
        warnOnce("no-column-wrapper",
          "a side pane has no .tiles-shell wrapper to tag - rendering no bar and touching nothing");
        continue;
      }
      // Never hide the chat column: a wrapper that also holds the chat pane is
      // refused outright, so the stock split is what the user is left with.
      if (holdsChat(wrapper)) {
        warnOnce("shared-chat-column",
          "a side pane shares its column wrapper with the chat pane - refusing to tag it");
        continue;
      }
      dup = indexOfWrapper(cols, wrapper);
      if (dup !== -1) {
        warnOnce("shared-column",
          "two side panes share one column wrapper - only the first gets a tab");
        continue;
      }
      cols.push({ tileId: paneOf[i].tileId, wrapper: wrapper, shell: shell, pane: paneOf[i].pane });
    }

    // Tagged-but-paneless wrappers. Kept ONLY when upstream's own layout still
    // lists the tile: that is what separates "unmounted because something else is
    // expanded" (mirror lists it) from a stale tag on a wrapper upstream has
    // reused for something else (mirror does not).
    var tagged = taggedWrappers();
    for (i = 0; i < tagged.length; i++) {
      if (indexOfWrapper(cols, tagged[i]) !== -1) continue;
      tid = tagged[i].getAttribute(COL_ATTR);
      if (!tid || sideIds.indexOf(tid) === -1) continue;
      if (colFor(cols, tid)) continue;
      cols.push({ tileId: tid, wrapper: tagged[i],
        shell: tagged[i].querySelector(SHELL_SELECTOR), pane: null });
    }

    cols.sort(function (a, b) { return inDocumentOrder(a.wrapper, b.wrapper); });

    // WHICH TILE IS EXPANDED, from the only signal upstream actually gives us: the
    // chrome row's own control reads "Collapse" on the expanded pane and "Expand"
    // everywhere else. Deliberately NOT from the mirror - measured live 2026-08-04,
    // `expandedTile` is absent from the persisted store at every sample, so it is
    // never persisted and there is nothing there to read.
    //
    // Resolved here rather than in a pass of its own because this function already
    // holds the mounted panes. While an expand is active there is exactly ONE
    // mounted side pane, so the loop is one chrome-row read in the state that
    // matters; in the ordinary state it is one cheap querySelector per open panel.
    var expandedTileId = null;
    for (i = 0; i < cols.length; i++) {
      if (cols[i].pane && H.chromeButtons(cols[i].pane).collapse) {
        expandedTileId = cols[i].tileId;
        break;
      }
    }
    return { cols: cols, sidePanes: sidePanes, expandedTileId: expandedTileId };
  }

  // Upstream's layout order first (dragging tiles in upstream's own UI therefore
  // reorders our tabs for free), then any column the ~1s-debounced mirror has not
  // caught up with, in document order - which is where upstream puts a new column
  // anyway.
  //
  // MEMBERSHIP TEST, and it is CONDITIONAL:
  //
  //  - NOT EXPANDED: a tile needs a COLUMN to get a tab. That is what makes a close
  //    instant - the column goes and the tab goes with it, instead of lingering for
  //    the mirror's ~1s debounce as a ghost tab for a panel that is already shut.
  //  - EXPAND ACTIVE: the column test is WRONG. Measured live 2026-08-04: expanding
  //    tears the other columns down ENTIRELY - the wrappers go, not just the panes -
  //    so our own tag has nothing left to survive on and "no column" is
  //    indistinguishable from "closed". The strip would collapse to the single
  //    expanded tab, leaving nothing to switch TO and making the sticky sequence
  //    unreachable from the bar. Here the mirror is the better witness: it keeps
  //    every tile across an expand (measured: layout=chat+diff+terminal throughout).
  //    So membership becomes the UNION of the mirror's side tiles and the mounted
  //    columns.
  //
  // Conditional rather than always-union precisely so the mirror's staleness is
  // confined to the one state where the DOM cannot answer the question.
  function orderedTabs(sideIds, cols, expanded) {
    var out = [], i;
    for (i = 0; i < sideIds.length; i++) {
      if (out.indexOf(sideIds[i]) !== -1) continue;
      if (expanded || colFor(cols, sideIds[i])) out.push(sideIds[i]);
    }
    for (i = 0; i < cols.length; i++) {
      if (out.indexOf(cols[i].tileId) === -1) out.push(cols[i].tileId);
    }
    return out;
  }

  // Does this tab have a mounted pane right now? A union tab produced while an
  // expand is active does not: there is no wrapper to tag and nothing to click.
  function isMountedTab(view, tileId) {
    var c = colFor(view.cols, tileId);
    return !!(c && c.pane);
  }

  // Failure rule §7: a stored id naming a tile that is no longer in the layout
  // falls back to the layout's first side tile - and specifically to the first one
  // that HAS a column, because a union tab produced while an expand is active has
  // none, and picking it with nothing remembered would leave no visible column at
  // all.
  //
  // The one case that OVERRIDES the remembered tab is a column we have never
  // tagged appearing while we were already running: that is a panel the user just
  // opened, and leaving it hidden behind the previous tab would make opening a
  // panel look like it did nothing. On the FIRST pass every column is untagged -
  // that is adoption of the split that already exists, not an open - so the
  // remembered tab wins there. `anyTagged` is what distinguishes the two.
  //
  // That override is additionally narrowed to a tile WE HAVE NEVER HAD A TAB FOR,
  // which is what makes "untagged column" actually mean "just opened".
  //
  // Measured live 2026-08-04: collapsing brings the other panes AND their column
  // wrappers back as FRESH, untagged nodes - for tiles that had tabs all along - so
  // without this narrowing every collapse handed the active tab to whichever
  // remounted column came last in document order. That was observed directly: the
  // active tab jumped terminal -> diff on a plain collapse.
  //
  // `prevTabs` is the tab set of the last applied pass, replaced rather than
  // accumulated, so a tile that is closed is forgotten and REOPENING it (upstream
  // reuses the id, e.g. "diff") counts as new again. "Not in the mirror yet" was
  // tried first and is wrong: the mirror can have caught up before our tick, and
  // then a genuinely just-opened panel would get a tab but never be revealed.
  var prevTabs = {};

  function pickActive(tabs, cols, stored) {
    if (!tabs.length) return null;
    // A sticky sequence in flight makes the user's chosen tab authoritative. The
    // remount hands us untagged columns, and this is the belt to the braces above:
    // the switch the sequence exists to serve must not be hijacked by a heuristic.
    if (stickyPending && stored && tabs.indexOf(stored) !== -1) return stored;
    var anyTagged = false, fresh = null, i;
    for (i = 0; i < cols.length; i++) {
      if (cols[i].wrapper.hasAttribute(COL_ATTR)) anyTagged = true;
      else if (!prevTabs[cols[i].tileId]) fresh = cols[i].tileId;
    }
    if (anyTagged && fresh) return fresh;
    if (stored && tabs.indexOf(stored) !== -1) return stored;
    // Nothing remembered: prefer a tab we can actually SHOW. A union tab has no
    // column, and choosing it would leave no visible side column at all.
    for (i = 0; i < tabs.length; i++) if (colFor(cols, tabs[i])) return tabs[i];
    return tabs[0];
  }

  function rememberTabs(tabs) {
    var next = {}, i;
    for (i = 0; i < tabs.length; i++) next[tabs[i]] = true;
    prevTabs = next;
  }

  // The active tab, preferring this page-life's own record over localStorage.
  // Without the in-memory half a page whose localStorage is blocked or full could
  // not switch tabs at all: every switch would persist nothing, the next read
  // would return the OLD id, and pickActive() would put the previous tab straight
  // back. localStorage stays the layer that survives a reload; it is not the
  // layer the mechanism depends on.
  var activeMemo = {};
  // Set once a write has failed, so the share-only re-persist stops hammering a
  // localStorage that cannot take it. Cleared by the first write that succeeds.
  var persistBlocked = false;

  function storedActiveId(sid) {
    if (Object.prototype.hasOwnProperty.call(activeMemo, sid)) return activeMemo[sid];
    return S.read(sid).activeId;
  }

  // Test-only counters. computeView() is the expensive call (two JSON.parse of
  // upstream's whole store plus a fiber walk per pane), so a test that wants to prove
  // an observer is NOT driving it needs to count it rather than infer from timing.
  var stats = { computeViews: 0, renderBars: 0 };

  function computeView() {
    stats.computeViews++;
    var sid = sessionId();
    var root = liveLayout();
    var sideIds = root ? L.sideTileIds(root) : [];
    var res = resolveColumns(sideIds);
    // ANCHOR ROT, reported rather than suffered in silence. `cols = []` normally means
    // "no side panel is open", which is why applyView's empty branch is quiet - but
    // upstream's OWN mirror listing side tiles while we can resolve no pane at all is
    // not that state. It means [data-pane-root] (and its .epitaxy-view-panel fallback)
    // or memoizedProps.tileId has been renamed, and the feature has stopped existing.
    // The project rule for a lost anchor is "no bar AND warn once"; this is the warn.
    if (sideIds.length && !res.sidePanes) {
      warnOnce("anchor-rot",
        "upstream's own layout lists " + sideIds.length + " side panel(s) but no pane " +
        "root resolved - " + PANE_SELECTOR + " / " + PANE_FALLBACK_SELECTOR +
        " or the tileId fiber prop has moved. The tab bar will not render; the layout " +
        "is left exactly as Anthropic ships it.");
    }
    // THE UNION GATE is "the DOM is mid-expand-transition", which is two things:
    // an expand is active, OR a sticky sequence has clicked Collapse and is waiting
    // for the remount. The second half is load-bearing - upstream can clear its own
    // expanded flag BEFORE the columns come back, and for those frames the DOM still
    // cannot tell "unmounted because expanded" from "closed". Without it the chosen
    // tab drops out of the strip mid-sequence and the active marker bounces back to
    // whatever is still mounted. `expandedTileId` stays the honest, unmixed signal
    // for everything else (the ⤢ label, collapseIfExpanded, the hold's silence).
    var tabs = orderedTabs(sideIds, res.cols, !!res.expandedTileId || stickyPending);
    var stored = storedActiveId(sid);
    return { sessionId: sid, root: root, cols: res.cols, sidePanes: res.sidePanes,
      expandedTileId: res.expandedTileId, tabs: tabs, stored: stored,
      activeId: pickActive(tabs, res.cols, stored) };
  }

  // ---- structure: the ROW, the CHAIN, and what gets hidden -------------------
  // MEASURED LIVE 2026-08-05, and this is the whole reason this section exists:
  // the side region is NOT a flat row of column wrappers. Upstream nests tile
  // stacks. With chat + (diff / terminal) + preview the row's children were
  //
  //   [ chat column, .tiles-handle, STACK(diff, .tiles-handle, terminal),
  //     .tiles-handle, preview wrapper ]
  //
  // and the stack itself is display:flex;flex-direction:column. Hiding LEAF
  // wrappers - which is all v2 did - left the branch above them occupying its own
  // flex share, and produced four visible defects: a 337px dead box between chat
  // and the panel (both of the stack's leaves hidden, the stack still 0.951936 of
  // the row), a chat/side ratio that changed with the tab (our --cdb-side-flex
  // landed on a LEAF inside the stack for diff/terminal but on a ROW CHILD for
  // preview), a bar that sat 12px lower on terminal (the stack's own horizontal
  // handle still visible above it), and pane heights differing by that same 12px.
  //
  // So we tag STRUCTURALLY instead:
  //
  //   ROW      the container holding the chat column beside the side region.
  //   CHAIN    every element from the row's child that CONTAINS the active tile
  //            down to the active leaf wrapper. Leaf-first here; the LAST entry is
  //            the row-level one.
  //   FLEX     the row-level chain element gets var(--cdb-side-flex) - so the
  //            chat/side boundary is identical for every tab, whatever depth the
  //            active tile sits at. Inner chain elements get 1 1 0%: they are the
  //            only visible child of their parent, so they take all of it.
  //   HIDE     at row level, any child that CONTAINS a side pane and is not the
  //            chain element - i.e. the whole branch, not its leaves. Inside a
  //            chain container, every child that is not the next chain element
  //            (that catches the handles, the sibling leaves, and anything
  //            upstream adds later).
  //
  // NOTHING HERE IS "STRUCTURALLY SAFE" - it is all CHECKED. An earlier version of
  // this comment claimed the chat column could never be hidden because it holds no
  // side pane, and that a mis-resolved row was therefore harmless. Both were false
  // (reviewed and reproduced 2026-08-05, Claude Desktop 1.24012.9):
  //
  //  - the absence-keyed rule exempts the ONE element we marked, not "the chat
  //    column" as a concept, so a decoy first row child took the exemption and the
  //    real chat column measured 0px wide while the row stayed armed;
  //  - the inner-chain loop hides EVERY non-chain child, not only branches holding a
  //    side pane, so with `row = null` it reached up the ancestor path and hid the
  //    chat column and neighbouring app chrome.
  //
  // The first of those was reproduced AGAIN on 2026-08-06 against the "positive"
  // predicate that replaced it, because that predicate ("in flow, >= 80px wide, has
  // children, holds no mounted side pane") described a box with content rather than the
  // chat column, and ties were still broken by document order. So the pick is now
  // structural and single-answer: chatLooksRight() requires a .tiles-shell and NO pane
  // root, and chatColumnOf() returns null when two children qualify instead of taking
  // the first. Hiding-by-absence is also bounded to tile furniture, so a stranger that
  // owns no shell cannot be blanked by us at all.
  //
  // So: the chat pick is verified POSITIVELY (chatLooksRight), ambiguity refuses, the
  // row is required before anything is hidden at all, and arming demands both.
  //
  // THREE LOAD-BEARING ASSUMPTIONS live in this section, all validated against Claude
  // Desktop 1.24012.9 (2026-08-05) and all inventoried in baseline/PANEL_TABS_ANCHORS.md with the
  // console recipes that re-derive them:
  //   A1 the ROW SHAPE that chatLooksRight() encodes;
  //   A2 MAX_CHAIN_HOPS - the leaf->row nesting depth;
  //   A3 the literal tile id "chat" (see isNonChatPane / resolveColumns).
  // Each one now REFUSES and warns when it fails rather than guessing, but the feature
  // stops working until the assumption is re-established.
  var HANDLE_SELECTOR = ".tiles-handle";
  var BAR_CLASS = "cdb-tabs-bar";
  var MAX_CHAIN_HOPS = 12;

  function isHandle(el) {
    return !!(el && el.matches && el.matches(HANDLE_SELECTOR));
  }
  // Upstream's own leaf furniture and our own bar. Never a "branch", never a
  // candidate chat column, and never hidden by the chain rule.
  function isFurniture(el) {
    if (!el || !el.classList) return true;
    if (el.classList.contains(BAR_CLASS) || el.classList.contains("tiles-shell")) return true;
    return isHandle(el);
  }
  function holdsAny(el, nodes) {
    for (var i = 0; i < nodes.length; i++) if (el.contains(nodes[i])) return true;
    return false;
  }

  // The mounted side panes, which is what "contains a side pane" is tested against.
  function sidePanesOf(cols) {
    var out = [], i;
    for (i = 0; i < cols.length; i++) if (cols[i].pane) out.push(cols[i].pane);
    return out;
  }

  // Is this candidate the chat column? POSITIVELY IDENTIFIED, by something only the
  // chat column has.
  //
  // Every heuristic version of this was wrong, and the last one shipped a hole that was
  // reproduced on the live app: "not furniture, no mounted side pane, in flow, >= 80px
  // wide, has children" describes A BOX WITH CONTENT, not the chat column, so a decoy
  // planted as the row's FIRST child won on document order and the absence-keyed rule
  // hid the real chat column (measured: decoy tagged, real chat 0px, armed anyway).
  //
  // THE SIGNAL (measured on 1.24012.9 with all five row children, 2026-08-06):
  //
  //   row child             .tiles-shell   shells holding a pane
  //   chat column                1                  0
  //   .tiles-handle              0                  -
  //   stack(terminal,diff)       2                  2
  //   stack(preview,tasks)       2                  2
  //
  // So the chat column is the row child that OWNS AT LEAST ONE TILES-SHELL AND WHOSE
  // SHELLS ARE ALL EMPTY. Document-wide there is exactly ONE empty shell (measured:
  // emptyShellsInDoc 1 of totalShells 5), so this is a unique answer, not a tie-break.
  // A branch's shells always hold panes; a handle, rail, overlay, portal host, live
  // region or drag ghost owns no shell at all.
  //
  // Why per-shell rather than "contains no [data-pane-root] anywhere": live, the chat
  // column holds none - but its shell being EMPTY is the narrower and more durable
  // statement, and it survives upstream mounting the chat surface as a pane root
  // outside the shell (which is how the tests model it) without the predicate needing
  // to know about the "chat" tile id.
  //
  // Structural, not class-based, deliberately: `.tiles-shell` is already load-bearing
  // in a dozen places here, so it is an anchor we are committed to and re-audit anyway,
  // whereas the transcript's `epitaxy-transcript-*` classes would be a new and purely
  // cosmetic dependency. (They are recorded in the anchors doc as a cross-check.)
  //
  // The pane test is a DIRECT DOM QUERY, not "holds no MOUNTED side pane": the mounted
  // list is our own bookkeeping and lags upstream by a frame, which is what let a side
  // leaf between panes pass as chat.
  //
  // Note what is NOT here any more: the CANDIDATE's own width, child count and position.
  // They added no discrimination once the shell signal was in place, and the width test
  // actively caused a self-defeating test - insert a decoy into an ALREADY-ARMED row and
  // our own rule hides it, so it measures 0px and "fails" the width test, reporting SAFE.
  // (The shell's position, below, is a different quantity and does discriminate.)
  //
  // ...AND ITS SHELL IS ABSOLUTELY POSITIONED. This is the discriminator that separates
  // the chat column from A SIDE WRAPPER WHOSE PANE HAS NOT LANDED YET, and it is what
  // the "all shells empty" test alone could not do. Measured live on 1.24012.9
  // (2026-08-06, all five shells in the document):
  //
  //   shell owner      computed position   inline                       panes
  //   chat column      absolute            position:absolute;           0
  //                                        top/bottom/left:0;
  //                                        min-width:320px
  //   terminal leaf    static              (no position at all)         1
  //   diff leaf        static              (no position at all)         1
  //   preview leaf     static              (no position at all)         1
  //   tasks leaf       static              (no position at all)         1
  //
  // The four side shells carry a byte-identical inline style with no `position`; only
  // chat's is taken out of flow. So an EMPTY + STATIC shell is a side wrapper mid-mount,
  // and an EMPTY + ABSOLUTE shell is chat. Without this, a wrapper upstream inserts a
  // beat before its pane became a second chat candidate, `chatColumnOf` refused, the row
  // went null, and every mark was cleared - measured by review as chat 520 -> 312px with
  // three side branches painting. Refusing in the very frame the absence rule exists for
  // traded the user's zero-jump open straight back in.
  //
  // COMPUTED, not inline: upstream may move this to a class at any time and the computed
  // value survives that. If getComputedStyle is unavailable at all we do NOT fail the
  // candidate - going inert is worse than a weaker test.
  function chatLooksRight(el) {
    if (!el || isFurniture(el) || !el.querySelectorAll) return false;
    // One of OUR side columns can never be the chat column, whatever its panes are
    // doing this frame.
    if (el.hasAttribute && el.hasAttribute(COL_ATTR)) return false;
    var shells = el.querySelectorAll(SHELL_SELECTOR), i, abs = false;
    // It must own a shell...
    if (!shells.length) return false;
    // ...every one of them must be empty, by either of upstream's two pane anchors...
    for (i = 0; i < shells.length; i++) {
      if (shells[i].querySelector(PANE_SELECTOR)) return false;
      if (shells[i].querySelector(PANE_FALLBACK_SELECTOR)) return false;
    }
    if (!window.getComputedStyle) return true;
    // ...and at least one must be out of flow, which no side wrapper's is.
    for (i = 0; i < shells.length; i++) {
      if (window.getComputedStyle(shells[i]).position === "absolute") { abs = true; break; }
    }
    return abs;
  }

  // ---- the chat column, held ONCE identified -----------------------------------
  // STICKINESS. The pick is remembered, and re-decided only when the remembered element
  // stops being a valid chat column. That is deliberate and it is not the same job as
  // the discriminator above:
  //
  //  - the discriminator classifies correctly in a given frame;
  //  - stickiness stops us RE-LITIGATING a settled question every frame upstream is
  //    mid-render. It means ambiguity-refusal only ever guards the FIRST identification,
  //    which is where the decoy attack lives, instead of firing in transient frames
  //    where refusing unarms the layout and undoes the zero-jump open.
  //
  // Neither is redundant. If upstream ever makes a side shell absolute (or chat's
  // static) the discriminator silently weakens - and stickiness is what bounds the blast
  // radius of that, turning a per-frame failure into an at-most-once one at startup.
  // It also makes the row walk deterministic (see looksLikeRow), which removes the whole
  // class of "the walk stopped early because something else looked chat-ish" rather than
  // just the paneless-leaf instance of it.
  var stickyChat = null;

  // Is the held pick still good? Self-clearing: a stale ref is dropped here, so every
  // caller gets a straight answer and nothing has to remember to invalidate.
  function stickyChatOk() {
    if (!stickyChat) return false;
    if (!stickyChat.parentElement || !document.contains(stickyChat)) { stickyChat = null; return false; }
    if (!chatLooksRight(stickyChat)) { stickyChat = null; return false; }
    return true;
  }

  // The chat column, or null. AMBIGUITY REFUSES: two convincing candidates means we do
  // not know which is chat, and resolving that by document order is exactly the bug that
  // hid the user's chat column. Null makes applyStructure() refuse to arm, which leaves
  // upstream's own split - the safe direction.
  function chatColumnOf(row) {
    if (!row) return null;
    // Held pick first, so a transient frame cannot re-open a settled question.
    if (stickyChatOk() && stickyChat.parentElement === row) return stickyChat;
    var kids = row.children, i, found = null;
    for (i = 0; i < kids.length; i++) {
      if (!chatLooksRight(kids[i])) continue;
      if (found) return null;
      found = kids[i];
    }
    if (found) stickyChat = found;
    return found;
  }

  // Does `parent` look like the ROW? Once the chat column is known the answer is
  // DETERMINISTIC - the row is that element's own parent and nothing else. That is the
  // fix for the walk stopping at a STACK because a not-yet-filled leaf inside it looked
  // chat-ish: `data-cdb-row` moved to the stack, `data-cdb-chat` landed on the paneless
  // leaf, chat went 402 -> 248px with two side branches visible, and it warned ZERO
  // times because nothing had failed as far as the code was concerned.
  function looksLikeRow(parent, exclude) {
    if (stickyChatOk()) return stickyChat.parentElement === parent && stickyChat !== exclude;
    var kids = parent.children, i, found = null;
    for (i = 0; i < kids.length; i++) {
      if (kids[i] === exclude || !chatLooksRight(kids[i])) continue;
      if (found) return false;
      found = kids[i];
    }
    return !!found;
  }

  // Walks up from the active leaf wrapper to the row. `chain` is leaf-first and its
  // last entry is the row-level element.
  //
  // `row` is null when no convincing chat column turned up before the hop budget
  // (MAX_CHAIN_HOPS) or <body>. That is a REFUSAL, not a partial success: with no row
  // we do not know where the side region ends, so applyStructure() hides NOTHING and
  // marks nothing. An earlier comment here said hiding was "still safe (it only ever
  // hides something that holds a side pane)" - that was only true of the row-level
  // rule; the inner-chain loop hid every non-chain child of every chain element, and
  // with the chain topping out at an arbitrary high ancestor that included the chat
  // column and neighbouring app chrome. Reproduced 2026-08-05.
  function resolveChain(leafWrapper) {
    var chain = [leafWrapper], node = leafWrapper, parent, hops = 0, row = null;
    while (hops++ < MAX_CHAIN_HOPS) {
      parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (looksLikeRow(parent, node)) { row = parent; break; }
      chain.push(parent);
      node = parent;
    }
    return { row: row, chain: chain, rowChild: chain[chain.length - 1] };
  }

  // ---- geometry: A TWO-PANE SPLIT, held per session as a RATIO ----------------
  // THE RULE: the side region gets the width ONE panel would get in a two-pane
  // split - chat versus the active branch alone - and that split is remembered as
  // a PROPORTION.
  //
  //   chatShare := chatFlex / (chatFlex + sideFlex)   captured, then HELD
  //   sideFlex  := chatFlex * (1 - chatShare) / chatShare
  //
  // Since the hidden branches are display:none and contribute nothing, the two
  // visible children are chat (chatFlex) and the branch (sideFlex), so the boundary
  // is exactly chatShare. Three things follow:
  //
  //  - CHAT DOES NOT SHRINK WHEN A PANEL IS OPENED. Only ONE panel is ever visible,
  //    so the side region must not claim the combined share of all the branches.
  //    (It did once: with 4 branches open - measured chat 1.1989 | 0.8011 | 1 | 1 |
  //    1 - summing them gave the side 3.801 of 5.0 and squeezed chat to 428px of
  //    1796, worse on every new panel.)
  //  - IT SURVIVES UPSTREAM'S RENORMALISATION, which is why it is a RATIO and not a
  //    total or a difference. Upstream rescales the row's flexes when branches are
  //    added or removed: measured live 2026-08-05, chat went 1.198940 -> 2.0 for
  //    the same visual split. The previous version held TOTAL and applied
  //    `sideFlex = TOTAL - chatFlex`; as chatFlex drifted up toward TOTAL that
  //    difference collapsed (2.000003 - 1.6 = 0.4 -> chat 1427px, panel 357px) and
  //    the user watched the panel shrink. A ratio is invariant under uniform
  //    rescaling: double chatFlex and sideFlex doubles with it, so the boundary
  //    does not move. The user's word was "sometimes" because it only bit when an
  //    open or close actually rescaled chat.
  //  - THE SIDE WIDTH IS THE SAME ON EVERY TAB, even when two branches carry
  //    different upstream flexes, because the share is per session and not per
  //    branch. That is b5dfb16's uniformity, kept.
  //
  // Flexes are read from INLINE flex-grow, which is upstream's own value and is
  // fresh: our overrides live in a stylesheet rule, never inline, so reading
  // element.style.flexGrow can never read our own value back. The mirror's
  // geometry() is the fallback.
  var shareMemo = {};
  // Only reached when nothing can be captured either (no readable chat flex AND no
  // readable branch flex), which means we know nothing about the split.
  var DEFAULT_SHARE = 0.5;

  function inlineFlex(el) {
    var g = el && el.style ? parseFloat(el.style.flexGrow) : NaN;
    return isFinite(g) && g > 0 ? g : null;
  }

  function chatFlexOf(chatCol, root) {
    var g = inlineFlex(chatCol);
    if (g !== null) return g;
    var geom = root ? L.geometry(root) : null;
    return geom && geom.chatFlex > 0 ? geom.chatFlex : 1;
  }

  // The active branch's OWN flex, used only when capturing TOTAL. Falls back to the
  // mirror's side total divided by nothing clever - just its own value if we can
  // read it, else an equal share, else 1.
  function branchFlexOf(rowChild, root) {
    var g = inlineFlex(rowChild);
    if (g !== null) return g;
    var geom = root ? L.geometry(root) : null;
    return geom && geom.sideFlex > 0 ? geom.sideFlex : 1;
  }

  // Held per session, seeded from localStorage so a reload does not jump. A stored
  // value outside the open interval (0,1), or non-numeric, is DISCARDED and
  // recaptured - never clamped. `total` from the previous version cannot be
  // mistaken for one: it lives under a different key, so nothing reads it.
  //
  // Memoised on the ADOPT path too, not just on capture. Without that the memo
  // stayed undefined after a reload and the persist step wrote that undefined
  // straight back over the stored value - remembered for exactly one pass, then
  // lost.
  function chatShareFor(sid, chatFlex, activeBranchFlex) {
    var s = Object.prototype.hasOwnProperty.call(shareMemo, sid)
      ? shareMemo[sid] : S.read(sid).chatShare;
    if (S.validShare(s)) { shareMemo[sid] = s; return s; }
    var denom = chatFlex + activeBranchFlex;
    var captured = denom > 0 ? chatFlex / denom : DEFAULT_SHARE;
    if (!S.validShare(captured)) captured = DEFAULT_SHARE;
    shareMemo[sid] = captured;
    return captured;
  }

  function sideFlexOf(chatCol, rowChild, root, sid) {
    var chatFlex = chatFlexOf(chatCol, root);
    // WHILE THE USER IS DRAGGING the chat<->side divider, mirror upstream's OWN
    // chat:adjacent proportion instead of holding ours. Holding a ratio through a
    // drag would pin the boundary and the divider would do nothing; upstream is
    // writing exactly the proportion the user is choosing, so following it is both
    // correct and perfectly live. The result is re-captured on pointerup.
    if (dragIsArmed()) {
      var adj = adjacentBranchFlex();
      if (adj !== null) return adj;
    }
    var share = chatShareFor(sid, chatFlex, branchFlexOf(rowChild, root));
    // A ratio needs a positive anchor. With chat collapsed or unreadable there is
    // nothing to take a proportion OF, so fall back to the branch's own upstream
    // flex rather than dividing by zero into a window-filling panel.
    if (!(chatFlex > 0)) return branchFlexOf(rowChild, root);
    return chatFlex * (1 - share) / share;
  }

  function syncSideFlex(chatCol, rowChild, root, sid) {
    var v = String(sideFlexOf(chatCol, rowChild, root, sid));
    var de = document.documentElement;
    if (!de || !de.style) return v;
    if (de.style.getPropertyValue(FLEX_VAR) === v) return v;
    de.style.setProperty(FLEX_VAR, v);
    return v;
  }

  // ---- the chat<->side drag ---------------------------------------------------
  // Two jobs here, and they are different in kind.
  //
  // TRACKING. Upstream's drag handler rewrites the chat column's INLINE flex many
  // times a second, and our sideFlex is derived from it, so it has to follow.
  // Waiting for the 500ms sweep made the divider visibly lag the pointer, which is
  // a large part of why it "felt broken". An attribute observer on the ONE element
  // upstream writes is the whole mechanism: no listener attached to a node we do
  // not own, and it recomputes a single custom property rather than running a full
  // pass. It cannot feed back - our value goes on <html>, never on the chat column.
  //
  // DISCRIMINATING A DRAG FROM A RENORMALISATION, which is what makes the ratio
  // safe to re-capture. Both change chatFlex, but they mean opposite things: a drag
  // IS the user choosing a new proportion, a renormalisation must leave the
  // proportion alone. Two signals, required TOGETHER:
  //
  //   1. a pointerdown on the kept chat<->side handle, ended by a pointerup. This
  //      is the authoritative one - only a drag has a pointer on that handle.
  //   2. the row's child count UNCHANGED across the gesture.
  //
  // AND, not OR, deliberately. Upstream's renormalisation is not uniform - measured
  // 2026-08-05, chat/adjacent went 1.198940/0.801063 (share 0.599) to 2.0/1.0
  // (share 0.667) - so re-capturing on one would visibly move the boundary. Signal
  // 1 alone already excludes it (no pointer is involved), and signal 2 costs one
  // integer compare and covers a branch appearing mid-gesture. Listeners are on
  // DOCUMENT, in the capture phase, so nothing is ever attached to upstream's own
  // handle element.
  var dragArmed = false;
  var dragRowKids = -1;
  var dragArmedAt = 0;
  var dragListenersInstalled = false;
  // A drag is over in well under a second. If a pointerup is ever swallowed - a
  // capture we do not see, a window blur mid-gesture - staying armed would mean
  // mirroring upstream's own adjacent flex forever and quietly ignoring the held
  // share. This ceiling is the belt for that; it is never reached by a real drag.
  var DRAG_ARM_MAX_MS = 10000;

  function dragIsArmed() {
    if (!dragArmed) return false;
    if (Date.now() - dragArmedAt > DRAG_ARM_MAX_MS) { dragArmed = false; return false; }
    return true;
  }

  // Upstream's drag partner: the row child immediately after the kept handle. Its
  // inline flex is written by the same drag that writes chat's, so the pair IS the
  // proportion the user chose - even while that branch is hidden.
  function adjacentBranchFlex() {
    if (!lastHandle) return null;
    return inlineFlex(lastHandle.nextElementSibling);
  }

  function recaptureShare() {
    if (!lastRow || !lastSid) return false;
    if (lastRow.children.length !== dragRowKids) return false;
    var chatFlex = inlineFlex(lastChatCol);
    var adj = adjacentBranchFlex();
    if (chatFlex === null || adj === null) return false;
    var s = chatFlex / (chatFlex + adj);
    if (!S.validShare(s)) return false;
    shareMemo[lastSid] = s;
    persist(lastSid, storedActiveId(lastSid));
    return true;
  }

  function onDragDown(ev) {
    if (!enabled || !lastHandle || !ev.target) return;
    if (ev.target !== lastHandle &&
        !(lastHandle.contains && lastHandle.contains(ev.target))) return;
    dragArmed = true;
    dragArmedAt = Date.now();
    dragRowKids = lastRow ? lastRow.children.length : -1;
  }

  function onDragUp() {
    if (!dragArmed) return;
    dragArmed = false;
    if (!enabled) return;
    recaptureShare();
    syncSideFlex(lastChatCol, lastRowChild, null, lastSid);
  }

  // On BOTH document and window. Upstream's own drag tracks pointermove on window
  // (verified live 2026-08-05), and an event dispatched AT window never reaches a
  // document listener - window is not below document in the propagation path - so
  // listening on document alone silently missed the pointerup and left us armed.
  // onDragUp() is idempotent, so hearing it twice costs nothing.
  function installDragListeners() {
    if (dragListenersInstalled || !document.addEventListener) return;
    dragListenersInstalled = true;
    document.addEventListener("pointerdown", onDragDown, true);
    document.addEventListener("pointerup", onDragUp, true);
    // A gesture the page cancels (window blur, Escape) must not leave us armed.
    document.addEventListener("pointercancel", onDragUp, true);
    document.addEventListener("lostpointercapture", onDragUp, true);
    if (window.addEventListener) {
      window.addEventListener("pointerup", onDragUp, true);
      window.addEventListener("pointercancel", onDragUp, true);
      window.addEventListener("blur", onDragUp, true);
    }
  }

  var chatFlexObserver = null;
  var chatFlexObserved = null;

  function observeChatFlex() {
    if (!window.MutationObserver) return;
    if (lastChatCol === chatFlexObserved) return;
    if (!chatFlexObserver) {
      chatFlexObserver = new window.MutationObserver(function () {
        if (!enabled || !lastChatCol) return;
        // root is deliberately null: during a drag the inline flex IS present (that
        // is what fired this), and the session's TOTAL is already in the memo, so
        // there is nothing here worth a localStorage read and a JSON.parse for.
        syncSideFlex(lastChatCol, lastRowChild, null, lastSid);
      });
    }
    chatFlexObserver.disconnect();
    chatFlexObserved = lastChatCol;
    if (lastChatCol) {
      chatFlexObserver.observe(lastChatCol, { attributes: true, attributeFilter: ["style"] });
    }
  }

  // ---- structural marking ----------------------------------------------------
  // Marks are applied by DIFF, never cleared-and-reapplied: renderBar() and the
  // sweep run several times a second and a full clear would restyle the whole side
  // region on every pass. `wanted` is the complete desired set for one attribute;
  // anything else carrying it loses it.
  function syncMark(attr, wanted) {
    var have = document.querySelectorAll("[" + attr + "]"), i, el;
    for (i = 0; i < have.length; i++) {
      el = have[i];
      if (wanted.indexOf(el) === -1) el.removeAttribute(attr);
    }
    for (i = 0; i < wanted.length; i++) {
      if (!wanted[i].hasAttribute(attr)) wanted[i].setAttribute(attr, "");
    }
  }

  // The structural pass. Returns what it decided so the tests (and the live
  // probes) can assert the shape rather than infer it from pixels.
  function applyStructure(view, activeCol) {
    var sidePanes = sidePanesOf(view.cols);
    var res = resolveChain(activeCol.wrapper);
    var chain = res.chain, rowChild = res.rowChild, row = res.row;
    var hide = [], fill = [], side = [], k, i, kids, c, chatCol = null, keptHandle = null;

    // NO ROW, NO HIDING - and this return is the whole of H1's fix. Without a row we
    // cannot say which siblings belong to the side region, and the inner-chain loop
    // below is not restricted to branches holding a side pane, so running it would
    // reach up the ancestor path and hide the chat column. Everything is cleared
    // rather than left behind, and it warns, because a row we cannot resolve is a
    // real anchor failure and not an ordinary state.
    if (!row) {
      warnOnce("no-row",
        "could not resolve the tiles row from the active panel (no convincing chat " +
        "column within " + MAX_CHAIN_HOPS + " hops) - hiding nothing and leaving " +
        "upstream's own split alone");
      clearStructuralMarks();
      structRefused = true;
      return { row: null, chain: chain, rowChild: rowChild, hidden: 0,
        chatCol: null, handle: null, armed: false };
    }
    chatCol = chatColumnOf(row);
    // Same refusal for the chat column itself, and it covers BOTH failure modes:
    // no candidate at all, AND more than one (chatColumnOf returns null for either).
    // Armed absence-keying with an unverified chat exemption is precisely how the chat
    // column gets hidden, and picking the first of two candidates by document order is
    // how it got hidden in the reproduction - a decoy inserted ahead of chat won.
    if (!chatCol) {
      warnOnce("no-chat-column",
        "the tiles row has no single child that positively identifies as the chat " +
        "column (none, or more than one) - hiding nothing rather than guessing");
      clearStructuralMarks();
      structRefused = true;
      return { row: row, chain: chain, rowChild: rowChild, hidden: 0,
        chatCol: null, handle: null, armed: false };
    }

    // Inner chain containers: exactly ONE of their children is ever visible, so
    // everything else goes - the sibling leaves AND upstream's handles, which is
    // what was pushing the bar and the pane down by 12px.
    for (k = chain.length - 1; k >= 1; k--) {
      kids = chain[k].children;
      for (i = 0; i < kids.length; i++) {
        c = kids[i];
        if (c === chain[k - 1]) continue;
        // Never our own bar or upstream's shell: those belong to a leaf, and a
        // chain container should not have them - but if the shape ever changes,
        // hiding them would blank the panel.
        if (c.classList && (c.classList.contains(BAR_CLASS) ||
            c.classList.contains("tiles-shell"))) continue;
        hide.push(c);
      }
    }
    // Every chain element except the row-level one simply fills its parent.
    for (k = 0; k < chain.length; k++) if (chain[k] !== rowChild) fill.push(chain[k]);

    if (row) {
      kids = row.children;
      for (i = 0; i < kids.length; i++) {
        c = kids[i];
        if (c === rowChild) continue;
        if (isHandle(c)) {
          // EXACTLY ONE row handle survives: the chat<->side divider, the handle
          // immediately after the chat column. Every other row handle sits between
          // two side branches of which at most one is ever visible, so it could
          // only ever drag a box nobody can see. Note the rule is positional, NOT
          // "hide a handle next to something hidden" - with the stack hidden BOTH
          // row handles are flanked by a hidden box, and that rule would take the
          // chat<->side drag away entirely.
          if (chatCol && c.previousElementSibling === chatCol) { keptHandle = c; continue; }
          hide.push(c);
          continue;
        }
        // A BRANCH - hidden whole, which is what closes the dead-gap defect. Only
        // ever something that holds a side pane, so the chat column, and anything
        // else outside the side region, is untouchable by construction.
        if (holdsAny(c, sidePanes)) hide.push(c);
      }
      side.push(rowChild);
    }

    // ARMING, and it is the interlock for the absence-keyed rule. Only when BOTH the
    // row and a positively-identified chat column resolved, and the chain is real: an
    // armed container hides every child that is not exempt, so arming on a
    // mis-resolved row would hide the chat column itself.
    //
    // Armed: the row, plus every INNER chain container - not the leaf, whose children
    // are our bar and upstream's shell and must both stay.
    var armed = [], canArm = !!(row && chatCol && chain.length && rowChild);
    if (canArm) {
      armed.push(row);
      for (k = 1; k < chain.length; k++) armed.push(chain[k]);
    }

    syncMark(HIDE_ATTR, hide);
    syncMark(FILL_ATTR, fill);
    syncMark(SIDE_ATTR, side);
    syncMark(CHAIN_ATTR, chain);
    syncMark(ROW_ATTR, row ? [row] : []);
    syncMark(CHAT_ATTR, chatCol ? [chatCol] : []);
    syncMark(KEEP_ATTR, keptHandle ? [keptHandle] : []);
    // Armed LAST, so the exemptions are already in place when the rule starts
    // applying. The other order would blink the chat column for one style pass.
    syncMark(ARMED_ATTR, armed);
    structRefused = !canArm;
    lastRow = row;
    lastChatCol = chatCol || null;
    lastRowChild = rowChild;
    lastHandle = keptHandle;
    lastSid = view.sessionId;
    observeChatFlex();
    installDragListeners();
    syncSideFlex(lastChatCol, rowChild, view.root, view.sessionId);
    return { row: row, chain: chain, rowChild: rowChild, hidden: hide.length,
      chatCol: lastChatCol, handle: keptHandle, armed: canArm };
  }

  // EVERY structural mark, gone. This is what "restore upstream's own split" actually
  // requires: dropping ARMED alone left `data-cdb-hide` and `data-cdb-side` in place,
  // so branches stayed display:none and the bar could end up re-hosted inside a hidden
  // stack with the expand control inert - while the watchdog's own warning claimed the
  // split had been restored. clearAll() always did this correctly; unarm() did not.
  //
  // ARMED goes FIRST: while it is set, removing the chat/keep exemptions would hide the
  // chat column for a style pass.
  function clearStructuralMarks() {
    syncMark(ARMED_ATTR, []);
    syncMark(HIDE_ATTR, []);
    syncMark(SIDE_ATTR, []);
    syncMark(FILL_ATTR, []);
    syncMark(CHAIN_ATTR, []);
    syncMark(ROW_ATTR, []);
    syncMark(CHAT_ATTR, []);
    syncMark(KEEP_ATTR, []);
  }

  // Drops the absence-keyed rule's interlock AND everything it was interlocking, which
  // is what genuinely restores upstream's own split - the correct degraded state
  // whenever we cannot say what should be visible.
  function unarm() {
    clearStructuralMarks();
  }

  // ---- apply -----------------------------------------------------------------
  // The whole reconciler. Tags every resolvable column, marks exactly one active,
  // applies the structural pass above, and writes NOTHING to upstream's layout -
  // `wrote` is reported (always 0) so the tests can assert that by construction
  // rather than by inspection.
  function applyView(view) {
    if (!enabled) return { action: "none", wrote: 0 };
    if (!view.cols.length) {
      // The ordinary "no side panel is open" state is silent; resolveColumns()
      // has already warned if there were side panes it could not place.
      // UNARMED: with no side panel there is nothing of ours to hide, and leaving the
      // absence-keyed rule live over a row we no longer understand is exactly how it
      // would hide the chat column.
      unarm();
      holdSince = 0;
      rememberTabs(view.tabs);
      return { action: "no-columns", wrote: 0, tabs: [], activeId: null };
    }
    var activeCol = colFor(view.cols, view.activeId);
    if (!activeCol) {
      // EXPECTED while an expand is active: the chosen tab is a union tab whose
      // column upstream has torn down, and the sticky sequence is waiting for the
      // remount. Holding every attribute exactly as it is keeps the column the user
      // can SEE visible - never a blank one - and the sequence re-tags once the
      // remount lands. So this is silent in that state.
      //
      // With nothing expanded, pickActive() cannot produce it, so reaching it means
      // the DOM moved under us between the two reads: same hold, but worth saying.
      if (!view.expandedTileId && !stickyPending) {
        warnOnce("no-active-column",
          "the active tab has no column this pass - leaving attributes alone");
      }
      // Holding KEEPS the marks, which is what keeps the column the user can see
      // visible rather than blanking the side region. But it must not hold forever:
      // with the absence-keyed rule live and a stale chain, a row that never resolves
      // again would leave the side region showing a column upstream has moved on from.
      // The watchdog unarms, which puts upstream's own split back.
      if (!holdSince) holdSince = Date.now();
      else if (Date.now() - holdSince > HOLD_UNARM_MS) {
        warnOnce("hold-watchdog",
          "no active column resolved for " + HOLD_UNARM_MS + "ms - unarming, which " +
          "restores upstream's own split rather than leaving the side region stale");
        unarm();
      }
      return { action: "hold", wrote: 0, tabs: view.tabs, activeId: view.activeId };
    }
    ensureStyle();
    var i, w, tagged;
    for (i = 0; i < view.cols.length; i++) {
      view.cols[i].wrapper.setAttribute(COL_ATTR, view.cols[i].tileId);
    }
    // Swept across every tagged wrapper in the document, not just the resolved
    // columns: a wrapper that lost its pane (something else is expanded) must
    // still lose its active marker, and one that upstream is about to remove must
    // not keep it either.
    tagged = taggedWrappers();
    for (i = 0; i < tagged.length; i++) {
      w = tagged[i];
      if (w.getAttribute(COL_ATTR) === view.activeId) w.setAttribute(ACTIVE_ATTR, "");
      else w.removeAttribute(ACTIVE_ATTR);
    }
    holdSince = 0;
    var struct = applyStructure(view, activeCol);
    // Persisted when the active tab moved OR when the structural pass has just
    // CAPTURED a chat/side share that is not on disk yet - a reload must not jump
    // the boundary back.
    // The share half of this condition is only worth acting on when the memo actually
    // HAS a value to write. Comparing against a bare shareMemo[sid] made the condition
    // permanently true whenever localStorage was blocked or full - persist() warns once
    // and returns false, so the stored value never caught up and every pass (2Hz sweep
    // plus every observer tick) retried a readBlob + setItem for nothing.
    var wantShare = shareMemoOrStored(view.sessionId);
    if (view.stored !== view.activeId ||
        (!persistBlocked && S.validShare(wantShare) !== null &&
         S.read(view.sessionId).chatShare !== wantShare)) {
      persist(view.sessionId, view.activeId);
    }
    // Recorded here and NOT on the "hold" path above: a hold is mid-sequence, and
    // forgetting a tab there would let the remount look like a fresh open.
    rememberTabs(view.tabs);
    return { action: "applied", wrote: 0, tabs: view.tabs, activeId: view.activeId,
      rowFound: !!struct.row, chainDepth: struct.chain.length, hidden: struct.hidden };
  }

  // Kept under the old name so the loop, the tests and the mental model all still
  // have one entry point for "bring the DOM in line with the truth".
  function reconcile() {
    return applyView(computeView());
  }

  // Disable. Removes our attributes, the stylesheet and the flex variable;
  // upstream's real split returns with NO layout write at all, so unlike v1 this
  // cannot fail and needs no retry state.
  function clearAll() {
    var tagged = taggedWrappers(), i;
    for (i = 0; i < tagged.length; i++) {
      tagged[i].removeAttribute(ACTIVE_ATTR);
      tagged[i].removeAttribute(COL_ATTR);
    }
    // Every structural mark too, or a hidden branch stays hidden with no stylesheet
    // to explain it and no reconciler to take it back.
    clearStructuralMarks();
    holdSince = 0;
    lastRow = null;
    // Release the held chat pick. Stickiness is deliberately kept across an unarm -
    // that is the point of it - but a full teardown must not carry a decision from a
    // previous life of the feature into the next one.
    stickyChat = null;
    structRefused = false;
    var st = document.querySelector("style[data-cdb-tabs]");
    if (st && st.parentNode) st.parentNode.removeChild(st);
    var de = document.documentElement;
    if (de && de.style && de.style.removeProperty) de.style.removeProperty(FLEX_VAR);
    return tagged.length;
  }

  function setEnabled(on) {
    var next = on === true;
    if (next === enabled) return;
    enabled = next;
    if (!enabled) {
      cancelSticky();
      if (bar) { bar.remove(); bar = null; }
      lastBarSig = null;
      clearAll();
    }
  }

  // ---- switching -------------------------------------------------------------
  // TWO paths, and the split is one boolean deep.
  //
  // NOT EXPANDED (the overwhelmingly common case) is the v2 mechanism unchanged:
  // one attribute toggle, ZERO layout writes, no timers, every panel left
  // mounted with its React state intact. Nothing below is allowed to add work to
  // that path - it is the reason v2 exists.
  //
  // EXPANDED needs a sequence, because upstream unmounts every OTHER tile's pane
  // while one tile is expanded: the target column genuinely does not exist in the
  // DOM, so it cannot just be revealed. Full-width is nevertheless STICKY across
  // a switch (asked for explicitly), so:
  //
  //   1. click upstream's own Collapse on the active pane's chrome row
  //   2. wait, bounded, for upstream to remount the columns
  //   3. re-tag, so the newly chosen tile is the active one
  //   4. click upstream's own Expand on the NEW active pane's chrome row
  //
  // Both controls are resolved LIVE off the pane's own chrome row each time -
  // never cached, never a stored closure, because whenever we need one the pane
  // is mounted. Steps 2-4 are the only asynchronous thing in this module.
  //
  // WHAT THIS COSTS, so a future reader does not "fix" it: the newly-active panel
  // REMOUNTS, so its React state is fresh. That is inherent and it is not the
  // sequence's fault - upstream threw that state away the moment the user
  // expanded, before we did anything. Skipping the collapse is not an
  // alternative: there would be no pane to show.
  //
  // THE BUDGET: 1200ms, probed every 50ms - so the first probe lands at 50ms and
  // the last at exactly 1200ms. Deliberately generous, because the slowest
  // upstream re-render measured on this layout was ~900ms (v1's per-switch cost)
  // and the state we are waiting IN is already correct and fully usable: collapsed,
  // the chosen tab active, the bar present. So a long wait costs only a late
  // re-expand, while a short one costs the feature outright. Spent in TICKS rather
  // than against Date.now(), so the bound is deterministic and does not depend on
  // a clock (the DOM harness runs on a virtual one).
  var STICKY_EXPAND_TIMEOUT_MS = 1200;
  var STICKY_EXPAND_POLL_MS = 50;
  var STICKY_EXPAND_TICKS = Math.ceil(STICKY_EXPAND_TIMEOUT_MS / STICKY_EXPAND_POLL_MS) - 1;

  // The supersede token. Every activate() that actually changes the tab bumps it,
  // and an in-flight sequence carries the value it started with: the instant the
  // two differ the old sequence returns having touched nothing. Two rapid switches
  // while expanded therefore cannot interleave - the newer target wins and the
  // older sequence abandons QUIETLY (no warn: being superseded is not a fault, and
  // warning on it would fire on ordinary fast clicking).
  var switchGen = 0;
  var stickyTimer = 0;
  // True from the moment we click Collapse until the re-expand lands or the budget
  // runs out. activate() reads it so that a switch which SUPERSEDES a pending
  // sequence merely re-points it at the new target: the Collapse has already been
  // clicked and clicking it a second time would toggle upstream's expandedTile
  // straight back ON.
  var stickyPending = false;

  function cancelSticky() {
    switchGen++;
    stickyPending = false;
    if (stickyTimer) { window.clearTimeout(stickyTimer); stickyTimer = 0; }
  }

  // Upstream's own Expand / Collapse / Close button for one tile, read out of the
  // DOM right now; `which` is "expand", "collapse" or "close". null whenever the
  // pane is unmounted or its chrome row does not carry that control - and every
  // caller treats null as "stop here", never as "try something else".
  function chromeControl(view, tileId, which) {
    var col = colFor(view.cols, tileId);
    var b = col && col.pane ? H.chromeButtons(col.pane) : null;
    return (b && b[which]) || null;
  }

  function clickChrome(btn, what, tileId) {
    try { btn.click(); return true; } catch (e) {
      warn(what + " click threw for " + tileId + ": " + ((e && e.message) || e));
      return false;
    }
  }

  // Steps 3 and 4, re-probed until the remount lands or the budget runs out.
  // EVERY exit leaves a coherent state: the worst case is collapsed with the
  // chosen tab active and the bar present. Never expanded-on-the-wrong-panel,
  // never a blank column, never stuck mid-sequence.
  function stickyExpandStep(tileId, gen, ticksLeft) {
    stickyTimer = 0;
    if (gen !== switchGen || !enabled) return;
    var view = computeView();
    if (chromeControl(view, tileId, "expand")) {
      stickyPending = false;
      // Re-tag BEFORE expanding: the remount can change which columns resolve,
      // and the active marker has to already be on the target's column or we
      // would take upstream full-width on a panel the user did not choose.
      persist(view.sessionId, tileId);
      view = computeView();
      applyView(view);
      if (view.activeId !== tileId) {
        // Unreachable from our own state (tileId was just persisted), so this is
        // the DOM having moved under us. Refusing to expand is the safe half of
        // the choice: collapsed-and-correct beats expanded-and-wrong.
        warn("gave up restoring full-width: " + tileId + " is no longer the active tab");
        syncExpandLabel(view);
        return;
      }
      var btn = chromeControl(view, tileId, "expand");
      if (btn) clickChrome(btn, "re-expand", tileId);
      // The step has no caller to re-render for it (unlike onBarClick, which does
      // activate() then renderBar()), and it has just changed both the active tab
      // and the mounted set - which decides the per-tab ✕. Without this the strip
      // would stay stale until the next 500ms sweep.
      renderBar();
      // React commits expandedTile asynchronously, so the chrome row still reads
      // the PRE-click label right now. The ⤢'s accessible name catches up a tick
      // later, exactly as toggleExpandActive() does it.
      window.setTimeout(function () { if (gen === switchGen) syncExpandLabel(); }, 0);
      return;
    }
    if (ticksLeft > 0) {
      stickyTimer = window.setTimeout(function () {
        stickyExpandStep(tileId, gen, ticksLeft - 1);
      }, STICKY_EXPAND_POLL_MS);
      return;
    }
    stickyPending = false;
    // The remount never came. We are already IN the safe state - collapsed, the
    // chosen tab active, the bar there - so this only has to say so, once, and put
    // the ⤢'s label back in step with it. Deliberately NO reassignment of the
    // active tab: if upstream really never brings that pane back, the tile is gone
    // and the ordinary reconciler drops the tab as soon as the mirror stops listing
    // it - the same path a tile closed from upstream's own UI takes.
    warnOnce("sticky-expand-timeout",
      "upstream did not remount the panel within " + STICKY_EXPAND_TIMEOUT_MS +
      "ms of collapsing, so full-width was not restored - the tab switch itself " +
      "landed and the panel is simply left collapsed");
    renderBar();
    syncExpandLabel();
  }

  // Was a panel expanded, and did we manage to collapse it? `view.expandedTileId`
  // is the single source for that (resolveColumns reads it off the chrome rows), so
  // the state test and the button we click are the same fact and cannot disagree.
  //
  // Deliberately keyed on expandedTileId rather than on the ACTIVE column: a second
  // switch arriving before upstream has remounted anything finds our active marker
  // already sitting on a PANELESS union tab, and a test that only looked there would
  // conclude "not expanded" and silently drop the stickiness.
  //
  // false covers "was not expanded" and "the control could not be resolved or threw"
  // alike - in both cases the caller falls through to the plain attribute switch,
  // which is the safe end state.
  function collapseIfExpanded(view) {
    if (!view.expandedTileId) return false;
    var btn = chromeControl(view, view.expandedTileId, "collapse");
    if (!btn) return false;
    return clickChrome(btn, "collapse", view.expandedTileId);
  }

  function activate(tileId) {
    if (!enabled || !tileId) return false;
    var view = computeView();
    if (view.tabs.indexOf(tileId) === -1) {
      warnOnce("activate-unknown", "activate() refused a tileId with no column");
      return false;
    }
    // Clicking the tab that is already active is a no-op, INCLUDING for a sequence
    // in flight: cancelling it there would abandon a re-expand the user never asked
    // to give up.
    if (tileId === view.activeId) { applyView(view); return true; }
    var pending = stickyPending;
    // Supersede: any in-flight sequence is abandoned from here on (quietly - its
    // own gen check is the whole mechanism), so two rapid switches cannot run over
    // each other and the newer target is the one that wins.
    cancelSticky();
    var sticky = pending || collapseIfExpanded(view);
    // Raised BEFORE the applyView below, not after: that pass sees the chosen tab's
    // column still missing (upstream has not remounted yet) and has to recognise the
    // hold as expected rather than warn about it - and pickActive() has to treat the
    // chosen tab as authoritative from this moment on.
    if (sticky) stickyPending = true;
    persist(view.sessionId, tileId);
    // Re-read: the collapse above may have remounted panes, and the store now
    // carries the new active id.
    applyView(computeView());
    // Only reached when a panel really was expanded. The non-expanded path has by
    // now done everything it is ever going to do: one attribute toggle, no timer.
    if (sticky) {
      var gen = switchGen;
      stickyTimer = window.setTimeout(function () {
        stickyExpandStep(tileId, gen, STICKY_EXPAND_TICKS);
      }, STICKY_EXPAND_POLL_MS);
    }
    return true;
  }

  // ---- closing ---------------------------------------------------------------
  // An inactive panel is MOUNTED (just hidden), so its own Close control is in
  // the document and a programmatic .click() runs upstream's real per-kind
  // teardown - display:none does not prevent it. That is what retired v1's whole
  // cached-handler apparatus (harvest-before-unmount, the deferred ghost-close
  // path and the `closing` guard).
  function closeTab(tileId) {
    if (!enabled || !tileId) return { closed: false, via: "none" };
    var view = computeView();
    var col = colFor(view.cols, tileId);
    if (!col || !col.pane) {
      warnOnce("close-not-mounted", "closeTab(): no mounted pane for " + tileId);
      return { closed: false, via: "none" };
    }
    var btn = chromeControl(view, tileId, "close");
    if (!btn) {
      warnOnce("close-no-control", "closeTab(): the pane has no Close control");
      return { closed: false, via: "none" };
    }
    // A pending re-expand may be waiting on a tile that is about to stop existing,
    // and its own gen check is what makes abandoning it free.
    cancelSticky();
    try { btn.click(); } catch (e) {
      // Leaving the tab exactly where it is keeps it clickable and closable
      // again, which is the recoverable direction.
      warn("close click threw for " + tileId + " - leaving the tab in place: " +
        ((e && e.message) || e));
      return { closed: false, via: "none" };
    }
    // Hand the active slot to the left neighbour (else the right) now, so the
    // pass that observes the close does not have to fall back to the first tab.
    if (tileId === view.activeId) {
      var idx = view.tabs.indexOf(tileId), rest = [], i;
      for (i = 0; i < view.tabs.length; i++) if (view.tabs[i] !== tileId) rest.push(view.tabs[i]);
      persist(view.sessionId, rest.length ? rest[Math.max(0, idx - 1)] : null);
    }
    applyView(computeView());
    return { closed: true, via: "click" };
  }

  // ---- the tab bar -----------------------------------------------------------
  // Theme tokens hold BARE HSL TRIPLETS in this app, so every token use is
  // wrapped in hsl() with the fallback expressed as a triplet inside var().
  //
  // BAR_HEIGHT_PX is a FIXED height (not "however tall the content ends up
  // being"): the side .tiles-shell carries upstream's own inline height:100%,
  // so pushing it down by an unpredictable amount would overflow its parent
  // by that same amount (measured live: overflowsParentBy 34, parent
  // overflow:visible - it would spill). Deriving both the bar's own height and
  // the compensating "+ .tiles-shell" rule from ONE constant is what keeps
  // them from drifting apart.
  var BAR_HEIGHT_PX = 34;

  // Defect 5 (2026-08-04, live CDP measurement): the chat area paints no
  // background of its own - it shows body.bg-surface-1 = rgb(36,39,58), which is
  // exactly the --bg-100 token (232 23.4% 18.4%). The bar used to paint --bg-200
  // (rgb(30,32,48)), one step DARKER on that ramp, which is why it read as a
  // darker strip rather than as part of the surface. It now paints --bg-100.
  //
  // Ramp direction matters and is counter-intuitive: per
  // baseline/THEME_TOKEN_MAP.md --bg-000 is the LIGHTEST of the bg tokens and
  // --bg-400 the darkest. So "one step up" for the selected chip is --bg-000, and
  // "one step down" for the resting chips is --bg-200 - NOT the other way round.
  var CSS = [
    // THE MECHANISM. !important is required because upstream sets display/flex
    // inline on the wrappers and stacks; that this wins is proven by the existing
    // shell-height rule below and by the 2026-08-04 live experiment.
    //
    // Keyed on the STRUCTURAL attributes, not on the leaf wrappers: the side region
    // is a nested tree, so what has to be hidden or given the side flex is whatever
    // element the chain resolution picked, at whatever depth (2026-08-05).
    // HIDING BY ABSENCE - the rule that removes the open/close transient.
    //
    // Tag-driven hiding was the bug the user was seeing as "jumpy". A branch was
    // hidden because we had put data-cdb-hide ON it, so a branch upstream had only
    // just inserted was untagged and therefore VISIBLE until our next reconcile.
    // Measured per frame before this rule: opening a panel put chat 190px off its
    // steady width with TWO visible side branches for 29 frames (~96ms), and closing
    // the active one left the whole side region blank for 29 frames (~112ms).
    //
    // Now the DEFAULT for a child of an armed container is hidden, and visibility is
    // the exception - so a brand-new sibling is hidden from its very first layout.
    // Three positive exemptions: the active chain, the chat column, and the kept
    // chat<->side handle.
    //
    // data-cdb-armed is the safety interlock, and it matters precisely BECAUSE this
    // rule keys on absence: an unarmed or mis-resolved row would otherwise hide the
    // chat column itself. It is set only once the chat column AND an active chain are
    // both resolved, and dropped the moment either is not - which restores upstream's
    // own split, the correct degraded state.
    //
    // WHAT ABSENCE MAY HIDE IS BOUNDED, and that is the second half of H2's fix.
    // Keying on absence means every unrecognised child is hidden, so an element that
    // has nothing to do with the tile system - an overlay, a portal host, a live
    // region, a drag ghost, an upstream addition we have never seen - got blanked
    // merely for being new. The rule now applies only to things that are demonstrably
    // upstream's tile furniture:
    //
    //   :has(.tiles-shell)  a tile-bearing branch or stack. Measured on 1.24012.9:
    //                       every branch owns >= 1 .tiles-shell; overlays, rails and
    //                       portal hosts own none.
    //   .tiles-handle       a 12px drag grip. Never a surface, and all but the kept
    //                       chat<->side one must go.
    //
    // Both are still hidden from their FIRST layout, so the transient fix is intact -
    // verified, not assumed: upstream inserts a wrapper together with its shell as one
    // subtree, so the new child matches :has() on the very first frame, and a new
    // handle matches by class. Anything else is left alone. :has() is available -
    // Chromium 148 in this build.
    //
    // This does NOT by itself protect the chat column, which owns a shell too and so
    // still matches - that protection is positive identification plus the
    // refuse-on-ambiguity in chatColumnOf(). What this bounds is the collateral.
    "[" + ARMED_ATTR + "] > *:has(.tiles-shell)" + ABSENCE_EXEMPT + "," +
      "[" + ARMED_ATTR + "] > " + HANDLE_SELECTOR + ABSENCE_EXEMPT +
      "{display:none !important}",
    // Kept alongside it: the tag records what the reconciler positively DECIDED, and
    // is what the tests and the live probes read. The rule above is the fail-safe
    // default that closes the race; this is the explicit record of the decision.
    "[" + HIDE_ATTR + "]{display:none !important}",
    "[" + SIDE_ATTR + "]{flex:var(" + FLEX_VAR + ",1) 1 0% !important}",
    "[" + FILL_ATTR + "]{flex:1 1 0% !important}",
    // The BAR itself never scrolls - overflow:hidden, not overflow-x:auto. It used
    // to be the scroller, and that was a functional break: the separator and ⤢ are
    // flex siblings of the chips, so they scrolled away with them. At 6 tabs the
    // right-hand controls sat PAST the bar's right edge (measured live 2026-08-05:
    // bar 1591-2085, ⤢ at 2120-2139), reachable only by scrolling - so a user with a
    // handful of panels open could not expand at all. The CHIPS are their own
    // scroller now (.cdb-tabs-strip) and ⤢ is a non-shrinking sibling of it, pinned
    // at the right edge with the chips scrolling under it.
    ".cdb-tabs-bar{display:flex;align-items:center;gap:3px;padding:3px 6px;min-width:0;",
    "overflow:hidden;background:hsl(var(--bg-100,232 23.4% 18.4%));height:" + BAR_HEIGHT_PX + "px;",
    "box-sizing:border-box}",
    // THE CHIP SCROLLER. min-width:0 is what actually lets it shrink below its
    // content width - without it a flex item refuses to go under min-content and the
    // controls get pushed out again, which is the whole bug.
    ".cdb-tabs-strip{display:flex;align-items:center;gap:3px;flex:1 1 auto;min-width:0;",
    "overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-ms-overflow-style:none}",
    // The scrollbar is REMOVED rather than thinned. The bar's height is a fixed
    // BAR_HEIGHT_PX and it is load-bearing - the .tiles-shell compensation rule below
    // is derived from the same constant - so a horizontal scrollbar inside it would
    // either eat chip height or grow the bar and desync that rule. The chips stay
    // reachable by wheel/trackpad, and the active chip is scrolled into view whenever
    // it changes (revealActiveChip), which is the case that actually matters.
    ".cdb-tabs-strip::-webkit-scrollbar{height:0;width:0;display:none}",
    // Compensates the fixed height above: the side shell's inline height:100%
    // would otherwise overflow its parent by exactly the bar's height once the
    // bar is inserted as its preceding sibling. !important is required to win
    // over that inline style.
    ".cdb-tabs-bar + .tiles-shell{height:calc(100% - " + BAR_HEIGHT_PX + "px) !important}",
    // Upstream's own Expand/Collapse/Close for the active panel are redundant
    // once our bar is on screen (it has its own ⤢/✕ per tab). Hidden while our
    // bar is actually present - keyed off the SAME adjacent-sibling relationship
    // the height rule above relies on, so if the bar is ever absent for any
    // reason these selectors cannot match anything and upstream's controls come
    // back on their own, with no JS teardown. Matched by aria-label only.
    //
    // Hiding is CSS only, so the buttons stay in the DOM and stay clickable -
    // which is exactly what our own ✕ and ⤢ now do (a programmatic .click() on a
    // display:none button still fires; verified live 2026-08-04).
    ".cdb-tabs-bar + .tiles-shell button[aria-label=\"Expand\"],",
    ".cdb-tabs-bar + .tiles-shell button[aria-label=\"Collapse\"],",
    ".cdb-tabs-bar + .tiles-shell button[aria-label=\"Close\"]{display:none}",
    // A compact strip of rounded chips: the resting chip sits one ramp step below
    // the bar (recessed but legible), the selected one a step above it with a
    // subtle border (raised), and only the selected one gets full-strength text.
    ".cdb-tabs-item{display:flex;align-items:center;border-radius:6px;",
    "box-sizing:border-box;border:1px solid transparent;",
    "background:hsl(var(--bg-200,233 23% 15.3%))}",
    ".cdb-tabs-item:hover{background:hsl(var(--bg-000,232 23.4% 22%) / 0.6)}",
    ".cdb-tabs-item[data-active=\"1\"],.cdb-tabs-item[data-active=\"1\"]:hover{",
    "background:hsl(var(--bg-000,232 23.4% 22%));",
    "border-color:hsl(var(--border-300,0 0% 40%) / 0.45)}",
    ".cdb-tabs-tab{all:unset;cursor:default;padding:3px 8px;font-size:12px;",
    "color:hsl(var(--text-300,0 0% 70%))}",
    ".cdb-tabs-item[data-active=\"1\"] .cdb-tabs-tab{color:hsl(var(--text-100,0 0% 93%))}",
    ".cdb-tabs-close,.cdb-tabs-expand{all:unset;cursor:default;padding:2px 6px;",
    "font-size:11px;color:hsl(var(--text-300,0 0% 70%))}",
    // FLEX SIZING, and it has to come AFTER the `all:unset` above: all:unset resets
    // flex to its initial value, so declaring these any earlier would be silently
    // undone. Chips do not shrink (they scroll instead, or the labels would squeeze
    // to nothing before the strip ever scrolled), and the right-hand controls neither
    // shrink nor scroll - that is what keeps ⤢ reachable at any tab count.
    ".cdb-tabs-item{flex:0 0 auto}",
    ".cdb-tabs-sep,.cdb-tabs-expand{flex:0 0 auto}",
    ".cdb-tabs-close:hover,.cdb-tabs-expand:hover{",
    "color:hsl(var(--text-100,0 0% 93%))}",
    // Separates the right-aligned ⤢ from the chip strip. A 1px rule rather than more
    // padding, so it still reads as a divider when the strip scrolls. KEPT after the +
    // was removed: it divides the strip from the controls, and ⤢ is still one.
    ".cdb-tabs-sep{width:1px;align-self:stretch;margin:4px 3px;flex:0 0 auto;",
    "background:hsl(var(--border-300,0 0% 40%) / 0.3)}",
    ".cdb-tabs-strip{flex:1 1 auto}"
  ].join("");

  // ---- THE LABEL MAP ---------------------------------------------------------
  // tileId -> the word the tab strip shows. UPSTREAM'S OWN word wherever it has one,
  // which is the whole point: the strip must not invent names for panels the user
  // opens through upstream's controls.
  //
  // VERSION-SENSITIVE - validated against Claude Desktop 1.24012.9 - AND MEASURED,
  // because the pairing is NOT guessable. Upstream's affordance labelled **"Browser"
  // opens the tile whose id is `preview`**, and the one labelled **"Files" opens the
  // tile whose id is `browser`**. Naming a chip after its tile id would therefore put
  // "Preview" and "Browser" on the two panels the user knows as "Browser" and "Files".
  //
  // TO RE-DERIVE: press each of upstream's affordances and diff
  // __cdbTabsPage.state().tabs - the tileId that appears IS the mapping - then press it
  // again to restore. Recipe and expected values in baseline/PANEL_TABS_ANCHORS.md.
  //
  // Kept SHORT: a chip sits in a 34px scrolling strip. Upstream's full wording is
  // longer for two of these ("Artifacts", "Background tasks") and the user asked only
  // for the preview/browser rename, so those two stay short by choice.
  //
  // The `menu` and `via` columns this table used to carry were the + open-panel menu's
  // opener plumbing, and went with it on 2026-08-06. Nothing here opens a panel now.
  var KINDS = [
    { tileId: "diff", chip: "Diff" },
    { tileId: "terminal", chip: "Terminal" },
    { tileId: "preview", chip: "Browser" },
    { tileId: "artifact", chip: "Artifact" },
    { tileId: "browser", chip: "Files" },
    { tileId: "tasks", chip: "Tasks" },
    // Kinds upstream can open that we have no measured word for. They appear as tabs
    // when upstream opens them; the fallback in labelFor() names them.
    { tileId: "pr", chip: "PR" },
    { tileId: "file", chip: "File" },
    { tileId: "simulator", chip: "Simulator" },
    { tileId: "transcript", chip: "Transcript" }
  ];

  function kindFor(tileId) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].tileId === tileId) return KINDS[i];
    return null;
  }

  var bar = null;

  function labelFor(tileId) {
    if (!tileId) return "";
    // Instance-suffixed ids exist (upstream maps id -> kind), e.g. "diff-2".
    var base = String(tileId).replace(/-\d+$/, "");
    var kind = kindFor(base);
    if (kind) {
      var m = /-(\d+)$/.exec(String(tileId));
      return m ? kind.chip + " " + m[1] : kind.chip;
    }
    // A kind we have no measured name for: the raw id, capitalised. Better a slightly
    // technical word than a blank chip for a panel the user can see.
    return String(tileId).charAt(0).toUpperCase() + String(tileId).slice(1);
  }

  function ensureStyle() {
    if (document.querySelector("style[data-cdb-tabs]")) return;
    var st = document.createElement("style");
    st.setAttribute("data-cdb-tabs", "1");
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function barEl() { return bar && bar.isConnected ? bar : null; }

  // The held share for this session, or the stored one when we have not computed it
  // yet. Never undefined, so persist() cannot blank a remembered boundary.
  function shareMemoOrStored(sid) {
    if (Object.prototype.hasOwnProperty.call(shareMemo, sid)) return shareMemo[sid];
    return S.read(sid).chatShare;
  }

  // Everything the rendered bar's children depend on. renderBar() is called on
  // a timer, and rebuilding children unconditionally would blow away the focus
  // ring (and interrupt a click) several times a second, so a pass that would
  // produce the identical bar does nothing at all.
  var lastBarSig = null;

  // MOUNTEDNESS IS PART OF THE SIGNATURE. It decides whether a chip gets a ✕ (see
  // the chip loop), so a tab going unmounted-and-back across an expand has to force
  // a rebuild - otherwise the strip would keep offering a ✕ for a panel whose Close
  // control is no longer in the document.
  // The opener-label component is gone with the + open-panel menu (2026-08-06):
  // upstream's set of header openers no longer affects anything we render, so it cannot
  // change the bar. What remains is exactly what the bar's children are built from.
  function barSignature(view) {
    var mask = "", i;
    for (i = 0; i < view.tabs.length; i++) mask += isMountedTab(view, view.tabs[i]) ? "1" : "0";
    return view.tabs.join("") + "|" + (view.activeId || "") + "|" + mask;
  }

  // Is the ACTIVE panel expanded right now? Upstream's own control carries
  // "Collapse" instead of "Expand" while it is, which is the same signal
  // toggleExpandActive() clicks - so the label the user is told and the direction
  // the click actually goes can never disagree.
  function activeExpanded(view) {
    return !!view.expandedTileId && view.expandedTileId === view.activeId;
  }

  function expandLabel(view) { return activeExpanded(view || computeView()) ? "Collapse" : "Expand"; }

  // Keeps the ⤢'s accessible name in step with what it will actually do.
  //
  // Called on EVERY renderBar() pass, including one that early-outs because the
  // bar is unchanged: expanding a panel changes neither the tab set, the active
  // tab nor the opener set, so it does not move the bar signature and would never
  // trigger a rebuild. Deliberately an in-place attribute update rather than a
  // signature input - a rebuild on every expand would throw away focus and the
  // label is the only thing that needs to change.
  function syncExpandLabel(view) {
    var btn = bar && bar.querySelector("[data-cdb-expand]");
    if (btn) btn.setAttribute("aria-label", expandLabel(view));
  }

  // The bar's ⤢. Clicks whichever of upstream's own Expand/Collapse buttons is
  // on the active pane's chrome row RIGHT NOW, so one control toggles both ways -
  // which is what pays for hiding upstream's own pair (see the CSS note). The
  // button is display:none under our stylesheet; a programmatic click still
  // fires, and reading the live button is what makes the direction correct
  // instead of re-firing a stale expand closure.
  function toggleExpandActive() {
    // The user taking manual control supersedes any pending re-expand, which would
    // otherwise fight the click that just happened.
    cancelSticky();
    var view = computeView();
    var btn = chromeControl(view, view.activeId, "collapse") ||
      chromeControl(view, view.activeId, "expand");
    if (!btn) {
      warnOnce("no-expand-control",
        "no Expand/Collapse control on the active pane's chrome row");
      return;
    }
    try { btn.click(); } catch (e) {
      warn("expand click threw: " + ((e && e.message) || e));
    }
    // React commits the expandedTile change asynchronously, so reading the chrome
    // row back synchronously here would still see the PRE-click label. Deferred
    // by a tick purely so the accessible name follows the user's own click
    // immediately instead of waiting for the next observer/sweep pass.
    window.setTimeout(function () { syncExpandLabel(); }, 0);
  }

  // ---- ONE delegated listener, installed on the bar --------------------------
  // renderBar() rebuilds the bar's children, and the bar is RE-PARENTED into the
  // active column on every switch. With a listener per node, a click arriving
  // mid-rebuild lands on a detached node whose handler no longer matters and is
  // simply lost. Delegating to the container makes both irrelevant: the listener
  // belongs to the node that is neither rebuilt nor recreated (verified
  // 2026-08-04 - a re-parent preserves node identity AND its listeners), and the
  // target is resolved from whatever is under the pointer at click time.
  //
  // Resolved by marker ATTRIBUTE, not by class, and close BEFORE tab so a click
  // on a ✕ can never be read as a click on the chip it sits in. Real <button>
  // elements throughout, so Enter/Space still synthesise a click that bubbles
  // here - keyboard behaviour and ARIA are untouched.
  function onBarClick(ev) {
    var t = ev.target, hit;
    if (!t || !t.closest) return;
    hit = t.closest("[data-cdb-close]");
    if (hit) { closeTab(hit.getAttribute("data-cdb-close")); renderBar(); return; }
    hit = t.closest("[data-cdb-tab]");
    if (hit) { activate(hit.getAttribute("data-cdb-tab")); renderBar(); return; }
    hit = t.closest("[data-cdb-expand]");
    if (hit) { toggleExpandActive(); return; }
  }

  function dropBar() {
    if (bar) { bar.remove(); bar = null; }
    lastBarSig = null;
    return null;
  }

  // Which column the bar LIVES in. Normally the active one. But a switch made while
  // expanded points activeId at a tab whose column upstream has torn down, and
  // dropping the bar for those few frames would blink it out AND stop the
  // height-compensation rule from applying to the column that is still on screen.
  // So it falls back to the column that is actually VISIBLE - the one still
  // carrying our active marker - then to any connected column, and only gives up
  // when there is none.
  function barHostCol(view) {
    var col = colFor(view.cols, view.activeId), i;
    if (col && col.wrapper.isConnected) return col;
    for (i = 0; i < view.cols.length; i++) {
      if (view.cols[i].wrapper.isConnected &&
          view.cols[i].wrapper.hasAttribute(ACTIVE_ATTR)) return view.cols[i];
    }
    for (i = 0; i < view.cols.length; i++) {
      if (view.cols[i].wrapper.isConnected) return view.cols[i];
    }
    return null;
  }

  function renderBar(view) {
    stats.renderBars++;
    if (!enabled) return dropBar();
    view = view || computeView();
    if (!view.tabs.length) return dropBar();
    // §7: no column wrappers resolvable means no bar at all. The degraded state
    // is the stock split, which is strictly safer than v1's (where degrading
    // could leave panels outside the layout entirely).
    var activeCol = barHostCol(view);
    if (!activeCol) return dropBar();
    // REFUSED means NO BAR - UNLESS SOMETHING IS EXPANDED. The refuse state is
    // layout-clean, but leaving the bar up in it was a dead end: nothing is armed, so a
    // chip click toggles an attribute that no longer changes anything the user can see
    // (measured: both panels stayed at 156px) while our own
    // `.cdb-tabs-bar + .tiles-shell button[aria-label=…]{display:none}` rule kept
    // upstream's per-pane Expand/Collapse/Close hidden. So the user had our inert
    // controls AND not theirs. Dropping the bar fixes both halves at once, and that is
    // why it is the choice rather than "make the chips work": those rules are SIBLING
    // selectors on the bar, so removing it un-hides upstream's controls automatically.
    //
    // THE EXPANDED EXCEPTION, and it is not a special case bolted on - it is the whole
    // distinction the first version of this got wrong. Measured live 2026-08-06: while a
    // tile is expanded upstream tears the row down, chat included (chat 0px, the expanded
    // panel 1796px, and NO row child owns an empty absolute shell any more), so the row
    // legitimately cannot be resolved and applyStructure refuses. Dropping the bar there
    // took the tab strip AND the ⤢ away for as long as the user stayed expanded, which
    // breaks sticky expand outright - the sequence needs the chips to switch and the ⤢ to
    // collapse. The fixtures missed it because they do not reproduce upstream's expanded
    // teardown.
    //
    // The dead-end argument simply does not apply in this state: the chips are NOT inert
    // while expanded (activate() runs the sticky collapse -> remount -> re-expand
    // sequence, which is real work) and nothing needs hiding, because upstream is already
    // showing exactly one panel full width. So: refuse to hide, keep the bar.
    if (structRefused && !view.expandedTileId) return dropBar();
    ensureStyle();

    var sig = barSignature(view);

    // The bar lives INSIDE the active column, immediately before that column's
    // shell - so the height-compensation rule (which keys on the adjacent
    // sibling) follows it automatically. Switching tabs RE-PARENTS this same
    // node; verified live that identity and the delegated listener both survive.
    var host = activeCol.wrapper;
    var ref = activeCol.shell || host.firstChild;
    var created = false;
    if (!bar || !bar.isConnected) {
      bar = el("div", "cdb-tabs-bar");
      bar.setAttribute("role", "tablist");
      bar.setAttribute("aria-label", "Side panels");
      // Installed exactly once per bar ELEMENT, alongside its creation.
      bar.addEventListener("click", onBarClick, false);
      host.insertBefore(bar, ref);
      created = true;
    } else if (bar.parentElement !== host) {
      host.insertBefore(bar, ref);
    }
    // Synced before the early-out, not after it: the expanded state is not part
    // of the signature (see syncExpandLabel), so this return is the pass that has
    // to carry it in the steady state.
    if (!created && sig === lastBarSig) {
      syncExpandLabel(view);
      // The early-out still has to carry the reveal: the strip may have been
      // re-laid-out (narrower column, resized window) since the last rebuild, which
      // does not move the signature but can put the active chip out of sight.
      revealFromBar(view.activeId);
      return bar;
    }
    lastBarSig = sig;
    while (bar.firstChild) bar.removeChild(bar.firstChild);

    // The chips live in their OWN scroller, not directly in the bar - see the
    // .cdb-tabs-strip note in the CSS. Everything after it is a non-shrinking
    // sibling, so ⤢ stays pinned at the right edge however many tabs there are.
    var strip = el("div", "cdb-tabs-strip");
    bar.appendChild(strip);
    var activeItem = null;

    for (var i = 0; i < view.tabs.length; i++) {
      (function (tileId) {
        var item = el("div", "cdb-tabs-item");
        if (tileId === view.activeId) item.setAttribute("data-active", "1");
        var tab = el("button", "cdb-tabs-tab", labelFor(tileId));
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", tileId === view.activeId ? "true" : "false");
        tab.setAttribute("data-cdb-tab", tileId);
        item.appendChild(tab);
        // THE ✕ IS OMITTED, not disabled, on a tab whose pane is unmounted - which
        // only happens for a union tab while an expand is active. Closing means
        // clicking upstream's OWN Close control and that control is not in the
        // document at all for such a tile.
        //
        // The decision, and why it is not "collapse first, then close": a second
        // asynchronous sequence would double the failure modes for an operation the
        // user can already reach in one extra click (switch to the tab - which runs
        // the sticky sequence and remounts it - then ✕), and a ✕ that visibly
        // un-expands the whole layout before doing anything is a surprising close.
        // OMITTED rather than rendered-disabled so there is no dead affordance, and
        // the tab itself stays clickable throughout. closeTab() keeps its own
        // not-mounted guard regardless, since Ctrl+N and the API can still reach it.
        // No cached-handler machinery is involved anywhere in this.
        if (isMountedTab(view, tileId)) {
          var close = el("button", "cdb-tabs-close", "✕");
          close.setAttribute("aria-label", "Close " + labelFor(tileId));
          // The marker onBarClick resolves this by. It carries the tileId itself so
          // the delegated handler needs no closure and no index arithmetic.
          close.setAttribute("data-cdb-close", tileId);
          item.appendChild(close);
        }
        if (tileId === view.activeId) activeItem = item;
        strip.appendChild(item);
      })(view.tabs[i]);
    }

    // A 1px divider: the controls sit hard right, visibly separated from the chip
    // strip. No spacer any more - the strip is flex:1 1 auto, so it takes the free
    // space itself and pushes these to the edge.
    bar.appendChild(el("div", "cdb-tabs-sep"));

    // Our OWN ⤢ - an addition, not a relocation. It clicks upstream's own
    // expand/collapse control for the active tile, so ⤢ keeps its native
    // meaning, and its ACCESSIBLE NAME follows that state: "Expand" while the
    // active panel is collapsed, "Collapse" while it is expanded. Upstream's own
    // pair is hidden by our stylesheet, so this control is the only one on screen
    // and a name that is wrong half the time is the difference between a usable
    // and an unusable control for a screen-reader user. The visible GLYPH stays
    // ⤢ in both states: it reads as a single toggle affordance and the accessible
    // name is what carries the state.
    var expand = el("button", "cdb-tabs-expand", "⤢");
    expand.setAttribute("aria-label", expandLabel(view));
    expand.setAttribute("data-cdb-expand", "1");
    bar.appendChild(expand);
    // Last, once the strip has its real width: a Ctrl+N switch to a tab that is
    // scrolled out of sight would otherwise leave the selection invisible. The strip
    // is a fresh element on every rebuild, so its scrollLeft starts at 0 and the
    // previous reveal's bookkeeping no longer applies.
    lastRevealFor = null;
    revealActiveChip(strip, activeItem, view.activeId);
    return bar;
  }

  // Scrolls the active chip into the strip's visible box, by the smallest amount
  // that does it. Deliberately NOT scrollIntoView(): that can scroll ANY scrollable
  // ancestor, including the page, and the page must never move because of us. Pure
  // reads plus one scrollLeft write on our own element.
  //
  // WHEN it runs is the subtle part. Only-on-rebuild is not enough: measured live
  // 2026-08-05, opening a 6th panel left the newly-active chip off-screen at
  // scrollLeft 0, because the pass that made it active ran while the strip was still
  // wide enough and the overflow only appeared afterwards - and a pass that produces
  // an identical bar early-outs before ever reaching the reveal. Running it on EVERY
  // pass instead would fight the user: the 500ms sweep would snap the strip back
  // whenever they scrolled it by hand.
  //
  // So it runs when something that INVALIDATES the previous reveal changed: the
  // active tab, or the strip's own width (a re-layout, a re-parent into a narrower
  // column, a window resize). Manual scrolling changes neither, so it is left alone.
  var lastRevealFor = null;
  var lastRevealWidth = -1;

  function revealActiveChip(strip, item, activeId) {
    if (!strip || !item || !strip.getBoundingClientRect) return -1;
    var sr = strip.getBoundingClientRect();
    if (!sr.width) return -1;
    var w = Math.round(sr.width);
    if (activeId === lastRevealFor && w === lastRevealWidth) return strip.scrollLeft;
    lastRevealFor = activeId;
    lastRevealWidth = w;
    var ir = item.getBoundingClientRect();
    if (ir.left < sr.left) strip.scrollLeft -= (sr.left - ir.left);
    else if (ir.right > sr.right) strip.scrollLeft += (ir.right - sr.right);
    return strip.scrollLeft;
  }

  // The strip and the active chip of the bar as it stands, for the passes that did
  // not rebuild it.
  function revealFromBar(activeId) {
    if (!bar) return -1;
    var strip = bar.querySelector(".cdb-tabs-strip");
    if (!strip) return -1;
    return revealActiveChip(strip, strip.querySelector('.cdb-tabs-item[data-active="1"]'),
      activeId);
  }

  // ---- keyboard -----------------------------------------------------------
  // A shell legitimately wants Ctrl+1 / Ctrl+Tab, so the handler stands down
  // whenever focus is in the terminal surface or any editable target. Stealing
  // keys from the terminal would be a worse regression than having no shortcut.
  //
  // document.activeElement does not pierce an open shadow root (it stops at
  // the shadow host) or an iframe (it resolves to the <iframe> element itself
  // in the parent document). Neither xterm.js nor this app's own chrome renders
  // the terminal inside a shadow root or an iframe (see
  // NON_DIFF_SURFACE_SELECTOR in diff_views_page.js, which targets the same
  // "[class*=\"xterm\"]" div directly), so the terminal-stealing regression this
  // guard exists to prevent is fully covered. A text input embedded in some
  // OTHER iframe pane (e.g. an Artifact preview) would not be caught - but that
  // is a narrower, accepted gap: it is not the terminal, and it cannot be closed
  // without an unreliable cross-frame reach-in.
  function focusIsProtected() {
    var a = document.activeElement;
    if (!a) return false;
    if (a.closest && (a.closest('[class*="xterm"]') || a.closest("[data-ccd-terminal]"))) return true;
    var tag = (a.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return a.isContentEditable === true;
  }

  // Resolves ev to a 0-based tab-slot index, or -1 when it is not one of our
  // Ctrl+1..9 shortcuts.
  //
  // Position ("activate the tab in slot N") is a PHYSICAL-key concept, so
  // ev.code (Digit1..Digit9, Numpad1..Numpad9) is authoritative rather than
  // the character ev.key produces. On AZERTY/similar layouts the unshifted
  // number row emits punctuation (e.g. "&", "é", ...) for ev.key, not a
  // digit, so a key-only test leaves the shortcut silently dead there. ev.key
  // is kept as a FALLBACK for when ev.code is empty/unavailable - some
  // synthetic events and older remote-input paths never populate it - so
  // behaviour never regresses where the key-based match already worked.
  function digitIndexFromEvent(ev) {
    var code = ev.code;
    if (code) {
      var dm = /^Digit([1-9])$/.exec(code);
      if (dm) return parseInt(dm[1], 10) - 1;
      var nm = /^Numpad([1-9])$/.exec(code);
      // ev.key is additionally required for the NUMPAD, and only for it. With
      // NumLock OFF a numpad key still reports code:"Numpad1" but produces its
      // navigation function instead of a digit (key:"End", "ArrowDown",
      // "PageDown"...), so a code-only test makes Ctrl+End on the numpad activate
      // tab 1 and preventDefault it - the one behaviour this feature would TAKE
      // AWAY from a user who enables it. The Digit branch above deliberately does
      // NOT check ev.key: that is the AZERTY fix, and it must not regress.
      if (nm && /^[1-9]$/.test(ev.key)) return parseInt(nm[1], 10) - 1;
      return -1;
    }
    if (ev.key >= "1" && ev.key <= "9") return parseInt(ev.key, 10) - 1;
    return -1;
  }

  function handleKey(ev) {
    if (!enabled || !ev.ctrlKey || ev.altKey || ev.metaKey) return false;
    if (focusIsProtected()) return false;
    // A held key auto-repeats keydown; without this, every repeat tick would
    // re-run activate()/renderBar() on the tab that is already active. Bail
    // BEFORE any further checks (including preventDefault below) - a repeat
    // is never treated as "handled".
    if (ev.repeat) return false;
    // NO Ctrl+Tab handling: probe 5 (2026-08-03) found the page already claims
    // Ctrl+Tab and Ctrl+Shift+Tab. Intercepting them would break an existing
    // upstream behaviour, which is worse than having no cycle shortcut.
    var idx = digitIndexFromEvent(ev);
    if (idx < 0) return false;
    var view = computeView();
    if (idx >= view.tabs.length) return false;
    if (!activate(view.tabs[idx])) return false;
    renderBar();
    ev.preventDefault();
    return true;
  }

  var shortcutsInstalled = false;
  function installShortcuts() {
    if (shortcutsInstalled) return;
    shortcutsInstalled = true;
    document.addEventListener("keydown", handleKey, true);
  }

  // ---- live loop -------------------------------------------------------------
  // Nothing above this point runs by itself: start() is what makes the module
  // live. Three drivers, deliberately different in kind:
  //   - a debounced MutationObserver, for anything the user does through
  //     upstream's own controls (opening a panel, closing a pane, expanding);
  //   - a slow sweep, as the backstop for a change that produces no observable
  //     childList mutation (only the localStorage mirror moved, or the user
  //     dragged the chat/side divider);
  //   - a slower pref poll, so flipping the feature switch takes effect without
  //     a restart.
  var SWEEP_MS = 500;
  var PREF_POLL_MS = 5000;
  // Long enough to coalesce a burst (upstream mounts a pane in several steps),
  // short enough to feel immediate. Every user action taken through OUR bar
  // re-renders synchronously, so this latency only ever applies to changes
  // upstream initiated.
  var DEBOUNCE_MS = 120;

  var started = false;
  var pendingTick = 0;      // debounce timer id, 0 when idle
  var inObserverTick = false;   // re-entrancy guard for the synchronous observer pass
  var sweepTimer = 0;
  var prefTimer = 0;
  var observer = null;
  var observedRoot = null;
  // A SECOND observer on the SAME root (columnsRoot()) but independent of the
  // debounce above. Its only job is putting the bar back the instant it
  // disappears; it never reconciles or touches pendingTick.
  var barObserver = null;
  var barObservedRoot = null;

  function tick() {
    observeRoot();
    observeBarGuardRoot();
    var view = computeView();
    applyView(view);
    renderBar(view);
  }

  // What the observer exists to catch is a pane (or a shell) mounting or
  // unmounting - nothing else can change the tile set. Requiring that, rather
  // than merely rejecting text nodes and our own elements, is what keeps the
  // streaming chat transcript from driving the loop: streamed markdown inserts
  // real ELEMENTS inside the chat pane continuously, which a
  // "not-ours-and-not-text" filter would accept, pinning the tick rate at the
  // debounce ceiling for as long as a response was being written. Everything
  // else the loop cares about - an opener appearing, a mirror-only change, a
  // divider drag - is picked up by the sweep instead.
  function isPaneish(node) {
    if (node.nodeType !== 1) return false;
    if (node.matches && (node.matches(PANE_SELECTOR) || node.matches(SHELL_SELECTOR))) return true;
    return !!(node.querySelector &&
      (node.querySelector(PANE_SELECTOR) || node.querySelector(SHELL_SELECTOR)));
  }
  function isRelevant(recs) {
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i], j;
      for (j = 0; j < r.addedNodes.length; j++) {
        if (isPaneish(r.addedNodes[j])) return true;
      }
      for (j = 0; j < r.removedNodes.length; j++) {
        if (isPaneish(r.removedNodes[j])) return true;
      }
    }
    return false;
  }

  // ---- the observer root: ONE resolver, both observers -----------------------
  // Watch the flex ROW that holds every column wrapper, rather than all of
  // <body> or any single column. Upstream renders ONE .tiles-shell PER COLUMN
  // and opening a second side panel builds a whole NEW column wrapper, so a root
  // scoped to the wrapper holding the current side pane would never see it - the
  // measured cost of that was 1275ms of visibly-split layout before the sweep
  // noticed. The row is also the node whose childList changes when upstream
  // replaces a column wrapper (our bar lives inside one), which is what the
  // bar-guard needs, so this is ONE helper both observers call rather than two
  // resolutions free to drift apart. Falls back to document.body when no such
  // row can be found - a strictly bigger net, never a wrong one.
  //
  // Widening the root does NOT widen what wakes the loop: the debounced observer
  // still puts every batch through isRelevant/isPaneish, so the streamed
  // transcript churn in the chat column is rejected before anything is scheduled.
  //
  // Starts from a mounted non-chat pane, else from one of our own tagged column
  // wrappers - the second source keeps the root stable while a tile is expanded
  // and upstream has unmounted the other panes.
  // The ROW resolved by the structural pass is exactly this node, so prefer it -
  // and it is strictly better than the old walk, which stopped at "an ancestor with
  // >= 2 .tiles-shell". With a NESTED stack that test matches the STACK (measured
  // live 2026-08-05: the diff/terminal stack holds two shells), so the observers
  // were scoped INSIDE the side region and could not see a sibling branch appear or
  // disappear at row level at all.
  function columnsRoot() {
    if (lastRow && lastRow.isConnected) return lastRow;
    var panes = H.panes(), i, node = null;
    for (i = 0; i < panes.length; i++) {
      if (isNonChatPane(panes[i])) { node = panes[i]; break; }
    }
    if (!node) node = taggedWrappers()[0] || null;
    // Fallback for the passes before the first apply: walk to the highest ancestor
    // that still holds every shell, not the first one holding two, so a nested stack
    // cannot capture the root.
    var cur = node ? node.parentElement : null, best = null;
    var total = document.querySelectorAll(SHELL_SELECTOR).length;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cur.querySelectorAll(SHELL_SELECTOR).length >= Math.min(2, total)) best = cur;
      cur = cur.parentElement;
    }
    return best || document.body || document.documentElement;
  }

  function observeRoot() {
    if (!observer) return;
    var next = columnsRoot();
    if (!next || next === observedRoot) return;
    observer.disconnect();
    observer.observe(next, { childList: true, subtree: true });
    observedRoot = next;
  }

  function observeBarGuardRoot() {
    if (!barObserver) return;
    var next = columnsRoot();
    if (!next || next === barObservedRoot) return;
    barObserver.disconnect();
    barObserver.observe(next, { childList: true, subtree: true });
    barObservedRoot = next;
  }

  // ---- anti-flicker bar-guard ------------------------------------------------
  // Fires on every childList mutation in columnsRoot()'s subtree. Its only job is
  // "the bar should exist but does not -> put it back now", with NO debounce:
  // while the bar is missing the compensating height rule stops applying and the
  // panel visibly jumps. Deliberately calls renderBar() rather than tick(): a
  // full tick also reconciles, which the debounced observer and the sweep already
  // do at their own coalesced pace.
  //
  // Cannot become a feedback loop: renderBar() inserting the bar is itself a
  // childList mutation this same observer will see, but by then barEl() is
  // non-null, so that next invocation is a no-op before it does anything.
  // What the bar guard must wake for: OUR BAR being taken out (its entire purpose), or
  // a pane/shell appearing or leaving (which can change whether a bar is wanted at all).
  // Streamed transcript markdown is neither, which is the point.
  function isBarGuardRelevant(recs) {
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i], j, n;
      for (j = 0; j < r.removedNodes.length; j++) {
        n = r.removedNodes[j];
        if (n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains(BAR_CLASS)) return true;
        if (n.querySelector && n.querySelector("." + BAR_CLASS)) return true;
      }
      if (isRelevant([r])) return true;
    }
    return false;
  }

  function guardBar() {
    if (!enabled) return;
    if (barEl()) return;
    // Cheapest possible disqualifier BEFORE computeView(): with no pane root in the
    // document there is no side panel, so there is no bar to put back and nothing to
    // compute. barEl() alone was not enough of an early-out - it only holds while a
    // bar exists, which is precisely not this state.
    if (!document.querySelector(PANE_SELECTOR) &&
        !document.querySelector(PANE_FALLBACK_SELECTOR)) return;
    renderBar();
  }

  // The pref lives main-side and is reported by the cdbTabs bridge. That bridge
  // may not exist at all (it is injected separately, and an older/newer build
  // may not have it), so every step is treated as optional: absent is silent,
  // a bad shape or a throw warns ONCE, and a rejection is ignored. Re-polled
  // for the life of the page, so a bridge that appears late is still picked up.
  function pollPref() {
    var api = window.cdbTabs;
    if (!api || typeof api.state !== "function") return;
    var p;
    try { p = api.state(); } catch (e) {
      warnOnce("pref-threw", "cdbTabs.state() threw: " + ((e && e.message) || e));
      return;
    }
    if (!p || typeof p.then !== "function") {
      warnOnce("pref-shape", "cdbTabs.state() did not return a promise - ignoring the pref");
      return;
    }
    p.then(function (st) {
      var next = !!(st && st.enabled);
      if (next === enabled) return;
      setEnabled(next);
      tick();
    }, function () {});
  }

  // The sweep absorbs a debounced pass that is still pending rather than running
  // alongside it: without this, a mutation landing a few ms before an interval
  // boundary produces two full passes milliseconds apart.
  function sweep() {
    if (pendingTick) { window.clearTimeout(pendingTick); pendingTick = 0; }
    tick();
  }

  function start() {
    // Idempotent: a second call must not double the observer or the sweep -
    // every pass would then run twice, and the debounce below would hide it.
    if (started) return;
    started = true;
    installShortcuts();
    if (window.MutationObserver) {
      observer = new window.MutationObserver(function (recs) {
        if (!isRelevant(recs)) return;
        // SYNCHRONOUSLY, BEFORE THE NEXT PAINT. A MutationObserver callback runs as a
        // microtask after the mutation and before layout and paint, so reconciling
        // here is what stops a branch upstream has just inserted from ever being
        // painted, and what keeps the chat/side boundary from wobbling on a close.
        //
        // The 120ms debounce used to sit in FRONT of this and was the whole transient
        // the user reported as "jumpy". Measured per frame: opening a panel put chat
        // 190px off its steady width with TWO visible side branches for ~96ms, and
        // closing the active panel left the entire side region blank for ~112ms.
        //
        // Re-entrancy guard, not a debounce: tick() mutates the DOM itself (it moves
        // the bar), and although isRelevant() rejects those, the guard makes that
        // independent of isRelevant staying correct.
        if (!inObserverTick) {
          inObserverTick = true;
          try { tick(); } finally { inObserverTick = false; }
        }
        // A trailing coalesced pass as well. Upstream sometimes inserts a wrapper and
        // fills it a moment later, and the second half must not have to wait for the
        // 500ms sweep. This is now a follow-up, not the primary path.
        if (!pendingTick) {
          pendingTick = window.setTimeout(function () { pendingTick = 0; tick(); }, DEBOUNCE_MS);
        }
      });
      observeRoot();
      // FILTERED, but NOT with isRelevant(): the bar's own removal is the mutation this
      // observer exists to catch, and our bar is not "paneish", so isRelevant would
      // filter out exactly the event it must react to.
      //
      // Unfiltered, this ran a full renderBar() -> computeView() in the pre-paint
      // microtask for EVERY childList batch in the observed subtree whenever no bar
      // existed - the ordinary state on a plain chat, a project page, or the Code tab
      // before the first panel opens. computeView() parses upstream's whole store twice
      // and walks every pane's fiber, and the root can be document.body or a lastRow
      // containing the streaming transcript, so streamed markdown drove it
      // continuously. Same hazard the other observer's gate exists to prevent.
      barObserver = new window.MutationObserver(function (recs) {
        if (!isBarGuardRelevant(recs)) return;
        guardBar();
      });
      observeBarGuardRoot();
    }
    sweepTimer = window.setInterval(sweep, SWEEP_MS);
    pollPref();
    prefTimer = window.setInterval(pollPref, PREF_POLL_MS);
  }

  // Full teardown. Nothing in the page calls this today, but start() installs a
  // page-lifetime observer, two intervals and three document listeners, and the
  // injector that will call start() is the one place that could ever need to
  // undo them (a re-injection, or the feature being torn out). Leaves the
  // persisted active id alone, and leaves `enabled` as it was, so a later
  // start() picks up where this left off.
  //
  // It must leave no live DOM either: the bar's own buttons call
  // activate()/closeTab(), so a bar left behind by a stopped module is a control
  // with nothing reconciling it. Our column attributes come off too - a stopped
  // module must not leave a panel hidden with no way to reach it.
  function stop() {
    if (!started) return;
    started = false;
    stickyChat = null;
    structRefused = false;
    cancelSticky();
    if (pendingTick) { window.clearTimeout(pendingTick); pendingTick = 0; }
    if (sweepTimer) { window.clearInterval(sweepTimer); sweepTimer = 0; }
    if (prefTimer) { window.clearInterval(prefTimer); prefTimer = 0; }
    if (observer) { observer.disconnect(); observer = null; }
    observedRoot = null;
    if (barObserver) { barObserver.disconnect(); barObserver = null; }
    barObservedRoot = null;
    if (chatFlexObserver) { chatFlexObserver.disconnect(); chatFlexObserver = null; }
    chatFlexObserved = null;
    dragArmed = false;
    if (dragListenersInstalled) {
      document.removeEventListener("pointerdown", onDragDown, true);
      document.removeEventListener("pointerup", onDragUp, true);
      document.removeEventListener("pointercancel", onDragUp, true);
      document.removeEventListener("lostpointercapture", onDragUp, true);
      if (window.removeEventListener) {
        window.removeEventListener("pointerup", onDragUp, true);
        window.removeEventListener("pointercancel", onDragUp, true);
        window.removeEventListener("blur", onDragUp, true);
      }
      dragListenersInstalled = false;
    }
    dropBar();
    clearAll();
    if (shortcutsInstalled) {
      document.removeEventListener("keydown", handleKey, true);
      shortcutsInstalled = false;
    }
  }

  // JSON-safe projection of computeView(), for consumers and tests.
  function state() {
    var view = computeView();
    var cols = [], i;
    for (i = 0; i < view.cols.length; i++) {
      cols.push({ tileId: view.cols[i].tileId, mounted: !!view.cols[i].pane });
    }
    return { sessionId: view.sessionId, tabs: view.tabs, activeId: view.activeId,
      storedActiveId: view.stored, columns: cols, sidePanes: view.sidePanes,
      expandedTileId: view.expandedTileId };
  }

  window.__cdbTabsPage = { state: state, reconcile: reconcile, activate: activate,
    closeTab: closeTab, setEnabled: setEnabled, clearAll: clearAll,
    renderBar: function () { return renderBar(); }, barEl: barEl, labelFor: labelFor,
    installShortcuts: installShortcuts, handleKey: handleKey,
    start: start, stop: stop, _warn: warn,
    // Test-only, like _warn above: `enabled` is not otherwise observable.
    _health: function () { return { enabled: enabled }; },
    // Test-only: exposes the private observedRoot / barObservedRoot vars so the
    // observer-scoping tests can assert WHICH node each MutationObserver is
    // attached to (columnsRoot(), the row spanning every column wrapper), and
    // that BOTH observers resolved the same node.
    _observedRoot: function () { return observedRoot; },
    _barObservedRoot: function () { return barObservedRoot; },
    // Test-only: the flex value handed to the active side branch.
    _sideFlex: function () { return this._flex().sideFlex; },
    // Test-only: the whole geometry decision - the held per-session SHARE, the live
    // chatFlex it is applied to, and the active branch's own flex (read only when
    // CAPTURING). Lets a test assert the share is chat/(chat+activeBranch), that it
    // is invariant under a chatFlex rescale, and what the drag re-captured.
    _flex: function () {
      var view = computeView();
      var col = colFor(view.cols, view.activeId);
      var res = col ? resolveChain(col.wrapper) : null;
      var chatCol = res ? chatColumnOf(res.row) : null;
      var rowChild = res ? res.rowChild : null;
      var chatFlex = chatFlexOf(chatCol, view.root);
      var branchFlex = branchFlexOf(rowChild, view.root);
      var sideFlex = sideFlexOf(chatCol, rowChild, view.root, view.sessionId);
      return { chatFlex: chatFlex, branchFlex: branchFlex,
        chatShare: chatShareFor(view.sessionId, chatFlex, branchFlex),
        storedShare: S.read(view.sessionId).chatShare,
        sideFlex: sideFlex,
        // What the boundary WILL be, so a test can assert invariance without pixels.
        boundary: chatFlex / (chatFlex + sideFlex),
        dragArmed: dragIsArmed() };
    },
    // Test-only: forget the held share, as a fresh page would.
    _forgetShare: function (sid) { delete shareMemo[sid || sessionId()]; },
    // Test-only: how many times the expensive paths have run, so a test can prove an
    // observer is not driving them instead of guessing from wall-clock timing.
    _stats: function () { return { computeViews: stats.computeViews, renderBars: stats.renderBars }; },
    _resetStats: function () { stats.computeViews = 0; stats.renderBars = 0; },
    // Test-only: the watchdog's own recovery path, which no user action reaches.
    _unarm: function () { unarm(); },
    // Test-only: drop the HELD chat pick, as a fresh page would, so a test can force the
    // first-identification path (where ambiguity-refusal applies) on demand.
    _forgetChat: function () { stickyChat = null; },
    // Test-only: drive the drag discriminator without synthesising pointer events
    // through upstream's handle. `phase` is "down" or "up".
    _drag: function (phase) {
      if (phase === "down") { onDragDown({ target: lastHandle }); return dragArmed; }
      onDragUp();
      return dragArmed;
    },
    // Test-only: the structure the last/current pass resolves - the row, the chain
    // from the row-level element down to the active leaf, and which elements carry
    // each structural mark. Lets the suites and the live probes assert the SHAPE
    // rather than infer it from pixels.
    _structure: function () {
      var view = computeView();
      var col = colFor(view.cols, view.activeId);
      if (!col) return { row: null, chain: [], rowChild: null };
      var sidePanes = sidePanesOf(view.cols);
      var res = resolveChain(col.wrapper);
      function tag(el) {
        if (!el) return null;
        return { col: el.getAttribute(COL_ATTR), hide: el.hasAttribute(HIDE_ATTR),
          side: el.hasAttribute(SIDE_ATTR), fill: el.hasAttribute(FILL_ATTR),
          chain: el.hasAttribute(CHAIN_ATTR), row: el.hasAttribute(ROW_ATTR),
          width: Math.round(el.getBoundingClientRect().width),
          height: Math.round(el.getBoundingClientRect().height) };
      }
      var chain = [], i;
      for (i = res.chain.length - 1; i >= 0; i--) chain.push(tag(res.chain[i]));
      var chatCol = chatColumnOf(res.row);
      var rowKids = [], kids = res.row ? res.row.children : [], cands = 0;
      for (i = 0; i < kids.length; i++) {
        // `chatCandidate` is the raw per-child predicate and `chat` the RESOLVED
        // answer. They differ exactly when the row is ambiguous - two candidates, no
        // chat - which is the state a test has to be able to see to prove the refusal.
        if (chatLooksRight(kids[i])) cands++;
        rowKids.push({ handle: isHandle(kids[i]), hide: kids[i].hasAttribute(HIDE_ATTR),
          side: kids[i].hasAttribute(SIDE_ATTR), chat: kids[i] === chatCol,
          chatCandidate: chatLooksRight(kids[i]),
          chatMark: kids[i].hasAttribute(CHAT_ATTR),
          shell: !!(kids[i].querySelector && kids[i].querySelector(SHELL_SELECTOR)),
          // The discriminator, per child, so a test can prove WHY a candidate was
          // rejected rather than just that it was.
          shellPos: (function () {
            var s = kids[i].querySelector && kids[i].querySelector(SHELL_SELECTOR);
            return s && window.getComputedStyle ? window.getComputedStyle(s).position : null;
          })(),
          holdsSide: holdsAny(kids[i], sidePanes),
          width: Math.round(kids[i].getBoundingClientRect().width) });
      }
      return { row: tag(res.row), rowFound: !!res.row, chain: chain, rowChildren: rowKids,
        chatCandidates: cands, chatResolved: !!chatCol,
        // Is the answer being HELD, and is the held element the one we resolved? Lets a
        // test prove stickiness is doing the work rather than inferring it from geometry.
        chatSticky: stickyChatOk(), chatStickyIsResolved: stickyChatOk() && stickyChat === chatCol };
    } };
})();
