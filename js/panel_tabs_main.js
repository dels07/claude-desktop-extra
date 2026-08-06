/*
 * panel_tabs_main.js - main-process half of the panel tabs feature.
 *
 * Owns the opt-in pref and injects the page script on dom-ready. The page half
 * (js/panel_tabs_layout.js, _store.js, _harvest.js, _page.js, concatenated by
 * patches/add_feature_panel_tabs.nim) polls state() and mounts or removes its
 * bar from what it reports, which is what makes the switch live with no
 * restart.
 *
 * SECURITY: the caller is remote claude.ai code. Every handler validates the
 * sender's ORIGIN (not a substring test of the URL - see okSender below) and
 * takes only a boolean; nothing page-supplied reaches the filesystem.
 */
;/*__CDB_PANEL_TABS__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  if (globalThis.__cdbPanelTabsMain) return;
  globalThis.__cdbPanelTabsMain = true;

  var _electron = require("electron");
  var _app = _electron.app;
  var _ipc = _electron.ipcMain;
  var _fs = require("fs");
  var _path = require("path");
  var _URL = require("url").URL;

  var PAGE_SRC = "__CDB_TABS_PAGE_SRC__";
  var PREF_KEY = "panelTabs";
  var PREF_DEFAULT = false;
  var JSONC_NAME = "claude-desktop-extra.jsonc";
  var JSON_NAME = "claude-desktop-extra.json";

  function log(m) { (globalThis.__cdbDiag || console.log)("[panel-tabs] " + m); }

  function userDir() {
    try { return _app.getPath("userData"); } catch (e) { return null; }
  }
  // Same as every other config consumer (js/diff_views_main.js, extra_settings_main.js,
  // growthbook_overrides.js, patches/add_feature_cowork_glow.nim): the one-time
  // claude-desktop-bin.* -> claude-desktop-extra.* rename migration is installed by
  // the custom-themes patch and same-anchor prefix injections stack in reverse, so
  // it may not have run yet when we get here. Nudging it before every path
  // resolution is defence-in-depth against a write landing before the migration
  // runs and orphaning a user's legacy config.
  function pathFor(name) {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var d = userDir();
    return d ? _path.join(d, name) : null;
  }

  // Comment/trailing-comma stripper for the .jsonc/.json config files, shared
  // in spirit with the diff-views pref reader (js/diff_views_main.js). A naive
  // "strip from // to end of line unless preceded by :" heuristic corrupts any
  // string VALUE that happens to contain "//" without a preceding colon (a
  // path fragment, not just a URL) - e.g. {"note":"see a//b for details"}
  // truncates mid-string and the file fails to parse. Matching whole quoted
  // strings FIRST and passing them through untouched is the only way to strip
  // comments without risking string contents, whatever they contain.
  function stripComments(s) {
    return String(s)
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (m, q) { return q ? q : ""; })
      .replace(/,(\s*[}\]])/g, "$1");
  }
  // LENIENT reader for the read-only paths (pref lookup / lock detection): any
  // problem - missing file, unparseable JSON, wrong shape - is reported the
  // same as "no pref set here" and falls through to the next source. This is
  // safe here because nothing is written back. writePref (below) does NOT use
  // this function for its own existing-file read: a write must distinguish
  // "absent" from "present but broken" instead of silently treating both as
  // empty, or a broken file gets overwritten and every other key in it is lost.
  function readFileJson(p) {
    try {
      if (!p || !_fs.existsSync(p)) return null;
      var stripped = stripComments(_fs.readFileSync(p, "utf8"));
      var v = stripped.trim() ? JSON.parse(stripped) : {};
      return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
    } catch (e) { return null; }
  }

  // The .jsonc is the HUMAN-OWNED file and wins the startup merge, so a value
  // found there is reported as locked and pref-set refuses to fight it instead
  // of writing a .json the merge would then ignore.
  function readPrefFromDisk() {
    var jsonc = readFileJson(pathFor(JSONC_NAME));
    if (jsonc && typeof jsonc[PREF_KEY] === "boolean") {
      return { value: jsonc[PREF_KEY], source: "jsonc-locked" };
    }
    var json = readFileJson(pathFor(JSON_NAME));
    if (json && typeof json[PREF_KEY] === "boolean") {
      return { value: json[PREF_KEY], source: "json" };
    }
    return { value: PREF_DEFAULT, source: "default" };
  }

  // Writes ONLY the .json (the .jsonc is never created or rewritten here), tmp +
  // rename so a crash cannot leave half a file, and every other key survives.
  //
  // Unlike readFileJson above, an existing-but-broken file is NOT silently
  // treated as empty here: that would make pref-set report success while
  // quietly discarding every other extra's settings the moment a user's
  // hand-edited file has a stray comma or an unbalanced brace. ENOENT (file
  // genuinely absent) is the only case that proceeds with an empty object;
  // every other read/parse/shape failure refuses and writes nothing.
  function writePref(value) {
    var p = pathFor(JSON_NAME);
    if (!p) return { ok: false, error: "no userData path" };
    var raw = null;
    try { raw = _fs.readFileSync(p, "utf8"); }
    catch (e) {
      if (e.code !== "ENOENT") return { ok: false, error: "cannot read " + p + ": " + ((e && e.message) || String(e)) };
    }
    var cfg = {};
    if (raw !== null) {
      var stripped = stripComments(raw);
      try { cfg = stripped.trim() ? JSON.parse(stripped) : {}; }
      catch (e2) {
        return { ok: false, error: p + " is not valid JSON (" + e2.message +
          ") - fix or remove it first; nothing was written" };
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return { ok: false, error: p + " must contain a JSON object; nothing was written" };
      }
      if (stripped !== raw) {
        // Rewriting as plain JSON drops comments - keep the original once.
        try { _fs.writeFileSync(p + ".cdb-bak", raw, { flag: "wx" }); } catch (e3) {}
      }
    }
    // The default is FALSE, so "off" is the ABSENCE of the key: a fresh install
    // and one that switched the feature back off look the same on disk, and only
    // an explicit opt-in ever writes anything.
    if (value === PREF_DEFAULT) delete cfg[PREF_KEY];
    else cfg[PREF_KEY] = value;
    var tmp = p + ".cdb-tmp";
    try {
      _fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      _fs.renameSync(tmp, p);
    } catch (e4) {
      try { _fs.unlinkSync(tmp); } catch (e5) {}
      return { ok: false, error: "cannot write " + p + ": " + ((e4 && e4.message) || String(e4)) };
    }
    return { ok: true, path: p };
  }

  // Exact-origin allowlist, same posture as the diff-views and cowork-glow
  // sender checks: comparing parsed origins instead of testing whether the raw
  // URL STRING contains "claude.ai"/"claude.com" anywhere. A substring test
  // would also pass a lookalike host such as "https://evil.example/?next=
  // claude.ai" or "https://claude.ai.evil.example" - both contain the
  // substring, neither is our origin.
  var ALLOWED_ORIGINS = [
    "https://claude.ai",
    "https://preview.claude.ai",
    "https://claude.com",
    "https://preview.claude.com"
  ];
  function originAllowed(rawUrl) {
    var origin;
    try { origin = new _URL(String(rawUrl)).origin; } catch (e) { return false; }
    for (var i = 0; i < ALLOWED_ORIGINS.length; i++) {
      if (origin === ALLOWED_ORIGINS[i]) return true;
    }
    return false;
  }
  // FAILS CLOSED: wc.isDestroyed() is called unguarded, same as the diff-views
  // precedent - a sender object missing the method throws, the catch below
  // turns that into "not ok", not "assume fine". Do not soften this to a
  // typeof-guard that treats a missing method as "not destroyed".
  function okSender(ev) {
    try {
      var wc = ev && ev.sender;
      if (!wc || wc.isDestroyed()) return false;
      if (!originAllowed(wc.getURL() || "")) return false;
      var frame = ev.senderFrame;
      if (frame && frame.parent) return false;
      return true;
    } catch (e) { return false; }
  }

  _ipc.handle("cdb-tabs:state", function (ev) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    var disk = readPrefFromDisk();
    return { ok: true, enabled: disk.value === true, source: disk.source };
  });

  _ipc.handle("cdb-tabs:pref-read", function (ev) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    var disk = readPrefFromDisk();
    return { ok: true, enabled: disk.value === true,
      lockedByJsonc: disk.source === "jsonc-locked", source: disk.source };
  });

  _ipc.handle("cdb-tabs:pref-set", function (ev, enabled) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    var disk = readPrefFromDisk();
    if (disk.source === "jsonc-locked") {
      return { ok: false, error: PREF_KEY + " is set in " + JSONC_NAME +
        " - edit that file to change it" };
    }
    var w = writePref(enabled);
    if (!w.ok) return w;
    return { ok: true, enabled: enabled, path: w.path };
  });

  // ---- page injection ---------------------------------------------------------
  // Injected in BOTH pref states: the page polls state() itself and mounts or
  // removes its bar from what it reports (slowly, for the life of the page),
  // which is what makes the settings toggle apply live with no restart. With
  // no bridge present the page degrades silently (no throw, no warn spam,
  // feature off) - this handler is what makes it live at all.
  //
  // The URL test here is a plain substring check, same posture as the sibling
  // diff-views injection site: it only decides whether to bother running
  // executeJavaScript on this webContents, it is NOT a security boundary (the
  // page script itself does nothing sensitive - it only defines globals and
  // polls state(), which re-validates the sender origin strictly, above). A
  // false-positive match here would at most waste one executeJavaScript call
  // on an unrelated page.
  _app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () {
      try {
        var url = (wc.getURL && wc.getURL()) || "";
        if (url.indexOf("claude.ai") !== -1 || url.indexOf("claude.com") !== -1) {
          wc.executeJavaScript(PAGE_SRC).catch(function () {});
        }
      } catch (e) {}
    });
  });

  // Our IIFE runs before __cdbDiag exists (same-anchor injections stack, and
  // console.log is discarded by the official build), so a synchronous log
  // here would be silently lost. Deferring one tick lets all top-level bundle
  // code run first, by which point __cdbDiag is defined.
  setTimeout(function () {
    var disk = readPrefFromDisk();
    log("installed (main); pref " + PREF_KEY + "=" + disk.value + " (source: " + disk.source + ")" +
      (disk.value ? "" : " - opt-in feature is off: no bar, no layout writes"));
  }, 0);
})();
