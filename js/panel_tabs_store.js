/*
 * panel_tabs_store.js - the ONE thing about panel tabs that upstream does not
 * already know: which tab is active, per Code session.
 *
 * v2 (mechanism change, 2026-08-04): every tab's tile now stays in upstream's
 * own tileLayout - we switch tabs by toggling a CSS attribute, not by rewriting
 * the layout - so tab MEMBERSHIP, ORDER and GEOMETRY are all derivable from
 * upstream's layout and are no longer persisted here. v1 had to persist them
 * because an inactive panel was removed from the layout, making this file the
 * only record that it existed at all. That is no longer true, and the shrink is
 * the point.
 *
 * ONE number came back (2026-08-05): `chatShare`, the chat side of the chat/panel
 * split as a PROPORTION in (0,1). It is not derivable from the live layout, because
 * it is deliberately the proportion of a TWO-PANE split - chat versus the ONE
 * branch on screen - while upstream's layout holds every branch. Deriving it fresh
 * would make chat shrink every time another panel was opened.
 *
 * A PROPORTION and not a total or a difference, and that is the whole point. An
 * earlier version stored `total` and applied `sideFlex = total - chatFlex`; that
 * is unsound, because upstream RENORMALISES the row's flexes when branches are
 * added or removed (measured live: chat 1.198940 -> 2.0 for the same visual
 * split). The difference then collapsed toward zero and the panel visibly shrank.
 * A ratio is invariant under uniform rescaling, which is exactly the drift that
 * has to be survived.
 *
 * `total` from that version is therefore a WRONG-SHAPED value that exists in real
 * users' localStorage. It is discarded by construction: the key is different, so
 * nothing reads it, and the next write drops it. Never read `total` as a share -
 * 2.000003 is not a proportion.
 *
 * Anything not a finite number strictly between 0 and 1 reads back as null, which
 * the reconciler treats as "capture it fresh" - discarded, never clamped.
 *
 * A v1 blob (key "cdb.panelTabs.v1") is simply ignored: the KEY changed, so
 * nothing reads it. That is the correct migration - v1's tabs[] listed panels
 * v1 had REMOVED from the layout, and under v2 those are not open.
 *
 * It must still never throw: anything unreadable degrades to "no active id",
 * which the reconciler resolves to the layout's first side tile.
 */
(function () {
  "use strict";
  if (window.__cdbTabsStore) return;

  var KEY = "cdb.panelTabs.v2";
  var VERSION = 2;

  function defaults() { return { activeId: null, chatShare: null }; }

  // A share is only meaningful as a finite number STRICTLY inside (0,1): 0 would
  // mean chat has no width, 1 that the panel has none, and both ends make the
  // sideFlex formula degenerate. NaN, Infinity, a non-number and anything outside
  // the open interval are all "we do not have one".
  function validShare(v) {
    return typeof v === "number" && isFinite(v) && v > 0 && v < 1 ? v : null;
  }

  function isStringArray(v) {
    if (Object.prototype.toString.call(v) !== "[object Array]") return false;
    for (var i = 0; i < v.length; i++) if (typeof v[i] !== "string") return false;
    return true;
  }

  function readBlob() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return { version: VERSION, bySession: {} };
      var b = JSON.parse(raw);
      if (!b || b.version !== VERSION || !b.bySession ||
          Object.prototype.toString.call(b.bySession) !== "[object Object]") {
        return { version: VERSION, bySession: {} };
      }
      return b;
    } catch (e) { return { version: VERSION, bySession: {} }; }
  }

  function read(sessionId) {
    var e = readBlob().bySession[sessionId];
    if (!e || typeof e !== "object") return defaults();
    return { activeId: typeof e.activeId === "string" ? e.activeId : null,
      chatShare: validShare(e.chatShare) };
  }

  // The bySession map with every session outside validIds dropped. keepId is
  // never dropped: it is the session being written right now, and the caller's
  // valid set comes from upstream's own tileLayoutBySession, which need not carry
  // an entry for a brand-new session yet. Pure - it neither reads nor writes
  // localStorage - so write() can prune inside its own single setItem.
  function keptSessions(bySession, validIds, keepId) {
    var keep = {}, i, id;
    for (i = 0; i < validIds.length; i++) {
      id = validIds[i];
      if (bySession[id]) keep[id] = bySession[id];
    }
    if (keepId && bySession[keepId]) keep[keepId] = bySession[keepId];
    return keep;
  }

  // validSessionIds is OPTIONAL and enables lazy pruning. Anything that is not
  // an array of strings is ignored, so a caller that cannot establish which
  // sessions still exist writes without pruning - "we do not know" must never
  // turn into "delete everything".
  //
  // Pruned in the SAME setItem as the entry itself rather than by calling
  // prune() afterwards: prune() is its own read-modify-write, so delegating
  // would double both the storage write and the cross-tab storage event.
  //
  // activeId is the WHOLE entry now (v2). null is a legal value and means "no
  // opinion" - the reconciler then resolves to the layout's first side tile.
  // The entry is REPLACED, never merged, which is what drops the retired `total`
  // field from an older blob rather than carrying it forward forever.
  function write(sessionId, activeId, validSessionIds, chatShare) {
    if (!sessionId) return false;
    try {
      var b = readBlob();
      b.bySession[sessionId] = { activeId: typeof activeId === "string" ? activeId : null,
        chatShare: validShare(chatShare) };
      // After the assignment above, so keptSessions() can find sessionId to keep.
      if (isStringArray(validSessionIds)) {
        b.bySession = keptSessions(b.bySession, validSessionIds, sessionId);
      }
      window.localStorage.setItem(KEY, JSON.stringify(b));
      return true;
    } catch (e) { return false; }
  }

  // The explicit full-sweep form: prunes without writing an entry. write()'s
  // validSessionIds argument is the path the feature actually uses, so this is
  // here for a caller that needs the sweep on its own; both go through
  // keptSessions, so there is one pruning rule, not two.
  function prune(validSessionIds) {
    try {
      var b = readBlob();
      b.bySession = keptSessions(b.bySession, validSessionIds, null);
      window.localStorage.setItem(KEY, JSON.stringify(b));
    } catch (e) {}
  }

  window.__cdbTabsStore = { read: read, write: write, prune: prune, validShare: validShare,
    KEY: KEY, VERSION: VERSION };
})();
