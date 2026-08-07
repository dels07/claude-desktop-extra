# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Diff view modes (Working tree / Branch changes / Latest turn) for the Code
# tab. Injects js/diff_views_main.js (with js/diff_views_expand.js +
# js/diff_views_page.js embedded, in that order) into the main bundle.
# Counterpart preload bridge: patches/add_feature_diff_views_bridge.nim.
#
# Break risk: VERY LOW for the injection (stable "use strict"; anchor, no
# regex on minified code). The page half keys off remote epitaxy DOM and
# degrades to a no-op on a claude.ai redeploy.

import std/[os, strutils]

const MAIN_JS = staticRead("../../js/diff_views_main.js")
const PAGE_JS = staticRead("../../js/diff_views_page.js")
const EXPAND_JS = staticRead("../../js/diff_views_expand.js")

const MARKER = "__CDB_DIFF_VIEWS__"
const PLACEHOLDER = "\"__CDB_DV_PAGE_SRC__\""

proc escapeJs(s: string): string =
  result = s
  result = result.replace("\\", "\\\\")
  result = result.replace("\"", "\\\"")
  result = result.replace("\n", "\\n")
  result = result.replace("\r", "")

proc buildInjection(): string =
  if PLACEHOLDER notin MAIN_JS:
    raise newException(ValueError, "diff_views_main.js lost its page-src placeholder")
  # ORDER MATTERS: the expand module defines window.__cdbDvExpandAll, which the
  # page script reads while it builds the chrome row. Both halves are evaluated
  # as ONE string, so the module simply goes first.
  let pageSrc = EXPAND_JS & "\n;\n" & PAGE_JS
  MAIN_JS.replace(PLACEHOLDER, "\"" & escapeJs(pageSrc) & "\"")

proc apply*(input: string): string =
  result = input
  # Idempotency: positive end-state assertion (Rule 6).
  if MARKER in result:
    echo "  [OK] diff views: injection already present (idempotent)"
    return
  let injection = buildInjection()
  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & injection & result[strictPrefix.len .. ^1]
    echo "  [OK] diff views injected after \"use strict\""
  else:
    result = injection & result
    echo "  [OK] diff views prepended"
  if MARKER notin result:
    echo "  [FAIL] diff views: injection not present after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_diff_views <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_diff_views ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] diff views applied"
  else:
    if MARKER notin output:
      echo "  [FAIL] No changes made and injection is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
