#!/usr/bin/env node
/*
 * test-panel-tabs-layout.mjs - pure unit tests for js/panel_tabs_layout.js and
 * js/panel_tabs_store.js. No Chromium, no npm: the modules are evaluated in a
 * bare VM context with a minimal window/localStorage stub.
 *
 * v2 (2026-08-04): the tree BUILDERS (build/buildSplit) and the structural
 * signature are gone along with the write path they served - we no longer write
 * upstream's tileLayout at all - so their assertions are gone too. What is left
 * is the read side (which the tab strip's membership and order derive from) and
 * the store, which now persists ONE field.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  name + (JSON.stringify(a) === JSON.stringify(b) ? "" : " -> got " + JSON.stringify(a)));

function loadModules(files, store) {
  const win = { localStorage: store, console };
  win.window = win;
  const ctx = vm.createContext(win);
  for (const f of files) vm.runInContext(readFileSync(join(ROOT, f), "utf8"), ctx);
  return win;
}

const FIXTURE = { root: { kind: "stack", id: "s1", direction: "row", flex: 1, children: [
  { kind: "tile", tileId: "chat", flex: 2 },
  { kind: "stack", id: "s2", direction: "column", flex: 1, children: [
    { kind: "tile", tileId: "terminal", flex: 1 },
    { kind: "tile", tileId: "diff", flex: 1 }] },
  { kind: "tile", tileId: "preview", flex: 1 }] } };

const w = loadModules(["js/panel_tabs_layout.js"], null);
const L = w.__cdbTabsLayout;

eq(L.tileIds(FIXTURE.root), ["chat", "terminal", "diff", "preview"], "tileIds walks nested stacks");
eq(L.sideTileIds(FIXTURE.root), ["terminal", "diff", "preview"], "sideTileIds drops chat");
eq(L.geometry(FIXTURE.root), { chatFlex: 2, sideFlex: 2 }, "geometry sums non-chat top-level flex");
// ... and again with every number DISTINCT. Above, chatFlex and sideFlex are both 2,
// so an implementation that returned the chat flex for both - or summed the wrong
// children - would pass. Here 5 vs 3+7=10 can only come out right one way.
eq(L.geometry({ kind: "stack", direction: "row", flex: 1, children: [
     { kind: "tile", tileId: "chat", flex: 5 },
     { kind: "stack", direction: "column", flex: 3, children: [
       { kind: "tile", tileId: "terminal", flex: 100 },
       { kind: "tile", tileId: "diff", flex: 200 }] },
     { kind: "tile", tileId: "preview", flex: 7 }] }),
   { chatFlex: 5, sideFlex: 10 },
   "geometry: TOP-LEVEL only and non-degenerate - chat 5, sides 3+7=10, and the nested 100/200 are correctly ignored");

// sideTileIds IS the tab strip's membership and order in v2, so its order must be
// upstream's own child order - dragging tiles in upstream's UI reorders our tabs.
{
  const reordered = JSON.parse(JSON.stringify(FIXTURE.root));
  reordered.children = [reordered.children[0], reordered.children[2], reordered.children[1]];
  eq(L.sideTileIds(reordered), ["preview", "terminal", "diff"],
     "sideTileIds follows upstream's child order, so reordering tiles reorders the tabs");
}

const GEOM_DIVERGE_FIXTURE = { kind: "stack", id: "g1", direction: "row", flex: 1, children: [
  { kind: "tile", tileId: "chat", flex: 2 },
  { kind: "tile", tileId: "terminal", flex: 3 },
  { kind: "tile", tileId: "diff", flex: 4 }] };
eq(L.geometry(GEOM_DIVERGE_FIXTURE), { chatFlex: 2, sideFlex: 7 },
  "geometry sums flex, not the count, of non-chat top-level children");

// Degradation: a node shape we do not recognise must read as "nothing", never
// throw - every caller treats an empty list as "stay passive".
eq(L.tileIds(null), [], "tileIds of null is empty");
eq(L.tileIds({ kind: "stack", children: "nope" }), [], "tileIds ignores a non-array children");
eq(L.sideTileIds({ type: "stack", children: [{ type: "tile", tileId: "diff" }] }), [],
   "a renamed node discriminator degrades to an empty tile list rather than throwing");
eq(L.geometry(null), { chatFlex: 0, sideFlex: 0 }, "geometry of null is zeroes");

// The write-path builders are GONE with the write path itself (v2). Asserted
// rather than merely deleted: re-adding one would mean the layout is being
// written again, which is the thing this mechanism change exists to stop.
ok(typeof L.build === "undefined" && typeof L.buildSplit === "undefined",
   "the tile-tree BUILDERS are gone - nothing writes upstream's layout any more");
ok(typeof L.signature === "undefined",
   "the structural signature is gone - it existed only as a loop guard for our own writes");
eq(Object.keys(L).sort(), ["STORE_KEY", "geometry", "readStore", "sideTileIds", "tileIds"],
   "the module's surface is read-only");

// --- readStore ---------------------------------------------------------------
{
  const MIRROR = "epitaxy.sidePaneStore.v1";
  function storage(initial) {
    var map = Object.assign({}, initial || {});
    return { getItem: (k) => (k in map ? map[k] : null),
             setItem: (k, v) => { map[k] = String(v); }, removeItem: (k) => { delete map[k]; } };
  }
  const good = loadModules(["js/panel_tabs_layout.js"], storage({ [MIRROR]: JSON.stringify({
    state: { tileLayout: FIXTURE, tileLayoutBySession: { local_a: FIXTURE },
             currentSessionId: "local_a" }, version: 4 }) })).__cdbTabsLayout;
  eq(good.readStore().currentSessionId, "local_a", "readStore returns the current session id");
  eq(L.sideTileIds(good.readStore().tileLayout.root), ["terminal", "diff", "preview"],
     "readStore's tileLayout unwraps to a node sideTileIds can read");
  const bad = loadModules(["js/panel_tabs_layout.js"], storage({ [MIRROR]: "{not json" })).__cdbTabsLayout;
  eq(bad.readStore(), null, "a corrupt mirror reads as null instead of throwing");
  const empty = loadModules(["js/panel_tabs_layout.js"], storage()).__cdbTabsLayout;
  eq(empty.readStore(), null, "an absent mirror reads as null");
  const noLayout = loadModules(["js/panel_tabs_layout.js"],
    storage({ [MIRROR]: JSON.stringify({ state: {} }) })).__cdbTabsLayout;
  eq(noLayout.readStore(), null, "a mirror with no tileLayout reads as null");
}

// --- store (v2: the active tab, and nothing else) ----------------------------
function fakeStorage(initial) {
  var map = Object.assign({}, initial || {});
  return { getItem: (k) => (k in map ? map[k] : null),
           setItem: (k, v) => { map[k] = String(v); },
           removeItem: (k) => { delete map[k]; }, _map: map };
}
const KEY = "cdb.panelTabs.v2";
const KEY_V1 = "cdb.panelTabs.v1";

{
  const st = fakeStorage();
  const S = loadModules(["js/panel_tabs_store.js"], st).__cdbTabsStore;
  eq(S.KEY, KEY, "the store key is the v2 key");
  eq(S.VERSION, 2, "the store version is 2");
  eq(S.read("local_a"), { activeId: null, chatShare: null }, "read of an empty store returns no active id");
  ok(S.write("local_a", "diff"), "write returns true");
  eq(S.read("local_a"), { activeId: "diff", chatShare: null }, "round-trips through localStorage");
  eq(JSON.parse(st._map[KEY]).version, 2, "blob carries version 2");
  eq(JSON.parse(st._map[KEY]).bySession.local_a, { activeId: "diff", chatShare: null },
     "the persisted entry is ONLY the active id - membership, order and geometry now come from upstream's layout");
  eq(S.read("local_b"), { activeId: null, chatShare: null }, "sessions are isolated");
  ok(S.write("local_a", null), "writing a null active id is legal");
  eq(S.read("local_a"), { activeId: null, chatShare: null }, "a null active id round-trips as 'no opinion'");
}

// `chatShare` - the chat side of the chat/panel split as a PROPORTION, the one
// number that came back in v2 because it is deliberately NOT derivable from the
// live layout (it describes a two-pane split, while upstream's layout holds every
// branch). A RATIO and not a total: upstream renormalises the row's flexes, and a
// ratio is invariant under that where a total or a difference is not. Anything
// outside the open interval (0,1) must read back as null, which the reconciler
// treats as "capture it fresh" - discarded, never clamped.
{
  const st = fakeStorage();
  const S = loadModules(["js/panel_tabs_store.js"], st).__cdbTabsStore;
  ok(S.write("local_a", "diff", null, 0.4), "a share is written alongside the active id");
  eq(S.read("local_a"), { activeId: "diff", chatShare: 0.4 }, "and round-trips through localStorage");
  eq(JSON.parse(st._map[KEY]).bySession.local_a, { activeId: "diff", chatShare: 0.4 },
     "the persisted entry is exactly {activeId, chatShare} - nothing else came back with it");
  [undefined, null, 0, 1, 1.4, -0.3, NaN, Infinity, -Infinity, "0.4", {}, []].forEach((bad) => {
    S.write("local_a", "diff", null, bad);
    eq(S.read("local_a").chatShare, null,
       "a share of " + (typeof bad === "object" ? JSON.stringify(bad) : String(bad)) +
       " reads back as null, i.e. 'we do not have one'");
  });
  eq([S.validShare(0.25), S.validShare(0.999), S.validShare(0), S.validShare(1),
      S.validShare(1.5), S.validShare(-0.1), S.validShare(NaN), S.validShare(Infinity),
      S.validShare("0.5"), S.validShare(undefined)],
     [0.25, 0.999, null, null, null, null, null, null, null, null],
     "validShare() is the single rule both read and write go through - the OPEN interval (0,1)");
}
{
  // The retired `total` field, exactly as it exists in real users' localStorage.
  // 2.000003 is not a proportion, so it must not be read as one - and the next
  // write must drop it rather than carrying it forward forever.
  const st = fakeStorage({ [KEY]: JSON.stringify({ version: 2,
    bySession: { local_a: { activeId: "diff", total: 2.000003 } } }) });
  const S = loadModules(["js/panel_tabs_store.js"], st).__cdbTabsStore;
  eq(S.read("local_a"), { activeId: "diff", chatShare: null },
     "migration: a retired `total` is not read as a share - the entry reads as having none");
  S.write("local_a", "diff", null, 0.4);
  eq(JSON.parse(st._map[KEY]).bySession.local_a, { activeId: "diff", chatShare: 0.4 },
     "migration: the next write REPLACES the entry, so `total` is gone rather than lingering beside the share");
}
{
  // A stored entry whose share is valid but whose activeId is junk must still yield
  // the share: the two are independent.
  const st = fakeStorage({ [KEY]: JSON.stringify({ version: 2,
    bySession: { local_a: { activeId: 7, chatShare: 0.25 } } }) });
  const S = loadModules(["js/panel_tabs_store.js"], st).__cdbTabsStore;
  eq(S.read("local_a"), { activeId: null, chatShare: 0.25 },
     "a junk activeId does not take the share down with it");
}

// A v1 blob is IGNORED rather than migrated: its tabs[] described panels v1 had
// REMOVED from upstream's layout, and under v2 those are simply not open.
{
  const st = fakeStorage({ [KEY_V1]: JSON.stringify({ version: 1, bySession: {
    local_a: { tabs: ["diff", "terminal"], activeId: "terminal", chatFlex: 3, sideFlex: 2 } } }) });
  const S = loadModules(["js/panel_tabs_store.js"], st).__cdbTabsStore;
  eq(S.read("local_a"), { activeId: null, chatShare: null },
     "a v1 blob under the old key is ignored - v2 reads a different key entirely");
  S.write("local_a", "diff");
  ok(st._map[KEY_V1] !== undefined && JSON.parse(st._map[KEY_V1]).version === 1,
     "the v1 blob is left untouched rather than rewritten or deleted");
}

{
  const S = loadModules(["js/panel_tabs_store.js"], fakeStorage({ [KEY]: "{not json" })).__cdbTabsStore;
  eq(S.read("local_a"), { activeId: null, chatShare: null },
     "corrupt JSON reads as no active id instead of throwing");
}
{
  const S = loadModules(["js/panel_tabs_store.js"],
    fakeStorage({ [KEY]: JSON.stringify({ version: 99, bySession: { local_a: { activeId: "diff" } } }) })).__cdbTabsStore;
  eq(S.read("local_a"), { activeId: null, chatShare: null }, "unknown version is ignored");
}
{
  const S = loadModules(["js/panel_tabs_store.js"],
    fakeStorage({ [KEY]: JSON.stringify({ version: 2, bySession: { local_a: { activeId: 7 } } }) })).__cdbTabsStore;
  eq(S.read("local_a"), { activeId: null, chatShare: null }, "a wrong-typed activeId reads as no active id");
}
{
  const st = fakeStorage({ [KEY]: JSON.stringify({ version: 2, bySession: [] }) });
  const S = loadModules(["js/panel_tabs_store.js"], st).__cdbTabsStore;
  ok(S.write("local_a", "diff"), "write returns true even after rejecting an array-shaped bySession");
  eq(S.read("local_a"), { activeId: "diff", chatShare: null }, "data survives write after array-blob rejection");
  ok(Object.prototype.toString.call(JSON.parse(st._map[KEY]).bySession) === "[object Object]",
     "persisted blob.bySession is a plain object, not an array");
}

// --- pruning ----------------------------------------------------------------
{
  const st = fakeStorage();
  const S = loadModules(["js/panel_tabs_store.js"], st).__cdbTabsStore;
  S.write("local_a", "diff");
  S.write("local_gone", "preview");
  S.prune(["local_a"]);
  eq(Object.keys(JSON.parse(st._map[KEY]).bySession), ["local_a"], "prune drops unknown sessions");
}
{
  const st = fakeStorage();
  const S = loadModules(["js/panel_tabs_store.js"], st).__cdbTabsStore;
  S.write("local_gone", "preview");
  S.write("local_keep", "terminal");
  // The valid set deliberately OMITS the session being written: upstream's
  // tileLayoutBySession (where the caller gets it) need not carry an entry for a
  // brand-new session yet, and pruning the session we are writing would be
  // self-defeating.
  ok(S.write("local_a", "diff", ["local_keep"]) === true, "a pruning write still returns true");
  eq(Object.keys(JSON.parse(st._map[KEY]).bySession).sort(), ["local_a", "local_keep"],
     "write prunes sessions outside the valid set");
  eq(S.read("local_a"), { activeId: "diff", chatShare: null },
     "write never prunes the session it is writing, even when the valid set omits it");
  eq(S.read("local_keep"), { activeId: "terminal", chatShare: null }, "a session inside the valid set keeps its entry");
  eq(S.read("local_gone"), { activeId: null, chatShare: null }, "the pruned session's entry is really gone");
}
{
  // A caller that cannot establish the valid set must write WITHOUT pruning:
  // "we do not know which sessions exist" must never mean "delete them all".
  const st = fakeStorage();
  const S = loadModules(["js/panel_tabs_store.js"], st).__cdbTabsStore;
  const both = ["local_a", "local_other"];
  S.write("local_other", "preview");
  S.write("local_a", "diff");
  eq(Object.keys(JSON.parse(st._map[KEY]).bySession).sort(), both,
     "write with no valid-session argument prunes nothing");
  S.write("local_a", "diff", "nope");
  eq(Object.keys(JSON.parse(st._map[KEY]).bySession).sort(), both,
     "write ignores a non-array valid-session argument instead of pruning on it");
  S.write("local_a", "diff", [7]);
  eq(Object.keys(JSON.parse(st._map[KEY]).bySession).sort(), both,
     "write ignores a valid-session array that is not all strings");
}
{
  // ONE storage write per persist, not two: the pruning happens inside write()'s
  // own setItem rather than by delegating to prune()'s separate
  // read-modify-write. Each setItem fires a cross-tab storage event.
  const st = fakeStorage();
  let sets = 0;
  const counting = { getItem: st.getItem, removeItem: st.removeItem,
    setItem: (k, v) => { sets++; st.setItem(k, v); } };
  const S = loadModules(["js/panel_tabs_store.js"], counting).__cdbTabsStore;
  S.write("local_a", "diff", ["local_a"]);
  ok(sets === 1, "a pruning write is a single localStorage.setItem");
}
{
  function throwingStorage() {
    return { getItem: () => null, setItem: () => { throw new Error("quota exceeded"); },
             removeItem: () => {} };
  }
  const S = loadModules(["js/panel_tabs_store.js"], throwingStorage()).__cdbTabsStore;
  ok(S.write("local_a", "diff") === false, "write returns false when localStorage.setItem throws");
  S.prune(["local_a", "local_b"]);
  ok(true, "prune does not throw when localStorage.setItem throws");
}
{
  // Missing localStorage entirely (the module is injected into a page whose
  // storage is blocked): read must still answer, write must still return false.
  const S = loadModules(["js/panel_tabs_store.js"], undefined).__cdbTabsStore;
  eq(S.read("local_a"), { activeId: null, chatShare: null }, "read with no localStorage degrades to no active id");
  ok(S.write("local_a", "diff") === false, "write with no localStorage returns false");
  ok(S.write("", "diff") === false, "write with no session id returns false");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
