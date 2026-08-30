#!/usr/bin/env node
/*
 * test-files-quick-open-dom.mjs - headless-Chromium tests for the page half of
 * the Files quick open feature (js/files_quick_open_page.js, delivered by
 * patches/community/add_feature_files_quick_open.nim).
 *
 * The Files tile is REMOTE claude.ai markup, so a clean patch run proves
 * nothing about this feature. The fixture reproduces what was measured live on
 * 2026-08-29 (1.37937.3): a [data-pane-root][data-perf-screen="file"] pane with
 * an input[aria-label="Filter files"], a [role=tree] of virtualized
 * [role=treeitem] rows, and a React fiber chain on the rows whose ancestor
 * exposes memoizedProps.onPreview(path, line, findQuery) and
 * memoizedProps.entry = {name, absPath, relativePath, isDirectory, positions}.
 * The `treeHidden` fixture reproduces the second shape, measured on 1.40609.0:
 * the same pane with its tree COLLAPSED - no tree, no rows, no filter box, no
 * onPreview anywhere - and upstream's "Show file tree" button as the way back.
 * window["claude.web"].Resources.fetchMentionOptions and window.cdbQuickOpen
 * are faked; every scenario reads its assertions back through a #__result sink.
 *
 * Exits 3 when Chromium is missing so the runner records SKIP.
 * Usage: node scripts/tests/community/test-files-quick-open-dom.mjs [--keep] [--chromium PATH]
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unescapeHtml } from "../lib/unescape-html.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PAGE_SRC = readFileSync(join(ROOT, "js/files_quick_open_page.js"), "utf8");
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const CHROMIUM = (() => {
  const i = argv.indexOf("--chromium");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  for (const c of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    try { const p = execFileSync("/bin/sh", ["-c", "command -v " + c], { encoding: "utf8" }).trim(); if (p) return p; } catch {}
  }
  return null;
})();
if (!CHROMIUM) { console.log("  SKIP: no chromium on PATH"); process.exit(3); }

// Fixtures load from file://, like every other DOM suite in this repo.
//
// They used to be served over loopback HTTP, because the page module arms Ctrl+P
// only under an /epitaxy pathname and a file:// document cannot have one. That
// made this the only harness touching the network, and it could not run on a CI
// runner at all: a pending network fetch pauses Chrome's virtual clock, so
// --virtual-time-budget never expired and --dump-dom never fired. The suite
// burned a 6h workflow timeout twice before that was understood.
//
// js/files_quick_open_page.js now reads the path from data-cdb-test-path when
// (and only when) the document is file:, which is unreachable from the remote
// https page it actually runs in. So the server is gone and this suite runs
// anywhere the others do.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "cdb-qopen-fx-"));
process.on("exit", () => {
  if (!KEEP) { try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {} }
});
// Chrome needs a distinct file per scenario, or it may serve the previous one
// from cache; the counter also makes a --keep run readable.
let fixtureSeq = 0;
function writeFixture(html) {
  const file = join(FIXTURE_DIR, "case-" + (++fixtureSeq) + ".html");
  writeFileSync(file, html);
  return "file://" + file;
}

const ROOT_DIR = "/home/u/proj/";
// Mirrors HINT_NO_HANDLER in js/files_quick_open_page.js.
const HINT_NO_HANDLER = "Cannot open files: the Files panel changed (onPreview anchor missing)";
const HINT_NO_PANE = "Open the Files panel first (Session actions → Files)";
const HINT_OPENING_PANE = "Opening the Files panel…";
const FILES = [
  "modules/user/src/tests/user-run/use-cases/user-service.spec.ts",
  "modules/user/src/domain/user-run/factories/user.service.ts",
  "shared/package.json",
  "shared/packages",           // reported as a directory by the fake index -> must be skipped
  "README.md"
];

// The fake index: greedy subsequence over the relative path, spaces stripped
// (the worker patch's job - this suite is about the PAGE), the upstream result
// shape {id:"file-<abs>", label:<rel>, icon, category, metadata: JSON string}.
const WIRING = `
window.__calls = { preview: [], mention: [] };
window.__errs = [];
window.addEventListener("error", function (e) { window.__errs.push(String(e && e.message)); });
// The page's contract is "degrade to a no-op plus ONE console.warn per key, never
// a throw", so the warnings are an assertable artifact, not noise: a scenario that
// makes a remote anchor throw checks __warns for the key AND __errs for silence.
window.__warns = [];
(function () {
  var orig = console.warn;
  console.warn = function () {
    try { window.__warns.push(Array.prototype.join.call(arguments, " ")); } catch (e) {}
    return orig.apply(console, arguments);
  };
})();
var FIBER = "__reactFiber$test";
var ROOT_DIR = ${JSON.stringify(ROOT_DIR)};
var FILES = ${JSON.stringify(FILES)};
function fuzzy(q, rel) {
  var lp = rel.toLowerCase(), pos = [], from = 0;
  for (var i = 0; i < q.length; i++) { var at = lp.indexOf(q[i], from); if (at < 0) return null; pos.push(at); from = at + 1; }
  return pos;
}
window.__fakeMention = function (query, kind) {
  window.__calls.mention.push([query, kind]);
  var q = String(query).toLowerCase().replace(/\\s+/g, "");
  var out = [];
  for (var i = 0; i < FILES.length; i++) {
    var rel = FILES[i], pos = q ? fuzzy(q, rel) : [];
    if (pos === null) continue;
    out.push({ id: "file-" + ROOT_DIR + rel, label: rel, icon: "file", category: "Files",
      metadata: JSON.stringify({ path: rel, isDirectory: rel === "shared/packages", positions: pos }) });
  }
  return Promise.resolve(out);
};
window["claude.web"] = { Resources: { fetchMentionOptions: window.__fakeMention } };
window.__prefState = { ok: true, enabled: true };
window.cdbQuickOpen = { version: 1, state: function () { return Promise.resolve(window.__prefState); } };
// Fiber chain, as measured: row node -> ... -> component with {entry, onPreview, onDrillInto}
// The recorder maps an omitted argument to the string "undefined": the #__result sink
// is JSON, and JSON.stringify would flatten a real undefined to null - which is exactly
// the distinction "opened with NO line" vs "opened with a null line" needs to survive.
window.__onPreview = function (path, line, findQuery) {
  window.__calls.preview.push([path, line === undefined ? "undefined" : line, findQuery === undefined ? "undefined" : findQuery]);
};
// noHandler reproduces "the pane is there, the rows are there, but the fiber
// ancestor no longer carries onPreview" - the shape an upstream refactor of the
// tree component would produce. Everything else (entry props, tree list) stays.
// __throwRowProps reproduces the nastiest remote shape: memoizedProps is an
// accessor on the row's own fiber that THROWS when the page reads it. React does
// not do this today, but the props object is remote code we do not control, and
// the fiber walk must not turn it into an unhandled page error. Set it from a
// scenario body BEFORE the rows are (re-)wired.
window.__throwRowProps = false;
window.__wireRow = function (row, rel, noHandler) {
  var entry = { name: rel.split("/").pop(), absPath: ROOT_DIR + rel, relativePath: rel, isDirectory: false, positions: [] };
  var props = { entry: entry, onDrillInto: function () {}, showPath: true };
  if (!noHandler) props.onPreview = window.__onPreview;
  var comp = { memoizedProps: props, return: null };
  var mid = { memoizedProps: { onContextMenu: function () {} }, return: comp };
  var leaf = { return: mid };
  if (window.__throwRowProps)
    Object.defineProperty(leaf, "memoizedProps", { get: function () { throw new Error("remote memoizedProps getter exploded"); } });
  else leaf.memoizedProps = {};
  row[FIBER] = leaf;
};
// Live on 1.40609.0 the walk up from the TREE (and from the filter box) finds no
// onPreview at all - only a row reaches it. Fixtures that set treeNoHandler
// reproduce that; the default keeps the handler on the tree's ancestor too, which
// is what the "no rendered rows" scenario harvests from.
window.__wireTree = function (tree, noHandler) {
  var props = { results: [], isFetching: false, onDrillInto: function () {} };
  if (!noHandler) props.onPreview = window.__onPreview;
  var list = { memoizedProps: props, return: null };
  tree[FIBER] = { memoizedProps: { role: "tree" }, return: list };
};
// Measured live: the component that owns onPreview also carries the folder the
// tile shows as a string \`root\` prop, WITHOUT a trailing slash.
window.__setRootProp = function (root) {
  document.querySelectorAll("[role=treeitem]").forEach(function (r) { r[FIBER].return.return.memoizedProps.root = root; });
  var t = document.querySelector("[data-test-tree]"); if (t) t[FIBER].return.memoizedProps.root = root;
};
window.__key = function (target, key, mods) {
  var ev = new KeyboardEvent("keydown", Object.assign({ key: key, bubbles: true, cancelable: true }, mods || {}));
  (target || document.body).dispatchEvent(ev);
  return ev.defaultPrevented;
};
window.__ctrlP = function (target) { return window.__key(target, "p", { ctrlKey: true }); };
window.__type = function (text) {
  var inp = document.querySelector("#cdb-qopen input.cdb-qopen-input");
  inp.value = text; inp.dispatchEvent(new Event("input", { bubbles: true }));
  return inp;
};
window.__rows = function () { return Array.prototype.slice.call(document.querySelectorAll("#cdb-qopen [role=option]")); };
window.__rowText = function () { return window.__rows().map(function (r) { return r.querySelector(".cdb-qopen-name").textContent + " | " + r.querySelector(".cdb-qopen-dir").textContent; }); };
window.__hint = function () { var h = document.querySelector("#cdb-qopen .cdb-qopen-hint"); return h ? h.textContent : null; };
window.__open = function () { return !!document.getElementById("cdb-qopen"); };
window.__treeBtnLabel = function () { var b = document.querySelector("#host button"); return b ? b.getAttribute("aria-label") : null; };
`;

// treeHidden reproduces the live shape the page was blind to before: the Files
// pane showing an open file with its tree COLLAPSED - no tree, no rows, no filter
// box, nothing exposing onPreview - and upstream's "Show file tree" toolbar
// button as the only way back. Clicking that button (a real listener here, as in
// the app) renders exactly the markup + fibers the normal fixture starts with and
// relabels the button, which is what the page waits for.
function fixture(opts) {
  const o = Object.assign({ pane: true, rows: true, handler: true, terminal: false,
    treeHidden: false, showTreeBtn: true, treeNoHandler: false,
    coldRows: null, coldDelayMs: 200, path: "/epitaxy/local_abc",
    // No Files pane at all: upstream's session ⋮ menu is the only way to get one.
    // Measured 1.40609.0: the ⋮ is NOT a sibling of the Terminal/Diff/Browser
    // toolbar buttons - it sits 2 parents up, in the one ancestor that contains
    // exactly one `More options for …` button. The menu renders async and its
    // Files entry reads "FilesCtrlF" (label + shortcut, no separator).
    paneOpener: false, filesMenuItem: true, menuDelayMs: 150, paneDelayMs: 300,
    openedPaneTreeHidden: false,
    // Measured 1.40609.0 on a pane opened from scratch: the tree renders with NO
    // rows, and the component owning onPreview is reachable only by DESCENDING
    // from the pane root - walking up from the tree or filter box finds nothing.
    paneListFiber: false }, opts || {});
  const rowsHtml = o.rows ? FILES.filter((f) => f !== "shared/packages").slice(0, 3).map((f, i) =>
    `<div role="treeitem" aria-level="1" data-test-rel="${f}">${f.split("/").pop()}</div>`).join("") : "";
  const treeHtml = `<input type="text" aria-label="Filter files" placeholder="Filter files… (? to search contents)">
      <div role="tree" data-test-tree="">${rowsHtml}</div>`;
  // COLD RENDER (measured 1.40609.0): the [role=tree] element commits BEFORE its
  // rows. coldRows === false means they never arrive at all.
  const emptyTreeHtml = `<input type="text" aria-label="Filter files" placeholder="Filter files… (? to search contents)">
      <div role="tree" data-test-tree=""></div>`;
  const paneBody = o.treeHidden
    ? `${o.showTreeBtn ? `<button type="button" aria-label="Show file tree" aria-pressed="false">tree</button>` : ""}
      <div data-test-editor="">README.md</div><div data-test-slot=""></div>`
    : treeHtml;
  const pane = o.pane ? `
    <div data-pane-root="" data-perf-screen="file" class="epitaxy-view-panel">
      <span>Files</span>
      ${paneBody}
    </div>` : "";
  const term = o.terminal ? `<div data-pane-root="" data-perf-screen="terminal"><div class="xterm"><textarea class="xterm-helper-textarea" id="term-input"></textarea></div></div>` : "";
  // Upstream's session header: the toolbar buttons in one wrapper, the ⋮ a level
  // out - the shape the page's structural climb (seed → ancestor holding exactly
  // one "More options for …") has to resolve.
  const opener = o.paneOpener ? `
    <div class="hdr-outer" style="display:flex">
      <div class="hdr-inner" style="display:flex">
        <button type="button" aria-label="Terminal">t</button>
        <button type="button" aria-label="Diff (uncommitted changes)">d</button>
        <button type="button" aria-label="Browser">b</button>
      </div>
      <button type="button" aria-label="More options for Test session">⋮</button>
    </div>` : "";
  // The pane the menu entry creates. Either shape is possible live: tree already
  // rendered, or the pane arriving with its tree collapsed (then the page has to
  // press "Show file tree" itself before anything exposes onPreview).
  const openedPaneHtml = `<div data-pane-root="" data-perf-screen="file" class="epitaxy-view-panel"><span>Files</span>` +
    (o.openedPaneTreeHidden
      ? `<button type="button" aria-label="Show file tree" aria-pressed="false">tree</button><div data-test-editor="">README.md</div><div data-test-slot=""></div>`
      : treeHtml) + `</div>`;
  // data-cdb-test-path is how a file:// document tells the page module which
  // route it is standing in for; see onCodeTab() in js/files_quick_open_page.js.
  // Keeping o.path as the source means every scenario's route stays exactly as
  // it was when these fixtures were served over HTTP.
  return { path: o.path, html: `<!doctype html><html data-cdb-test-path="${o.path}"><meta charset="utf-8">
<div id="host">${opener}${pane}${term}</div>
<pre id="__result"></pre>
<script>${WIRING}</script>
<script>
  var NO_HANDLER = ${o.handler === false};
  var TREE_NO_HANDLER = ${o.treeNoHandler === true};
  var COLD = ${o.coldRows !== null}, COLD_ROWS = ${o.coldRows === true}, COLD_MS = ${o.coldDelayMs};
  var PANE_LIST_FIBER = ${o.paneListFiber === true};
  // The live shape: a list component below the pane root carries onPreview (and
  // the tile's root prop), independent of whether any row is rendered.
  window.__wirePaneList = function (pane) {
    if (!pane) return;
    var list = { memoizedProps: { sessionId: "s1", root: ROOT_DIR.substring(0, ROOT_DIR.length - 1),
      listDirectory: function () {}, onPreview: window.__onPreview, prefetcher: {} }, child: null, sibling: null, return: null };
    var mid = { memoizedProps: { className: "pane-body" }, child: list, sibling: null, return: null };
    pane[FIBER] = { memoizedProps: {}, child: mid, sibling: null, return: null };
  };
  window.__wireAll = function () {
    var tree = document.querySelector("[data-test-tree]"); if (tree) window.__wireTree(tree, NO_HANDLER || TREE_NO_HANDLER);
    document.querySelectorAll("[role=treeitem]").forEach(function (r) { window.__wireRow(r, r.getAttribute("data-test-rel"), NO_HANDLER); });
    if (PANE_LIST_FIBER) window.__wirePaneList(document.querySelector('[data-perf-screen="file"]'));
  };
  window.__wireAll();
  var showBtn = document.querySelector('button[aria-label="Show file tree"]');
  if (showBtn) showBtn.addEventListener("click", function () {
    // WARM: tree + rows in one commit. COLD (measured 1.40609.0): the tree
    // element commits first and its rows COLD_MS later - or never, when
    // COLD_ROWS is false. The cold shape is what broke the open path: a poll
    // that stops at "a tree exists" harvests nothing and never tries again.
    document.querySelector("[data-test-slot]").innerHTML = COLD ? ${JSON.stringify(emptyTreeHtml)} : ${JSON.stringify(treeHtml)};
    window.__wireAll();
    showBtn.setAttribute("aria-label", "Hide file tree");
    showBtn.setAttribute("aria-pressed", "true");
    // Upstream's own React handler moves focus into the freshly rendered tree UI
    // (its "Filter files" box). Our modal must take focus back, or every keystroke
    // typed after the tree appears lands in upstream's filter instead.
    var filter = document.querySelector('input[aria-label="Filter files"]');
    if (filter) filter.focus();
    // recorded so the "focus came back" assertion cannot pass vacuously
    window.__filterStoleFocus = !!filter && document.activeElement === filter;
    if (COLD && COLD_ROWS) setTimeout(function () {
      var tree = document.querySelector("[data-test-tree]");
      if (tree) { tree.innerHTML = ${JSON.stringify(rowsHtml)}; window.__wireAll(); }
    }, COLD_MS);
  });
  // The session ⋮ → Files path, with upstream's own async stages: the menu renders
  // after the click, and the pane mounts after the entry is chosen. __menuOpens /
  // __filesClicks make "we drove upstream's real controls" provable, not assumed.
  window.__menuOpens = 0; window.__filesClicks = 0;
  var moreBtn = document.querySelector('button[aria-label^="More options for "]');
  if (moreBtn) moreBtn.addEventListener("click", function () {
    window.__menuOpens++;
    if (document.getElementById("test-menu")) return;
    setTimeout(function () {
      var m = document.createElement("div");
      m.id = "test-menu";
      m.innerHTML = '<div role="menuitem">Artifacts</div>' +
        (${o.filesMenuItem !== false} ? '<div role="menuitem">Files\\u2318CtrlF</div>' : "") +
        '<div role="menuitem">Background tasks</div><div role="menuitem">Rename</div>';
      document.body.appendChild(m);
      // A real menu closes on Escape, so the fixture does too - but note that
      // upstream's own menu on 1.40609.0 does NOT (measured: no synthetic event
      // closes it). Live it stays mounted behind our overlay and goes away with
      // it; this only asserts the page ATTEMPTS the dismissal, never that
      // upstream obeys.
      document.addEventListener("keydown", function esc(e) {
        if (e.key !== "Escape") return;
        document.removeEventListener("keydown", esc);
        m.parentNode && m.parentNode.removeChild(m);
      });
      var items = m.querySelectorAll('[role=menuitem]');
      for (var i = 0; i < items.length; i++) {
        if (!/^files/i.test(items[i].textContent.replace(/[^\\x20-\\x7e]/g, "").trim())) continue;
        items[i].addEventListener("click", function () {
          window.__filesClicks++;
          m.parentNode && m.parentNode.removeChild(m);
          setTimeout(function () {
            document.getElementById("host").insertAdjacentHTML("beforeend", ${JSON.stringify(openedPaneHtml)});
            window.__wireAll();
            var sb = document.querySelector('button[aria-label="Show file tree"]');
            if (sb) sb.addEventListener("click", function () {
              document.querySelector("[data-test-slot]").innerHTML = ${JSON.stringify(treeHtml)};
              window.__wireAll();
              sb.setAttribute("aria-label", "Hide file tree");
            });
          }, ${o.paneDelayMs});
        });
      }
    }, ${o.menuDelayMs});
  });
  window.__cdbQoTestPollMs = 300;
</script>
<script>${PAGE_SRC}</script>
<script>if (window.__cdbQuickOpenPage) window.__cdbQuickOpenPage.start();</script>
<script>${o.body || ""}</script>` };
}

// Per-scenario wall clock for the browser child. Every scenario here finishes in
// a couple of seconds; this only ever fires on a wedged browser.
const SCENARIO_TIMEOUT_MS = Number(process.env.CDB_QOPEN_SCENARIO_TIMEOUT_MS || 60000);
// The preflight only has to render a static page, so it can give up much sooner
// than a real scenario: this is the "can this browser work here at all" probe.
const PREFLIGHT_TIMEOUT_MS = Number(process.env.CDB_QOPEN_PREFLIGHT_TIMEOUT_MS || 25000);

// Removing a Chrome profile races the browser's own teardown: a SIGKILLed Chrome
// leaves its crashpad handler writing into <profile>/Default for a moment, and
// rmSync then throws ENOTEMPTY even with force:true (force only suppresses
// "missing", not "busy"). That throw escaped a finally block and turned a
// deliberate SKIP into a crash in CI. Cleanup of a temp dir must never decide
// the outcome of a test run.
function rmProfile(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (e) { /* a leftover temp dir is the OS's problem, not a test result */ }
}

// The browser invocation, shared by the preflight and every scenario.
//
// KNOWN LIMITATION: this suite does not run on GitHub's hosted runners.
//
// The mechanism is understood: --dump-dom fires when the load completes, and a
// PENDING NETWORK FETCH PAUSES CHROME'S VIRTUAL CLOCK, so --virtual-time-budget
// never expires and the dump never fires (demonstrated directly: against a
// server that accepts a connection and never answers, a 2.5s budget was still
// running at 45s). This is the only harness that loads its fixture over
// loopback HTTP instead of file:// - it has to, because the page module arms
// Ctrl+P only under a real /epitaxy pathname and a file:// document cannot have
// one - which is why no sibling harness is affected.
//
// What is NOT established is why the loopback fetch fails to complete on a
// runner. Two attempts did not fix it, and both are recorded here so nobody
// repeats them: the GCM/component-updater theory (the failing run's stderr
// showed GCM DEPRECATED_ENDPOINT / PHONE_REGISTRATION_ERROR retrying 25s apart,
// but disabling background networking changed nothing) and an ambient-proxy
// theory (Chrome bypasses proxies for localhost; verified unnecessary). The
// decisive datapoint against both: the preflight below renders a STATIC page
// with no script, no timers and no subresources, and it still wedges there.
//
// So the flags below are hardening, not a fix, and the preflight is what keeps
// this honest: an environment that cannot run the browser reports SKIP and says
// what went unverified, rather than masquerading as either a pass or a code
// regression. Run this suite locally, where it passes, before trusting a change
// to js/files_quick_open_page.js.
const CHROME_ARGS = (dir, budgetMs, url) => ["--headless", "--disable-gpu", "--no-sandbox",
  "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
  "--no-proxy-server",
  "--disable-background-networking", "--disable-sync",
  "--disable-component-update", "--disable-default-apps",
  "--disable-client-side-phishing-detection", "--metrics-recording-only",
  "--user-data-dir=" + dir,
  "--virtual-time-budget=" + budgetMs, "--dump-dom",
  url];

// PREFLIGHT: prove this browser can complete a loopback load + virtual-time dump
// AT ALL before running assertions, and separate the two failure meanings:
//
//   browser cannot render here          -> exit 3, reported SKIP (environment)
//   browser renders, an assertion fails -> exit 1, reported FAIL (our regression)
//
// Without this split a browser that wedges in one environment reads as a code
// regression and blocks every release until someone reads the log. That is the
// same convention this file already uses for "no chromium on PATH" (exit 3), and
// the same one scripts/tests/community/test-diff-views-expand-dom.mjs uses for a
// missing font. The SKIP is deliberately loud about what went unverified - a
// silent skip would be the false-positive the project forbids.
function preflight() {
  const dir = mkdtempSync(join(tmpdir(), "cdb-qopen-pre-"));
  const url = writeFixture('<!doctype html><html><body><pre id="__result">{"preflight":true}</pre></body></html>');
  try {
    const dom = execFileSync(CHROMIUM, CHROME_ARGS(dir, 1500, url),
      { encoding: "utf8", timeout: PREFLIGHT_TIMEOUT_MS, killSignal: "SIGKILL" });
    return /<pre id="__result">/.test(dom);
  } catch (e) {
    return false;
  } finally { if (!KEEP) rmProfile(dir); }
}

function run(fx, name, budgetMs) {
  const dir = mkdtempSync(join(tmpdir(), "cdb-qopen-"));   // a per-scenario Chrome profile: no localStorage leaks between cases
  const url = writeFixture(fx.html);
  try {
    // TIMEOUT - this bound is load-bearing, do not remove it.
    //
    // This is the ONLY harness in the repo that loads its fixture over
    // http://127.0.0.1 instead of file:// (it has to: the page module arms
    // Ctrl+P only under /epitaxy, and a file:// document cannot have a real
    // location.pathname). That difference is what made it able to hang forever:
    // --dump-dom fires when the load completes, and a PENDING NETWORK FETCH
    // PAUSES CHROME'S VIRTUAL CLOCK, so --virtual-time-budget never expires and
    // the dump never fires. Demonstrated directly - against a server that
    // accepts the connection and never responds, a 2.5s virtual-time budget was
    // still running at 45s. A file:// load cannot stall this way, which is why
    // no sibling harness could burn a job. With no timeout on execFileSync that
    // wedge is unbounded, and on GitHub's runners it consumed the full 6h
    // workflow timeout twice, reporting nothing.
    //
    // So: bound every launch and name the scenario, turning a silent stall into
    // a fast, diagnosable failure. scripts/run-feature-tests.sh carries a
    // second, per-harness bound as defence in depth.
    //
    // The flags are hardening, NOT the fix: --no-proxy-server was verified to be
    // unnecessary (Chrome bypasses proxies for localhost - the pre-fix harness
    // passes with http_proxy pointed at a black hole), it is kept only so the
    // loopback fetch cannot depend on ambient proxy config at all.
    let dom;
    try {
      dom = execFileSync(CHROMIUM, CHROME_ARGS(dir, budgetMs || 2500, url),
        { encoding: "utf8", timeout: SCENARIO_TIMEOUT_MS, killSignal: "SIGKILL" });
    } catch (e) {
      if (e && (e.code === "ETIMEDOUT" || e.killed)) {
        throw new Error("chromium hung for scenario \"" + name + "\" (killed after " +
          SCENARIO_TIMEOUT_MS + "ms) -- browser: " + CHROMIUM);
      }
      throw e;
    }
    const m = dom.match(/<pre id="__result">([\s\S]*?)<\/pre>/);
    if (!m) throw new Error("no #__result sink in dumped DOM for " + name);
    return JSON.parse(unescapeHtml(m[1]));
  } finally { if (!KEEP) rmProfile(dir); }
}

// The data-cdb-test-path seam exists only so this suite can use file:// like
// every other DOM harness. It MUST stay unreachable from the remote https page
// the module actually runs in - otherwise claude.ai markup could arm Ctrl+P
// outside the Code tab. This runs onCodeTab() directly against both protocols,
// so it needs no browser and cannot be skipped by an environment.
{
  const src = readFileSync(join(ROOT, "js/files_quick_open_page.js"), "utf8");
  const body = (src.match(/function onCodeTab\(\) \{[\s\S]*?\n  \}/) || [])[0];
  const armed = (protocol) => {
    const fn = new Function("window", "document", body + "; return onCodeTab();");
    return fn({ location: { protocol, pathname: "/settings" } },
              { documentElement: { getAttribute: () => "/epitaxy" } });
  };
  let pre = 0, preFail = 0;
  const t = (c, n) => { if (c) { pre++; console.log("  ok   " + n); } else { preFail++; console.log("  FAIL " + n); } };
  t(!!body, "onCodeTab() is still shaped so this check can read it");
  t(armed("file:") === true, "file: honours data-cdb-test-path (the harness depends on this)");
  t(armed("https:") === false, "https: IGNORES data-cdb-test-path - remote code cannot arm the hotkey");
  t(armed("http:") === false, "http: ignores it too");
  if (preFail) { console.log("\n" + pre + " passed, " + preFail + " failed"); process.exit(1); }
}

if (!preflight()) {
  console.log("  SKIP: this browser cannot complete a loopback load + virtual-time DOM dump here.");
  console.log("        Browser: " + CHROMIUM);
  console.log("        NOT verified: every page-half assertion in this suite - the Ctrl+P hotkey,");
  console.log("        the fiber harvest and its bounds, the degrade-to-a-warning paths, the IME and");
  console.log("        auto-repeat guards, the pane/tree creation flows, and the MRU.");
  console.log("        This is an ENVIRONMENT result, not a pass: run it on a machine with a working");
  console.log("        headless Chromium before trusting a change to js/files_quick_open_page.js.");
  process.exit(3);
}

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const SINK = 'document.getElementById("__result").textContent = JSON.stringify';
// Every scenario waits for the first pref poll (pref on) before pressing keys.
const AFTER_PREF = (body) => `setTimeout(function () { ${body} }, 50);`;

// --- open / close -----------------------------------------------------------------
{
  const r = run(fixture({ body: AFTER_PREF(`
    var out = {};
    out.prevented = window.__ctrlP();
    out.open = window.__open();
    out.focused = document.activeElement === document.querySelector("#cdb-qopen input.cdb-qopen-input");
    out.role = document.querySelector("#cdb-qopen [role=dialog]") ? "dialog" : null;
    window.__key(document.querySelector("#cdb-qopen input"), "Escape");
    out.closedByEsc = !window.__open();
    window.__ctrlP(); var again = window.__open(); window.__ctrlP(); out.toggleCloses = again && !window.__open();
    window.__ctrlP(); document.querySelector("#cdb-qopen").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); out.backdropCloses = !window.__open();
    ${SINK}(out);`) }), "open-close");
  ok(r.prevented === true, "Ctrl+P is intercepted (preventDefault) on the Code tab with the pref on");
  ok(r.open === true && r.role === "dialog", "the modal mounts as #cdb-qopen with a role=dialog box");
  ok(r.focused === true, "the input has focus on open");
  ok(r.closedByEsc === true, "Escape closes it");
  ok(r.toggleCloses === true, "a second Ctrl+P closes it");
  ok(r.backdropCloses === true, "a click on the backdrop closes it");
}
// --- search + render ----------------------------------------------------------------
{
  const r = run(fixture({ body: AFTER_PREF(`
    window.__ctrlP(); window.__type("user service");
    setTimeout(function () {
      var out = { rows: window.__rowText(), marks: window.__rows()[0].querySelectorAll("mark").length,
        mention: window.__calls.mention.slice(-1)[0], count: window.__rows().length };
      out.noDirs = window.__rowText().every(function (t) { return t.indexOf("packages |") !== 0; });
      ${SINK}(out);
    }, 400);`) }), "search-render");
  ok(r.mention && r.mention[0] === "user service" && r.mention[1] === "files", "the query goes to fetchMentionOptions(q, \"files\") verbatim (the worker handles spaces)");
  ok(r.rows[0] === "user-service.spec.ts | modules/user/src/tests/user-run/use-cases", "row = basename | dirname: " + r.rows[0]);
  ok(r.count === 2 && r.noDirs, "only the two user-service files render; the directory result is skipped");
  ok(r.marks > 0, "match positions render as <mark>: " + r.marks);
}
{
  // 15-row cap: a query every file matches ("") is the MRU path, so seed 20 fake files by
  // overriding the fake and use a one-letter query.
  const r = run(fixture({ body: AFTER_PREF(`
    window["claude.web"].Resources.fetchMentionOptions = function (q) {
      var out = []; for (var i = 0; i < 40; i++) out.push({ id: "file-" + ROOT_DIR + "f" + i + ".ts", label: "f" + i + ".ts", metadata: JSON.stringify({ path: "f" + i + ".ts", isDirectory: false, positions: [0] }) });
      return Promise.resolve(out);
    };
    window.__ctrlP(); window.__type("f");
    setTimeout(function () { ${SINK}({ count: window.__rows().length }); }, 400);`) }), "cap");
  ok(r.count === 15, "at most 15 rows are rendered from a 40-result answer (" + r.count + ")");
}
// --- IME composition + key autorepeat -----------------------------------------------
// Both guards protect against a WRONG ACTION, not a no-op, so they get their own
// scenario. Enter/Arrow/Escape belong to the IME while a composition is open, and
// a held Ctrl+P auto-repeats onto open(), which is a toggle.
{
  const r = run(fixture({ body: AFTER_PREF(`
    window.__ctrlP(); window.__type("user service");
    setTimeout(function () {
      var inp = document.querySelector("#cdb-qopen input");
      var out = {};
      // A composing Enter must NOT open a file and must NOT close the box.
      window.__key(inp, "Enter", { isComposing: true });
      out.previewAfterComposingEnter = window.__calls.preview.slice();
      out.openAfterComposingEnter = window.__open();
      // Legacy IME path: some engines report keyCode 229 instead.
      window.__key(inp, "Enter", { keyCode: 229 });
      out.previewAfter229 = window.__calls.preview.slice();
      // A composing arrow must not move our selection out from under the IME.
      var before = window.__rows().findIndex(function (x) { return x.getAttribute("aria-selected") === "true"; });
      window.__key(inp, "ArrowDown", { isComposing: true });
      out.selMoved = window.__rows().findIndex(function (x) { return x.getAttribute("aria-selected") === "true"; }) !== before;
      // A committed (non-composing) Enter still works.
      window.__key(inp, "Enter");
      out.previewAfterRealEnter = window.__calls.preview.slice();
      // Autorepeat must not be treated as handled, and must not toggle the modal.
      var wasOpen = window.__open();
      out.repeatPrevented = window.__key(document.body, "p", { ctrlKey: true, repeat: true });
      out.openUnchangedByRepeat = window.__open() === wasOpen;
      ${SINK}(out);
    }, 400);`) }), "ime-repeat");
  ok(r.previewAfterComposingEnter.length === 0, "a composing Enter opens nothing");
  ok(r.openAfterComposingEnter === true, "and leaves the box open");
  ok(r.previewAfter229.length === 0, "the legacy keyCode 229 IME path is guarded too");
  ok(r.selMoved === false, "a composing ArrowDown does not move the selection");
  ok(r.previewAfterRealEnter.length === 1, "a real, committed Enter still opens the file");
  ok(r.repeatPrevented === false, "an auto-repeated Ctrl+P is not treated as handled");
  ok(r.openUnchangedByRepeat === true, "and does not toggle the modal");
}
// --- keyboard + mouse open ----------------------------------------------------------
{
  const r = run(fixture({ body: AFTER_PREF(`
    window.__ctrlP(); window.__type("user service");
    setTimeout(function () {
      var inp = document.querySelector("#cdb-qopen input");
      window.__key(inp, "ArrowDown");
      var selIdx = window.__rows().findIndex(function (r) { return r.getAttribute("aria-selected") === "true"; });
      window.__key(inp, "Enter");
      var out = { selIdx: selIdx, preview: window.__calls.preview.slice(), closed: !window.__open() };
      // mouse: reopen, click the first row
      window.__ctrlP(); window.__type("user service");
      setTimeout(function () {
        window.__rows()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
        out.previewAfterClick = window.__calls.preview.slice();
        out.mru = JSON.parse(localStorage.getItem("cdb-qopen-mru:" + ROOT_DIR) || "[]");
        ${SINK}(out);
      }, 400);
    }, 400);`) }), "pick");
  ok(r.selIdx === 1, "ArrowDown moves the selection to the second row");
  ok(r.preview.length === 1 && r.preview[0][0] === ROOT_DIR + "modules/user/src/domain/user-run/factories/user.service.ts" && r.preview[0][1] === "undefined",
     "Enter calls onPreview(<tileRoot>/<rel>) of the selected row with no line: " + JSON.stringify(r.preview));
  ok(r.closed === true, "the modal closes after opening a file");
  ok(r.previewAfterClick.length === 2 && r.previewAfterClick[1][0] === ROOT_DIR + "modules/user/src/tests/user-run/use-cases/user-service.spec.ts",
     "a mouse click opens that row");
  ok(JSON.stringify(r.mru) === JSON.stringify(["modules/user/src/tests/user-run/use-cases/user-service.spec.ts", "modules/user/src/domain/user-run/factories/user.service.ts"]),
     "MRU is most-recent-first under cdb-qopen-mru:<tileRoot>: " + JSON.stringify(r.mru));
}
{
  const r = run(fixture({ body: AFTER_PREF(`
    window.__ctrlP(); window.__type("readme:42");
    setTimeout(function () {
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      ${SINK}({ preview: window.__calls.preview, mention: window.__calls.mention.slice(-1)[0] });
    }, 400);`) }), "line-suffix");
  ok(r.mention[0] === "readme", "a trailing :<n> is stripped from the search text");
  ok(r.preview.length === 1 && r.preview[0][0] === ROOT_DIR + "README.md" && r.preview[0][1] === 42, "and passed to onPreview as the line: " + JSON.stringify(r.preview));
}
// --- MRU on empty query -------------------------------------------------------------
{
  const r = run(fixture({ body: `
    localStorage.setItem("cdb-qopen-mru:" + ROOT_DIR, JSON.stringify(["shared/package.json", "README.md"]));
    ${AFTER_PREF(`window.__ctrlP(); setTimeout(function () { ${SINK}({ rows: window.__rowText(), mention: window.__calls.mention.length }); }, 300);`)}` }), "mru");
  ok(JSON.stringify(r.rows) === JSON.stringify(["package.json | shared", "README.md | "]), "empty query lists the MRU, most recent first: " + JSON.stringify(r.rows));
  ok(r.mention === 0, "and does not call the index for an empty query");
}
// --- guards -----------------------------------------------------------------------
{
  const r = run(fixture({ pane: false, body: AFTER_PREF(`
    window.__ctrlP(); var hint = window.__hint(); window.__key(document.querySelector("#cdb-qopen input"), "Enter");
    ${SINK}({ open: window.__open(), hint: hint, preview: window.__calls.preview.length });`) }), "no-pane");
  ok(r.open === true && r.hint === "Open the Files panel first (Session actions → Files)", "no Files pane: the modal opens with the hint: " + r.hint);
  ok(r.preview === 0, "and Enter opens nothing");
}
{
  const r = run(fixture({ terminal: true, body: AFTER_PREF(`
    var t = document.getElementById("term-input"); t.focus();
    var prevented = window.__ctrlP(t);
    ${SINK}({ prevented: prevented, open: window.__open() });`) }), "terminal-focus");
  ok(r.prevented === false && r.open === false, "Ctrl+P inside an .xterm is left to the terminal");
}
{
  const r = run(fixture({ path: "/new", body: AFTER_PREF(`${SINK}({ prevented: window.__ctrlP(), open: window.__open() });`) }), "not-code-tab");
  ok(r.prevented === false && r.open === false, "outside /epitaxy the key is not intercepted");
}
{
  const r = run(fixture({ body: AFTER_PREF(`
    window.__ctrlP(); var wasOpen = window.__open();
    window.__prefState = { ok: true, enabled: false };
    setTimeout(function () { var closed = !window.__open(); var p = window.__ctrlP(); ${SINK}({ wasOpen: wasOpen, closed: closed, prevented: p, open: window.__open() }); }, 700);`) }), "pref-off", 3000);
  ok(r.wasOpen === true && r.closed === true, "turning the pref off closes an open modal on the next poll");
  ok(r.prevented === false && r.open === false, "and Ctrl+P is no longer intercepted");
}
{
  // The bridge is gone by the time start()'s FIRST poll has already answered, so this
  // scenario waits a full poll interval (300ms in test mode) for the page to notice.
  const r = run(fixture({ body: `delete window.cdbQuickOpen;
    setTimeout(function () { ${SINK}({ prevented: window.__ctrlP(), open: window.__open() }); }, 500);` }), "no-bridge");
  ok(r.prevented === false && r.open === false, "no window.cdbQuickOpen: silent no-op");
}
{
  const r = run(fixture({ rows: false, body: AFTER_PREF(`
    window.__ctrlP(); window.__type("readme");
    setTimeout(function () { window.__key(document.querySelector("#cdb-qopen input"), "Enter"); ${SINK}({ preview: window.__calls.preview }); }, 400);`) }), "no-rows");
  ok(r.preview.length === 1 && r.preview[0][0] === ROOT_DIR + "README.md",
     "with zero rendered rows the handler is harvested from the tree and the path comes from the index id: " + JSON.stringify(r.preview));
}
{
  // Zero rendered rows -> no tile root. The MRU is keyed by that root and holds
  // RELATIVE paths, so with no root it must be disabled in BOTH directions:
  // never read (a root-less key would yield rows whose "absolute" path is the
  // relative one, and upstream's onPreview does path.startsWith(...)) and never
  // written (that key would shadow the real per-root MRU). Both keys are seeded.
  const r = run(fixture({ rows: false, body: `
    localStorage.setItem("cdb-qopen-mru:", JSON.stringify(["shared/package.json"]));
    localStorage.setItem("cdb-qopen-mru:" + ROOT_DIR, JSON.stringify(["README.md"]));
    ${AFTER_PREF(`
      window.__ctrlP();
      var out = { rows: window.__rows().length, hint: window.__hint() };
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      out.previewOnEmpty = window.__calls.preview.length;
      window.__type("readme");
      setTimeout(function () {
        window.__key(document.querySelector("#cdb-qopen input"), "Enter");
        out.preview = window.__calls.preview.slice();
        out.rootless = localStorage.getItem("cdb-qopen-mru:");
        out.rooted = localStorage.getItem("cdb-qopen-mru:" + ROOT_DIR);
        ${SINK}(out);
      }, 400);`)}` }), "no-root-mru");
  ok(r.rows === 0 && r.hint === "Type to search files in this session's folder",
     "root unknown: an empty query renders no MRU rows and shows the neutral hint: " + r.rows + " / " + r.hint);
  ok(r.previewOnEmpty === 0, "and Enter on that empty list opens nothing (no relative path reaches onPreview)");
  ok(r.preview.length === 1 && r.preview[0][0] === ROOT_DIR + "README.md",
     "a real search still opens the ABSOLUTE path from the index id: " + JSON.stringify(r.preview));
  ok(r.rootless === JSON.stringify(["shared/package.json"]), "the root-less MRU key is not written: " + r.rootless);
  ok(r.rooted === JSON.stringify(["README.md"]), "and the real per-root MRU is left alone: " + r.rooted);
}
{
  // Pane and rows present, but the fiber ancestor lost onPreview: open, say so,
  // and refuse to act - never guess another way into upstream's tree.
  const r = run(fixture({ handler: false, body: AFTER_PREF(`
    window.__ctrlP();
    var out = { open: window.__open(), hint: window.__hint() };
    window.__type("readme");
    setTimeout(function () {
      out.rowsRendered = window.__rows().length;
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      out.hintAfterSearch = window.__hint();
      out.preview = window.__calls.preview.length;
      ${SINK}(out);
    }, 400);`) }), "no-onpreview");
  ok(r.open === true && r.hint === HINT_NO_HANDLER, "pane present but no onPreview fiber: the modal opens with the hint: " + r.hint);
  ok(r.rowsRendered > 0 && r.hintAfterSearch === HINT_NO_HANDLER, "the search still renders rows and the hint stays: " + r.rowsRendered + " / " + r.hintAfterSearch);
  ok(r.preview === 0, "and Enter opens nothing");
}
// --- hidden file tree ---------------------------------------------------------------
{
  // The live defect (1.40609.0, 2026-08-29): the pane is open on a file with the
  // tree collapsed, so nothing in it exposes onPreview and Ctrl+P could only ever
  // say "the Files panel changed". Upstream's own button brings it all back.
  const r = run(fixture({ treeHidden: true, body: AFTER_PREF(`
    var out = { labelBefore: window.__treeBtnLabel(), treeBefore: !!document.querySelector("#host [role=tree]") };
    window.__ctrlP();
    out.open = window.__open(); out.hintWhileShowing = window.__hint();
    window.__type("readme");
    setTimeout(function () {
      out.label = window.__treeBtnLabel();
      out.rows = window.__rowText();
      out.hint = window.__hint();
      out.filterStoleFocus = window.__filterStoleFocus === true;
      out.focusBack = document.activeElement === document.querySelector("#cdb-qopen input.cdb-qopen-input");
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      out.preview = window.__calls.preview.slice();
      out.errs = window.__errs.slice();
      ${SINK}(out);
    }, 500);`) }), "tree-hidden");
  ok(r.labelBefore === "Show file tree" && r.treeBefore === false,
     "the fixture starts with the tree hidden behind the toolbar button: " + r.labelBefore + " / tree in DOM: " + r.treeBefore);
  ok(r.open === true && r.hintWhileShowing === "Showing the file tree…",
     "tree hidden: the modal still mounts at once, with the transient hint: " + r.hintWhileShowing);
  ok(r.label === "Hide file tree", "upstream's \"Show file tree\" button was clicked (it now reads: " + r.label + ")");
  ok(r.rows.length === 1 && r.hint === "↑↓ to select · Enter to open · :<line> to jump",
     "once the tree renders the harvest re-runs: " + JSON.stringify(r.rows) + " / " + r.hint);
  ok(r.preview.length === 1 && r.preview[0][0] === ROOT_DIR + "README.md",
     "and Enter opens the file through the recovered onPreview: " + JSON.stringify(r.preview));
  ok(r.errs.length === 0, "no error escaped into the page: " + JSON.stringify(r.errs));
  ok(r.filterStoleFocus === true && r.focusBack === true,
     "upstream's click moved focus to its \"Filter files\" box (" + r.filterStoleFocus +
     ") and the modal took it back (" + r.focusBack + ")");
}
{
  // Same hidden-tree path, but the rows upstream renders carry a memoizedProps
  // ACCESSOR that throws. The harvest runs from a setInterval tick, outside the
  // keydown handler's try/catch, so without its own guard the throw would surface
  // as an unhandled page error. Contract: no-op + one warning + the honest hint.
  const r = run(fixture({ treeHidden: true, body: AFTER_PREF(`
    window.__throwRowProps = true;
    window.__ctrlP();
    var out = { open: window.__open() };
    window.__type("readme");
    setTimeout(function () {
      out.stillOpen = window.__open();
      out.hint = window.__hint();
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      out.preview = window.__calls.preview.length;
      out.errs = window.__errs.slice();
      out.warns = window.__warns.filter(function (w) { return w.indexOf("[cdb-qopen] open-threw") === 0; });
      ${SINK}(out);
    }, 500);`) }), "tree-hidden-props-throw");
  ok(r.open === true && r.stillOpen === true, "a throwing row memoizedProps getter leaves the modal open");
  ok(r.errs.length === 0, "and nothing escapes as a page error: " + JSON.stringify(r.errs));
  ok(r.warns.length === 1, "exactly one [cdb-qopen] open-threw warning is recorded: " + JSON.stringify(r.warns));
  ok(r.hint === HINT_NO_HANDLER && r.preview === 0,
     "the hint says the anchor is gone and Enter opens nothing: " + r.hint);
}
{
  // COLD RENDER - the live open-path defect (1.40609.0, 2026-08-29). The tree has
  // been hidden since app start, so upstream commits the [role=tree] element
  // FIRST and its rows ~200 ms later, and onPreview is reachable only from a ROW
  // (treeNoHandler reproduces the measured fiber shape: the walk up from the tree
  // returns null). A harvest that fires on "the tree exists" therefore finds
  // nothing, gives up for good, and Enter opens nothing - what the user hit. The
  // wait condition must be the harvest itself.
  const r = run(fixture({ treeHidden: true, coldRows: true, treeNoHandler: true, body: AFTER_PREF(`
    var out = {};
    window.__ctrlP();
    out.hintWhileShowing = window.__hint();
    window.__type("readme");
    setTimeout(function () {
      out.rowsInPane = document.querySelectorAll("#host [role=treeitem]").length;
      out.hint = window.__hint();
      out.rows = window.__rowText();
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      out.preview = window.__calls.preview.slice();
      out.errs = window.__errs.slice();
      ${SINK}(out);
    }, 900);`) }), "tree-hidden-cold-render", 4000);
  ok(r.hintWhileShowing === "Showing the file tree…" && r.rowsInPane === 3,
     "cold render: the tree element lands first and its rows only later (" + r.rowsInPane + " rows at the end)");
  ok(r.hint !== HINT_NO_HANDLER && r.rows.length === 1,
     "the retried harvest picks the handler up from the late row: hint " + JSON.stringify(r.hint));
  ok(r.preview.length === 1 && r.preview[0][0] === ROOT_DIR + "README.md",
     "and Enter opens the file through it: " + JSON.stringify(r.preview));
  ok(r.errs.length === 0, "no error escaped into the page: " + JSON.stringify(r.errs));
}
{
  // Same cold path, but the rows never arrive (an empty folder, or upstream's own
  // filter matched nothing). After the budget the honest hint is all that is left
  // - and it must arrive without a throw and without opening anything.
  const r = run(fixture({ treeHidden: true, coldRows: false, treeNoHandler: true, body: AFTER_PREF(`
    window.__ctrlP();
    window.__type("readme");
    setTimeout(function () {
      var out = { open: window.__open(), hint: window.__hint(), rows: window.__rows().length };
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      out.preview = window.__calls.preview.length;
      out.errs = window.__errs.slice();
      out.warns = window.__warns.filter(function (w) { return w.indexOf("[cdb-qopen] ") === 0; });
      ${SINK}(out);
    }, 3400);`) }), "harvest-timeout", 7000);
  ok(r.open === true && r.hint === HINT_NO_HANDLER,
     "rows that never arrive: after the budget the modal is still open with the honest hint: " + r.hint);
  ok(r.rows > 0 && r.preview === 0, "the search still rendered rows (" + r.rows + ") but Enter opens nothing");
  ok(r.errs.length === 0, "and nothing throws: " + JSON.stringify(r.errs));
  ok(r.warns.some((w) => w.indexOf("[cdb-qopen] harvest-timeout") === 0) &&
     r.warns.some((w) => w.indexOf("[cdb-qopen] no-onpreview") === 0),
     "the timeout is warned once, with the no-onpreview key: " + JSON.stringify(r.warns));
}
{
  // Tree hidden and no button to press (an upstream relabel, or a pane that
  // simply has no toggle): say so and refuse to act - never fake the tree open.
  const r = run(fixture({ treeHidden: true, showTreeBtn: false, body: AFTER_PREF(`
    window.__ctrlP();
    var out = { open: window.__open(), hint: window.__hint() };
    window.__type("readme");
    setTimeout(function () {
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      out.hintAfter = window.__hint();
      out.preview = window.__calls.preview.length;
      out.errs = window.__errs.slice();
      ${SINK}(out);
    }, 500);`) }), "tree-hidden-no-button");
  ok(r.open === true && r.hint === HINT_NO_HANDLER,
     "tree hidden with no \"Show file tree\" button: the modal opens with the hint: " + r.hint);
  ok(r.hintAfter === HINT_NO_HANDLER && r.preview === 0, "Enter opens nothing and the hint stays: " + r.hintAfter);
  ok(r.errs.length === 0, "and nothing throws: " + JSON.stringify(r.errs));
}
{
  // The tile root: the fiber that owns onPreview carries the folder as a string
  // `root` prop (no trailing slash). It wins over the row-derived root, because
  // the rows can belong to a different folder than the one the tile shows.
  const r = run(fixture({ body: AFTER_PREF(`
    window.__setRootProp("/home/u/other");
    window.__ctrlP(); window.__type("readme");
    setTimeout(function () {
      var st = window.__cdbQuickOpenPage.state();
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      ${SINK}({ preview: window.__calls.preview.slice(), root: st.root });
    }, 400);`) }), "fiber-root");
  ok(r.root === "/home/u/other/", "the fiber's own root prop wins over the row-derived one (" + ROOT_DIR + "): " + r.root);
  ok(r.preview.length === 1 && r.preview[0][0] === "/home/u/other/README.md",
     "and the missing trailing slash is normalised before it is concatenated: " + JSON.stringify(r.preview));
}

// --- no Files pane at all: open it through upstream's own session menu ----------
{
  // The pane is closed, so nothing in the page exposes onPreview and there is no
  // "Show file tree" button either. The only way in is upstream's session ⋮ →
  // Files, and it has two async stages (menu, then pane) before the harvest can
  // even start. Ctrl+P must still feel instant.
  const r = run(fixture({ pane: false, paneOpener: true, body: AFTER_PREF(`
    window.__ctrlP();
    var early = { open: window.__open(), hint: window.__hint(), pane: !!document.querySelector('[data-perf-screen="file"]') };
    window.__type("readme");
    setTimeout(function () {
      var out = { early: early, hint: window.__hint(), rows: window.__rows().length,
        menuOpens: window.__menuOpens, filesClicks: window.__filesClicks,
        paneNow: !!document.querySelector('[data-perf-screen="file"]'),
        menuLeftOpen: !!document.getElementById("test-menu") };
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      out.preview = window.__calls.preview.slice();
      out.errs = window.__errs.slice();
      ${SINK}(out);
    }, 1600);`) }), "no-pane-auto-open", 5000);
  ok(r.early.open === true && r.early.pane === false,
     "the modal mounts instantly, before any pane exists");
  ok(r.early.hint === HINT_OPENING_PANE,
     "and says what it is doing meanwhile: " + JSON.stringify(r.early.hint));
  ok(r.menuOpens === 1 && r.filesClicks === 1,
     "upstream's own ⋮ menu is opened once and its Files entry clicked once (" +
     r.menuOpens + "/" + r.filesClicks + ")");
  ok(r.paneNow === true, "which is what creates the Files pane");
  ok(r.menuLeftOpen === false, "and the menu does not stay open over the app");
  ok(r.hint !== HINT_NO_PANE && r.rows === 1,
     "the harvest then lands and results render: hint " + JSON.stringify(r.hint) + ", rows " + r.rows);
  ok(r.preview.length === 1 && r.preview[0][0] === ROOT_DIR + "README.md",
     "Enter opens the file through the freshly created pane: " + JSON.stringify(r.preview));
  ok(r.errs.length === 0, "no error escaped into the page: " + JSON.stringify(r.errs));
}
{
  // The pane can arrive with its tree collapsed. That is the hidden-tree case one
  // stage later, so the same poll has to press "Show file tree" itself.
  const r = run(fixture({ pane: false, paneOpener: true, openedPaneTreeHidden: true, body: AFTER_PREF(`
    window.__ctrlP(); window.__type("readme");
    setTimeout(function () {
      var out = { hint: window.__hint(), rows: window.__rows().length,
        treeShown: !!document.querySelector('[role="tree"]') };
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      out.preview = window.__calls.preview.slice();
      out.errs = window.__errs.slice();
      ${SINK}(out);
    }, 2000);`) }), "no-pane-then-hidden-tree", 5000);
  ok(r.treeShown === true, "a pane that mounts with its tree collapsed gets the tree shown too");
  ok(r.preview.length === 1 && r.preview[0][0] === ROOT_DIR + "README.md",
     "and the file still opens: " + JSON.stringify(r.preview));
  ok(r.errs.length === 0, "no error escaped into the page: " + JSON.stringify(r.errs));
}
{
  // Upstream's menu is there but has no Files entry (an anchor that moved, or a
  // session that cannot show files). Degrade to the honest hint - never hang.
  const r = run(fixture({ pane: false, paneOpener: true, filesMenuItem: false, body: AFTER_PREF(`
    window.__ctrlP(); window.__type("readme");
    setTimeout(function () {
      var out = { hint: window.__hint(), menuOpens: window.__menuOpens,
        paneNow: !!document.querySelector('[data-perf-screen="file"]'),
        menuLeftOpen: !!document.getElementById("test-menu") };
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      out.preview = window.__calls.preview.length;
      out.errs = window.__errs.slice();
      out.warns = window.__warns.filter(function (w) { return w.indexOf("[cdb-qopen] ") === 0; });
      ${SINK}(out);
    }, 2600);`) }), "no-pane-no-files-entry", 5000);
  ok(r.menuOpens === 1 && r.paneNow === false, "the menu is tried once and yields no pane");
  ok(r.hint === HINT_NO_PANE, "the hint falls back to the honest one: " + JSON.stringify(r.hint));
  ok(r.menuLeftOpen === false, "the menu is dismissed rather than left hanging over the app");
  ok(r.preview === 0, "Enter opens nothing");
  ok(r.warns.some(function (w) { return w.indexOf("[cdb-qopen] no-files-menu-item") === 0; }),
     "and the missing entry is warned once: " + JSON.stringify(r.warns));
  ok(r.errs.length === 0, "no error escaped into the page: " + JSON.stringify(r.errs));
}
{
  // No pane AND no session menu to reach one (upstream moved the toolbar, or this
  // surface has none): the pre-existing behaviour, unchanged.
  const r = run(fixture({ pane: false, body: AFTER_PREF(`
    window.__ctrlP();
    ${SINK}({ open: window.__open(), hint: window.__hint(), errs: window.__errs.slice() });`) }), "no-pane-no-opener");
  ok(r.open === true && r.hint === HINT_NO_PANE,
     "with no way to open a pane the modal still opens and says so: " + JSON.stringify(r.hint));
  ok(r.errs.length === 0, "no error escaped into the page: " + JSON.stringify(r.errs));
}

{
  // A pane opened from scratch renders its tree with NO rows for a while
  // (measured 1.40609.0). Walking up from the tree or the filter box finds
  // nothing then - only descending from the pane root reaches the component that
  // owns onPreview. Without that descent the harvest times out on every
  // freshly-opened pane, which is exactly the case the ⋮ path creates.
  const r = run(fixture({ rows: false, paneListFiber: true, body: AFTER_PREF(`
    window.__ctrlP(); window.__type("readme");
    setTimeout(function () {
      var out = { hint: window.__hint(), rowsInPane: document.querySelectorAll('[role=treeitem]').length,
        rows: window.__rows().length, root: window.__cdbQuickOpenPage.state().root };
      window.__key(document.querySelector("#cdb-qopen input"), "Enter");
      out.preview = window.__calls.preview.slice();
      out.errs = window.__errs.slice();
      ${SINK}(out);
    }, 700);`) }), "empty-tree-list-fiber");
  ok(r.rowsInPane === 0, "the pane's tree really is row-less in this shape");
  ok(r.hint !== HINT_NO_HANDLER && r.root === ROOT_DIR,
     "the handler is still found by descending, root and all: " + JSON.stringify(r.root));
  ok(r.preview.length === 1 && r.preview[0][0] === ROOT_DIR + "README.md",
     "and Enter opens the file: " + JSON.stringify(r.preview));
  ok(r.errs.length === 0, "no error escaped into the page: " + JSON.stringify(r.errs));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
