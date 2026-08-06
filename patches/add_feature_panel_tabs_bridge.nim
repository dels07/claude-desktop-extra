# @patch-target: app.asar.contents/.vite/build/mainView.js
# @patch-type: nim
#
# contextBridge for the panel tabs feature (window.cdbTabs).
#
# Break risk: VERY LOW - no regex against minified app code, only the stable
# leading "use strict"; of the preload bundle.

import std/[os, strutils]

const BRIDGE_JS = staticRead("../js/panel_tabs_bridge.js")

# Positive end-state markers (Rule 6): the build tag and the exposed global.
const MARKERS = ["__cdb_panel_tabs_bridge", "exposeInMainWorld(\"cdbTabs\""]

proc markersPresent(s: string): int =
  for m in MARKERS:
    if m in s:
      result.inc

proc apply*(input: string): string =
  result = input
  let present = markersPresent(result)
  if present == MARKERS.len:
    echo "  [OK] cdbTabs bridge already injected (idempotent)"
    return
  if present > 0:
    echo "  [FAIL] Partial injection (" & $present & "/" & $MARKERS.len &
      " markers) -- refusing to patch on top; re-audit the preload bundle"
    quit(1)
  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & "\n" & BRIDGE_JS & result[strictPrefix.len .. ^1]
    echo "  [OK] cdbTabs bridge inserted after \"use strict\""
  else:
    echo "  [FAIL] mainView.js does not start with \"use strict\"; -- re-audit"
    quit(1)
  if markersPresent(result) != MARKERS.len:
    echo "  [FAIL] markers absent after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_panel_tabs_bridge <path_to_mainView.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_panel_tabs_bridge ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] cdbTabs bridge applied"
  else:
    echo "  [OK] Already applied (no changes needed)"
