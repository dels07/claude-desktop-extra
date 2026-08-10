#!/usr/bin/env node
/*
 * test-panel-tabs-dom.mjs - headless-Chromium DOM tests for the panel tabs
 * feature (js/panel_tabs_{layout,store,harvest,page}.js, delivered by
 * patches/community/add_feature_panel_tabs.nim).
 *
 * The Code tab is REMOTE claude.ai markup, so a clean patch run says nothing
 * about this feature working. What CAN be pinned is that the modules derive
 * everything from the DOM and fiber props they are given.
 *
 * MECHANISM v2 (2026-08-04). The fixture reproduces the real column structure
 * measured live against 1.24012.9: a flex ROW of column wrappers, ONE
 * .tiles-shell per column, the CHAT column first in document order and its shell
 * holding no tiles at all (the chat pane sits beside it, which is why
 * document.querySelector(".tiles-shell") is never a valid way to find the side
 * column). Tabs are switched by toggling data-cdb-col-active, never by rewriting
 * upstream's layout - so `window.__calls.layout` is wired up purely as a TRIPWIRE
 * and virtually every scenario asserts it stayed at zero.
 *
 * Most of the v1 suite described the layout-write behaviour that has been
 * deleted (the [chat, active] tree, the freshness/echo/signature guards, the drop
 * branch and its vetoes, the cached-handler ghost-close path, the disable
 * restore-split and its retry) and went with it. That is not lost coverage: the
 * behaviour it described no longer exists.
 *
 * No npm dependency: each scenario is a generated HTML file run through
 * `chromium --headless --dump-dom`, and assertions are read back out of the
 * dumped DOM via a #__result JSON sink.
 *
 * Exits 3 when Chromium is missing so validate-patches.sh records SKIP.
 *
 * Usage: node scripts/tests/community/test-panel-tabs-dom.mjs [--keep] [--chromium PATH]
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unescapeHtml } from "../lib/unescape-html.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = (f) => readFileSync(join(ROOT, "js/" + f), "utf8");

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const CHROMIUM = (() => {
  const i = argv.indexOf("--chromium");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  for (const c of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    try {
      const p = execFileSync("/bin/sh", ["-c", "command -v " + c], { encoding: "utf8" }).trim();
      if (p) return p;
    } catch {}
  }
  return null;
})();
if (!CHROMIUM) { console.log("  SKIP: no chromium on PATH"); process.exit(3); }

// --- fixture -----------------------------------------------------------------
// paneHtml(t) is upstream's pane shape: a [data-pane-root] whose chrome row ends
// in aria-labelled control buttons.
const paneHtml = (t) => `
      <div class="epitaxy-view-panel" data-pane-root="" data-test-tile="${t}">
        <div class="chrome-row">
          <span class="breadcrumb">master &rarr; feature/x</span>
          <button aria-label="Expand" data-cds="Button">E</button>
          <button aria-label="Close" data-cds="Button" class="epitaxy-pane-close-control">X</button>
        </div>
        <div class="body">${t} content</div>
      </div>`;

// The two shell shapes, and the difference between them is load-bearing. Measured live
// on 1.24012.9 (2026-08-06), every .tiles-shell in the document:
//
//   chat's shell   position:absolute (inline: top/bottom/left:0, min-width:320px), EMPTY
//   a side shell   position:static   (no `position` in its inline style at all), 1 pane
//
// That is the discriminator `chatLooksRight()` uses to tell the chat column from a side
// wrapper whose pane has not landed yet, so a fixture that gave chat a STATIC shell would
// be testing a DOM upstream does not produce - and would let a mis-identification pass.
// The wrappers get `position:relative` because upstream's do (measured inline:
// `position: relative; min-width: 100px; ...`), which is what contains the absolute shell.
const CHAT_SHELL = `<div class="tiles-shell" style="position:absolute;top:0;bottom:0;left:0;width:100%;height:100%"></div>`;
const sideShell = (t) => `<div class="tiles-shell" style="height:100%">${paneHtml(t)}</div>`;

// The column row. tiles[0] is expected to be "chat": its column keeps an EMPTY,
// ABSOLUTELY POSITIONED .tiles-shell and holds the chat pane outside it, as measured live.
function columnRow(tiles, flexes) {
  return tiles.map((t) => {
    const flex = (flexes && flexes[t] !== undefined) ? flexes[t] : (t === "chat" ? 2 : 1);
    if (t === "chat") {
      return `
    <div class="epitaxy-column" data-test-col="chat" style="position:relative;flex: ${flex} 1 0%;">
      <div class="epitaxy-titlebar">titlebar</div>
      ${paneHtml("chat")}
      ${CHAT_SHELL}
    </div>`;
    }
    return `
    <div class="epitaxy-column" data-test-col="${t}" style="position:relative;flex: ${flex} 1 0%;">
      ${sideShell(t)}
    </div>`;
  }).join("");
}

// Fiber/prop wiring, plus the page-side helpers every scenario body uses.
// __calls.layout is the layout-write TRIPWIRE: the fiber ancestor still exposes
// onLayoutChange exactly as upstream does, so anything that ever called it would
// be recorded. Nothing does.
const WIRING = `
window.__calls = { layout: [], expand: [], close: [] };
var FIBER = "__reactFiber$test";
var RPROPS = "__reactProps$test";
function fiberFor(tileId, noLayoutChange) {
  var tileNode = { memoizedProps: { tileId: tileId }, return: null };
  var engineProps = { removeTile: function (id) { window.__calls.removeTile = id; } };
  if (!noLayoutChange) {
    engineProps.onLayoutChange = function (t) { window.__calls.layout.push(t); };
  }
  tileNode.return = { memoizedProps: engineProps, return: null };
  return tileNode;
}
window.__wireTile = function (pane, tileId, noLayoutChange) {
  pane[FIBER] = fiberFor(tileId, noLayoutChange);
  var ctl = pane.querySelector('[aria-label="Expand"],[aria-label="Collapse"]');
  var cls = pane.querySelector('[aria-label="Close"]');
  // Native listeners, because v2 drives upstream's own controls with a real
  // .click() rather than by invoking a harvested React onClick.
  ctl.addEventListener("click", function () {
    var was = ctl.getAttribute("aria-label");
    window.__calls.expand.push([tileId, was]);
    // Upstream COMMITS the expandedTile change and relabels its own control, which
    // is the only signal we ever read the state back from. Doing it here rather
    // than by hand in each scenario is what keeps a label assertion honest: it can
    // only read "Collapse" if the click really happened.
    ctl.setAttribute("aria-label", was === "Expand" ? "Collapse" : "Expand");
  });
  cls.addEventListener("click", function () { window.__calls.close.push([tileId, "click"]); });
  // The React props stay too: a regression that went back to invoking them
  // directly would show up as an entry with "props" instead of "click".
  ctl[RPROPS] = { onClick: function () { window.__calls.expand.push([tileId, "props"]); } };
  cls[RPROPS] = { onClick: function () { window.__calls.close.push([tileId, "props"]); } };
};
window.__paneOf = function (tileId) {
  return document.querySelector('[data-test-tile="' + tileId + '"]');
};
window.__col = function (tileId) {
  return document.querySelector('[data-test-col="' + tileId + '"]');
};
window.__tag = function (tileId) {
  var c = window.__col(tileId);
  return c ? c.getAttribute("data-cdb-col") : null;
};
window.__activeCol = function () {
  var n = document.querySelector("[data-cdb-col-active]");
  return n ? n.getAttribute("data-cdb-col") : null;
};
window.__activeColCount = function () {
  return document.querySelectorAll("[data-cdb-col-active]").length;
};
window.__hiddenCols = function () {
  var out = [], n = document.querySelectorAll("[data-cdb-col]:not([data-cdb-col-active])"), i;
  for (i = 0; i < n.length; i++) out.push(n[i].getAttribute("data-cdb-col"));
  return out;
};
window.__taggedCols = function () {
  var out = [], n = document.querySelectorAll("[data-cdb-col]"), i;
  for (i = 0; i < n.length; i++) out.push(n[i].getAttribute("data-cdb-col"));
  return out;
};
window.__writes = function () { return window.__calls.layout.length; };
// Nothing of ours is ever in flight any more: the availability probe this used to wait
// on went with the + menu (2026-08-06). Kept as a plain defer so the scenarios that
// call it still read the same, and so a future async step has one obvious place to go.
window.__whenIdle = function (cb) { setTimeout(cb, 0); };
window.__setExpanded = function (tileId, on) {
  var p = window.__paneOf(tileId);
  var b = p.querySelector('button[aria-label="Expand"],button[aria-label="Collapse"]');
  b.setAttribute("aria-label", on ? "Collapse" : "Expand");
};
window.__unmountPane = function (tileId) {
  var p = window.__paneOf(tileId);
  if (p && p.parentNode) p.parentNode.removeChild(p);
};
// What upstream does when the expanded tile is collapsed: the pane comes BACK
// into the column wrapper that is still there (and still carries our tag), as a
// fresh node with a fresh fiber. Deliberately re-wires rather than re-attaching
// the old node, so nothing in the sticky sequence can be passing because it held
// on to a pre-unmount reference.
window.__remountPane = function (tileId) {
  var col = window.__col(tileId);
  if (!col) return null;
  var shell = col.querySelector(".tiles-shell");
  shell.innerHTML = '<div class="epitaxy-view-panel" data-pane-root="" data-test-tile="' +
    tileId + '"><div class="chrome-row"><button aria-label="Expand">E</button>' +
    '<button aria-label="Close" class="epitaxy-pane-close-control">X</button></div>' +
    '<div class="body">' + tileId + '</div></div>';
  window.__wireTile(shell.firstChild, tileId);
  return shell.firstChild;
};
// Upstream flipping the whole expanded state off: the expanded tile's own control
// goes back to "Expand" and every other pane is remounted.
window.__collapseAll = function (expandedTileId, others) {
  window.__setExpanded(expandedTileId, false);
  for (var i = 0; i < others.length; i++) window.__remountPane(others[i]);
};
window.__dropCol = function (tileId) {
  var c = window.__col(tileId);
  if (c && c.parentNode) c.parentNode.removeChild(c);
};
window.__addCol = function (tileId, flex) {
  var host = document.getElementById("tile-host");
  var wrap = document.createElement("div");
  wrap.className = "epitaxy-column";
  wrap.setAttribute("data-test-col", tileId);
  wrap.style.flex = (flex === undefined ? 1 : flex) + " 1 0%";
  var shell = document.createElement("div");
  shell.className = "tiles-shell";
  shell.style.height = "100%";
  shell.innerHTML = '<div class="epitaxy-view-panel" data-pane-root="" data-test-tile="' + tileId +
    '"><div class="chrome-row"><button aria-label="Expand">E</button>' +
    '<button aria-label="Close" class="epitaxy-pane-close-control">X</button></div>' +
    '<div class="body">' + tileId + '</div></div>';
  wrap.appendChild(shell);
  host.appendChild(wrap);
  window.__wireTile(shell.firstChild, tileId);
  return wrap;
};
window.__reorderCols = function (order) {
  var host = document.getElementById("tile-host"), i, c;
  for (i = 0; i < order.length; i++) {
    c = window.__col(order[i]);
    if (c) host.appendChild(c);
  }
};
window.__mirror = function (sideTiles, sessionId, flexes) {
  flexes = flexes || {};
  var children = [{ kind: "tile", tileId: "chat", flex: flexes.chat === undefined ? 2 : flexes.chat }];
  for (var i = 0; i < sideTiles.length; i++) {
    children.push({ kind: "tile", tileId: sideTiles[i],
      flex: flexes[sideTiles[i]] === undefined ? 1 : flexes[sideTiles[i]] });
  }
  localStorage.setItem("epitaxy.sidePaneStore.v1", JSON.stringify({
    state: { tileLayout: { root: { kind: "stack", id: "s1", direction: "row", flex: 1,
      children: children } }, tileLayoutBySession: {},
      currentSessionId: sessionId || "local_a" }, version: 4 }));
};
`;

// THE NESTED SHAPE, measured live 2026-08-05 (session local_7c526730, 3 tabs):
//
//   row[ chat column, .tiles-handle, STACK[diff, .tiles-handle, terminal],
//        .tiles-handle, preview wrapper ]
//
// The row is display:flex;flex-direction:row and the stack
// display:flex;flex-direction:column. The measured live CHAT column holds no
// [data-pane-root] at all, which is why it can only be identified structurally -
// so this fixture reproduces that too, with the chat column carrying an empty
// .tiles-shell and no pane.
//
// Flexes are the measured ones: chat 1.04806, stack 0.951936, preview 1 at row
// level, and diff 3 / terminal 1 INSIDE the stack - the numbers that made summing
// leaves produce a meaningless side flex.
function nestedRow() {
  // 12px on the axis it divides, stretching on the other - as measured (the row's
  // dividers are 12x1146, the stack's is 843x12). The HEIGHT on the in-stack one is
  // load-bearing for the fixture: it is exactly the 12px that was pushing the bar
  // and the pane down on the terminal tab.
  const handle = (label, orient) =>
    `<div class="tiles-handle draggable-none hide-focus-ring" role="separator" ` +
    `aria-label="${label}"${orient ? ' aria-orientation="horizontal"' : ""} ` +
    `style="flex: 0 0 auto; ${orient ? "height: 12px" : "width: 12px"};"></div>`;
  const leaf = (t, flex) => `
    <div class="epitaxy-column" data-test-col="${t}" style="position:relative;flex: ${flex} 1 0%;">
      ${sideShell(t)}
    </div>`;
  return `
    <div class="epitaxy-column" data-test-col="chat" style="position:relative;flex: 1.04806 1 0%;">
      <div class="epitaxy-titlebar">titlebar</div>
      ${CHAT_SHELL}
    </div>
    ${handle("Resize 1 and 2")}
    <div data-test-stack="1" style="display:flex; flex-direction:column; flex: 0.951936 1 0%;">
      ${leaf("diff", 3)}
      ${handle("Resize 1 and 2", true)}
      ${leaf("terminal", 1)}
    </div>
    ${handle("Resize 2 and 3")}
    ${leaf("preview", 1)}`;
}

// tiles: the columns to render, chat first. opts.body is the scenario script.
// opts.wrap replaces the whole column row (for the degenerate-DOM scenarios).
// opts.page loads panel_tabs_page.js and seeds the mirror from `tiles`.
function fixture(tiles, opts) {
  opts = opts || {};
  const row = opts.wrap ? opts.wrap(paneHtml, tiles) : columnRow(tiles, opts.flexes);
  const sideTiles = tiles.filter((t) => t !== "chat");
  const seed = opts.page
    ? `window.__mirror(${JSON.stringify(opts.mirror || sideTiles)}, "local_a", ${JSON.stringify(opts.flexes || {})});`
    : "";
  const wireAll = `
[].forEach.call(document.querySelectorAll("[data-pane-root]"), function (p) {
  window.__wireTile(p, p.getAttribute("data-test-tile"), ${opts.noLayoutChange ? "true" : "false"});
});
${opts.extraSetup || ""}
${seed}`;
  return `<!doctype html><meta charset="utf-8">
<style>body{margin:0}
#tile-host{display:flex;position:relative;height:400px}
/* min-width:0 so a column respects its flex SHARE instead of refusing to go
   below its content's min-content width. Upstream's real columns behave this
   way (the pane scrolls internally); without it a fixture with many columns
   pushes the row wider than the viewport, which put the bar - and therefore the
   + and the expand control - off-screen and made the reachability probes
   measure fixture geometry rather than the bar. */
.epitaxy-column,.tiles-shell{min-width:0}</style>
<div id="tile-host">${row}</div>
<pre id="__result"></pre>
<script>${WIRING}</script>
<script>${wireAll}</script>
<script>${SRC("panel_tabs_layout.js")}</script>
<script>${SRC("panel_tabs_store.js")}</script>
<script>${SRC("panel_tabs_harvest.js")}</script>
${opts.page ? `<script>${SRC("panel_tabs_page.js")}</script>` : ""}
<script>${opts.body || ""}</script>`;
}

// Shorthand for the common "modules + page script + mirror seeded from tiles".
function withPage(tiles, body, opts) {
  return fixture(tiles, Object.assign({}, opts || {}, { page: true, body: body }));
}

// A single pane whose fiber ancestor chain is fully explicit, used to
// regression-guard the harvester's one remaining load-bearing rule: no hardcoded
// hop count. `chain` is an array of JS source snippets, each one ancestor's
// memoizedProps (or the literal "null"), ordered from the pane's OWN fiber node
// (hop 0) up through `.return`.
function chainFixture(tileId, chain, body) {
  const setup = `
(function () {
  var chain = [${chain.join(",\n")}];
  var node = null;
  for (var i = chain.length - 1; i >= 0; i--) node = { memoizedProps: chain[i], return: node };
  document.querySelector("[data-pane-root]")["__reactFiber$test"] = node;
})();
`;
  return `<!doctype html><meta charset="utf-8">
<div id="tile-host"><div class="tiles-shell">${paneHtml(tileId)}</div></div>
<pre id="__result"></pre>
<script>${WIRING}</script>
<script>${setup}</script>
<script>${SRC("panel_tabs_layout.js")}</script>
<script>${SRC("panel_tabs_store.js")}</script>
<script>${SRC("panel_tabs_harvest.js")}</script>
<script>${body}</script>`;
}

// budgetMs raises the virtual-time budget for scenarios that have to outlive a
// timer slower than the 2s default (the live loop's 5s pref poll).
function run(html, name, budgetMs) {
  const dir = mkdtempSync(join(tmpdir(), "cdb-tabs-"));
  const file = join(dir, "case.html");
  writeFileSync(file, html);
  try {
    const dom = execFileSync(CHROMIUM, ["--headless", "--disable-gpu", "--no-sandbox",
      "--virtual-time-budget=" + (budgetMs || 2000), "--dump-dom", "file://" + file], { encoding: "utf8" });
    const m = dom.match(/<pre id="__result">([\s\S]*?)<\/pre>/);
    if (!m) throw new Error("no #__result sink in dumped DOM for " + name);
    return JSON.parse(unescapeHtml(m[1]));
  } finally { if (!KEEP) rmSync(dir, { recursive: true, force: true }); }
}

let pass = 0, fail = 0, skipped = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); } };
// A skipped assertion is REPORTED, never silently passed: a suite that quietly tests
// nothing is worse than one that is honest about a gap.
const skip = (name, why) => { skipped++; console.log("  SKIP " + name + " -- " + why); };
// THE + MENU IS GONE (2026-08-06), not parked. The ADD_MENU_ENABLED flag, the nine
// blocks that used to skip on it, and the regex that read the flag out of the source
// are all deleted. What replaces them is a single assertion that the code cannot come
// back by accident - see "no opener surface" below.
// CODE ONLY, comments stripped. Both modules deliberately DOCUMENT what was removed
// and why, so a raw substring scan would match its own changelog and fail forever.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");
const PAGE_SRC = stripComments(readFileSync(join(ROOT, "js/panel_tabs_page.js"), "utf8"));
const HARVEST_SRC_TOP = stripComments(readFileSync(join(ROOT, "js/panel_tabs_harvest.js"), "utf8"));

const SINK = 'document.getElementById("__result").textContent = JSON.stringify';

// --- harvester ---------------------------------------------------------------
{
  const r = run(fixture(["chat", "terminal", "diff"], { body: `
    var H = window.__cdbTabsHarvest;
    var out = { panes: [], buttons: [] };
    var list = H.panes();
    for (var i = 0; i < list.length; i++) {
      out.panes.push(H.tileIdOf(list[i]));
      var b = H.chromeButtons(list[i]);
      out.buttons.push([!!b.expand, !!b.collapse, !!b.close]);
    }
    ${SINK}(out);` }), "harvest-basics");
  ok(JSON.stringify(r.panes) === '["chat","terminal","diff"]',
     "harvest: every pane root resolves its tileId from the fiber ancestor's memoizedProps");
  ok(JSON.stringify(r.buttons) === "[[true,false,true],[true,false,true],[true,false,true]]",
     "harvest: chrome-row controls resolve by aria-label (Expand present, Collapse absent, Close present)");
}
{
  const r = run(fixture(["chat", "diff"], { body: `
    var H = window.__cdbTabsHarvest;
    window.__setExpanded("diff", true);
    var b = H.chromeButtons(window.__paneOf("diff"));
    ${SINK}({ expand: !!b.expand, collapse: !!b.collapse });` }), "harvest-collapse-label");
  ok(r.expand === false && r.collapse === true,
     "harvest: once upstream flips the control to \"Collapse\" the harvester reports collapse, not expand");
}
{
  // The one load-bearing harvester rule left: never a hardcoded hop count.
  const r = run(chainFixture("deep-tile", [
    "null",
    '{ onLayoutChange: function () {} }',
    "{ someOtherProp: 1 }",
    "null",
    "{ unrelated: function () {} }",
    '{ tileId: "deep-tile" }'
  ], `
    var H = window.__cdbTabsHarvest;
    ${SINK}({ tid: H.tileIdOf(H.panes()[0]) });`), "harvest-deep-chain");
  ok(r.tid === "deep-tile",
     "harvest: tileId is found by SEARCHING ancestors, at any depth - never by a hardcoded hop count");
}
{
  const r = run(chainFixture("solo", ["null", "null", "null"], `
    var H = window.__cdbTabsHarvest;
    ${SINK}({ tid: H.tileIdOf(H.panes()[0]) });`), "harvest-no-tileid");
  ok(r.tid === null, "harvest: a chain with no tileId prop degrades to null rather than throwing");
}
{
  // Positive assertion of the v2 deletion: the write path is gone, so the exact-
  // name onLayoutChange resolution and the per-tileId handler cache that only
  // existed to survive an unmount are gone with it. Re-adding either would mean
  // the feature had gone back to writing upstream's layout.
  const r = run(fixture(["chat", "diff"], { body: `
    var H = window.__cdbTabsHarvest;
    ${SINK}({ keys: Object.keys(H).sort() });` }), "harvest-surface");
  ok(r.keys.indexOf("onLayoutChange") === -1 && r.keys.indexOf("harvestAll") === -1 &&
     r.keys.indexOf("cacheFor") === -1 && r.keys.indexOf("findPropByExactName") === -1,
     "harvest: no onLayoutChange, no harvestAll, no cacheFor - the layout-write path and the handler cache are gone");
  ok(JSON.stringify(r.keys) === '["chromeButtons","panes","tileIdOf"]',
     "harvest: the surface is THREE readers and nothing else - openActions, syntheticEvent and the whole Session actions/probe layer went with the + menu on 2026-08-06");
}

// --- no opener surface: the + menu cannot come back by accident ----------------
// Source-level, because the point is that the CODE is gone rather than merely unused.
// A flag or a dead function would have satisfied every behavioural assertion in this
// suite while still shipping the machinery the user asked to be removed.
{
  const banned = [
    ["ADD_MENU_ENABLED", "the parked-menu flag"],
    ["cdb-tabs-add", "the + button"],
    ["cdb-tabs-menu", "the popup"],
    ["data-cdb-probe-hidden", "the probe's attribute on <html>"],
    ["cdb-probe-style", "the probe's injected stylesheet"],
    ["scheduleAvailProbe", "the availability scheduler"],
    ["availMemo", "the availability cache"],
    ["menuitemcheckbox", "upstream's Session actions entries"],
    ["Session actions", "upstream's Session actions button"],
    ["openPanelViaSessionMenu", "the session-route opener"],
    ["probeSessionItems", "the probe itself"],
    ["pressPointer", "the synthesised pointer sequence"],
    ["syntheticEvent", "the synthesised React event"]
  ];
  const hits = banned.filter(([needle]) =>
    PAGE_SRC.indexOf(needle) !== -1 || HARVEST_SRC_TOP.indexOf(needle) !== -1);
  ok(hits.length === 0,
     "no opener surface: neither module mentions any of the 13 removed identifiers" +
     (hits.length ? " - still present: " + hits.map((h) => h[0]).join(", ") : ""));
  // And the harvester must stay READ-ONLY: nothing in it may synthesise input or
  // mutate the document. This is the invariant the probe used to break.
  const mutators = ["dispatchEvent", "document.head", "appendChild", "setAttribute", ".click("]
    .filter((m) => HARVEST_SRC_TOP.indexOf(m) !== -1);
  ok(mutators.length === 0,
     "no opener surface: the harvester never dispatches an event, appends a node, sets an attribute or clicks anything - it only reads" +
     (mutators.length ? " - found: " + mutators.join(", ") : ""));
}

// --- enable adopts the split that already exists -----------------------------
{
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    var before = { tagged: window.__taggedCols(), writes: window.__writes() };
    P.setEnabled(true);
    var res = P.reconcile();
    ${SINK}({ before: before, action: res.action, wrote: res.wrote,
      writes: window.__writes(), tabs: P.state().tabs, activeId: P.state().activeId,
      chatTag: window.__tag("chat"), tagged: window.__taggedCols(),
      active: window.__activeCol(), hidden: window.__hiddenCols(),
      activeCount: window.__activeColCount(),
      panesStillThere: [window.__paneOf("diff") !== null, window.__paneOf("terminal") !== null,
        window.__paneOf("preview") !== null] });`), "enable-adopts");
  ok(r.before.tagged.length === 0 && r.before.writes === 0,
     "enable: nothing is tagged and nothing is written before the feature is switched on");
  ok(r.action === "applied" && r.wrote === 0 && r.writes === 0,
     "enable: adopting the existing split issues ZERO layout writes");
  ok(JSON.stringify(r.tabs) === '["diff","terminal","preview"]',
     "enable: the tab strip is upstream's own side tiles, in upstream's own order");
  ok(JSON.stringify(r.tagged) === '["diff","terminal","preview"]',
     "enable: every side column is tagged with its tileId, in document order");
  ok(r.chatTag === null, "enable: the CHAT column is never tagged, so it can never be hidden");
  ok(r.activeCount === 1 && r.active === "diff",
     "enable: exactly one column is marked active - the first side tile, with nothing remembered yet");
  ok(JSON.stringify(r.hidden) === '["terminal","preview"]',
     "enable: every other side column is left for the display:none rule to hide");
  ok(JSON.stringify(r.panesStillThere) === "[true,true,true]",
     "enable: every panel is still MOUNTED - hiding is CSS, not an unmount");
}

// --- switching: attributes only, zero writes, panes stay mounted --------------
{
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile();
    var start = { active: window.__activeCol(), writes: window.__writes(),
      tagged: window.__taggedCols() };
    var okSwitch = P.activate("preview");
    var mid = { active: window.__activeCol(), writes: window.__writes(),
      tagged: window.__taggedCols(), hidden: window.__hiddenCols(),
      activeCount: window.__activeColCount(),
      panes: [window.__paneOf("diff") !== null, window.__paneOf("terminal") !== null,
        window.__paneOf("preview") !== null] };
    P.activate("terminal");
    P.activate("diff");
    ${SINK}({ start: start, okSwitch: okSwitch, mid: mid,
      finalActive: window.__activeCol(), writes: window.__writes(),
      stored: JSON.parse(localStorage.getItem("cdb.panelTabs.v2")).bySession.local_a,
      taggedUnchanged: JSON.stringify(window.__taggedCols()) === JSON.stringify(start.tagged) });`),
    "switch-attributes-only");
  ok(r.okSwitch === true && r.mid.active === "preview",
     "switch: activate() moves the active marker to the requested column");
  ok(r.mid.activeCount === 1, "switch: exactly one column is ever marked active");
  ok(JSON.stringify(r.mid.hidden) === '["diff","terminal"]',
     "switch: the columns that are not active carry the tag but not the active marker");
  ok(r.mid.writes === 0 && r.writes === 0,
     "switch: three tab switches issue ZERO layout writes - onLayoutChange is never called");
  ok(JSON.stringify(r.mid.panes) === "[true,true,true]",
     "switch: a hidden column's pane stays in the DOM (this is what preserves its React state)");
  ok(r.taggedUnchanged === true,
     "switch: the set of tagged columns does not change - only which one is marked active");
  ok(r.finalActive === "diff" && r.stored.activeId === "diff",
     "switch: the active tab is persisted under the v2 key and nothing else is");
}

// --- the mechanism's own CSS --------------------------------------------------
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile();
    var css = document.querySelector("style[data-cdb-tabs]").textContent;
    ${SINK}({
      hideRule: /\\[data-cdb-hide\\]\\{display:none !important\\}/.test(css),
      flexRule: /\\[data-cdb-side\\]\\{flex:var\\(--cdb-side-flex,1\\) 1 0% !important\\}/.test(css),
      fillRule: /\\[data-cdb-fill\\]\\{flex:1 1 0% !important\\}/.test(css),
      noLeafRules: css.indexOf("[data-cdb-col]") === -1 && css.indexOf("[data-cdb-col-active]") === -1,
      heightRule: css.indexOf(".cdb-tabs-bar + .tiles-shell{height:calc(100% - 34px) !important}") !== -1,
      hiddenWidth: window.__col("terminal").getBoundingClientRect().width,
      activeWidth: window.__col("diff").getBoundingClientRect().width,
      chatWidth: window.__col("chat").getBoundingClientRect().width,
      flexVar: document.documentElement.style.getPropertyValue("--cdb-side-flex"),
      sideFlex: P._sideFlex() });`), "mechanism-css");
  ok(r.hideRule === true,
     "css: one rule hides whatever the structural pass marked, with !important to beat upstream's inline style");
  ok(r.flexRule === true,
     "css: the ROW-LEVEL element on the active chain gets the side region's whole flex from a custom property");
  ok(r.fillRule === true,
     "css: an inner chain element simply fills its parent - it is the only visible child of it");
  ok(r.noLeafRules === true,
     "css: NO rule keys off the leaf wrappers any more - data-cdb-col is identity only, because the side region is a nested tree");
  ok(r.heightRule === true,
     "css: the shell height-compensation rule is unchanged");
  ok(r.hiddenWidth === 0, "css: a hidden column really measures 0px wide");
  ok(r.activeWidth > 0 && r.chatWidth > 0,
     "css: the active column and the chat column both keep real width");
  ok(Math.abs(r.sideFlex - 1) < 1e-9 && Math.abs(parseFloat(r.flexVar) - 1) < 1e-9,
     "css: the active branch's flex is chatFlex*(1-share)/share, i.e. what ONE panel gets in a two-pane split against chat (chat 2 : side 1)");
}
{
  // THE RATIO RULE. Flexes are read from INLINE flex-grow - upstream's own value,
  // which our stylesheet rule can never overwrite - falling back to the mirror.
  // The split is held as a PROPORTION, chatShare, and sideFlex is derived from it.
  const r = run(withPage(["chat", "diff", "terminal", "preview", "tasks"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile();
    var out = { fromDom: P._flex() };
    // OPENING A TAB must not move the boundary: only one panel is ever on screen,
    // so the side region's share cannot depend on how many are open.
    var FL = { chat: 1.0481, diff: 0.238, terminal: 0.238, preview: 0.238, tasks: 0.238, browser: 0.238 };
    window.__addCol("browser", 0.238);
    window.__mirror(["diff","terminal","preview","tasks","browser"], "local_a", FL);
    P.reconcile();
    out.afterOpen = P._flex();
    // UPSTREAM RENORMALISATION - the bug this rule exists for. Upstream rescaled
    // chat 1.198940 -> 2.0 for the same visual split; a DIFFERENCE collapsed toward
    // zero as chatFlex rose. Here chat's own flex is nearly doubled with nothing
    // else touched, exactly as measured.
    window.__col("chat").style.flex = "2.0 1 0%";
    out.afterRescale = P._flex();
    // ... and a UNIFORM rescale of everything, the other shape it takes.
    window.__col("chat").style.flex = "5.2405 1 0%";
    var cols = ["diff", "terminal", "preview", "tasks", "browser"], i, c;
    for (i = 0; i < cols.length; i++) { c = window.__col(cols[i]); if (c) c.style.flex = "1.19 1 0%"; }
    out.afterUniform = P._flex();
    ${SINK}(out);`,
    { flexes: { chat: 1.0481, diff: 0.238, terminal: 0.238, preview: 0.238, tasks: 0.238 } }),
    "flex-ratio-rule");
  const SHARE = 1.0481 / (1.0481 + 0.238);
  ok(Math.abs(r.fromDom.chatFlex - 1.0481) < 1e-9 &&
     Math.abs(r.fromDom.branchFlex - 0.238) < 1e-9 &&
     Math.abs(r.fromDom.chatShare - SHARE) < 1e-9,
     "ratio: the share is chatFlex/(chatFlex + the ACTIVE branch's flex), a two-pane proportion");
  ok(Math.abs(r.fromDom.sideFlex - 0.238) < 1e-9 &&
     Math.abs(r.fromDom.boundary - SHARE) < 1e-9,
     "ratio: sideFlex is chatFlex*(1-share)/share, so the boundary IS the share");
  ok(Math.abs(r.afterOpen.chatShare - SHARE) < 1e-9 &&
     Math.abs(r.afterOpen.boundary - SHARE) < 1e-9,
     "ratio: opening a FIFTH panel moves neither the share nor the boundary - chat does not shrink as tabs are added");
  ok(Math.abs(r.afterRescale.chatFlex - 2.0) < 1e-9 &&
     Math.abs(r.afterRescale.chatShare - SHARE) < 1e-9 &&
     Math.abs(r.afterRescale.boundary - SHARE) < 1e-9 &&
     r.afterRescale.sideFlex > r.fromDom.sideFlex,
     "ratio: upstream rescaling chatFlex 1.0481 -> 2.0 leaves the BOUNDARY untouched - sideFlex grows with it, which a TOTAL-minus-chatFlex difference could not do");
  ok(Math.abs(r.afterUniform.boundary - SHARE) < 1e-9,
     "ratio: a uniform rescale of every row flex leaves the boundary untouched too - that is what invariance under rescaling means");
}
{
  // Reload: a persisted share is adopted, a nonsensical one discarded and
  // recaptured - never clamped. And the retired `total` field must NEVER be read as
  // a share: 2.000003 is not a proportion.
  const seed = (entry) => `localStorage.setItem("cdb.panelTabs.v2", JSON.stringify({
    version: 2, bySession: { local_a: ${entry} } }));`;
  const body = `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile();
    ${SINK}({ flex: P._flex(),
      stored: JSON.parse(localStorage.getItem("cdb.panelTabs.v2")).bySession.local_a,
      chatW: Math.round(window.__col("chat").getBoundingClientRect().width) });`;
  const F = { flexes: { chat: 1.0481, diff: 0.238, terminal: 0.238 } };
  const captured = 1.0481 / (1.0481 + 0.238);

  let r = run(withPage(["chat", "diff", "terminal"], body,
    Object.assign({ extraSetup: seed('{ activeId: "terminal", chatShare: 0.4 }') }, F)),
    "flex-share-reload");
  ok(Math.abs(r.flex.chatShare - 0.4) < 1e-9 && Math.abs(r.flex.boundary - 0.4) < 1e-9,
     "reload: a persisted share is adopted as-is, so a reload does not jump the boundary");
  ok(Math.abs(r.stored.chatShare - 0.4) < 1e-9 && r.stored.activeId === "terminal",
     "reload: it stays persisted alongside activeId");

  // The retired field, exactly as it exists in real users' localStorage today.
  r = run(withPage(["chat", "diff", "terminal"], body,
    Object.assign({ extraSetup: seed('{ activeId: "terminal", total: 2.000003 }') }, F)),
    "flex-share-migrate-total");
  ok(Math.abs(r.flex.chatShare - captured) < 1e-9,
     "migration: a stored `total` is NOT read as a share - the share is recaptured from the live layout instead");
  ok(r.stored.total === undefined && Math.abs(r.stored.chatShare - captured) < 1e-9,
     "migration: and the next write DROPS the retired field rather than carrying it forever");

  [["null", "null"], ["0", "zero"], ["1", "exactly 1"], ["1.4", "above 1"],
   ["-0.3", "negative"], ['"0.4"', "a string"], ["1e999", "Infinity"]].forEach(([v, why]) => {
    const rr = run(withPage(["chat", "diff", "terminal"], body,
      Object.assign({ extraSetup: seed('{ activeId: "terminal", chatShare: ' + v + " }") }, F)),
      "flex-share-bad-" + why);
    ok(Math.abs(rr.flex.chatShare - captured) < 1e-9,
       "reload: a stored share of " + why + " is DISCARDED and recaptured from the live layout, not clamped");
  });
}
{
  // THE DRAG DISCRIMINATOR. A pointer gesture on the kept chat<->side handle IS the
  // user choosing a proportion, so it re-captures. A chatFlex change with no gesture
  // is upstream renormalising and must NOT.
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile();
    var chat = window.__col("chat");
    var stack = document.querySelector("[data-test-stack]");
    var out = { start: P._flex() };
    // (1) no gesture: upstream renormalises chat AND the adjacent branch, exactly
    // the non-uniform shape measured live (share 0.599 -> 0.667 if we believed it).
    chat.style.flex = "2.0 1 0%"; stack.style.flex = "1.0 1 0%";
    P.reconcile();
    out.renorm = P._flex();
    // (2) the same numbers, but framed by a real pointer gesture on the handle.
    out.armed = P._drag("down");
    out.duringDrag = P._flex();
    out.stillArmed = P._drag("up");
    out.afterDrag = P._flex();
    out.stored = JSON.parse(localStorage.getItem("cdb.panelTabs.v2")).bySession.local_a;
    // (3) a gesture during which the row's child set changes is NOT a clean drag.
    P._forgetShare(); P.reconcile();
    var base = P._flex();
    P._drag("down");
    window.__addCol("tasks", 1);
    chat.style.flex = "4.0 1 0%";
    P._drag("up");
    out.dirtyGesture = P._flex();
    out.baseShare = base.chatShare;
    ${SINK}(out);`,
    { wrap: () => nestedRow(), mirror: ["diff", "terminal", "preview"] }),
    "flex-drag-discriminator");
  const START = 1.04806 / (1.04806 + 0.951936);
  ok(Math.abs(r.start.chatShare - START) < 1e-9, "drag: the share starts at the captured two-pane proportion");
  ok(Math.abs(r.renorm.chatShare - START) < 1e-9 && Math.abs(r.renorm.boundary - START) < 1e-9,
     "drag: a chatFlex/branch rescale with NO pointer gesture is a renormalisation - the share is held and the boundary does not move");
  ok(r.armed === true && r.stillArmed === false,
     "drag: a pointerdown on the kept handle arms the discriminator and a pointerup disarms it");
  ok(Math.abs(r.duringDrag.sideFlex - 1.0) < 1e-9,
     "drag: WHILE armed the side flex mirrors upstream's own adjacent-branch flex, so the divider tracks the pointer instead of being pinned by our ratio");
  ok(Math.abs(r.afterDrag.chatShare - 2.0 / 3.0) < 1e-9 &&
     Math.abs(r.afterDrag.boundary - 2.0 / 3.0) < 1e-9,
     "drag: pointerup re-captures the share from upstream's own chat:adjacent pair (2.0 : 1.0), which is the proportion the user chose");
  ok(Math.abs(r.stored.chatShare - 2.0 / 3.0) < 1e-9,
     "drag: and the released position is persisted, so it sticks");
  ok(Math.abs(r.dirtyGesture.chatShare - r.baseShare) < 1e-9,
     "drag: a gesture during which a branch appears is NOT treated as a clean drag - both signals are required, not either");
}

// --- never hide the chat column, never hide every side column -----------------
{
  const r = run(withPage(["chat", "diff"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile();
    ${SINK}({ tagged: window.__taggedCols(), active: window.__activeCol(),
      hidden: window.__hiddenCols(), chatTag: window.__tag("chat"),
      chatWidth: window.__col("chat").getBoundingClientRect().width,
      diffWidth: window.__col("diff").getBoundingClientRect().width,
      writes: window.__writes() });`), "single-side-column");
  ok(JSON.stringify(r.hidden) === "[]" && r.active === "diff",
     "safety: with one side column it is the active one - we never hide every side column");
  ok(r.chatTag === null && r.chatWidth > 0 && r.diffWidth > 0,
     "safety: the chat column is untagged and both columns are visible");
  ok(r.writes === 0, "safety: still zero layout writes");
}
{
  // A wrapper that holds BOTH the chat pane and a side pane is refused outright:
  // tagging it would hide chat. The degraded state is the stock split.
  const r = run(withPage(["chat", "diff"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true);
    var res = P.reconcile();
    P.renderBar();
    ${SINK}({ action: res.action, tagged: window.__taggedCols(), bar: P.barEl() !== null,
      writes: window.__writes(), warns: window.__cdbTabsWarnCount || 0,
      chatVisible: document.querySelector('[data-test-col="shared"]').getBoundingClientRect().width > 0 });`,
    { wrap: (pane) => `
      <div class="epitaxy-column" data-test-col="shared" style="flex: 1 1 0%;">
        <div class="tiles-shell" style="height:100%">${pane("chat")}${pane("diff")}</div>
      </div>` }), "shared-chat-column");
  ok(JSON.stringify(r.tagged) === "[]",
     "safety: a column wrapper that also holds the chat pane is never tagged");
  ok(r.action === "no-columns" && r.bar === false,
     "safety: with no taggable column there is no bar at all - the degraded state is the stock split");
  ok(r.writes === 0 && r.warns === 1,
     "safety: it warns and touches nothing (no layout write of any kind)");
  ok(r.chatVisible === true, "safety: the shared column stays visible");
}
{
  // A side pane with no .tiles-shell ancestor: nothing to resolve, so nothing is
  // touched (§7 failure rule).
  const r = run(withPage(["chat", "diff"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true);
    var res = P.reconcile();
    P.renderBar();
    ${SINK}({ action: res.action, tabs: P.state().tabs, sidePanes: P.state().sidePanes,
      bar: P.barEl() !== null, writes: window.__writes(),
      warns: window.__cdbTabsWarnCount || 0, style: !!document.querySelector("style[data-cdb-tabs]") });`,
    { wrap: (pane) => `
      <div class="epitaxy-column" data-test-col="chat" style="flex: 1 1 0%;">
        ${pane("chat")}<div class="tiles-shell"></div>
      </div>
      <div class="no-shell-here">${pane("diff")}</div>` }), "no-shell-wrapper");
  ok(r.sidePanes === 1 && JSON.stringify(r.tabs) === "[]",
     "degradation: a side pane with no .tiles-shell yields no column and therefore no tab");
  ok(r.action === "no-columns" && r.bar === false && r.style === false,
     "degradation: no bar, no stylesheet - nothing is touched");
  ok(r.writes === 0 && r.warns === 1, "degradation: it warns once - exactly once - and writes nothing");
}

// --- the active id resolves after upstream closes or reorders tiles -----------
{
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile();
    P.activate("terminal");
    var before = { active: window.__activeCol(), tabs: P.state().tabs };
    // Upstream closes the ACTIVE tile: its column leaves the DOM and the layout.
    window.__dropCol("terminal");
    window.__mirror(["diff", "preview"]);
    var res = P.reconcile();
    var afterClose = { action: res.action, active: window.__activeCol(),
      tabs: P.state().tabs, hidden: window.__hiddenCols() };
    // Upstream reorders the remaining tiles (a tile drag in its own UI).
    window.__mirror(["preview", "diff"]);
    window.__reorderCols(["preview", "diff"]);
    P.reconcile();
    ${SINK}({ before: before, afterClose: afterClose, reorderedTabs: P.state().tabs,
      activeAfterReorder: window.__activeCol(), writes: window.__writes() });`),
    "resolve-after-close-and-reorder");
  ok(r.before.active === "terminal", "resolve: the switch landed before upstream changed anything");
  ok(r.afterClose.active === "diff" && JSON.stringify(r.afterClose.tabs) === '["diff","preview"]',
     "resolve: an active id naming a tile upstream has closed falls back to the layout's first side tile");
  ok(JSON.stringify(r.reorderedTabs) === '["preview","diff"]',
     "resolve: tab ORDER follows upstream's layout child order, so a tile drag in upstream's UI reorders the tabs");
  ok(r.activeAfterReorder === "diff",
     "resolve: a reorder does not move the active tab - only the strip's order changes");
  ok(r.writes === 0, "resolve: neither a close nor a reorder makes us write the layout");
}
{
  // The mirror is written on a ~1s debounce, so it can still list a tile whose
  // column is already gone. A tile with no column at all is not a tab.
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile();
    window.__dropCol("terminal");            // gone from the DOM...
    var res = P.reconcile();                 // ...but the mirror still lists it
    ${SINK}({ mirrorSide: window.__cdbTabsLayout.sideTileIds(
        JSON.parse(localStorage.getItem("epitaxy.sidePaneStore.v1")).state.tileLayout.root),
      tabs: P.state().tabs, action: res.action, writes: window.__writes() });`),
    "stale-mirror-tile");
  ok(JSON.stringify(r.mirrorSide) === '["diff","terminal"]',
     "stale mirror: the mirror still lists the closed tile (this is the ~1s debounce)");
  ok(JSON.stringify(r.tabs) === '["diff"]',
     "stale mirror: a tile with no column is dropped from the strip rather than left as a dead chip");
  ok(r.writes === 0, "stale mirror: still no layout write");
}
{
  // A panel the user just opened: its column is in the DOM a frame before the
  // mirror knows about it. It gets a tab immediately AND becomes active - opening
  // a panel that stayed hidden would be a dead-end.
  const r = run(withPage(["chat", "diff"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile();
    window.__addCol("terminal");              // mirror deliberately NOT updated
    var res = P.reconcile();
    var fresh = { tabs: P.state().tabs, active: window.__activeCol(), action: res.action };
    window.__mirror(["diff", "terminal"]);    // the mirror catches up
    P.reconcile();
    ${SINK}({ fresh: fresh, settledTabs: P.state().tabs, settledActive: window.__activeCol(),
      writes: window.__writes() });`), "fresh-column-union");
  ok(JSON.stringify(r.fresh.tabs) === '["diff","terminal"]',
     "fresh column: a column present in the DOM but not yet in the debounced mirror still gets a tab");
  ok(r.fresh.active === "terminal",
     "fresh column: a panel the user just opened becomes the active tab");
  ok(JSON.stringify(r.settledTabs) === '["diff","terminal"]' && r.settledActive === "terminal",
     "fresh column: nothing moves when the mirror catches up");
  ok(r.writes === 0, "fresh column: opening a panel makes us write nothing - upstream's opener did it all");
}
{
  // Upstream unmounts every OTHER pane while one tile is expanded. Our own tag on
  // the column wrapper is what keeps those tabs from vanishing for the duration.
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile();
    window.__setExpanded("diff", true);
    window.__unmountPane("terminal");
    window.__unmountPane("preview");
    var res = P.reconcile();
    var expanded = { tabs: P.state().tabs, columns: P.state().columns,
      active: window.__activeCol(), hidden: window.__hiddenCols() };
    // A tag on a wrapper upstream has REUSED (the mirror no longer lists it) is
    // not allowed to keep a phantom tab alive.
    window.__mirror(["diff", "terminal"]);
    P.reconcile();
    ${SINK}({ expanded: expanded, afterMirrorDrop: P.state().tabs, writes: window.__writes() });`),
    "expanded-unmount-keeps-tabs");
  ok(JSON.stringify(r.expanded.tabs) === '["diff","terminal","preview"]',
     "expanded: a tagged column whose pane upstream unmounted keeps its tab while the layout still lists the tile");
  ok(JSON.stringify(r.expanded.columns) ===
     '[{"tileId":"diff","mounted":true},{"tileId":"terminal","mounted":false},{"tileId":"preview","mounted":false}]',
     "expanded: those columns are tracked as unmounted, not as gone");
  ok(r.expanded.active === "diff" && JSON.stringify(r.expanded.hidden) === '["terminal","preview"]',
     "expanded: the expanded tile stays active and the rest stay hidden");
  ok(JSON.stringify(r.afterMirrorDrop) === '["diff","terminal"]',
     "expanded: a paneless tag the layout no longer lists is dropped, so a reused wrapper cannot leave a phantom tab");
  ok(r.writes === 0, "expanded: expanding writes nothing");
}

// --- closing ----------------------------------------------------------------
{
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile();
    // The ACTIVE tab (diff) is closed through our own ✕.
    var res = P.closeTab("diff");
    var afterActive = { res: res, close: window.__calls.close.slice(),
      stored: JSON.parse(localStorage.getItem("cdb.panelTabs.v2")).bySession.local_a };
    // And an INACTIVE (display:none) tab: its own Close control is in the DOM
    // because the panel is mounted, and a programmatic click still fires.
    window.__dropCol("diff"); window.__mirror(["terminal", "preview"]);
    P.reconcile();
    var activeNow = window.__activeCol();
    var res2 = P.closeTab("preview");
    ${SINK}({ afterActive: afterActive, activeNow: activeNow, res2: res2,
      close: window.__calls.close, writes: window.__writes(),
      hiddenWidthAtClose: window.__col("preview").getBoundingClientRect().width });`),
    "close-clicks-own-control");
  ok(r.afterActive.res.closed === true && r.afterActive.res.via === "click",
     "close: closing a tab is a direct click on that pane's own Close control");
  ok(JSON.stringify(r.afterActive.close) === '[["diff","click"]]',
     "close: it is a NATIVE click, not a re-invoked React onClick prop (no cached handler machinery left)");
  ok(r.afterActive.stored.activeId === "terminal",
     "close: closing the ACTIVE tab hands the slot to its left neighbour, else the right one");
  ok(r.activeNow === "terminal" && r.res2.closed === true,
     "close: an INACTIVE tab closes too");
  ok(r.hiddenWidthAtClose === 0,
     "close: that tab's column really was display:none (0px wide) when its button was clicked");
  ok(JSON.stringify(r.close) === '[["diff","click"],["preview","click"]]',
     "close: display:none does not prevent a programmatic .click() - which is what retired the cached-handler path");
  ok(r.writes === 0, "close: closing writes nothing - upstream's own close owns the transition");
}
{
  const r = run(withPage(["chat", "diff"], `
    var P = window.__cdbTabsPage;
    var disabled = P.closeTab("diff");
    P.setEnabled(true); P.reconcile();
    var empty = P.closeTab("");
    var unknown = P.closeTab("nope");
    ${SINK}({ disabled: disabled, empty: empty, unknown: unknown,
      close: window.__calls.close, writes: window.__writes() });`), "close-refusals");
  ok(r.disabled.closed === false && r.empty.closed === false && r.unknown.closed === false,
     "close: refused while disabled, with no tileId, and for a tileId that has no column");
  ok(JSON.stringify(r.close) === "[]" && r.writes === 0,
     "close: a refusal clicks nothing and writes nothing");
}

// --- the bar ------------------------------------------------------------------
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    var bar = P.barEl();
    var tabs = bar.querySelectorAll('[role="tab"]');
    ${SINK}({
      role: bar.getAttribute("role"), label: bar.getAttribute("aria-label"),
      tabLabels: [].map.call(tabs, function (t) { return t.textContent; }),
      selected: [].map.call(tabs, function (t) { return t.getAttribute("aria-selected"); }),
      closeLabels: [].map.call(bar.querySelectorAll(".cdb-tabs-close"),
        function (b) { return b.getAttribute("aria-label"); }),
      expandLabel: bar.querySelector("[data-cdb-expand]").getAttribute("aria-label"),
      order: [].map.call(bar.children, function (n) { return n.className; }),
      hostIsActiveColumn: bar.parentElement === window.__col("diff"),
      nextIsShell: bar.nextElementSibling === window.__col("diff").querySelector(".tiles-shell"),
      writes: window.__writes() });`), "bar-markup");
  ok(r.role === "tablist" && r.label === "Side panels",
     "bar: role=\"tablist\" semantics are unchanged");
  ok(JSON.stringify(r.tabLabels) === '["Diff","Terminal"]',
     "bar: one chip per side tile, labelled from the tileId->kind map");
  ok(JSON.stringify(r.selected) === '["true","false"]',
     "bar: aria-selected tracks the active tab");
  ok(JSON.stringify(r.closeLabels) === '["Close Diff","Close Terminal"]',
     "bar: every chip carries its own ✕ with a per-tab accessible name");
  ok(r.expandLabel === "Expand",
     "bar: the ⤢ is rendered with its state-tracking accessible name");
  ok(JSON.stringify(r.order) === '["cdb-tabs-strip","cdb-tabs-sep","cdb-tabs-expand"]',
     "bar: EXACTLY three children - the chip SCROLLER, a 1px separator, then ⤢ as a non-shrinking sibling. The + is gone, and this pins the whole bar so it cannot come back");
  ok(r.hostIsActiveColumn === true && r.nextIsShell === true,
     "bar: it mounts INSIDE the active column, immediately before that column's shell - so the height rule applies");
  ok(r.writes === 0, "bar: rendering writes nothing");
}
{
  // THE re-parent property. The bar is the SAME node after a switch (so the one
  // delegated listener survives), it moves into the new active column, and a
  // click landing immediately after the move still works.
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    var bar1 = P.barEl();
    bar1.setAttribute("data-identity", "original");
    var firstHost = bar1.parentElement === window.__col("diff");
    P.activate("terminal"); P.renderBar();
    var bar2 = P.barEl();
    var moved = { same: bar2 === bar1, identity: bar2.getAttribute("data-identity"),
      host: bar2.parentElement === window.__col("terminal"),
      nextIsShell: bar2.nextElementSibling === window.__col("terminal").querySelector(".tiles-shell") };
    // A click dispatched at the delegated listener's node RIGHT AFTER the
    // re-parent must still register.
    bar2.querySelector('[data-cdb-tab="preview"]').click();
    var afterClick = { active: window.__activeCol(),
      host: P.barEl().parentElement === window.__col("preview"),
      same: P.barEl() === bar1 };
    ${SINK}({ firstHost: firstHost, moved: moved, afterClick: afterClick,
      writes: window.__writes() });`), "bar-reparent");
  ok(r.firstHost === true, "reparent: the bar starts in the first active column");
  ok(r.moved.same === true && r.moved.identity === "original",
     "reparent: switching re-parents the SAME node - identity is preserved, so its listener is too");
  ok(r.moved.host === true && r.moved.nextIsShell === true,
     "reparent: it lands inside the new active column, still immediately before that column's shell");
  ok(r.afterClick.active === "preview" && r.afterClick.same === true,
     "reparent: the single delegated click listener still works after the re-parent");
  ok(r.afterClick.host === true, "reparent: and the bar follows again");
  ok(r.writes === 0, "reparent: no layout writes anywhere in this sequence");
}
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    var bar = P.barEl();
    var out = { switched: null, closed: null };
    bar.querySelector('[data-cdb-tab="terminal"]').click();
    out.switched = [window.__activeCol(),
      [].map.call(bar.querySelectorAll('[role="tab"]'),
        function (t) { return t.getAttribute("aria-selected"); })];
    P.barEl().querySelector('[data-cdb-close="diff"]').click();
    out.closed = window.__calls.close.slice();
    ${SINK}(Object.assign(out, { writes: window.__writes() }));`), "bar-delegated-clicks");
  ok(r.switched[0] === "terminal" && JSON.stringify(r.switched[1]) === '["false","true"]',
     "bar: clicking a chip switches the column and moves aria-selected");
  ok(JSON.stringify(r.closed) === '[["diff","click"]]',
     "bar: clicking a chip's ✕ clicks that pane's own Close control");
  ok(r.writes === 0, "bar: neither click writes the layout");
}
{
  // No side panel open at all: no tabs, no bar, nothing tagged. (The ordinary
  // state of a Code session, so it must also be silent.)
  const r = run(withPage(["chat"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true);
    var res = P.reconcile();
    var bar = P.renderBar();
    ${SINK}({ action: res.action, tabs: P.state().tabs, bar: bar,
      tagged: window.__taggedCols(), writes: window.__writes(),
      warns: window.__cdbTabsWarnCount || 0 });`), "chat-only");
  ok(r.action === "no-columns" && JSON.stringify(r.tabs) === "[]" && r.bar === null,
     "chat-only: no side column means no tabs and no bar");
  ok(JSON.stringify(r.tagged) === "[]" && r.writes === 0,
     "chat-only: nothing is tagged and nothing is written");
  ok(r.warns === 0, "chat-only: and it is SILENT - having no side panel open is not a failure");
}

// --- the ⤢ -------------------------------------------------------------------
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    var btn = function () { return P.barEl().querySelector("[data-cdb-expand]"); };
    var beforeLabel = btn().getAttribute("aria-label");
    btn().click();
    var afterExpandClick = window.__calls.expand.slice();
    // Upstream flips its own control's label once expandedTile is set.
    window.__setExpanded("diff", true);
    P.renderBar();
    var expandedLabel = btn().getAttribute("aria-label");
    btn().click();
    ${SINK}({ beforeLabel: beforeLabel, afterExpandClick: afterExpandClick,
      expandedLabel: expandedLabel, calls: window.__calls.expand,
      writes: window.__writes() });`), "expand-toggle");
  ok(r.beforeLabel === "Expand",
     "⤢: the accessible name is \"Expand\" while the active panel is collapsed");
  ok(JSON.stringify(r.afterExpandClick) === '[["diff","Expand"]]',
     "⤢: it clicks upstream's own Expand button on the active pane - a native click, not a stale harvested closure");
  ok(r.expandedLabel === "Collapse",
     "⤢: once upstream's control reads \"Collapse\" so does ours - the name always matches what the click will do");
  ok(JSON.stringify(r.calls) === '[["diff","Expand"],["diff","Collapse"]]',
     "⤢: the second click fires COLLAPSE - one control toggles both ways, which is what pays for hiding upstream's pair");
  ok(r.writes === 0, "⤢: expanding and collapsing write nothing");
}
// --- NESTED structure: the side region is a tree, not a flat row ---------------
// The shape and the flexes here are the ones measured live 2026-08-05. v2 tagged
// LEAF wrappers, which left the branch above a hidden leaf occupying its own flex
// share: a dead gap, a chat/side ratio that moved with the tab, and a bar/pane
// pushed 12px down by the stack's own handle. Everything below is that class of
// defect, asserted structurally.
{
  const NESTED = { wrap: () => nestedRow(), mirror: ["diff", "terminal", "preview"] };
  const probe = `
    function boxes() {
      var row = document.querySelector("[data-cdb-row]") || document.getElementById("tile-host");
      var out = [], i, c, r;
      for (i = 0; i < row.children.length; i++) {
        c = row.children[i]; r = c.getBoundingClientRect();
        out.push({ w: Math.round(r.width), hide: c.hasAttribute("data-cdb-hide"),
          side: c.hasAttribute("data-cdb-side"),
          handle: c.classList.contains("tiles-handle"),
          stack: c.getAttribute("data-test-stack") === "1",
          col: c.getAttribute("data-test-col"),
          // A visible box that contains no VISIBLE pane is the dead-gap defect.
          visiblePanes: (function () {
            var p = c.querySelectorAll("[data-pane-root]"), n = 0, j;
            for (j = 0; j < p.length; j++) if (p[j].getBoundingClientRect().width > 0) n++;
            return n;
          })() });
      }
      return out;
    }
    function stackKids() {
      var s = document.querySelector("[data-test-stack]"), out = [], i, c;
      for (i = 0; i < s.children.length; i++) {
        c = s.children[i];
        out.push({ handle: c.classList.contains("tiles-handle"),
          col: c.getAttribute("data-test-col"), hide: c.hasAttribute("data-cdb-hide"),
          fill: c.hasAttribute("data-cdb-fill"), side: c.hasAttribute("data-cdb-side"),
          w: Math.round(c.getBoundingClientRect().width) });
      }
      return out;
    }
    // _structure() is deliberately optional here: the geometry assertions below are
    // the ones that describe the DEFECT, and they must fail cleanly against a build
    // that has no structural pass at all rather than abort the whole run.
    function shot() {
      var barEl = P.barEl(), shell = barEl ? barEl.nextElementSibling : null;
      var st = P._structure ? P._structure()
        : { row: null, rowFound: false, chain: [], rowChildren: [] };
      return { active: window.__activeCol(), boxes: boxes(), stackKids: stackKids(),
        struct: st, sideFlex: P._sideFlex(), flex: P._flex ? P._flex() : {},
        flexVar: document.documentElement.style.getPropertyValue("--cdb-side-flex"),
        chatW: Math.round(window.__col("chat").getBoundingClientRect().width),
        barY: barEl ? Math.round(barEl.getBoundingClientRect().top) : null,
        shellH: shell ? Math.round(shell.getBoundingClientRect().height) : null };
    }`;
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    ${probe}
    var out = {};
    out.diff = shot();
    P.activate("terminal"); P.renderBar(); out.terminal = shot();
    P.activate("preview"); P.renderBar(); out.preview = shot();
    P.activate("diff"); P.renderBar(); out.backToDiff = shot();
    out.writes = window.__writes();
    out.warns = window.__cdbTabsWarnCount || 0;
    ${SINK}(out);`, NESTED), "nested-structure");

  const tabsOf = ["diff", "terminal", "preview"].map((t) => r[t]);
  // --- the chain and the marks
  const ch = (s, i) => (s.struct.chain[i] || {});
  ok(r.diff.struct.rowFound === true && r.diff.struct.chain.length === 2 &&
     r.preview.struct.chain.length === 1,
     "nested: the chain is resolved to its real depth - two elements for a tile inside the stack, one for a row-level tile");
  ok(ch(r.diff, 0).side === true && ch(r.diff, 0).fill === false &&
     ch(r.diff, 1).side === false && ch(r.diff, 1).fill === true,
     "nested: the ROW-LEVEL chain element carries the side flex and the inner one does not - it just fills its parent");
  ok(ch(r.preview, 0).side === true && ch(r.preview, 0).col === "preview",
     "nested: for a row-level tile the leaf IS the row-level element, so it carries the side flex itself");
  ok(!!r.diff.struct.row && r.diff.struct.row.row === true && r.diff.struct.row.side === false,
     "nested: the row itself is marked but never given a flex of ours - it is upstream's own container");
  // --- defect 1: no dead gap
  ok(tabsOf.every((s) => s.boxes.every((b) => b.w === 0 || b.visiblePanes > 0 || b.handle ||
       b.col === "chat")),
     "nested: no visible box in the row contains zero visible panes - the dead gap is gone");
  ok(r.preview.boxes.filter((b) => b.stack)[0].w === 0 &&
     r.preview.boxes.filter((b) => b.stack)[0].hide === true,
     "nested: with a row-level tile active the whole STACK branch is hidden, not just its leaves");
  ok(r.diff.boxes.filter((b) => b.col === "preview")[0].hide === true &&
     r.terminal.boxes.filter((b) => b.col === "preview")[0].hide === true,
     "nested: and with a tile inside the stack active the sibling row-level branch is hidden");
  // --- defect 2: the chat/side ratio does not move
  ok(r.diff.chatW === r.terminal.chatW && r.diff.chatW === r.preview.chatW && r.diff.chatW > 0,
     "nested: the CHAT width is identical on every tab - the side flex lands on the row-level element whatever the depth");
  const NESTED_SHARE = 1.04806 / (1.04806 + 0.951936);   // chat vs the STACK alone
  ok(tabsOf.every((s) => Math.abs(s.sideFlex - r.diff.sideFlex) < 1e-9) &&
     Math.abs(r.diff.sideFlex - 0.951936) < 1e-12,
     "nested: the side flex is chatFlex*(1-share)/share for a TWO-pane split, not the sum over all four branches");
  ok(tabsOf.every((s) => Math.abs(s.flex.chatShare - NESTED_SHARE) < 1e-9),
     "nested: the share is chatFlex/(chatFlex + the ACTIVE branch's flex) - a proportion of a two-pane split, not of all four");
  ok(Math.abs(r.preview.flex.branchFlex - 1) < 1e-9 &&
     Math.abs(r.preview.flex.chatShare - NESTED_SHARE) < 1e-9,
     "nested: switching to a branch whose OWN flex is 1 does not move the share - it is held per session, which is what keeps the side width uniform");
  // --- defects 3 and 4: handles inside the stack
  ok(r.diff.stackKids.filter((k) => k.handle).every((k) => k.hide === true) &&
     r.terminal.stackKids.filter((k) => k.handle).every((k) => k.hide === true),
     "nested: every handle INSIDE a chain stack is hidden - only one child of it is ever visible, so they can only drag a hidden box");
  ok(r.diff.barY === r.terminal.barY && r.diff.barY === r.preview.barY,
     "nested: the bar sits at the same y on every tab - the stack's own handle no longer pushes it down 12px");
  ok(r.diff.shellH === r.terminal.shellH && r.diff.shellH === r.preview.shellH &&
     r.diff.shellH > 0,
     "nested: pane heights are identical across tabs, and the bar's height compensation still lands");
  // --- the chat<->side divider
  ok(tabsOf.every((s) => {
       const h = s.boxes.filter((b) => b.handle);
       return h.length === 2 && h[0].hide === false && h[1].hide === true;
     }),
     "nested: exactly ONE row handle survives - the chat<->side divider after the chat column - and the between-branches one is hidden");
  ok(tabsOf.every((s) => s.boxes.filter((b) => b.col === "chat")[0].hide === false &&
       s.boxes.filter((b) => b.col === "chat")[0].w > 0),
     "nested: the chat column is never hidden - it holds no side pane, so it cannot be");
  // --- and none of it writes
  ok(r.writes === 0 && r.warns === 0,
     "nested: four switches through a nested tree write ZERO layout and warn not at all");
  ok(r.backToDiff.chatW === r.diff.chatW &&
     JSON.stringify(r.backToDiff.stackKids) === JSON.stringify(r.diff.stackKids),
     "nested: switching away and back is exactly reversible - the marks are diffed, not accumulated");
}
{
  // The FLAT row still has to work: it is the shape every other scenario uses and
  // the shape a single-panel session has. Same assertions, no stack.
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    var s = P._structure ? P._structure() : { rowFound: false, chain: [{}] };
    ${SINK}({ rowFound: s.rowFound, depth: s.chain.length, side: s.chain[0].side,
      fill: s.chain[0].fill, rowIsHost: document.getElementById("tile-host").hasAttribute("data-cdb-row"),
      terminalHidden: window.__col("terminal").hasAttribute("data-cdb-hide"),
      chatHidden: window.__col("chat").hasAttribute("data-cdb-hide"),
      chatW: Math.round(window.__col("chat").getBoundingClientRect().width),
      diffW: Math.round(window.__col("diff").getBoundingClientRect().width),
      terminalW: Math.round(window.__col("terminal").getBoundingClientRect().width),
      sideFlex: P._sideFlex(), writes: window.__writes() });`), "flat-row-still-works");
  ok(r.rowFound === true && r.rowIsHost === true && r.depth === 1,
     "flat row: the row resolves to the column row itself and the chain is one element deep");
  ok(r.side === true && r.fill === false,
     "flat row: that one element is both leaf and row-level, so it carries the side flex");
  ok(r.terminalHidden === true && r.chatHidden === false,
     "flat row: the non-active column is hidden and the chat column is not");
  ok(r.chatW > 0 && r.diffW > 0 && r.terminalW === 0 && Math.abs(r.sideFlex - 1) < 1e-9,
     "flat row: chat and the active column share the row on a TWO-pane ratio (chat 2 : side 1), and the inactive column measures 0");
  ok(r.writes === 0, "flat row: zero layout writes");
}

// --- the tab strip stays COMPLETE while a tile is expanded --------------------
// Measured live 2026-08-04: expanding tears the other columns down ENTIRELY -
// wrappers included, not just the panes - so a column-only membership test
// collapsed the bar to the single expanded tab, leaving nothing to switch to and
// making the sticky sequence unreachable. While an expand is active membership is
// the UNION of the mirror's side tiles and the resolvable columns.
{
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    P.activate("terminal"); P.renderBar();
    var before = { tabs: P.state().tabs, expandedTileId: P.state().expandedTileId };
    // Upstream expands terminal: its own control flips, and every OTHER column
    // wrapper is torn out of the document.
    window.__setExpanded("terminal", true);
    window.__dropCol("diff");
    window.__dropCol("preview");
    P.reconcile(); P.renderBar();
    function chips() {
      var out = [], n = P.barEl().querySelectorAll(".cdb-tabs-item"), i;
      for (i = 0; i < n.length; i++) {
        out.push([n[i].querySelector("[data-cdb-tab]").getAttribute("data-cdb-tab"),
          n[i].querySelector("[data-cdb-close]") !== null]);
      }
      return out;
    }
    ${SINK}({ before: before, expandedTileId: P.state().expandedTileId,
      tabs: P.state().tabs, columns: P.state().columns, chips: chips(),
      active: window.__activeCol(), activeCount: window.__activeColCount(),
      bar: P.barEl() !== null, barInTerminal: P.barEl().parentElement === window.__col("terminal"),
      terminalWidth: window.__col("terminal").getBoundingClientRect().width,
      closeRefused: P.closeTab("diff"),
      warns: window.__cdbTabsWarnCount || 0, writes: window.__writes() });`),
    "expanded-union-tabs");
  ok(JSON.stringify(r.before.tabs) === '["diff","terminal","preview"]' &&
     r.before.expandedTileId === null,
     "union: with nothing expanded the strip is the three mounted columns and expandedTileId is null");
  ok(r.expandedTileId === "terminal",
     "union: the expanded tile is read off the live chrome row - the pane whose control says \"Collapse\"");
  ok(JSON.stringify(r.tabs) === '["diff","terminal","preview"]',
     "union: the strip stays COMPLETE even though only one column wrapper is left in the DOM");
  ok(JSON.stringify(r.columns) === '[{"tileId":"terminal","mounted":true}]',
     "union: and it is honest about it - only one column actually resolves");
  ok(JSON.stringify(r.chips) === '[["diff",false],["terminal",true],["preview",false]]',
     "union: every tab renders, and the ✕ is OMITTED on the two whose panes are unmounted");
  ok(r.active === "terminal" && r.activeCount === 1 && r.terminalWidth > 0,
     "union: a tab with no column is never treated as the active column - the expanded one stays active and visible");
  ok(r.bar === true && r.barInTerminal === true,
     "union: the bar is still there, hosted in the one column that exists");
  ok(r.closeRefused.closed === false,
     "union: closeTab() on an unmounted tab refuses - its own Close control is not in the document (the ✕ is omitted for exactly this reason)");
  ok(r.writes === 0, "union: still zero layout writes");
}
{
  // THE GHOST-TAB REGRESSION GUARD. The union must NOT apply when nothing is
  // expanded: the mirror lags ~1s, so a just-closed tile lingers in it and an
  // always-union strip would show a dead tab for a second. Same stale mirror, both
  // states, asserted side by side - the gate is the only difference.
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    // Upstream closes terminal. The mirror still lists it (deliberately NOT updated).
    window.__dropCol("terminal");
    P.reconcile(); P.renderBar();
    var barTabs = function () {
      var out = [], n = P.barEl().querySelectorAll("[data-cdb-tab]"), i;
      for (i = 0; i < n.length; i++) out.push(n[i].getAttribute("data-cdb-tab"));
      return out;
    };
    var notExpanded = { tabs: P.state().tabs, barTabs: barTabs(),
      expandedTileId: P.state().expandedTileId };
    // Nothing else changes - not the mirror, not the DOM - except that diff is now
    // expanded. That alone must switch membership to the union.
    window.__setExpanded("diff", true);
    P.reconcile(); P.renderBar();
    ${SINK}({ notExpanded: notExpanded, expandedTabs: P.state().tabs,
      expandedBarTabs: barTabs(), writes: window.__writes() });`),
    "ghost-tab-guard");
  ok(JSON.stringify(r.notExpanded.tabs) === '["diff"]' &&
     JSON.stringify(r.notExpanded.barTabs) === '["diff"]',
     "ghost tab: with nothing expanded a tile that has left the DOM vanishes from the strip IMMEDIATELY, stale mirror or not");
  ok(r.notExpanded.expandedTileId === null,
     "ghost tab: and the state agrees nothing is expanded");
  ok(JSON.stringify(r.expandedTabs) === '["diff","terminal"]' &&
     JSON.stringify(r.expandedBarTabs) === '["diff","terminal"]',
     "ghost tab: the SAME stale mirror does produce the union once an expand is active - the expanded state is the only gate");
  ok(r.writes === 0, "ghost tab: zero layout writes either way");
}
{
  // The live path end to end: click a tab whose column upstream has torn down.
  // That is the sticky sequence, and the target must resolve from the REMOUNTED
  // node - probe 4 measured that the panes come back as fresh nodes.
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    P.activate("terminal"); P.renderBar();
    window.__setExpanded("terminal", true);
    window.__dropCol("diff");                 // wrapper and all, as upstream does
    P.reconcile(); P.renderBar();
    var out = { tabs: P.state().tabs };
    // Clicked through the BAR, the way the user reaches it.
    P.barEl().querySelector('[data-cdb-tab="diff"]').click();
    out.afterClick = { calls: window.__calls.expand.slice(), stored: P.state().storedActiveId,
      visible: window.__activeCol(), bar: P.barEl() !== null };
    // Upstream collapses: the other column comes back, wrapper and pane both FRESH.
    setTimeout(function () { window.__addCol("diff"); window.__reorderCols(["diff", "terminal"]); }, 80);
    setTimeout(function () {
      out.calls = window.__calls.expand.slice();
      out.endActive = window.__activeCol();
      out.endTabs = P.state().tabs;
      out.endExpandedTileId = P.state().expandedTileId;
      out.endWidth = window.__col("diff").getBoundingClientRect().width;
      out.endCloseOnDiff = P.barEl().querySelector('[data-cdb-close="diff"]') !== null;
      out.label = P.barEl().querySelector("[data-cdb-expand]").getAttribute("aria-label");
      out.warns = window.__cdbTabsWarnCount || 0;
      out.writes = window.__writes();
      ${SINK}(out);
    }, 700);`), "expanded-click-unmounted-tab", 2000);
  ok(JSON.stringify(r.tabs) === '["diff","terminal"]',
     "unmounted click: the tab is there to click in the first place - that is what the union buys");
  ok(JSON.stringify(r.afterClick.calls) === '[["terminal","Collapse"]]' &&
     r.afterClick.stored === "diff",
     "unmounted click: the click collapses the expanded tile and records the chosen tab");
  ok(r.afterClick.visible === "terminal" && r.afterClick.bar === true,
     "unmounted click: until the remount lands the column still on screen stays visible and keeps the bar - never a blank column");
  ok(JSON.stringify(r.calls) === '[["terminal","Collapse"],["diff","Expand"]]',
     "unmounted click: once upstream remounts the column, Expand is clicked on the FRESH node - full-width lands on the chosen tab");
  ok(r.endActive === "diff" && r.endExpandedTileId === "diff" && r.endWidth > 0,
     "unmounted click: it ends expanded on the chosen tab, active and visible");
  ok(r.endCloseOnDiff === true && r.label === "Collapse",
     "unmounted click: the ✕ comes back with the pane, and the ⤢ label matches the expanded end state");
  ok(r.warns === 0,
     "unmounted click: the whole sequence is silent - the mid-sequence hold is an expected state, not a fault");
  ok(r.writes === 0, "unmounted click: zero layout writes");
}

// --- full-width is STICKY across a tab switch --------------------------------
// Upstream unmounts every OTHER tile's pane while one is expanded, so the target
// column genuinely does not exist and cannot just be revealed. The sequence is
// collapse -> wait for the remount -> re-tag -> expand again, bounded at 1200ms.
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    var lbl = function () {
      return P.barEl().querySelector("[data-cdb-expand]").getAttribute("aria-label");
    };
    // Upstream's expanded state, faithfully: diff's own control reads "Collapse"
    // and every other pane is UNMOUNTED.
    window.__setExpanded("diff", true);
    window.__unmountPane("terminal");
    var out = {};
    P.activate("terminal");
    out.afterSwitch = { calls: window.__calls.expand.slice(), active: window.__activeCol(),
      mounted: window.__paneOf("terminal") !== null };
    // Upstream reacts a few frames later: the expanded flag clears and the other
    // panes come back as fresh nodes.
    setTimeout(function () { window.__collapseAll("diff", ["terminal"]); }, 80);
    setTimeout(function () {
      out.calls = window.__calls.expand.slice();
      out.endActive = window.__activeCol();
      out.endMounted = window.__paneOf("terminal") !== null;
      // Read off upstream's OWN control: "Collapse" is present only on a pane
      // upstream considers expanded.
      out.endExpanded = window.__paneOf("terminal")
        .querySelector('button[aria-label="Collapse"]') !== null;
      out.endWidth = window.__col("terminal").getBoundingClientRect().width;
      out.hidden = window.__hiddenCols();
      out.endLabel = lbl();
      out.tabs = P.state().tabs;
      out.writes = window.__writes();
      ${SINK}(out);
    }, 700);`), "sticky-expand-happy", 2000);
  ok(JSON.stringify(r.afterSwitch.calls) === '[["diff","Collapse"]]',
     "sticky: the switch starts by clicking upstream's own Collapse on the outgoing pane");
  ok(r.afterSwitch.active === "terminal" && r.afterSwitch.mounted === false,
     "sticky: the chosen tab is active immediately, before upstream has remounted anything");
  ok(JSON.stringify(r.calls) === '[["diff","Collapse"],["terminal","Expand"]]',
     "sticky: once the remount lands it clicks upstream's own Expand on the NEW active pane - full-width survives the switch");
  ok(r.endActive === "terminal" && r.endMounted === true && r.endWidth > 0,
     "sticky: it ends with the new tile active, mounted and visible");
  ok(r.endExpanded === true,
     "sticky: and upstream's OWN control on that pane now reads \"Collapse\" - upstream really is expanded on the new tile");
  ok(JSON.stringify(r.hidden) === '["diff"]' && JSON.stringify(r.tabs) === '["diff","terminal"]',
     "sticky: the tab strip is intact and the outgoing column is simply hidden again");
  ok(r.endLabel === "Collapse",
     "sticky: the ⤢'s accessible name reads \"Collapse\" at the end, matching the expanded state it produced");
  ok(r.writes === 0, "sticky: the whole sequence issues ZERO layout writes");
}
{
  // THE REGRESSION GUARD FOR V2'S CORE PROPERTY. A switch made while NOT expanded
  // must be untouched by any of the above: attributes only, no writes, no timer,
  // no click on any of upstream's controls, and every panel still mounted long
  // after the sticky budget would have expired.
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    var out = {};
    P.activate("preview");
    P.activate("terminal");
    out.immediate = { active: window.__activeCol(), expandCalls: window.__calls.expand.slice(),
      closeCalls: window.__calls.close.slice(), writes: window.__writes(),
      tagged: window.__taggedCols(), hidden: window.__hiddenCols(),
      panes: [window.__paneOf("diff") !== null, window.__paneOf("terminal") !== null,
        window.__paneOf("preview") !== null] };
    // Well past the 1200ms sticky budget: nothing may have been scheduled at all.
    setTimeout(function () {
      out.later = { active: window.__activeCol(), expandCalls: window.__calls.expand.slice(),
        writes: window.__writes(), warns: window.__cdbTabsWarnCount || 0,
        label: P.barEl().querySelector("[data-cdb-expand]").getAttribute("aria-label"),
        panes: [window.__paneOf("diff") !== null, window.__paneOf("terminal") !== null,
          window.__paneOf("preview") !== null] };
      ${SINK}(out);
    }, 1500);`), "sticky-does-not-touch-plain-switch", 2500);
  ok(r.immediate.active === "terminal" && r.immediate.writes === 0,
     "plain switch: still a pure attribute toggle with ZERO layout writes");
  ok(JSON.stringify(r.immediate.expandCalls) === "[]" &&
     JSON.stringify(r.immediate.closeCalls) === "[]",
     "plain switch: NONE of upstream's chrome controls is clicked - no collapse, no expand");
  ok(JSON.stringify(r.immediate.panes) === "[true,true,true]" &&
     JSON.stringify(r.immediate.tagged) === '["diff","terminal","preview"]' &&
     JSON.stringify(r.immediate.hidden) === '["diff","preview"]',
     "plain switch: every panel stays MOUNTED - only which column carries the active marker changes");
  ok(JSON.stringify(r.later.expandCalls) === "[]" && r.later.writes === 0 &&
     r.later.warns === 0,
     "plain switch: 1500ms later - past the whole sticky budget - nothing has fired and nothing has warned, so no sequence was ever scheduled");
  ok(r.later.active === "terminal" && JSON.stringify(r.later.panes) === "[true,true,true]" &&
     r.later.label === "Expand",
     "plain switch: the end state is unchanged and the ⤢ still reads \"Expand\"");
}
{
  // The remount never comes. Bounded: we must end COLLAPSED but correct - the
  // chosen tab active, the bar present - with one warn, and not stuck.
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    window.__setExpanded("diff", true);
    window.__unmountPane("terminal");
    P.activate("terminal");
    // Upstream never brings the pane back and never clears its own flag.
    setTimeout(function () {
      ${SINK}({ calls: window.__calls.expand.slice(), active: window.__activeCol(),
        tabs: P.state().tabs, bar: P.barEl() !== null,
        label: P.barEl().querySelector("[data-cdb-expand]").getAttribute("aria-label"),
        warns: window.__cdbTabsWarnCount || 0, writes: window.__writes() });
    }, 1600);`), "sticky-expand-no-remount", 2500);
  ok(JSON.stringify(r.calls) === '[["diff","Collapse"]]',
     "sticky timeout: the collapse happened and NO expand was ever fired - never expanded onto a pane that is not there");
  ok(r.active === "terminal" && JSON.stringify(r.tabs) === '["diff","terminal"]' && r.bar === true,
     "sticky timeout: it ends collapsed but CORRECT - the chosen tab is active, the strip and the bar are still there");
  ok(r.warns === 1,
     "sticky timeout: exactly one warn - the budget expiring is reported once, not once per probe");
  ok(r.label === "Expand",
     "sticky timeout: the ⤢'s accessible name is put back in step with the collapsed state it settled in");
  ok(r.writes === 0, "sticky timeout: still zero layout writes");
}
{
  // Upstream's chrome row loses its controls while a tile is expanded (a
  // redeploy): the Collapse cannot be resolved, so there is nothing to sequence.
  // The switch must still land, and must land in the same safe state.
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    window.__setExpanded("diff", true);
    window.__unmountPane("terminal");
    var row = window.__paneOf("diff").querySelector(".chrome-row");
    while (row.firstChild) row.removeChild(row.firstChild);
    P.activate("terminal");
    setTimeout(function () {
      ${SINK}({ calls: window.__calls.expand.slice(), active: window.__activeCol(),
        tabs: P.state().tabs, bar: P.barEl() !== null,
        label: P.barEl().querySelector("[data-cdb-expand]").getAttribute("aria-label"),
        warns: window.__cdbTabsWarnCount || 0, writes: window.__writes() });
    }, 1600);`), "sticky-expand-no-control", 2500);
  ok(JSON.stringify(r.calls) === "[]",
     "sticky, no control: with neither control resolvable nothing is clicked at all");
  ok(r.active === "terminal" && JSON.stringify(r.tabs) === '["diff","terminal"]' && r.bar === true,
     "sticky, no control: the switch still lands - chosen tab active, strip and bar present");
  ok(r.warns === 0 && r.label === "Expand",
     "sticky, no control: nothing was attempted so nothing warns, and the ⤢ reads \"Expand\"");
  ok(r.writes === 0, "sticky, no control: still zero layout writes");
}
{
  // Two rapid switches while expanded. They must not interleave: the newer target
  // wins, the older sequence abandons QUIETLY, and Collapse is clicked exactly
  // ONCE - a second click would toggle upstream's expandedTile straight back on.
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    window.__setExpanded("diff", true);
    window.__unmountPane("terminal");
    window.__unmountPane("preview");
    P.activate("terminal");
    P.activate("preview");          // same task, before any timer could fire
    setTimeout(function () { window.__collapseAll("diff", ["terminal", "preview"]); }, 80);
    setTimeout(function () { P.renderBar(); }, 300);
    setTimeout(function () {
      ${SINK}({ calls: window.__calls.expand.slice(), active: window.__activeCol(),
        hidden: window.__hiddenCols(), tabs: P.state().tabs,
        previewExpanded: window.__paneOf("preview")
          .querySelector('button[aria-label="Collapse"]') !== null,
        terminalExpanded: window.__paneOf("terminal")
          .querySelector('button[aria-label="Collapse"]') !== null,
        label: P.barEl().querySelector("[data-cdb-expand]").getAttribute("aria-label"),
        warns: window.__cdbTabsWarnCount || 0, writes: window.__writes(),
        previewWidth: window.__col("preview").getBoundingClientRect().width });
    }, 1600);`), "sticky-expand-supersede", 2500);
  ok(JSON.stringify(r.calls) === '[["diff","Collapse"],["preview","Expand"]]',
     "supersede: exactly ONE collapse and ONE expand - the two sequences did not interleave and Collapse was not clicked twice");
  ok(r.active === "preview" && r.previewWidth > 0 && r.previewExpanded === true,
     "supersede: the NEWER target is the one that ends up active and expanded");
  ok(r.terminalExpanded === false,
     "supersede: the superseded target was never expanded - the abandoned sequence touched nothing");
  ok(JSON.stringify(r.hidden) === '["diff","terminal"]' &&
     JSON.stringify(r.tabs) === '["diff","terminal","preview"]',
     "supersede: the superseded target is just another hidden tab - no half-applied state left behind");
  ok(r.warns === 0,
     "supersede: the abandoned sequence is silent - being superseded is not a fault and fast clicking must not spam the log");
  ok(r.label === "Collapse" && r.writes === 0,
     "supersede: the ⤢ label matches the end state, with zero layout writes");
}
{
  const r = run(withPage(["chat", "diff"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    // Upstream's chrome row loses its controls entirely (a redeploy).
    var row = window.__paneOf("diff").querySelector(".chrome-row");
    while (row.firstChild) row.removeChild(row.firstChild);
    P.barEl().querySelector("[data-cdb-expand]").click();
    ${SINK}({ calls: window.__calls.expand, warns: window.__cdbTabsWarnCount || 0,
      barStillThere: P.barEl() !== null });`), "expand-no-control");
  ok(JSON.stringify(r.calls) === "[]" && r.warns === 1,
     "⤢: with no Expand/Collapse control on the chrome row it warns once and does nothing");
  ok(r.barStillThere === true,
     "⤢: a failing control never takes the bar down - the user needs it to reach their tabs and the Extra switch");
}

// --- upstream's redundant chrome controls are hidden while our bar is present --
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    function vis(tileId, label) {
      var b = window.__paneOf(tileId).querySelector('button[aria-label="' + label + '"]');
      return b ? getComputedStyle(b).display : "absent";
    }
    var withBar = { expand: vis("diff", "Expand"), close: vis("diff", "Close") };
    window.__setExpanded("diff", true);
    var collapseHidden = vis("diff", "Collapse");
    var clickableWhileHidden = null;
    window.__paneOf("diff").querySelector('button[aria-label="Close"]').click();
    clickableWhileHidden = window.__calls.close.slice();
    P.setEnabled(false);
    var withoutBar = { collapse: vis("diff", "Collapse"), close: vis("diff", "Close") };
    ${SINK}({ withBar: withBar, collapseHidden: collapseHidden,
      clickableWhileHidden: clickableWhileHidden, withoutBar: withoutBar });`),
    "chrome-hide-with-bar");
  ok(r.withBar.expand === "none" && r.withBar.close === "none",
     "chrome: upstream's Expand and Close are hidden while our bar is present");
  ok(r.collapseHidden === "none", "chrome: so is Collapse, once upstream flips the label");
  ok(JSON.stringify(r.clickableWhileHidden) === '[["diff","click"]]',
     "chrome: a display:none control is still clickable - which is exactly what our ✕ and ⤢ rely on");
  ok(r.withoutBar.collapse !== "none" && r.withoutBar.close !== "none",
     "chrome: they come back on their own the moment the bar is gone - the rule keys on the bar's own adjacency, so no JS teardown is needed");
}

// --- disable / stop -----------------------------------------------------------
{
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    P.activate("preview"); P.renderBar();
    var on = { tagged: window.__taggedCols(), active: window.__activeCol(),
      bar: P.barEl() !== null, style: !!document.querySelector("style[data-cdb-tabs]"),
      flexVar: document.documentElement.style.getPropertyValue("--cdb-side-flex"),
      hiddenWidth: window.__col("diff").getBoundingClientRect().width,
      writes: window.__writes() };
    P.setEnabled(false);
    var off = { tagged: window.__taggedCols(), activeAttrs: window.__activeColCount(),
      bar: P.barEl() !== null, style: !!document.querySelector("style[data-cdb-tabs]"),
      flexVar: document.documentElement.style.getPropertyValue("--cdb-side-flex"),
      writes: window.__writes(), health: P._health(),
      widths: [window.__col("diff").getBoundingClientRect().width,
        window.__col("terminal").getBoundingClientRect().width,
        window.__col("preview").getBoundingClientRect().width,
        window.__col("chat").getBoundingClientRect().width] };
    // Re-enabling adopts the split again and honours the remembered active tab.
    P.setEnabled(true); P.reconcile(); P.renderBar();
    ${SINK}({ on: on, off: off, reActive: window.__activeCol(),
      reTagged: window.__taggedCols(), writes: window.__writes() });`), "disable");
  ok(r.on.tagged.length === 3 && r.on.active === "preview" && r.on.hiddenWidth === 0,
     "disable: the feature really was on and hiding columns first");
  ok(JSON.stringify(r.off.tagged) === "[]" && r.off.activeAttrs === 0,
     "disable: every data-cdb-col / data-cdb-col-active attribute is removed");
  ok(r.off.style === false && r.off.flexVar === "",
     "disable: the stylesheet and the flex custom property are removed too");
  ok(r.off.bar === false && r.off.health.enabled === false, "disable: the bar comes down");
  ok(r.off.writes === 0,
     "disable: upstream's real split returns with ZERO layout writes - which is why disabling cannot fail and needs no retry state");
  ok(r.off.widths[0] > 0 && r.off.widths[1] > 0 && r.off.widths[2] > 0 && r.off.widths[3] > 0,
     "disable: all four columns are visible again - nothing is stranded");
  ok(r.reActive === "preview" && r.reTagged.length === 3,
     "disable: re-enabling adopts the split again and restores the remembered active tab");
  ok(r.writes === 0, "disable: the whole off/on cycle writes nothing");
}
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.start(); P.reconcile(); P.renderBar();
    var on = { bar: P.barEl() !== null, tagged: window.__taggedCols().length };
    P.stop();
    ${SINK}({ on: on, bar: P.barEl() !== null, tagged: window.__taggedCols(),
      style: !!document.querySelector("style[data-cdb-tabs]"),
      observed: P._observedRoot(), writes: window.__writes() });`), "stop-teardown");
  ok(r.on.bar === true && r.on.tagged === 2, "stop: the module was live first");
  ok(r.bar === false && JSON.stringify(r.tagged) === "[]" && r.style === false,
     "stop: a stopped module leaves no bar and no hidden column - it must not leave a panel unreachable");
  ok(r.observed === null && r.writes === 0, "stop: the observers are disconnected and nothing was written");
}

// =============================================================================
// THE CHAT COLUMN IS NEVER HIDDEN AND NEVER LOSES WIDTH
// =============================================================================
// The single most important invariant in this feature, and the absence-keyed rule
// (`[data-cdb-armed] > *:not(chain):not(chat):not(keep){display:none}`) is what puts
// it at risk: the default is HIDDEN, so anything we fail to exempt disappears.
//
// Three triggers, all reproduced by reviewers against the pre-fix code (2026-08-05,
// Claude Desktop 1.24012.9). Each one ended with the user's chat column at 0px:
//   H2  a decoy first row child took the chat exemption
//   H1  the row could not be resolved, and the inner-chain loop reached up the
//       ancestor path and hid the chat column
//   M1  a side wrapper whose pane had not arrived yet passed as the chat column
{
  const CHAT_SEL = '[data-test-col="chat"]';
  // One probe, three fixtures. Reports what the chat column actually looks like plus
  // the structural marks, so a failure says WHY and not just "false".
  const PROBE = `
    function chatState() {
      var chat = document.querySelector('${CHAT_SEL}');
      var r = chat ? chat.getBoundingClientRect() : null;
      return { present: !!chat,
        width: r ? Math.round(r.width) : null,
        display: chat ? getComputedStyle(chat).display : null,
        hasHide: !!chat && chat.hasAttribute("data-cdb-hide"),
        hasChatAttr: !!chat && chat.hasAttribute("data-cdb-chat"),
        // The decisive one: is the chat column VISIBLE to the user?
        visible: !!r && r.width > 1 && getComputedStyle(chat).display !== "none" };
    }
    function marks() {
      var el = document.querySelector("[data-cdb-armed]");
      return { armedCount: document.querySelectorAll("[data-cdb-armed]").length,
        armedTag: el ? (el.getAttribute("data-test-stack") ? "STACK"
          : (el.id || el.getAttribute("data-test-col") || el.tagName)) : null,
        rowOn: (function () { var r = document.querySelector("[data-cdb-row]");
          return r ? (r.getAttribute("data-test-stack") ? "STACK" : (r.id || r.tagName)) : null; })(),
        chatAttrOn: (function () { var c = document.querySelector("[data-cdb-chat]");
          return c ? (c.getAttribute("data-test-col") || c.className || c.tagName) : null; })(),
        hideOn: [].map.call(document.querySelectorAll("[data-cdb-hide]"), function (n) {
          return n.getAttribute("data-test-col") || n.getAttribute("data-test-stack") ||
            n.className || n.tagName; }) };
    }`;

  // --- H2: a decoy as the row's FIRST child (overlay, portal mount, drag ghost).
  {
    const r = run(withPage(["chat", "diff", "terminal"], PROBE + `
      var P = window.__cdbTabsPage;
      var host = document.getElementById("tile-host");
      var decoy = document.createElement("div");
      decoy.className = "drag-overlay";
      decoy.setAttribute("data-test-decoy", "1");
      decoy.style.cssText = "position:absolute;inset:0";
      decoy.appendChild(document.createElement("span"));
      host.insertBefore(decoy, host.firstChild);
      P.setEnabled(true); P.reconcile(); P.renderBar();
      ${SINK}({ chat: chatState(), marks: marks(),
        decoyIsChat: decoy.hasAttribute("data-cdb-chat"),
        warns: window.__cdbTabsWarnCount || 0 });`), "chat-invariant-decoy");
    ok(r.chat.visible === true && r.chat.width > 1,
       "chat invariant / decoy first row child: the chat column is still VISIBLE with real width - reproduced at 0px before the fix");
    ok(r.chat.hasHide === false,
       "chat invariant / decoy: and it never carries data-cdb-hide");
    ok(r.decoyIsChat === false,
       "chat invariant / decoy: the decoy does not take the chat exemption - the pick is verified positively, not just 'not furniture'");
  }
  // --- H1: the row cannot be resolved at all. The chat column is made unrecognisable
  //     the way upstream could: it gains the `tiles-shell` class, so it reads as
  //     furniture and no row child looks like chat.
  {
    const r = run(withPage(["chat", "diff", "terminal"], PROBE + `
      var P = window.__cdbTabsPage;
      window.__col("chat").classList.add("tiles-shell");
      P.setEnabled(true); P.reconcile(); P.renderBar();
      ${SINK}({ chat: chatState(), marks: marks(),
        diffVisible: window.__col("diff").getBoundingClientRect().width > 1,
        warns: window.__cdbTabsWarnCount || 0 });`), "chat-invariant-no-row");
    ok(r.chat.visible === true && r.chat.width > 1,
       "chat invariant / row unresolvable: the chat column is still VISIBLE - before the fix the inner-chain loop reached up the ancestor path and hid it");
    ok(r.chat.hasHide === false && r.marks.hideOn.length === 0,
       "chat invariant / row unresolvable: NOTHING is hidden at all - no row means we cannot say what belongs to the side region");
    ok(r.marks.armedCount === 0,
       "chat invariant / row unresolvable: and the absence rule is not armed");
    ok(r.warns === 1,
       "chat invariant / row unresolvable: it warns exactly once - an unresolvable row is a real anchor failure, not an ordinary state");
    ok(r.diffVisible === true,
       "chat invariant / row unresolvable: upstream's own split is left alone, so every panel is reachable");
  }
  // --- M1: a side wrapper whose pane upstream has removed (or not yet inserted). This
  //     is reachable BECAUSE the observer pass is synchronous - it runs inside the very
  //     frame in which upstream inserts a wrapper and fills it a moment later.
  {
    const r = run(withPage(["chat", "diff", "terminal", "preview"], PROBE + `
      var P = window.__cdbTabsPage;
      // Settle first, so the wrappers carry our tags exactly as they do live.
      P.setEnabled(true); P.reconcile(); P.renderBar();
      P.activate("terminal"); P.renderBar();
      // Now upstream takes diff's PANE away but leaves the wrapper and its shell -
      // the paneless-column state resolveColumns() is built to keep.
      window.__unmountPane("diff");
      P.reconcile(); P.renderBar();
      ${SINK}({ chat: chatState(), marks: marks(),
        structDepth: P._structure().chain.length,
        rowIsHost: document.getElementById("tile-host").hasAttribute("data-cdb-row"),
        warns: window.__cdbTabsWarnCount || 0 });`,
      { wrap: () => nestedRow(), mirror: ["diff", "terminal", "preview"] }),
      "chat-invariant-paneless-wrapper");
    ok(r.chat.visible === true && r.chat.hasChatAttr === true,
       "chat invariant / paneless side wrapper: the REAL chat column is visible and holds the exemption");
    ok(r.marks.chatAttrOn === "chat",
       "chat invariant / paneless side wrapper: data-cdb-chat is on the chat column, not on a side leaf between panes");
    ok(r.rowIsHost === true && r.marks.rowOn !== "STACK",
       "chat invariant / paneless side wrapper: the row resolves to the real tiles row - before the fix the walk stopped at the STACK, so nothing was hidden and three panels showed at once");
    ok(r.marks.hideOn.length > 0,
       "chat invariant / paneless side wrapper: and hiding actually happens, which is what the structural pass exists to do");
  }
}
// --- H2, REOPENED: the decoy the first "positive" predicate still accepted -------
// The block above shipped and H2 was still reproducible on the live app. Two reasons,
// and both are test-design failures as much as code ones:
//
//  1. The predicate it added ("not furniture, holds no MOUNTED side pane, in flow,
//     >= 80px wide, has >= 1 child") describes A BOX WITH CONTENT, not the chat column.
//     The decoy above only failed it on `position:absolute`, so the assertion passed for
//     a reason that has nothing to do with identifying chat. An IN-FLOW decoy sails
//     through - which is what happened live: decoy tagged data-cdb-chat, real chat 0px,
//     row armed anyway.
//  2. Every probe that tried to catch this inserted the decoy into an ALREADY-ARMED
//     row. Our own absence rule then hides the decoy within the frame, so it measures
//     0px, so it fails the >= 80px test, so the probe reports SAFE. The test defeats
//     itself. Four separate probes were fooled this way.
//
// So every scenario here ARMS FROM A VIRGIN ROW that already contains the decoy, and
// each one first asserts the decoy's own measured width is NON-ZERO before the feature
// is switched on. Without that assertion the scenario proves nothing.
{
  // Self-contained probe: this block must not depend on the one above.
  const PROBE2 = `
    function boxOf(sel) {
      var el = typeof sel === "string" ? document.querySelector(sel) : sel;
      if (!el) return { present: false };
      var r = el.getBoundingClientRect();
      return { present: true, width: Math.round(r.width),
        display: getComputedStyle(el).display,
        isChat: el.hasAttribute("data-cdb-chat"),
        hasHide: el.hasAttribute("data-cdb-hide"),
        visible: r.width > 1 && getComputedStyle(el).display !== "none" };
    }
    function state() {
      return { chat: boxOf('[data-test-col="chat"]'),
        decoy: boxOf("[data-test-decoy]"),
        armedCount: document.querySelectorAll("[data-cdb-armed]").length,
        hideCount: document.querySelectorAll("[data-cdb-hide]").length,
        chatAttrOn: (function () { var c = document.querySelector("[data-cdb-chat]");
          return c ? (c.getAttribute("data-test-decoy") ? "DECOY"
            : (c.getAttribute("data-test-col") || c.tagName)) : null; })(),
        chatAttrCount: document.querySelectorAll("[data-cdb-chat]").length,
        warns: window.__cdbTabsWarnCount || 0 };
    }
    // An IN-FLOW sibling with real width and real content - a rail, a banner, an
    // inserted upsell, an app-chrome column. Everything the old predicate asked for.
    //
    // The shell argument is "" (none), "static" or "absolute", and the distinction is
    // the whole point of the discriminator:
    //   "static"    what a side wrapper looks like between its wrapper and its pane.
    //               Must be REJECTED outright - refusing here is what unarmed the
    //               layout mid-open and undid the zero-jump open.
    //   "absolute"  the only shape genuinely indistinguishable from chat. Must REFUSE.
    function plantDecoy(shell) {
      var d = document.createElement("div");
      d.setAttribute("data-test-decoy", "1");
      d.style.cssText = "position:relative;flex:0 0 auto;width:220px;height:100%";
      d.appendChild(document.createElement("span")).textContent = "rail";
      if (shell) {
        var s = document.createElement("div");
        s.className = "tiles-shell";
        s.style.cssText = shell === "absolute"
          ? "position:absolute;top:0;bottom:0;left:0;width:100%;height:100%"
          : "height:100%";
        d.appendChild(s);
      }
      var host = document.getElementById("tile-host");
      host.insertBefore(d, host.firstChild);
      return d;
    }`;

  // --- A: virgin row, in-flow decoy FIRST. The chat pick must not go by position.
  {
    const r = run(withPage(["chat", "diff", "terminal"], PROBE2 + `
      var P = window.__cdbTabsPage;
      var decoy = plantDecoy("");
      // BEFORE arming: prove the decoy is a real, wide, in-flow box. If this is 0 the
      // scenario is worthless - that is exactly how the earlier probes fooled themselves.
      var preDecoyWidth = Math.round(decoy.getBoundingClientRect().width);
      var preChatWidth = Math.round(window.__col("chat").getBoundingClientRect().width);
      P.setEnabled(true); P.reconcile(); P.renderBar();
      var s = state();
      s.preDecoyWidth = preDecoyWidth;
      s.preChatWidth = preChatWidth;
      s.candidates = P._structure ? P._structure().chatCandidates : "no-hook";
      ${SINK}(s);`), "h2-virgin-inflow-decoy");
    ok(r.preDecoyWidth > 1,
       "H2 virgin row: the planted decoy really is a wide in-flow box BEFORE the feature arms (" + r.preDecoyWidth + "px) - the earlier probes all measured 0 here and so tested nothing");
    ok(r.preChatWidth > 1,
       "H2 virgin row: and the real chat column has real width before arming too");
    ok(r.decoy.isChat === false && r.chatAttrOn === "chat",
       "H2 virgin row: the in-flow decoy does NOT take the chat exemption - reproduced live against the width/position predicate, which accepted it");
    ok(r.chat.visible === true && r.chat.hasHide === false,
       "H2 virgin row: the real chat column is VISIBLE and unhidden - it measured 0px in the live reproduction");
    ok(r.chatAttrCount === 1,
       "H2 virgin row: exactly one element carries data-cdb-chat");
    ok(r.candidates === 1,
       "H2 virgin row: the row has exactly ONE chat candidate, so the pick is unambiguous rather than first-past-the-post");
    ok(r.armedCount > 0 && r.hideCount > 0,
       "H2 virgin row: and the feature still works - the row is armed and the inactive branch is hidden");
    ok(r.decoy.visible === true,
       "H2 virgin row: the decoy itself is NOT blanked either - hiding-by-absence is bounded to tile furniture, and a rail we do not recognise is upstream's business");
  }

  // --- B: virgin row, decoy that ALSO owns an empty shell. Two candidates -> refuse.
  {
    const r = run(withPage(["chat", "diff", "terminal"], PROBE2 + `
      var P = window.__cdbTabsPage;
      var decoy = plantDecoy("absolute");
      var preDecoyWidth = Math.round(decoy.getBoundingClientRect().width);
      P.setEnabled(true); P.reconcile(); P.renderBar();
      var s = state();
      s.preDecoyWidth = preDecoyWidth;
      s.diffVisible = window.__col("diff").getBoundingClientRect().width > 1;
      // NEW-4: what the user is left LOOKING AT in the refuse state.
      s.barPresent = !!document.querySelector(".cdb-tabs-bar");
      s.upstreamControlsVisible = (function () {
        var b = document.querySelector('[data-pane-root] button[aria-label="Expand"]');
        return !!b && getComputedStyle(b).display !== "none";
      })();
      ${SINK}(s);`), "h2-virgin-ambiguous-decoy");
    ok(r.preDecoyWidth > 1,
       "H2 ambiguity: the shell-owning decoy is a real wide box before arming");
    ok(r.chatAttrCount === 0,
       "H2 ambiguity: with TWO indistinguishable candidates nothing is marked as chat - ambiguity is refused, not resolved by document order");
    ok(r.armedCount === 0 && r.hideCount === 0,
       "H2 ambiguity: so the absence rule is never armed and nothing is hidden - the safe degraded state");
    ok(r.chat.visible === true && r.decoy.visible === true,
       "H2 ambiguity: both the real chat column and the decoy stay visible - we blank neither when we cannot tell them apart");
    ok(r.diffVisible === true,
       "H2 ambiguity: upstream's own split is left intact, so every panel is still reachable");
    ok(r.warns === 1,
       "H2 ambiguity: and it warns exactly once - an unresolvable row is an anchor failure, not an ordinary state");
    // NEW-4: the refuse state was layout-clean but a DEAD END - our bar stayed up with
    // chips that changed nothing (both panels measured 156px on a click), while our own
    // `.cdb-tabs-bar + .tiles-shell button[aria-label=…]` rule kept upstream's per-pane
    // controls hidden. So the user had our inert controls and not theirs.
    ok(r.barPresent === false,
       "NEW-4: refusing DROPS our bar - leaving it up gave the user chips that do nothing, because switching panels IS the hiding we just declined to do");
    ok(r.upstreamControlsVisible === true,
       "NEW-4: and upstream's own per-pane Expand control is visible again - those rules are sibling selectors on the bar, so dropping it un-hides them with nothing to remember");
  }

  // --- NEW-4's OTHER HALF: a refusal caused by an EXPAND must KEEP the bar ----------
  // Measured live 2026-08-06: while a tile is expanded upstream tears the row down, chat
  // included (chat 0px, the expanded panel 1796px, no row child owning an empty absolute
  // shell), so applyStructure refuses - and the first version of the NEW-4 fix dropped the
  // bar for it, taking the tab strip and the ⤢ away for as long as the user stayed
  // expanded. That breaks sticky expand outright, since the sequence needs the chips to
  // switch and the ⤢ to collapse. Not caught by fixtures until this one, because the
  // others do not reproduce upstream's expanded teardown.
  {
    const r = run(withPage(["chat", "diff", "terminal"], PROBE2 + `
      var P = window.__cdbTabsPage;
      P.setEnabled(true); P.reconcile(); P.renderBar();
      var armedBefore = document.querySelectorAll("[data-cdb-armed]").length;
      // Upstream expands a tile AND tears the row down the way it really does: the chat
      // column stops being identifiable at all (its shell goes with the teardown).
      window.__setExpanded("diff", true);
      var shell = window.__col("chat").querySelector(".tiles-shell");
      shell.parentNode.removeChild(shell);
      P.reconcile(); P.renderBar();
      ${SINK}({ armedBefore: armedBefore,
        expanded: P.state().expandedTileId,
        refusedToArm: document.querySelectorAll("[data-cdb-armed]").length === 0,
        hidden: document.querySelectorAll("[data-cdb-hide]").length,
        barPresent: !!document.querySelector(".cdb-tabs-bar"),
        barChildren: (function () { var b = document.querySelector(".cdb-tabs-bar");
          return b ? [].map.call(b.children, function (n) { return n.className; }) : null; })(),
        chipCount: (function () { var b = document.querySelector(".cdb-tabs-bar");
          return b ? b.querySelectorAll('[role="tab"]').length : 0; })(),
        expandControl: (function () { var b = document.querySelector(".cdb-tabs-bar");
          var e = b && b.querySelector("[data-cdb-expand]");
          return e ? e.getAttribute("aria-label") : null; })() });`),
      "refuse-while-expanded-keeps-bar");
    ok(r.armedBefore > 0 && r.expanded === "diff",
       "expanded refusal: the row was armed before, and a tile really is expanded now - otherwise this tests nothing");
    ok(r.refusedToArm === true && r.hidden === 0,
       "expanded refusal: we still refuse to arm or hide - upstream is doing the hiding while expanded, so that part is right");
    ok(r.barPresent === true,
       "expanded refusal: but the BAR STAYS. Dropping it here took the tab strip and the ⤢ away for as long as the user stayed expanded, which breaks sticky expand");
    ok(JSON.stringify(r.barChildren) === '["cdb-tabs-strip","cdb-tabs-sep","cdb-tabs-expand"]' &&
       r.chipCount >= 2,
       "expanded refusal: with its chips still there to switch with - they are NOT inert in this state, activate() runs the sticky sequence");
    ok(r.expandControl === "Collapse",
       "expanded refusal: and the ⤢ still reads Collapse, so the user can get back out");
  }

  // --- C: the armed-row case the old probes tested by accident. It must still hold,
  //     and the decoy must survive: absence-keying may only reach tile furniture.
  {
    const r = run(withPage(["chat", "diff", "terminal"], PROBE2 + `
      var P = window.__cdbTabsPage;
      P.setEnabled(true); P.reconcile(); P.renderBar();
      var armedBefore = document.querySelectorAll("[data-cdb-armed]").length;
      var decoy = plantDecoy("");
      // No reconcile call: read the frame in which it was inserted, which is what the
      // absence rule exists to cover.
      var immediate = { decoyDisplay: getComputedStyle(decoy).display,
        chatWidth: Math.round(window.__col("chat").getBoundingClientRect().width) };
      P.reconcile(); P.renderBar();
      var s = state();
      s.armedBefore = armedBefore;
      s.immediate = immediate;
      ${SINK}(s);`), "h2-armed-row-decoy");
    ok(r.armedBefore > 0,
       "H2 armed row: the row really was armed before the decoy landed - otherwise this scenario tests nothing");
    ok(r.immediate.decoyDisplay !== "none",
       "H2 armed row: the decoy is NOT hidden in the frame it appears - the absence rule reaches tile branches and handles, not every stranger");
    ok(r.immediate.chatWidth > 1 && r.chat.visible === true,
       "H2 armed row: and the chat column keeps its width throughout");
    ok(r.decoy.isChat === false && r.chatAttrOn === "chat",
       "H2 armed row: the decoy still never takes the exemption after a full reconcile");
  }

  // --- D: the predicate must not be INERT. A too-strict chat test would pass every
  //     assertion above by never identifying anything, so pin the working case too.
  {
    const r = run(withPage(["chat", "diff", "terminal", "preview"], PROBE2 + `
      var P = window.__cdbTabsPage;
      P.setEnabled(true); P.reconcile(); P.renderBar();
      var s = state();
      s.candidates = P._structure ? P._structure().chatCandidates : "no-hook";
      s.resolved = P._structure ? P._structure().chatResolved : "no-hook";
      ${SINK}(s);`,
      { wrap: () => nestedRow(), mirror: ["diff", "terminal", "preview"] }),
      "h2-not-inert-nested");
    ok(r.candidates === 1 && r.resolved === true,
       "H2 not inert: on the real measured NESTED row the predicate finds exactly one chat candidate and resolves it");
    ok(r.chatAttrOn === "chat" && r.armedCount > 0 && r.hideCount > 0,
       "H2 not inert: the chat column is marked, the row is armed and hiding happens - a predicate that identified nothing would satisfy every safety assertion above while breaking the feature");
  }

  // --- E: the narrowed absence rule must NOT regress the open/close transient. Both
  //     kinds of tile furniture have to be hidden from their very first layout.
  {
    const r = run(withPage(["chat", "diff", "terminal"], PROBE2 + `
      var P = window.__cdbTabsPage;
      P.setEnabled(true); P.reconcile(); P.renderBar();
      var host = document.getElementById("tile-host");
      // A brand-new tile BRANCH, inserted the way upstream does it: the wrapper and its
      // shell arrive as ONE subtree, so it matches :has(.tiles-shell) immediately.
      var branch = document.createElement("div");
      branch.className = "epitaxy-column";
      branch.setAttribute("data-test-new", "branch");
      branch.style.cssText = "flex:1 1 0%";
      branch.innerHTML = '<div class="tiles-shell" style="height:100%">' +
        '<div class="epitaxy-view-panel" data-pane-root="" data-test-tile="tasks">x</div></div>';
      host.appendChild(branch);
      // And a brand-new handle, which owns no shell at all.
      var handle = document.createElement("div");
      handle.className = "tiles-handle draggable-none";
      handle.setAttribute("data-test-new", "handle");
      handle.style.cssText = "flex:0 0 auto;width:12px";
      host.appendChild(handle);
      // Read display WITHOUT reconciling: this is the pre-paint frame.
      ${SINK}({ branchDisplay: getComputedStyle(branch).display,
        handleDisplay: getComputedStyle(handle).display,
        chatWidth: Math.round(window.__col("chat").getBoundingClientRect().width) });`),
      "h2-transient-still-covered");
    ok(r.branchDisplay === "none",
       "H2 transient: a brand-new tile branch is display:none in the frame it is inserted - narrowing the absence rule to :has(.tiles-shell) did not reopen the transient");
    ok(r.handleDisplay === "none",
       "H2 transient: and so is a brand-new handle, which owns no shell - which is why the rule names .tiles-handle explicitly instead of relying on :has() alone");
    ok(r.chatWidth > 1,
       "H2 transient: with the chat column untouched throughout");
  }

  // --- F: THE REGRESSION THE AMBIGUITY REFUSAL CAUSED. A wrapper upstream inserts a
  //     beat before its pane owns an EMPTY shell, so under the shells-all-empty test
  //     alone it was a SECOND chat candidate: chatColumnOf refused, the row went null,
  //     every mark was cleared, and the layout unhid mid-open. Review measured chat
  //     520 -> 312px with three side branches painting, silent after one warnOnce -
  //     i.e. the zero-jump open traded straight back in.
  //
  //     The discriminator settles it: that wrapper's shell is STATIC, chat's is
  //     ABSOLUTE, so it is not a candidate at all and there is no ambiguity to refuse.
  {
    const r = run(withPage(["chat", "diff", "terminal"], PROBE2 + `
      var P = window.__cdbTabsPage;
      P.setEnabled(true); P.reconcile(); P.renderBar();
      var before = { chat: Math.round(window.__col("chat").getBoundingClientRect().width),
        armed: document.querySelectorAll("[data-cdb-armed]").length,
        hide: document.querySelectorAll("[data-cdb-hide]").length };
      // Upstream's wrapper-then-pane ordering: the wrapper and an EMPTY static shell.
      var host = document.getElementById("tile-host");
      var w = document.createElement("div");
      w.className = "epitaxy-column";
      w.setAttribute("data-test-pending", "1");
      w.style.cssText = "position:relative;flex:1 1 0%";
      w.innerHTML = '<div class="tiles-shell" style="height:100%"></div>';
      host.appendChild(w);
      var mid = { chatCandidates: P._structure ? P._structure().chatCandidates : "no-hook",
        pendingIsCandidate: (function () {
          var st = P._structure ? P._structure() : null;
          if (!st) return "no-hook";
          var k = st.rowChildren.filter(function (c) { return c.shellPos === "static" && c.chatCandidate; });
          return k.length > 0; })(),
        pendingDisplay: getComputedStyle(w).display };
      // Now the reconcile that used to refuse.
      P.reconcile(); P.renderBar();
      var after = { chat: Math.round(window.__col("chat").getBoundingClientRect().width),
        armed: document.querySelectorAll("[data-cdb-armed]").length,
        hide: document.querySelectorAll("[data-cdb-hide]").length,
        chatAttrOn: (function () { var c = document.querySelector("[data-cdb-chat]");
          return c ? (c.getAttribute("data-test-col") || c.getAttribute("data-test-pending") || c.tagName) : null; })(),
        pendingDisplay: getComputedStyle(w).display,
        visibleSideBranches: [].filter.call(host.children, function (c) {
          return !c.classList.contains("tiles-handle") && !c.hasAttribute("data-cdb-chat") &&
            c.getBoundingClientRect().width > 1; }).length,
        warns: window.__cdbTabsWarnCount || 0 };
      ${SINK}({ before: before, mid: mid, after: after });`), "new1-pending-wrapper");
    ok(r.before.armed > 0 && r.before.chat > 1,
       "NEW-1: the row was armed with a real chat width before the pending wrapper arrived");
    ok(r.mid.pendingIsCandidate === false,
       "NEW-1: a wrapper whose pane has not landed is NOT a chat candidate - its shell is static, chat's is absolute (this is the discriminator doing the work)");
    ok(r.mid.chatCandidates === 1,
       "NEW-1: so the row still has exactly ONE candidate and there is no ambiguity to refuse");
    ok(r.after.armed === r.before.armed && r.after.armed > 0,
       "NEW-1: the row stays ARMED across the reconcile - it unarmed everything before, which is what unhid the layout mid-open");
    ok(r.after.chat === r.before.chat,
       "NEW-1: and the chat column does not move one pixel - review measured 520 -> 312px here");
    ok(r.after.chatAttrOn === "chat",
       "NEW-1: the exemption stays on the real chat column, not on the half-built wrapper");
    ok(r.mid.pendingDisplay === "none" && r.after.pendingDisplay === "none",
       "NEW-1: the pending wrapper is hidden from its first frame and stays hidden - it owns a shell, so the absence rule reaches it");
    ok(r.after.visibleSideBranches === 1,
       "NEW-1: exactly ONE side branch is visible throughout - three painted at once before");
    ok(r.after.warns === 0,
       "NEW-1: and NOTHING warns - a wrapper mid-mount is an ordinary state, not an anchor failure");
  }

  // --- G: NEW-2 / M1's own stated trigger, which the previous round left open. A
  //     brand-new UNTAGGED paneless leaf appended to the STACK made looksLikeRow(STACK)
  //     true, so data-cdb-row moved to the stack and data-cdb-chat landed on that leaf:
  //     chat 402 -> 248px with two side branches visible and ZERO warns. Silently wrong.
  {
    const r = run(withPage(["chat", "diff", "terminal", "preview"], PROBE2 + `
      var P = window.__cdbTabsPage;
      P.setEnabled(true); P.reconcile(); P.renderBar();
      var host = document.getElementById("tile-host");
      var stack = document.querySelector("[data-test-stack]");
      var before = { chat: Math.round(window.__col("chat").getBoundingClientRect().width),
        rowIsHost: host.hasAttribute("data-cdb-row") };
      // A NEW leaf, never tagged by us, whose pane has not arrived.
      var leaf = document.createElement("div");
      leaf.className = "epitaxy-column";
      leaf.setAttribute("data-test-newleaf", "1");
      leaf.style.cssText = "position:relative;flex:1 1 0%";
      leaf.innerHTML = '<div class="tiles-shell" style="height:100%"></div>';
      stack.appendChild(leaf);
      P.reconcile(); P.renderBar();
      ${SINK}({ before: before,
        rowIsHost: host.hasAttribute("data-cdb-row"),
        rowIsStack: stack.hasAttribute("data-cdb-row"),
        chatAttrOn: (function () { var c = document.querySelector("[data-cdb-chat]");
          return c ? (c.getAttribute("data-test-col") || c.getAttribute("data-test-newleaf") || c.tagName) : null; })(),
        leafIsChat: leaf.hasAttribute("data-cdb-chat"),
        chat: Math.round(window.__col("chat").getBoundingClientRect().width),
        visibleSideBranches: [].filter.call(host.children, function (c) {
          return !c.classList.contains("tiles-handle") && !c.hasAttribute("data-cdb-chat") &&
            c.getBoundingClientRect().width > 1; }).length,
        sticky: P._structure ? P._structure().chatSticky : "no-hook",
        warns: window.__cdbTabsWarnCount || 0 });`,
      { wrap: () => nestedRow(), mirror: ["diff", "terminal", "preview"] }), "new2-untagged-paneless-leaf");
    ok(r.before.rowIsHost === true && r.before.chat > 1,
       "NEW-2: the row resolved to the real tiles row before the new leaf arrived");
    ok(r.leafIsChat === false && r.chatAttrOn === "chat",
       "NEW-2: a brand-new UNTAGGED paneless leaf does not take the chat exemption - the previous round only closed the already-tagged variant");
    ok(r.rowIsHost === true && r.rowIsStack === false,
       "NEW-2: and data-cdb-row stays on the real row instead of moving to the STACK - the walk is deterministic once the chat column is known");
    ok(r.chat === r.before.chat,
       "NEW-2: chat does not move - review measured 402 -> 248px here");
    ok(r.visibleSideBranches === 1,
       "NEW-2: exactly one side branch is visible - diff and preview both painted before");
    ok(r.sticky === true,
       "NEW-2: the chat pick is being HELD, which is what makes the row walk deterministic rather than a fresh guess every pass");
  }

  // --- H: stickiness must not become a way to LOCK IN a wrong answer, and must not
  //     make the feature inert. If the held element stops being a valid chat column it
  //     has to be released and re-decided.
  {
    const r = run(withPage(["chat", "diff", "terminal"], PROBE2 + `
      var P = window.__cdbTabsPage;
      P.setEnabled(true); P.reconcile(); P.renderBar();
      var held = P._structure ? P._structure().chatSticky : "no-hook";
      // Upstream mounts a pane INSIDE chat's own shell: the held element is no longer a
      // valid chat column, so the hold must be released rather than trusted.
      var shell = window.__col("chat").querySelector(".tiles-shell");
      shell.innerHTML = '<div class="epitaxy-view-panel" data-pane-root="" data-test-tile="x">x</div>';
      P.reconcile(); P.renderBar();
      var afterInvalidate = { sticky: P._structure ? P._structure().chatSticky : "no-hook",
        chatAttrCount: document.querySelectorAll("[data-cdb-chat]").length,
        armed: document.querySelectorAll("[data-cdb-armed]").length,
        chatVisible: window.__col("chat").getBoundingClientRect().width > 1 };
      // And put it back: the feature must recover, not stay inert.
      shell.innerHTML = "";
      P.reconcile(); P.renderBar();
      ${SINK}({ held: held, afterInvalidate: afterInvalidate,
        recovered: { sticky: P._structure ? P._structure().chatSticky : "no-hook",
          chatAttrOn: (function () { var c = document.querySelector("[data-cdb-chat]");
            return c ? (c.getAttribute("data-test-col") || c.tagName) : null; })(),
          armed: document.querySelectorAll("[data-cdb-armed]").length,
          hide: document.querySelectorAll("[data-cdb-hide]").length } });`),
      "sticky-releases-and-recovers");
    ok(r.held === true,
       "sticky: the pick is held once identified");
    ok(r.afterInvalidate.sticky === false,
       "sticky: the hold is RELEASED the moment the held element stops being a valid chat column - it is not a permanent lock-in");
    ok(r.afterInvalidate.chatVisible === true,
       "sticky: and the chat column stays visible while the pick is unsettled");
    ok(r.recovered.sticky === true && r.recovered.chatAttrOn === "chat",
       "sticky: it re-identifies and re-holds afterwards, so a transient never leaves the feature inert");
    ok(r.recovered.armed > 0 && r.recovered.hide > 0,
       "sticky: with arming and hiding both working again");
  }
}
// --- M3: unarm() must really restore upstream's split ---------------------------
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile();
    var before = { hide: document.querySelectorAll("[data-cdb-hide]").length,
      side: document.querySelectorAll("[data-cdb-side]").length,
      armed: document.querySelectorAll("[data-cdb-armed]").length,
      terminalW: Math.round(window.__col("terminal").getBoundingClientRect().width) };
    // Hook-tolerant: against a build without _unarm, emulate what unarm() USED to do
    // (drop the interlock only) so these assertions fail on the real property rather
    // than aborting the run. An assertion that cannot fail is worse than none.
    if (typeof P._unarm === "function") P._unarm();
    else {
      [].forEach.call(document.querySelectorAll("[data-cdb-armed]"), function (n) {
        n.removeAttribute("data-cdb-armed");
      });
    }
    var after = { hide: document.querySelectorAll("[data-cdb-hide]").length,
      side: document.querySelectorAll("[data-cdb-side]").length,
      armed: document.querySelectorAll("[data-cdb-armed]").length,
      chain: document.querySelectorAll("[data-cdb-chain]").length,
      terminalW: Math.round(window.__col("terminal").getBoundingClientRect().width),
      terminalDisplay: getComputedStyle(window.__col("terminal")).display,
      chatW: Math.round(window.__col("chat").getBoundingClientRect().width) };
    ${SINK}({ before: before, after: after });`), "unarm-restores-split");
  ok(r.before.hide > 0 && r.before.armed === 1 && r.before.terminalW === 0,
     "unarm: before it runs, the inactive column is hidden and the row is armed");
  ok(r.after.armed === 0 && r.after.hide === 0 && r.after.side === 0 && r.after.chain === 0,
     "unarm: it clears EVERY structural mark, not only the interlock - data-cdb-hide and data-cdb-side used to survive it");
  ok(r.after.terminalDisplay !== "none" && r.after.terminalW > 0,
     "unarm: so the hidden branch is really visible again - upstream's own split, which is what the watchdog's warning claims");
  ok(r.after.chatW > 0,
     "unarm: and the chat column keeps its width throughout");
}
// --- M2: a switch from the HOLD path must not destroy the stored share ----------
{
  const seed = `localStorage.setItem("cdb.panelTabs.v2", JSON.stringify({
    version: 2, bySession: { local_a: { activeId: "diff", chatShare: 0.7 } } }));`;
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true);
    // HOLD: terminal is expanded and mounted, diff is a union tab whose column
    // upstream has torn down - so the active tab has no column and applyStructure()
    // never runs, which is exactly the path that used to write chatShare:null.
    window.__setExpanded("terminal", true);
    window.__dropCol("diff");
    var res = P.reconcile();
    var afterHold = JSON.parse(localStorage.getItem("cdb.panelTabs.v2")).bySession.local_a;
    P.activate("terminal");
    var afterSwitch = JSON.parse(localStorage.getItem("cdb.panelTabs.v2")).bySession.local_a;
    ${SINK}({ action: res.action, afterHold: afterHold, afterSwitch: afterSwitch });`,
    { extraSetup: seed, mirror: ["diff", "terminal"] }), "hold-preserves-share");
  ok(r.action === "hold",
     "hold share: the fixture really reaches the hold path");
  ok(r.afterSwitch.chatShare === 0.7,
     "hold share: a switch taken from the hold path PRESERVES the stored 0.7 - it used to write null, and the next applied pass then recaptured 0.6667 from the live flexes, silently losing the boundary the user set");
  ok(r.afterSwitch.activeId === "terminal",
     "hold share: while the active tab is still recorded");
}
// --- M5: total anchor loss warns instead of dying silently ----------------------
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true);
    // Upstream renames the pane-root anchor: the mirror still lists two side tiles,
    // but nothing in the DOM answers to [data-pane-root] or .epitaxy-view-panel.
    [].forEach.call(document.querySelectorAll("[data-pane-root]"), function (p) {
      p.removeAttribute("data-pane-root");
      p.classList.remove("epitaxy-view-panel");
    });
    var res = P.reconcile();
    P.renderBar();
    // A second pass must not warn again.
    P.reconcile();
    ${SINK}({ action: res.action, bar: P.barEl() !== null,
      tabs: P.state().tabs, sidePanes: P.state().sidePanes,
      warns: window.__cdbTabsWarnCount || 0 });`), "anchor-rot-warns");
  ok(r.action === "no-columns" && r.bar === false && JSON.stringify(r.tabs) === "[]",
     "anchor rot: with both pane anchors gone there is no bar - the layout is left exactly as upstream ships it [got action=" + r.action + " bar=" + r.bar + " tabs=" + JSON.stringify(r.tabs) + " sidePanes=" + r.sidePanes + "]");
  ok(r.warns === 1,
     "anchor rot: and it warns EXACTLY once - upstream's own mirror listing side tiles while no pane resolves is unambiguous rot, not the ordinary empty state, and it used to die in total silence");
}
{
  // ... and the ordinary empty state must stay SILENT, or the warning above is noise.
  const r = run(withPage(["chat"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar(); P.reconcile();
    ${SINK}({ tabs: P.state().tabs, bar: P.barEl() !== null,
      warns: window.__cdbTabsWarnCount || 0 });`, { mirror: [] }), "empty-state-silent");
  ok(JSON.stringify(r.tabs) === "[]" && r.bar === false && r.warns === 0,
     "anchor rot: no side panel open at all stays silent - the mirror lists none, so there is nothing to disconfirm");
}
// --- M4: the bar guard must not drive computeView() on transcript churn ---------
{
  const r = run(withPage(["chat"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.start();
    setTimeout(function () {
      // No side panel is open, so there is no bar - the state in which the guard's
      // barEl() early-out does not hold.
      var noBar = P.barEl() === null;
      if (P._resetStats) P._resetStats();
      // Streamed markdown: real ELEMENT insertions inside the chat pane, exactly what
      // the other observer's filter exists to reject.
      var host = window.__col("chat");
      for (var i = 0; i < 30; i++) {
        var p = document.createElement("p");
        p.textContent = "streamed line " + i;
        host.appendChild(p);
      }
      Promise.resolve().then(function () {
        // -1 when the counter hook does not exist, so the assertion FAILS rather than
        // throwing and taking the whole run down with it.
        var churn = P._stats ? P._stats() : { computeViews: -1, renderBars: -1 };
        // And the guard must STILL put the bar back when our own bar is removed.
        ${SINK}({ noBar: noBar, churn: churn });
      });
    }, 900);`, { mirror: [] }), "bar-guard-not-driven-by-churn", 2500);
  ok(r.noBar === true,
     "bar guard: the fixture is in the no-bar state, where the cheap early-out does not apply");
  ok(r.churn.computeViews === 0,
     "bar guard: 30 streamed element insertions drive ZERO computeView() calls - it used to run a full one per childList batch in the pre-paint microtask, parsing upstream's whole store twice each time");
}
{
  // The other half: it must still restore a bar that really was removed.
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.start();
    setTimeout(function () {
      var had = P.barEl() !== null;
      P.barEl().remove();
      var gone = P.barEl() === null;
      Promise.resolve().then(function () {
        ${SINK}({ had: had, gone: gone, back: P.barEl() !== null });
      });
    }, 900);`), "bar-guard-still-restores", 2500);
  ok(r.had === true && r.gone === true && r.back === true,
     "bar guard: removing our own bar still puts it back in the same microtask - its own relevance test keys on the BAR, which isRelevant() would have filtered out");
}
// --- L1: a blocked localStorage must not be retried on every pass ---------------
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    var writes = 0;
    var realSet = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      if (k === "cdb.panelTabs.v2") { writes++; throw new Error("QuotaExceededError"); }
      return realSet(k, v);
    };
    P.setEnabled(true);
    P.reconcile(); P.reconcile(); P.reconcile(); P.reconcile(); P.reconcile();
    ${SINK}({ writes: writes, warns: window.__cdbTabsWarnCount || 0 });`),
    "blocked-storage-no-retry-storm");
  ok(r.writes <= 2,
     "blocked storage: five reconciles attempt at most two writes - the share condition used to be permanently unsatisfiable, so every pass (2Hz sweep plus every observer tick) retried a readBlob + setItem for nothing");
  ok(r.warns === 1,
     "blocked storage: and it warns exactly once");
}

// --- the OPEN/CLOSE transient --------------------------------------------------
// The user reported the layout as "jumpy" when opening and closing panels. Steady
// state was already correct, so this is purely about WHEN the reconcile runs.
//
// Row-level hiding used to be TAG-DRIVEN: a branch was hidden because we had put
// data-cdb-hide on it, so a branch upstream had only just inserted was untagged and
// therefore VISIBLE until our next pass - and that pass sat behind a 120ms debounce.
// Measured per frame before the fix (scratchpad/transient.mjs): opening put chat
// 190px off its steady width with TWO visible side branches for ~96ms, and closing
// the active panel left the whole side region blank for ~112ms.
//
// Two changes: hiding keys on ABSENCE inside an armed container, and the observer
// reconciles SYNCHRONOUSLY (a MutationObserver callback runs before layout/paint).
{
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    var host = document.getElementById("tile-host");
    P.setEnabled(true); P.start();
    function shot() {
      var chat = window.__col("chat");
      var side = document.querySelector("[data-cdb-side]");
      var kids = host.children, vis = 0, i, c, q;
      for (i = 0; i < kids.length; i++) {
        c = kids[i];
        if (c.getAttribute("data-test-col") === "chat") continue;
        if (c.classList.contains("tiles-handle")) continue;
        q = c.getBoundingClientRect();
        if (q.width >= 1 && c.querySelector("[data-pane-root]")) vis++;
      }
      return { chat: Math.round(chat.getBoundingClientRect().width),
        side: side ? Math.round(side.getBoundingClientRect().width) : null, vis: vis };
    }
    var out = {};
    setTimeout(function () {
      out.steady = shot();
      // UPSTREAM INSERTS A BRANCH.
      //
      // TWO SAMPLES, and the distinction is the whole point. SYNC is the same
      // synchronous turn as the mutation - the absence-keyed rule is the only thing
      // that can have acted, since a MutationObserver callback is a microtask and has
      // not run yet. MICRO is after the microtask queue drains, which is where the
      // observer's synchronous reconcile lands and is still BEFORE any rendering
      // opportunity, so nothing in between was ever painted.
      window.__addCol("tasks", 1);
      out.insertSync = shot();
      out.armedAfterInsert = document.querySelector("[data-cdb-armed]") !== null;
      var pIns = window.__paneOf("tasks");
      out.newPaneVisibleSync = !!pIns && pIns.getBoundingClientRect().width > 1;
      Promise.resolve().then(function () {
        out.insertMicro = shot();
        var p2 = window.__paneOf("tasks");
        out.newPaneVisibleMicro = !!p2 && p2.getBoundingClientRect().width > 1;
        out.activeMicro = window.__activeCol();
        setTimeout(function () {
          out.settledAfterInsert = shot();
          // UPSTREAM REMOVES THE ACTIVE BRANCH.
          var act = document.querySelector("[data-cdb-col-active]");
          var actId = act.getAttribute("data-cdb-col");
          window.__dropCol(actId);
          out.removedActive = actId;
          out.removeSync = shot();
          Promise.resolve().then(function () {
            out.removeMicro = shot();
            setTimeout(function () {
              out.settledAfterRemove = shot();
              ${SINK}(out);
            }, 700);
          });
        }, 700);
      });
    }, 900);`, { wrap: () => nestedRow(), mirror: ["diff", "terminal", "preview"] }),
    "transient-open-close", 4000);
  // --- OPEN
  ok(r.steady.vis === 1 && r.steady.chat > 0,
     "transient: steady state is one visible side branch");
  ok(r.insertSync.vis === 1 && r.insertSync.chat === r.steady.chat,
     "transient/open: in the SAME synchronous turn as the insertion there is still ONE visible side branch and the chat width has not moved - the absence-keyed rule hides a brand-new sibling from its very first layout, with no reconcile involved");
  ok(r.newPaneVisibleSync === false,
     "transient/open: the new panel is not yet visible in that turn - which is exactly why the reconcile must land before paint, not a debounce later");
  ok(r.newPaneVisibleMicro === true && r.activeMicro === "tasks",
     "transient/open: by the end of the microtask queue - still before any rendering opportunity - the observer's synchronous pass has made it the active chain and it IS visible, so a split flash is not traded for an empty gap");
  ok(r.insertMicro.vis === 1 && r.insertMicro.chat === r.steady.chat,
     "transient/open: and at that point it is still one visible branch at the unchanged chat width");
  ok(r.settledAfterInsert.vis === 1 && r.settledAfterInsert.chat === r.steady.chat,
     "transient/open: and it stays settled afterwards");
  // --- CLOSE
  ok(r.removeMicro.vis === 1,
     "transient/close: removing the ACTIVE branch leaves exactly one visible side branch by the microtask boundary - never a blank side region on screen");
  ok(r.removeMicro.side !== null && r.removeMicro.side > 0,
     "transient/close: and something carries the side flex again - the whole region used to go blank for ~112ms");
  ok(r.removeMicro.chat === r.steady.chat,
     "transient/close: with the chat width unchanged - it used to take the entire window");
  ok(r.settledAfterRemove.vis === 1 && r.settledAfterRemove.chat === r.steady.chat,
     "transient: settled after the close too");
  ok(r.armedAfterInsert === true,
     "transient: the absence rule's interlock is armed throughout - without it the rule would be inert and the branch visible");
}
{
  // THE INTERLOCK. The absence-keyed rule hides every non-exempt child of an armed
  // container, so arming it on a row we do not understand would hide the CHAT column.
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    var host = document.getElementById("tile-host");
    var chatW = function () { return Math.round(window.__col("chat").getBoundingClientRect().width); };
    var out = { armed: host.hasAttribute("data-cdb-armed"),
      chatExempt: window.__col("chat").hasAttribute("data-cdb-chat"),
      chatW: chatW() };
    // Disabling must unarm, or the row keeps hiding things with no reconciler left.
    P.setEnabled(false);
    out.afterDisable = { armed: document.querySelector("[data-cdb-armed]") !== null,
      chatW: chatW(),
      allVisible: [].filter.call(host.children, function (c) {
        return c.getBoundingClientRect().width > 1; }).length };
    ${SINK}(out);`), "armed-interlock");
  ok(r.armed === true && r.chatExempt === true,
     "interlock: the row is armed and the chat column carries its own exemption - the rule can never hide it");
  // NOT "the chat width is unchanged": disabling restores upstream's own split, which
  // legitimately redistributes the row across every column again. The invariant is
  // that the chat column is never HIDDEN by the interlock.
  ok(r.afterDisable.armed === false && r.afterDisable.chatW > 0,
     "interlock: disabling unarms, and the chat column still has real width - it is never the thing that gets hidden");
  ok(r.afterDisable.allVisible >= 3,
     "interlock: with the feature off every column is visible again - upstream's own split, which is the correct degraded state");
}
{
  // THE MACHINERY IS GONE, and this asserts the OBSERVABLE consequence over a full
  // start()/sweep lifetime rather than trusting the source scan above. The probe used to
  // drive upstream's own Session actions menu behind the user's back and set an
  // attribute on <html> while it did; both must now be impossible, not merely disabled.
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    // Watch EVERY attribute on <html>, not just the one the probe used to set: the
    // point is that this feature never touches the document element at all.
    var htmlAttrs = [];
    var mo = new MutationObserver(function (recs) {
      recs.forEach(function (rec) {
        if (rec.attributeName !== "style") htmlAttrs.push(rec.attributeName);
      });
    });
    // Every attribute, so this cannot become a test of the one name we remember.
    // The style attribute is EXCLUDED deliberately, and it is the only exclusion: the
    // chat/side ratio lives in --cdb-side-flex on <html>, a signed-off behaviour.
    mo.observe(document.documentElement, { attributes: true });
    P.setEnabled(true); P.start();
    setTimeout(function () {
      var bar = P.barEl();
      mo.disconnect();
      ${SINK}({ addRendered: !!bar.querySelector("[data-cdb-add]"),
        expandRendered: !!bar.querySelector("[data-cdb-expand]"),
        barChildren: [].map.call(bar.children, function (n) { return n.className; }),
        menuInDom: !!document.getElementById("cdb-tabs-menu"),
        probeStyleInjected: !!document.getElementById("cdb-probe-style"),
        anyInjectedStyle: document.querySelectorAll("style").length,
        htmlAttrsTouched: htmlAttrs,
        // The hooks are gone too, not just unused.
        hooks: [P._addMenuEnabled, P._avail, P._setAvail, P._probeAvail, P._availPending]
          .filter(function (h) { return !!h; }).length,
        warns: window.__cdbTabsWarnCount || 0 });
    }, 1600);`), "add-menu-deleted", 3000);
  ok(r.addRendered === false && r.menuInDom === false,
     "deleted: no + control is rendered and no popup exists in the DOM across a full start()/sweep lifetime");
  ok(JSON.stringify(r.barChildren) === '["cdb-tabs-strip","cdb-tabs-sep","cdb-tabs-expand"]',
     "deleted: the live bar is the strip, the separator and ⤢ - nothing else");
  ok(r.expandRendered === true,
     "deleted: the expand control stays - only the + went");
  ok(JSON.stringify(r.htmlAttrsTouched) === "[]",
     "deleted: no attribute other than `style` is ever touched on <html> - data-cdb-probe-hidden was the only one that ever was, and the probe that set it is gone (style carries --cdb-side-flex, which stays)");
  ok(r.probeStyleInjected === false,
     "deleted: the probe's hide stylesheet is never injected");
  ok(r.hooks === 0,
     "deleted: the five menu test hooks (_addMenuEnabled, _avail, _setAvail, _probeAvail, _availPending) are removed from the public surface, not left dangling");
  ok(r.warns === 0, "deleted: and it is silent");
}
{
  // With the + gone, opening a panel through UPSTREAM'S OWN control must still land
  // as a tab and get the active treatment - that is the whole fallback.
  const r = run(withPage(["chat", "diff"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.start();
    setTimeout(function () {
      var before = P.state().tabs.slice();
      // Upstream opens a panel by itself, exactly as its header button would.
      window.__addCol("terminal", 1);
      window.__mirror(["diff", "terminal"]);
      // After microtasks, which is where the observer's synchronous reconcile lands -
      // still before any paint, and long before the 120ms debounce.
      Promise.resolve().then(function () {
      var rightAway = { active: window.__activeCol(), tabs: P.state().tabs.slice() };
      setTimeout(function () {
        ${SINK}({ before: before, rightAway: rightAway,
          tabs: P.state().tabs, active: window.__activeCol(),
          activeVisible: window.__col("terminal").getBoundingClientRect().width > 1,
          writes: window.__writes(), warns: window.__cdbTabsWarnCount || 0 });
      }, 700);
      });
    }, 900);`), "upstream-open-without-add", 3000);
  ok(JSON.stringify(r.before) === '["diff"]' && JSON.stringify(r.tabs) === '["diff","terminal"]',
     "no +: a panel upstream opens by itself still becomes a tab");
  ok(r.rightAway.active === "terminal",
     "no +: and it is made active by the microtask after the insertion - before paint, not a 120ms debounce later");
  ok(r.active === "terminal" && r.activeVisible === true,
     "no +: it stays active and visible");
  ok(r.writes === 0 && r.warns === 0,
     "no +: adopting an upstream-opened panel writes nothing and warns nothing");
}

// --- the controls stay REACHABLE however many tabs there are -------------------
// The bar used to be the scroller, so the +, the ⤢ and the separator scrolled away
// with the chips. Measured live 2026-08-05 at 6 tabs: bar 1591-2085 while + sat at
// 2098-2117 and ⤢ at 2120-2139 - both past the right edge, so a user with a handful
// of panels open could not open another or expand at all.
//
// A PROGRAMMATIC .click() PASSES REGARDLESS, which is exactly why the earlier
// verification missed it. So these assert HIT-TESTING - elementFromPoint at the
// control's own centre must land on the control - as well as containment in the
// bar's visible client box.
{
  const TAB_COUNTS = [2, 6, 10];
  const KINDS = ["diff", "terminal", "preview", "artifact", "browser", "tasks",
    "pr", "simulator", "transcript", "file", "notes", "logs"];
  TAB_COUNTS.forEach((n) => {
    const tiles = ["chat"].concat(KINDS.slice(0, n));
    const r = run(withPage(tiles, `
      var P = window.__cdbTabsPage;
      P.setEnabled(true); P.reconcile(); P.renderBar();
      var bar = P.barEl();
      var br = bar.getBoundingClientRect();
      // The bar's VISIBLE box, i.e. its client rect - what the user can actually
      // reach without scrolling something.
      function probe(sel) {
        var n = bar.querySelector(sel);
        if (!n) return null;
        var q = n.getBoundingClientRect();
        var cx = Math.round(q.left + q.width / 2), cy = Math.round(q.top + q.height / 2);
        var hit = document.elementFromPoint(cx, cy);
        return { left: Math.round(q.left), right: Math.round(q.right),
          w: Math.round(q.width),
          insideBar: q.left >= br.left - 1 && q.right <= br.right + 1,
          // The hit may land on the control or on a descendant of it - both mean
          // "the pointer reaches this control".
          hitsSelf: !!hit && (hit === n || n.contains(hit)),
          hitTag: hit ? (hit.className || hit.tagName) : null };
      }
      var strip = bar.querySelector(".cdb-tabs-strip");
      ${SINK}({ tabs: P.state().tabs.length,
        bar: { left: Math.round(br.left), right: Math.round(br.right),
          w: Math.round(br.width), h: Math.round(br.height),
          scrollW: bar.scrollWidth, clientW: bar.clientWidth },
        add: probe("[data-cdb-add]"), expand: probe("[data-cdb-expand]"),
        barChildren: [].map.call(bar.children, function (x) { return x.className; }),
        strip: strip ? { scrollW: strip.scrollWidth, clientW: strip.clientWidth,
          overflowing: strip.scrollWidth > strip.clientWidth + 1 } : null,
        bodyScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 });`),
      "bar-reachable-" + n + "-tabs");
    ok(r.tabs === n, n + " tabs: the fixture really renders " + n + " tabs");
    ok(r.add === null &&
       JSON.stringify(r.barChildren) === '["cdb-tabs-strip","cdb-tabs-sep","cdb-tabs-expand"]',
       n + " tabs: there is no + at any tab count - it was DELETED, so the bar is the strip, the separator and ⤢");
    ok(r.expand.insideBar === true && r.expand.hitsSelf === true,
       n + " tabs: the ⤢ is inside the bar's visible box AND hit-tests to itself at its centre");
    ok(r.bar.h === 34,
       n + " tabs: the bar is still exactly 34px tall - the chips' scrollbar never grows it");
    ok(r.bar.scrollW <= r.bar.clientW + 1,
       n + " tabs: the BAR itself does not scroll - only the chip strip inside it does");
    ok(r.bodyScrollsX === false, n + " tabs: and the page body never scrolls horizontally");
  });
}
{
  // The chips DO scroll once they overflow, and the active chip is brought into view
  // when it changes - otherwise a Ctrl+N to an off-screen tab selects something the
  // user cannot see.
  const r = run(withPage(["chat", "diff", "terminal", "preview", "artifact", "browser", "tasks",
    "pr", "simulator", "transcript", "file"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    var strip = function () { return P.barEl().querySelector(".cdb-tabs-strip"); };
    function activeChipVisible() {
      var s = strip();
      var chip = s.querySelector('.cdb-tabs-item[data-active="1"]');
      if (!chip) return null;
      var sr = s.getBoundingClientRect(), cr = chip.getBoundingClientRect();
      return { visible: cr.left >= sr.left - 1 && cr.right <= sr.right + 1,
        scrollLeft: Math.round(s.scrollLeft),
        label: chip.querySelector("[data-cdb-tab]").getAttribute("data-cdb-tab") };
    }
    var out = { overflowing: strip().scrollWidth > strip().clientWidth + 1,
      atFirst: activeChipVisible() };
    // Ctrl+9 - the last slot, which starts scrolled out of sight.
    P.handleKey({ ctrlKey: true, code: "Digit9", key: "9",
      preventDefault: function () {}, repeat: false });
    out.afterCtrl9 = activeChipVisible();
    // ... and back to slot 1, which is now off-screen the other way.
    P.handleKey({ ctrlKey: true, code: "Digit1", key: "1",
      preventDefault: function () {}, repeat: false });
    out.afterCtrl1 = activeChipVisible();
    // MANUAL SCROLLING MUST NOT BE FOUGHT. A pass that changes neither the active tab
    // nor the strip's width leaves scrollLeft exactly where the user put it.
    strip().scrollLeft = 40;
    P.renderBar(); P.reconcile(); P.renderBar();
    out.afterManual = Math.round(strip().scrollLeft);
    // ... but a NEW active tab still reveals, even from that scrolled position.
    P.handleKey({ ctrlKey: true, code: "Digit9", key: "9",
      preventDefault: function () {}, repeat: false });
    out.afterManualThenSwitch = activeChipVisible();
    ${SINK}(out);`), "bar-active-chip-revealed");
  ok(r.overflowing === true,
     "chip strip: with 10 tabs the chips really do overflow their scroller");
  ok(r.atFirst.visible === true && r.atFirst.scrollLeft === 0,
     "chip strip: the initially-active chip is the first one and needs no scrolling");
  ok(r.afterCtrl9.label === "transcript" && r.afterCtrl9.visible === true &&
     r.afterCtrl9.scrollLeft > 0,
     "chip strip: Ctrl+9 selects the 9th tab AND scrolls it into view - the selection is never invisible");
  ok(r.afterCtrl1.label === "diff" && r.afterCtrl1.visible === true &&
     r.afterCtrl1.scrollLeft === 0,
     "chip strip: Ctrl+1 scrolls back the other way, by the smallest amount that reveals the chip");
  ok(r.afterManual === 40,
     "chip strip: a pass that changes neither the active tab nor the strip width leaves a MANUAL scroll alone - the sweep must not snap the strip back under the user");
  ok(r.afterManualThenSwitch.label === "transcript" && r.afterManualThenSwitch.visible === true,
     "chip strip: but a new active tab still reveals itself from a manually-scrolled position");
}

// --- keyboard ---------------------------------------------------------------
const KEYFN = `
    function key(k, opts) {
      var e = new KeyboardEvent("keydown", Object.assign(
        { key: k, ctrlKey: true, bubbles: true, cancelable: true }, opts || {}));
      document.dispatchEvent(e);
      return e.defaultPrevented;
    }`;
{
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar(); P.installShortcuts();
    ${KEYFN}
    var out = {};
    out.second = [key("2", { code: "Digit2" }), window.__activeCol()];
    out.third = [key("3", { code: "Digit3" }), window.__activeCol()];
    out.noCtrl = [key("1", { code: "Digit1", ctrlKey: false }), window.__activeCol()];
    out.alt = [key("1", { code: "Digit1", altKey: true }), window.__activeCol()];
    out.outOfRange = [key("9", { code: "Digit9" }), window.__activeCol()];
    out.tabChord = [key("Tab", { code: "Tab" }), window.__activeCol()];
    out.repeat = [key("1", { code: "Digit1", repeat: true }), window.__activeCol()];
    out.writes = window.__writes();
    ${SINK}(out);`), "keys-basic");
  ok(r.second[0] === true && r.second[1] === "terminal",
     "keys: Ctrl+2 activates the second tab and preventDefaults");
  ok(r.third[0] === true && r.third[1] === "preview", "keys: Ctrl+3 activates the third");
  ok(r.noCtrl[0] === false && r.noCtrl[1] === "preview" &&
     r.alt[0] === false && r.alt[1] === "preview",
     "keys: a bare digit and Ctrl+Alt+digit are both left alone");
  ok(r.outOfRange[0] === false && r.outOfRange[1] === "preview",
     "keys: Ctrl+9 with three tabs is not handled");
  ok(r.tabChord[0] === false,
     "keys: Ctrl+Tab is never claimed - the page already uses it");
  ok(r.repeat[0] === false && r.repeat[1] === "preview",
     "keys: a held key's auto-repeat is ignored");
  ok(r.writes === 0, "keys: shortcuts write nothing");
}
{
  const r = run(withPage(["chat", "diff", "terminal", "preview"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar(); P.installShortcuts();
    ${KEYFN}
    var out = {};
    // AZERTY: the unshifted number row emits punctuation for ev.key, so ev.code
    // has to be authoritative.
    out.azerty = [key("&", { code: "Digit2" }), window.__activeCol()];
    // The numpad additionally requires a digit in ev.key: with NumLock OFF the
    // same code arrives with key:"End"/"ArrowDown", and claiming those would TAKE
    // AWAY a behaviour from anyone who enables the feature.
    out.numlockOff = [key("End", { code: "Numpad1" }), window.__activeCol()];
    out.numlockOn = [key("1", { code: "Numpad1" }), window.__activeCol()];
    // No ev.code at all (some synthetic/remote-input paths): fall back to ev.key.
    out.codeFallback = [key("3", { code: "" }), window.__activeCol()];
    ${SINK}(out);`), "keys-layouts");
  ok(r.azerty[0] === true && r.azerty[1] === "terminal",
     "keys: ev.code is authoritative, so Ctrl+2 works on AZERTY where ev.key is \"&\"");
  ok(r.numlockOff[0] === false && r.numlockOff[1] === "terminal",
     "keys: a numpad key with NumLock OFF (key:\"End\") is NOT claimed");
  ok(r.numlockOn[0] === true && r.numlockOn[1] === "diff",
     "keys: the same numpad key with NumLock ON is");
  ok(r.codeFallback[0] === true && r.codeFallback[1] === "preview",
     "keys: with no ev.code at all it falls back to ev.key");
}
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar(); P.installShortcuts();
    ${KEYFN}
    var out = {};
    var xtermHost = document.createElement("div");
    xtermHost.className = "xterm xterm-screen";
    var target = document.createElement("div");
    target.setAttribute("tabindex", "0");
    xtermHost.appendChild(target);
    document.body.appendChild(xtermHost);
    target.focus();
    out.xterm = [key("2", { code: "Digit2" }), window.__activeCol()];
    var input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    out.input = [key("2", { code: "Digit2" }), window.__activeCol()];
    var ce = document.createElement("div");
    ce.setAttribute("contenteditable", "true");
    ce.setAttribute("tabindex", "0");
    document.body.appendChild(ce);
    ce.focus();
    out.editable = [key("2", { code: "Digit2" }), window.__activeCol()];
    var term2 = document.createElement("div");
    term2.setAttribute("data-ccd-terminal", "");
    var t2 = document.createElement("div");
    t2.setAttribute("tabindex", "0");
    term2.appendChild(t2);
    document.body.appendChild(term2);
    t2.focus();
    out.ccdTerminal = [key("2", { code: "Digit2" }), window.__activeCol()];
    t2.blur();
    out.activeElementAfterBlur = document.activeElement === document.body;
    out.afterBlur = [key("2", { code: "Digit2" }), window.__activeCol()];
    ${SINK}(out);`), "keys-focus-guard");
  ok(r.xterm[0] === false && r.xterm[1] === "diff",
     "keys: the shortcut stands down inside the xterm surface - a shell legitimately wants Ctrl+1");
  ok(r.input[0] === false && r.editable[0] === false && r.ccdTerminal[0] === false,
     "keys: and inside an input, a contenteditable, and [data-ccd-terminal]");
  ok(r.activeElementAfterBlur === true && r.afterBlur[0] === true && r.afterBlur[1] === "terminal",
     "keys: it works again once focus leaves the protected surface");
}
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    // COUNT THE REGISTRATION ATTEMPTS. The DOM de-duplicates an identical
    // (type, fn, capture) triple, so a duplicate install leaves no trace in the DOM,
    // and activate() is idempotent so the end state is identical after one handler or
    // three - a reviewer proved the old assertion could not fail by deleting the guard
    // outright. What the guard actually promises is that the module does not ATTEMPT a
    // redundant registration, so that is what is observed here.
    var registrations = 0;
    var realAdd = document.addEventListener.bind(document);
    document.addEventListener = function (type, fn, capture) {
      if (type === "keydown" && capture === true) registrations++;
      return realAdd(type, fn, capture);
    };
    P.installShortcuts(); P.installShortcuts(); P.installShortcuts();
    document.addEventListener = realAdd;
    ${KEYFN}
    var handled = key("2", { code: "Digit2" });
    var callsAfterOne = registrations;
    var activeWhileOn = window.__activeCol();
    P.setEnabled(false);
    var disabledHandled = key("1", { code: "Digit1" });
    ${SINK}({ handled: handled, active: activeWhileOn, callsAfterOne: callsAfterOne,
      disabledHandled: disabledHandled, tagged: window.__taggedCols() });`), "keys-install-idempotent");
  ok(r.handled === true && r.active === "terminal",
     "keys: the shortcut works after three installShortcuts() calls");
  ok(r.callsAfterOne === 1,
     "keys: three installShortcuts() calls make exactly ONE keydown registration - counted directly, because the DOM hides duplicate listeners and activate() is idempotent, so the end state alone cannot fail");
  ok(r.disabledHandled === false && JSON.stringify(r.tagged) === "[]",
     "keys: the shortcut is dead while the feature is off");
}

// --- live loop --------------------------------------------------------------
{
  // The bridge reports the pref; the loop picks it up without a restart, applies
  // the mechanism, and picks up a panel opened through upstream's own UI.
  const r = run(withPage(["chat", "diff"], `
    var P = window.__cdbTabsPage;
    var prefEnabled = false;
    window.cdbTabs = { state: function () { return Promise.resolve({ enabled: prefEnabled }); } };
    P.start();
    var out = { earlyBar: null, afterEnable: null, afterOpen: null };
    setTimeout(function () { out.earlyBar = P.barEl() !== null; prefEnabled = true; }, 100);
    setTimeout(function () {
      out.afterEnable = { bar: P.barEl() !== null, tagged: window.__taggedCols(),
        active: window.__activeCol() };
      window.__addCol("terminal");
      window.__mirror(["diff", "terminal"]);
    }, 6200);
    setTimeout(function () {
      out.afterOpen = { tabs: P.state().tabs, active: window.__activeCol(),
        hidden: window.__hiddenCols(), bar: P.barEl() !== null };
      out.writes = window.__writes();
      out.observed = P._observedRoot() === P._barObservedRoot();
      out.observedIsRow = P._observedRoot() === document.getElementById("tile-host");
      ${SINK}(out);
    }, 7000);`, { }), "live-loop", 9000);
  ok(r.earlyBar === false, "loop: nothing is rendered while the pref is off");
  ok(r.afterEnable && r.afterEnable.bar === true && r.afterEnable.active === "diff",
     "loop: the pref poll enables the feature without a restart and the bar appears");
  ok(JSON.stringify(r.afterOpen.tabs) === '["diff","terminal"]' && r.afterOpen.active === "terminal",
     "loop: a panel opened through upstream's own UI is picked up by the observer and becomes active");
  ok(JSON.stringify(r.afterOpen.hidden) === '["diff"]',
     "loop: and the previously-active column is hidden rather than unmounted");
  ok(r.writes === 0, "loop: a full page-life of reconciling writes the layout zero times");
  ok(r.observed === true && r.observedIsRow === true,
     "loop: both observers watch the SAME node - the flex row that spans every column wrapper");
}
{
  // The anti-flicker bar-guard: the bar reappears on a mutation, with no
  // debounce, because while it is missing the height-compensation rule stops
  // applying and the panel visibly jumps.
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.start();
    var out = {};
    setTimeout(function () {
      out.before = P.barEl() !== null;
      P.barEl().remove();
      out.removed = P.barEl() === null;
      // Any childList mutation in the observed row wakes the guard.
      var probe = document.createElement("div");
      document.getElementById("tile-host").appendChild(probe);
    }, 700);
    setTimeout(function () {
      out.restored = P.barEl() !== null;
      out.host = P.barEl() && P.barEl().parentElement === window.__col("diff");
      out.writes = window.__writes();
      ${SINK}(out);
    }, 760);`), "bar-guard", 2000);
  ok(r.before === true && r.removed === true, "bar-guard: the bar was up, then removed");
  ok(r.restored === true && r.host === true,
     "bar-guard: it is put back inside the active column immediately, without waiting for the debounced pass");
  ok(r.writes === 0, "bar-guard: putting the bar back writes nothing");
}
{
  const r = run(withPage(["chat", "diff"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true);
    var out = { ticks: 0 };
    P.start(); P.start(); P.start();
    var seen = 0;
    var realRender = P.renderBar;
    setTimeout(function () {
      out.bar = P.barEl() !== null;
      out.observedOnce = P._observedRoot() === P._barObservedRoot();
      P.stop();
      out.afterStop = { bar: P.barEl() !== null, observed: P._observedRoot() };
      P.stop();
      out.doubleStopOk = true;
      ${SINK}(out);
    }, 700);`), "loop-idempotent", 2000);
  ok(r.bar === true && r.observedOnce === true,
     "loop: start() is idempotent - three calls install one observer pair and one sweep");
  ok(r.afterStop.bar === false && r.afterStop.observed === null && r.doubleStopOk === true,
     "loop: stop() is idempotent too and leaves nothing live");
}

// --- surface tokens ----------------------------------------------------------
// Asserted on the stylesheet text plus the bar's own child order: the dump-dom
// harness does not resolve theme variables, so computed colour cannot be trusted
// here - the tokens and the structure can.
{
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    var css = document.querySelector("style[data-cdb-tabs]").textContent;
    function rule(re) { var m = re.exec(css); return m ? m[0] : ""; }
    var barRule = rule(/\\.cdb-tabs-bar\\{[^}]*\\}/);
    var itemRule = rule(/\\.cdb-tabs-item\\{[^}]*\\}/);
    var activeRule = rule(/\\.cdb-tabs-item\\[data-active="1"\\][^{]*\\{[^}]*\\}/);
    var hoverRule = rule(/\\.cdb-tabs-item:hover\\{[^}]*\\}/);
    var chipCss = barRule + itemRule + activeRule + hoverRule;
    ${SINK}({
      barUsesBg100: /background:hsl\\(var\\(--bg-100,\\s*[\\d.]+ [\\d.]+% [\\d.]+%\\)\\)/.test(barRule),
      barNoLongerBg200: barRule.indexOf("--bg-200") === -1,
      inactiveChip: /background:hsl\\(var\\(--bg-200,/.test(itemRule),
      activeChip: /background:hsl\\(var\\(--bg-000,/.test(activeRule),
      activeBorder: /border-color:hsl\\(var\\(--border-300,/.test(activeRule),
      chipHover: /background:hsl\\(var\\(--bg-000,/.test(hoverRule),
      controlHover: /\\.cdb-tabs-close:hover[^{]*\\{[^}]*color:hsl\\(var\\(--text-100,/.test(css),
      activeTabText: /\\.cdb-tabs-item\\[data-active="1"\\] \\.cdb-tabs-tab\\{color:hsl\\(var\\(--text-100,/.test(css),
      inactiveTabText: /\\.cdb-tabs-tab\\{[^}]*color:hsl\\(var\\(--text-300,/.test(css),
      // Every colour in the chip/bar rules must be hsl(var(--token, H S% L%)),
      // fallback triplet INSIDE var(). Strip that legal form and nothing
      // colour-shaped may be left.
      strayColour: /#[0-9a-fA-F]{3}|rgba?\\(|hsla?\\((?!var\\()/.test(
        chipCss.replace(/hsl\\(var\\(--[a-z0-9-]+,\\s*[\\d.]+ [\\d.]+% [\\d.]+%\\)(\\s*\\/\\s*[\\d.]+)?\\)/g, "")),
      focusVisibleUntouched: css.indexOf("focus-visible") === -1,
      barNoBorder: barRule.indexOf("border-bottom") === -1 });`), "bar-surface-tokens");
  ok(r.barUsesBg100 === true && r.barNoLongerBg200 === true,
     "surface: the bar paints the --bg-100 token - the same surface the chat area shows");
  ok(r.inactiveChip === true,
     "surface: resting chips sit one ramp step below the bar (--bg-200), quieter but still painted");
  ok(r.activeChip === true && r.activeBorder === true,
     "surface: the active chip is raised - a lighter --bg-000 fill plus a subtle --border-300 border");
  ok(r.chipHover === true && r.controlHover === true,
     "surface: hover states are kept, for both the chips and the right-hand controls");
  ok(r.activeTabText === true && r.inactiveTabText === true,
     "surface: the active tab gets full-strength text and inactive tabs a quieter --text-300");
  ok(r.strayColour === false,
     "surface: every colour is hsl(var(--token, H S% L%)) with the fallback triplet inside var() - no invented literals");
  ok(r.focusVisibleUntouched === true,
     "surface: the stylesheet still says nothing about :focus-visible");
  ok(r.barNoBorder === true,
     "surface: the bar's own rule carries no border-bottom - its background matches the chat surface exactly");
}

// --- labels ------------------------------------------------------------------
{
  const r = run(withPage(["chat", "diff"], `
    var P = window.__cdbTabsPage;
    ${SINK}({ known: [P.labelFor("diff"), P.labelFor("terminal"), P.labelFor("preview"),
      P.labelFor("browser"), P.labelFor("pr"), P.labelFor("tasks")],
      suffixed: P.labelFor("diff-2"), unknown: P.labelFor("weirdnew"),
      empty: P.labelFor(null) });`), "labels");
  ok(JSON.stringify(r.known) === '["Diff","Terminal","Browser","Files","PR","Tasks"]',
     "labels: the chip for tile `preview` reads \"Browser\" and the chip for tile `browser` reads \"Files\" - upstream's own names, the same ones the + uses");
  ok(r.suffixed === "Diff 2",
     "labels: an instance-suffixed tile id gets an ordinal rather than showing the raw id");
  ok(r.unknown === "Weirdnew" && r.empty === "",
     "labels: an unknown id falls back to itself, capitalised");
}

// --- degradation: unreadable mirror ------------------------------------------
{
  // With no layout mirror at all, membership falls back to the columns we can
  // actually see. The feature still works; it just cannot know upstream's order.
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    localStorage.setItem("epitaxy.sidePaneStore.v1", "{not json");
    P.setEnabled(true);
    var res = P.reconcile();
    P.renderBar();
    ${SINK}({ action: res.action, tabs: P.state().tabs, active: window.__activeCol(),
      bar: P.barEl() !== null, session: P.state().sessionId, writes: window.__writes(),
      sideFlex: P._sideFlex() });`), "unreadable-mirror");
  ok(r.action === "applied" && JSON.stringify(r.tabs) === '["diff","terminal"]',
     "degradation: with an unreadable mirror the tab strip still comes from the columns in the DOM");
  ok(r.active === "diff" && r.bar === true, "degradation: the bar still renders and a tab is still active");
  ok(r.session === "__no-session__",
     "degradation: an unresolvable session id degrades to a sentinel rather than throwing");
  ok(Math.abs(r.sideFlex - 1) < 1e-9 && r.writes === 0,
     "degradation: geometry comes from the columns' own inline flex (share 2/3 of chat 2 : side 1), and still nothing is written");
}
{
  // localStorage.setItem blocked: the active tab cannot be remembered, but every
  // switch still works. In v1 a failed persist could lose a panel outright; it
  // cannot now, because upstream's layout is the record.
  const r = run(withPage(["chat", "diff", "terminal"], `
    var P = window.__cdbTabsPage;
    P.setEnabled(true); P.reconcile(); P.renderBar();
    var real = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function () { throw new Error("blocked"); };
    var switched = P.activate("terminal");
    ${SINK}({ switched: switched, active: window.__activeCol(),
      tabs: P.state().tabs, warns: window.__cdbTabsWarnCount || 0,
      bar: P.barEl() !== null, writes: window.__writes() });`), "persist-blocked");
  ok(r.switched === true && r.active === "terminal",
     "degradation: a switch still lands when localStorage is blocked - the attribute toggle does not depend on it");
  ok(JSON.stringify(r.tabs) === '["diff","terminal"]' && r.bar === true,
     "degradation: no tab is lost - upstream's layout is the record of what is open");
  ok(r.warns === 1, "degradation: the failed persist is warned once - exactly once, so a warn-per-poll regression cannot pass");
}

console.log("\n" + pass + " passed, " + fail + " failed" + (skipped ? ", " + skipped + " skipped" : ""));
process.exit(fail ? 1 : 0);
