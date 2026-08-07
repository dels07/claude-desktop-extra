# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# "Extra" area inside the claude.ai Settings modal (Themes + Community Features +
# Anthropic Features + Deployment).
#
# The Settings modal is rendered by the REMOTE claude.ai SPA inside the mainView
# WebContentsView, so the UI cannot be a React route of ours: it is injected into
# the live page. This patch is the main-process half of that.
#
#   * ipcMain handlers: cdb-extra:themes-list / :paths / :reveal / :diag,
#     cdb-flags:catalog / :read / :set / :unset, cdb-glow:read / :set,
#     cdb-deploy:read / :mode / :set / :apply / :raw / :save-raw, cdb-app:relaunch.
#     cdb-themes:apply and cdb-themes:active are NOT registered here - they are
#     owned by add_feature_theme_picker.nim and the page calls them directly.
#   * the writer of the 1P/3P deployment mode and of the third-party configuration
#     the app boots from. Both files are upstream's own and user-level - the
#     persisted deploymentMode key in <userData>-3p/claude_desktop_config.json and
#     the applied entry of <userData>-3p/configLibrary - so no patch to the
#     bootstrap and no root is needed. /etc/claude-desktop/managed-settings.json
#     is only ever READ (it needs root and, when valid, wins over both).
#     The pinned key catalog in js/extra_settings_main.js is version-sensitive:
#     re-extract it from the bundle's schema on an upstream bump.
#   * the single writer of growthbookOverrides in <userData>/claude-desktop-extra.json
#     (atomic tmp+rename). The .jsonc is human-owned and never created or
#     rewritten here; entries a user put there win per flag id, and the UI shows
#     those toggles as disabled with that reason instead of pretending otherwise.
#   * page installation on every http(s) dom-ready: insertCSS (never CSP-gated,
#     no external asset) plus one executeJavaScript whose return value is logged.
#
# The renderer reaches all of this through the fixed-method cdbExtra bridge added
# by add_feature_extra_settings_bridge.nim (a separate .nim because the
# orchestrator stages every @patch-target in isolation - a patch can only touch
# the file named in its own header).
#
# Cross-patch state is read lazily via globalThis: same-anchor prefix injections
# stack in reverse order, so this code RUNS BEFORE add_feature_custom_themes
# installs globalThis.__cdbThemes. Handlers tolerate a missing registry.
#
# Break risk: VERY LOW on the desktop side - no regex against minified app code,
# only the stable "use strict"; prefix and standard Electron APIs. The real
# fragility is the remote Settings markup: the page script anchors on semantics
# only ([role=dialog] plus the visible text of known nav items), never on a
# generated class name, and every failure is soft (one diagnostic line, then
# nothing - Ctrl+Shift+T stays the robust fallback).

import std/[os, strutils, json]

const MAIN_JS = staticRead("../../js/extra_settings_main.js")
const PAGE_JS = staticRead("../../js/extra_settings_page.js")
const PAGE_CSS = staticRead("../../js/extra_settings_page.css")

# The page script and its stylesheet are spliced into the main-process IIFE as
# JS string literals (escapeJson yields a quoted, fully escaped literal). The
# placeholders are plain strings in the .js so it passes node --check unpatched.
const EXTRA_JS = MAIN_JS.replace("\"__CDB_EX_PAGE_SRC__\"", escapeJson(PAGE_JS)).replace(
    "\"__CDB_EX_PAGE_CSS__\"", escapeJson(PAGE_CSS)
  )

const EXPECTED_PATCHES = 1

# Positive end-state markers (Rule 6): the build tag, one handler name per panel
# from the main half, and one class name from the page half - so a partially
# spliced payload cannot report success.
const MARKERS =
  ["__cdb_extra_settings", "\"cdb-flags:set\"", "\"cdb-deploy:mode\"", "cdbx-navgroup"]

proc markersPresent(s: string): int =
  for m in MARKERS:
    if m in s:
      result.inc

proc apply*(input: string): string =
  result = input

  # Compile-time splice sanity: neither placeholder may survive into the bundle.
  if "__CDB_EX_PAGE_SRC__" in EXTRA_JS or "__CDB_EX_PAGE_CSS__" in EXTRA_JS:
    echo "  [FAIL] page src/css placeholder was not substituted -- js/extra_settings_main.js drifted"
    quit(1)

  var patchesApplied = 0

  # Idempotency: assert OUR injected end-state, never merely the absence of
  # something else.
  let present = markersPresent(result)
  if present == MARKERS.len:
    echo "  [OK] Extra settings area already injected (" & $present & "/" & $MARKERS.len &
      " markers present)"
    echo "  [PASS] No changes needed (already patched)"
    return
  if present > 0:
    echo "  [FAIL] Partial injection detected (" & $present & "/" & $MARKERS.len &
      " markers) -- refusing to patch on top; re-audit the bundle"
    quit(1)

  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & EXTRA_JS & result[strictPrefix.len .. ^1]
    echo "  [OK] Extra settings IIFE inserted after \"use strict\""
  else:
    result = EXTRA_JS & result
    echo "  [OK] Extra settings IIFE prepended"

  let found = markersPresent(result)
  if found < MARKERS.len:
    for m in MARKERS:
      if m notin result:
        echo "  [FAIL] marker missing after injection: " & m
    echo "  [FAIL] Only " & $found & "/" & $MARKERS.len & " markers present -- aborting"
    quit(1)
  echo "  [OK] " & $found & "/" & $MARKERS.len & " end-state markers verified"
  patchesApplied.inc

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_extra_settings <path_to_index.js>"
    quit(1)

  let filePath = paramStr(1)
  echo "=== Patch: add_feature_extra_settings ==="
  echo "  Target: " & filePath

  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)

  let input = readFile(filePath)
  let output = apply(input)

  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Extra settings area (Themes + Community Features + Anthropic Features + Deployment) added"
  else:
    echo "  [WARN] No changes made"
