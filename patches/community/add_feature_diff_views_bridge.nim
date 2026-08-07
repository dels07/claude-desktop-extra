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
# Break risk: VERY LOW - no regex against minified app code, only the stable
# leading "use strict"; of the preload bundle.

import std/[os, strutils]

const BRIDGE_JS = staticRead("../../js/diff_views_bridge.js")

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
  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & "\n" & BRIDGE_JS & result[strictPrefix.len .. ^1]
    echo "  [OK] cdbDiffViews bridge inserted after \"use strict\""
  else:
    echo "  [FAIL] mainView.js does not start with \"use strict\"; -- re-audit"
    quit(1)
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
