# @patch-target: app.asar.contents/.vite/build/mainView.js
# @patch-type: nim
#
# contextBridge for the Files quick open feature (window.cdbQuickOpen).
#
# Break risk: VERY LOW - no regex against minified app code; the snippet is a
# self-contained IIFE prepended to the head of the preload bundle.

import std/[os, strutils]

const BRIDGE_JS = staticRead("../../js/files_quick_open_bridge.js")

# Directive prologues only take effect when they are the very first statement,
# so we must inject *after* one rather than in front of it. This is live, not
# hypothetical: v1.26832.0 had none (the bundle opened with the Sentry release
# IIFE), but v1.40609.0 DOES open with `"use strict";` - the patch reports
# "inserted after the directive prologue" there. Both shapes are handled below;
# do not simplify this back to a fixed position-0 injection.
const DIRECTIVES = ["\"use strict\";", "'use strict';"]

# Positive end-state markers (Rule 6): the build tag and the exposed global.
const MARKERS = ["__cdb_files_quick_open_bridge", "exposeInMainWorld(\"cdbQuickOpen\""]

proc markersPresent(s: string): int =
  for m in MARKERS:
    if m in s:
      result.inc

proc apply*(input: string): string =
  result = input
  let present = markersPresent(result)
  if present == MARKERS.len:
    echo "  [OK] cdbQuickOpen bridge already injected (idempotent)"
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
    echo "  [OK] cdbQuickOpen bridge inserted after the directive prologue"
  else:
    echo "  [OK] cdbQuickOpen bridge prepended at the head of the preload"
  if markersPresent(result) != MARKERS.len:
    echo "  [FAIL] markers absent after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_files_quick_open_bridge <path_to_mainView.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_files_quick_open_bridge ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] cdbQuickOpen bridge applied"
  else:
    echo "  [OK] Already applied (no changes needed)"
