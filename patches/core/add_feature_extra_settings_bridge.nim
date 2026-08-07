# @patch-target: app.asar.contents/.vite/build/mainView.js
# @patch-type: nim
#
# contextBridge for the "Extra" settings area (window.cdbExtra).
#
# mainView.js is the preload of the mainView WebContentsView that hosts the
# remote claude.ai SPA (same target as fix_process_argv_renderer.nim). It is
# sandboxed: require("electron") works for the contextBridge/ipcRenderer subset
# and nothing else does.
#
# The main-process handlers live in add_feature_extra_settings.nim. They are a
# separate patch file because the orchestrator stages every @patch-target in
# isolation, so one patch can only modify the file named in its own header -
# patching a sibling would be a silent no-op.
#
# SECURITY: the page behind this preload is remote code. The exposed object is a
# fixed set of methods, each hardwired to one channel name - deliberately no
# generic invoke(channel, ...) passthrough. Argument shapes are re-validated on
# the main side, and every handler there checks the sender.
#
# Break risk: VERY LOW - no regex against minified app code, only the stable
# leading "use strict"; of the preload bundle.

import std/[os, strutils]

const BRIDGE_JS = staticRead("../../js/extra_settings_bridge.js")

const EXPECTED_PATCHES = 1

# Positive end-state markers (Rule 6): the build tag and the exposed global.
const MARKERS = ["__cdb_extra_bridge", "exposeInMainWorld(\"cdbExtra\""]

proc markersPresent(s: string): int =
  for m in MARKERS:
    if m in s:
      result.inc

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  let present = markersPresent(result)
  if present == MARKERS.len:
    echo "  [OK] cdbExtra bridge already injected (" & $present & "/" & $MARKERS.len &
      " markers present)"
    echo "  [PASS] No changes needed (already patched)"
    return
  if present > 0:
    echo "  [FAIL] Partial injection detected (" & $present & "/" & $MARKERS.len &
      " markers) -- refusing to patch on top; re-audit the preload bundle"
    quit(1)

  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & "\n" & BRIDGE_JS & result[strictPrefix.len .. ^1]
    echo "  [OK] cdbExtra bridge inserted after \"use strict\""
  else:
    echo "  [FAIL] mainView.js does not start with \"use strict\"; -- preload bundle shape changed, re-audit"
    quit(1)

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
    echo "Usage: add_feature_extra_settings_bridge <path_to_mainView.js>"
    quit(1)

  let filePath = paramStr(1)
  echo "=== Patch: add_feature_extra_settings_bridge ==="
  echo "  Target: " & filePath

  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)

  let input = readFile(filePath)
  let output = apply(input)

  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] cdbExtra bridge added to the mainView preload"
  else:
    echo "  [WARN] No changes made"
