# @patch-target: app.asar.contents/.vite/build/file-index-worker/fileIndexWorker.js
# @patch-type: nim
#
# Files quick open - worker half. Upstream's fuzzy file scorer treats a space in
# the query as a literal character to find, so "user service" matches nothing.
# This patch (1) prepends js/files_quick_open_worker.js, which defines
# __cdbQoSearch(index, query, limit) - VS Code's multi-piece AND search on top of
# the unchanged scorer, gated by process.env.CDB_FILES_QUICK_OPEN - and
# (2) rewrites the ONE call site inside FileIndexHost.search:
#     for(let{path:r,positions:i}of this.index.search(e,t))
#  -> for(let{path:r,positions:i}of __cdbQoSearch(this.index,e,t))
#
# Break risk: LOW. The anchor is the structural shape of FileIndexHost.search
# (a `let x=[]` followed by a for-of over this.index.search with the method's own
# two parameters); every identifier is a wildcard and the parameter names are
# cross-checked in the replacement. A second precondition pins `readyCount` on
# the scorer, which the helper needs and the call-site anchor does not cover.

import std/[os, strutils]
import regex

const HELPER_JS = staticRead("../../js/files_quick_open_worker.js")
const MARKER = "__CDB_QOPEN_WORKER__"
const DIRECTIVES = ["\"use strict\";", "'use strict';"]

# The rewritten call site, matched by SHAPE rather than by the bare substring
# "__cdbQoSearch(this.index," - that substring also occurs in the helper's own
# doc comment, so a substring test would report "call present" the moment the
# helper is prepended, even if the rewrite never happened (Rule 6: an [OK] must
# rest on a positively verified end-state).
let callRe = re2"\}of __cdbQoSearch\(this\.index,[\w$]+,[\w$]+\)\)"

proc hasCallSite(s: string): bool = s.contains(callRe)

# search(<q>,<lim>){let <acc>=[];if(this.index)for(let{path:<p>,positions:<pos>}of this.index.search(<q2>,<lim2>))
# Groups: 0 = everything up to and including "of ", 1 = q, 2 = lim, 3 = q2, 4 = lim2
let anchor = re2"(search\(([\w$]+),([\w$]+)\)\{let [\w$]+=\[\];if\(this\.index\)for\(let\{path:[\w$]+,positions:[\w$]+\}of )this\.index\.search\(([\w$]+),([\w$]+)\)\)"

# PRECONDITION for the helper's multi-piece path: js/files_quick_open_worker.js
# scans the WHOLE ready set per piece (`index.search(piece, index.readyCount)`),
# because intersecting two top-N lists would drop the very files the space fix
# exists for. If the scorer stops exposing `readyCount`, the helper reads
# `undefined`, falls into `total === 0` and returns [] for every multi-piece
# query - a SILENT regression the call-site anchor alone cannot catch. So pin it:
# the scorer's search() destructures it off `this`
# (measured 1.37937.3 and 1.40609.0: `{paths:u,lowerPaths:d,charBits:f,pathLens:p,readyCount:h}=this`)
# and the field is assigned somewhere in the bundle.
let readyCountRe = re2"readyCount:[\w$]+\}=this"

proc apply*(input: string): string =
  result = input
  let hasMarker = MARKER in result
  let hasCall = hasCallSite(result)
  # Idempotency (Rule 6): BOTH halves of our end-state must be present.
  if hasMarker and hasCall:
    echo "  [OK] files quick open worker: helper + rewritten call already present (idempotent)"
    return
  if hasMarker != hasCall:
    echo "  [FAIL] files quick open worker: partial injection (marker=" & $hasMarker &
      " call=" & $hasCall & ") - refusing to patch on top; re-audit the worker bundle"
    quit(1)

  if not result.contains(readyCountRe) or "this.readyCount=" notin result:
    echo "  [FAIL] files quick open worker: scorer no longer exposes readyCount - the helper's full-set scan would silently return nothing; re-audit"
    quit(1)

  var count = 0
  result = result.replace(anchor, proc(m: RegexMatch2, s: string): string =
    let q = s[m.group(1)]
    let lim = s[m.group(2)]
    if s[m.group(3)] != q or s[m.group(4)] != lim:
      echo "  [FAIL] files quick open worker: inner search() args (" & s[m.group(3)] & "," &
        s[m.group(4)] & ") are not the method parameters (" & q & "," & lim & ")"
      quit(1)
    inc count
    s[m.group(0)] & "__cdbQoSearch(this.index," & q & "," & lim & "))"
  )
  if count != 1:
    echo "  [FAIL] files quick open worker: expected exactly 1 FileIndexHost.search anchor, found " & $count
    quit(1)

  # Prepend the helper after the directive prologue (a directive only counts when
  # it is the very first statement).
  var prologue = 0
  for d in DIRECTIVES:
    if result.startsWith(d):
      prologue = d.len
      break
  let helper = "\n/*" & MARKER & "*/\n" & HELPER_JS & "\n"
  result = result[0 ..< prologue] & helper & result[prologue .. ^1]

  if MARKER notin result or not hasCallSite(result):
    echo "  [FAIL] files quick open worker: end-state absent after patching"
    quit(1)
  echo "  [OK] files quick open worker: helper prepended, FileIndexHost.search rewritten"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_files_quick_open_worker <path_to_fileIndexWorker.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_files_quick_open_worker ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] files quick open worker applied"
  else:
    if MARKER notin output or not hasCallSite(output):
      echo "  [FAIL] No changes made and end-state is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
