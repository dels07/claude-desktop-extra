# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Panel tabs for the Code tab's side panels. Injects js/panel_tabs_main.js with
# the four page modules embedded, in dependency order (layout, store, harvest,
# page). Counterpart preload bridge: patches/add_feature_panel_tabs_bridge.nim.
#
# Break risk: VERY LOW for the injection (stable "use strict"; anchor, no regex
# on minified code). The page half keys off remote epitaxy DOM and fiber props
# and degrades to a no-op on a claude.ai redeploy.

import std/[os, strutils]

const MAIN_JS = staticRead("../../js/panel_tabs_main.js")
const LAYOUT_JS = staticRead("../../js/panel_tabs_layout.js")
const STORE_JS = staticRead("../../js/panel_tabs_store.js")
const HARVEST_JS = staticRead("../../js/panel_tabs_harvest.js")
const PAGE_JS = staticRead("../../js/panel_tabs_page.js")

const MARKER = "__CDB_PANEL_TABS__"
const PLACEHOLDER = "\"__CDB_TABS_PAGE_SRC__\""

proc escapeJs(s: string): string =
  result = s
  result = result.replace("\\", "\\\\")
  result = result.replace("\"", "\\\"")
  result = result.replace("\n", "\\n")
  result = result.replace("\r", "")

proc buildInjection(): string =
  if PLACEHOLDER notin MAIN_JS:
    raise newException(ValueError, "panel_tabs_main.js lost its page-src placeholder")
  # ORDER MATTERS: page.js reads __cdbTabsLayout / __cdbTabsStore / __cdbTabsHarvest
  # at evaluation time and bails if any is missing. All four are evaluated as ONE
  # string, so dependency order is simply file order.
  let pageSrc = LAYOUT_JS & "\n;\n" & STORE_JS & "\n;\n" & HARVEST_JS & "\n;\n" &
    PAGE_JS & "\n;\nif(window.__cdbTabsPage)window.__cdbTabsPage.start();\n"
  MAIN_JS.replace(PLACEHOLDER, "\"" & escapeJs(pageSrc) & "\"")

proc apply*(input: string): string =
  result = input
  # Idempotency: positive end-state assertion (Rule 6).
  if MARKER in result:
    echo "  [OK] panel tabs: injection already present (idempotent)"
    return
  let injection = buildInjection()
  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & injection & result[strictPrefix.len .. ^1]
    echo "  [OK] panel tabs injected after \"use strict\""
  else:
    result = injection & result
    echo "  [OK] panel tabs prepended"
  if MARKER notin result:
    echo "  [FAIL] panel tabs: injection not present after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_panel_tabs <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_panel_tabs ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] panel tabs applied"
  else:
    if MARKER notin output:
      echo "  [FAIL] No changes made and injection is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
