# @patch-target: app.asar.contents/.vite/build/mainView.js
# @patch-type: nim
#
# contextBridge for the diff view modes feature (window.cdbDiffViews).
#
# mainView.js is the sandboxed preload of the WebContentsView hosting the
# remote claude.ai SPA. Separate patch file because the orchestrator stages
# every @patch-target in isolation.
#
# SECURITY: the page behind this preload is remote code. Fixed methods, one
# channel each - no generic passthrough. Main side re-validates everything.
#
# Break risk: VERY LOW - no regex against minified app code; the snippet is a
# self-contained IIFE prepended to the head of the preload bundle.

import std/[os, strutils]

const BRIDGE_JS = staticRead("../../js/diff_views_bridge.js")

# Directive prologues only take effect when they are the very first statement,
# so if upstream ever re-introduces one we must inject *after* it rather than
# in front of it. As of v1.26832.0 the bundle has none (it opens with the
# Sentry release IIFE), so position 0 is the injection point.
const DIRECTIVES = ["\"use strict\";", "'use strict';"]

# Positive end-state markers (Rule 6): the build tag and the exposed global.
const MARKERS = ["__cdb_diff_views_bridge", "exposeInMainWorld(\"cdbDiffViews\""]

proc markersPresent(s: string): int =
  for m in MARKERS:
    if m in s:
      result.inc

proc apply*(input: string): string =
  result = input
  let present = markersPresent(result)
  if present == MARKERS.len:
    echo "  [OK] cdbDiffViews bridge already injected (idempotent)"
    return
  if present > 0:
    echo "  [FAIL] Partial injection (" & $present & "/" & $MARKERS.len &
      " markers) -- refusing to patch on top; re-audit the preload bundle"
    quit(1)
  # Precondition: still a sandboxed CommonJS preload that pulls in electron.
  # Were it ever to become an ESM bundle, the injected require()/contextBridge
  # IIFE would be wrong and must be re-authored instead of silently prepended.
  if """require("electron")""" notin result and "require(`electron`)" notin result:
    echo "  [FAIL] mainView.js does not require electron -- preload bundle shape changed (ESM?), re-audit"
    quit(1)
  var prologue = 0
  for d in DIRECTIVES:
    if result.startsWith(d):
      prologue = d.len
      break
  result =
    result[0 ..< prologue] & (if prologue > 0: "\n" else: "") & BRIDGE_JS &
    result[prologue .. ^1]
  if prologue > 0:
    echo "  [OK] cdbDiffViews bridge inserted after the directive prologue"
  else:
    echo "  [OK] cdbDiffViews bridge prepended at the head of the preload"
  if markersPresent(result) != MARKERS.len:
    echo "  [FAIL] markers absent after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_diff_views_bridge <path_to_mainView.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_diff_views_bridge ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] cdbDiffViews bridge applied"
  else:
    echo "  [OK] Already applied (no changes needed)"
