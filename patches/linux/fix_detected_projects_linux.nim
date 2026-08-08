# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Enable Detected Projects (Recent Projects) on Linux.
# Three patches: platform guard, VSCode/Cursor DB path, Zed DB path.

import std/[os, strformat, strutils]
import regex

# Positive end-state assertion for the idempotency branch: OUR injected
# `&&process.platform!=="linux"` must sit right before the [detectedProjects]
# skipping log. Absence of the old `!=="darwin"` pattern is NOT enough (Rule 6).
proc alreadyPatched(s: string): bool =
  let idx = s.find("[detectedProjects] skipping")
  if idx == -1:
    return false
  let start = max(0, idx - 200)
  "&&process.platform!==\"linux\"" in s[start ..< idx]

proc apply*(input: string): string =
  result = input

  if alreadyPatched(result):
    echo "  [SKIP] Already patched (linux platform guard found)"
    return result

  var allOk = true

  # 1. Platform guard in detection entry-point
  # v1.26832.0: literals are backticks and the logger callee is dotted
  # (`if(process.platform!==`darwin`)return t.o.debug(`[detectedProjects] skipping`).
  let patGuard =
    re2"(if\(process\.platform!==[""`]darwin[""`])(&&process\.platform!==[""`]linux[""`])?\)(return [\w$]+(?:\.[\w$]+)*\.debug\(`\[detectedProjects\] skipping)"
  var countGuard = 0
  result = result.replace(
    patGuard,
    proc(m: RegexMatch2, s: string): string =
      inc countGuard
      s[m.group(0)] & "&&process.platform!==\"linux\")" & s[m.group(2)],
  )
  if countGuard > 0:
    echo &"  [OK] Platform guard: {countGuard} match(es)"
  else:
    echo "  [FAIL] Platform guard: 0 matches"
    allOk = false

  # 2. VSCode / Cursor state DB path
  # v1.26832.0: `i.default.join((0,a.homedir)(),`Library`,...)` - the path module
  # is a dotted member and homedir is called through the `(0,ns.fn)()` indirection.
  let patVscode =
    re2"([\w$]+(?:\.[\w$]+)*)\.join\(((?:\(0,[\w$]+(?:\.[\w$]+)*\.homedir\)|[\w$]+(?:\.[\w$]+)*\.homedir)\(\)),[""`]Library[""`],[""`]Application Support[""`],([\w$]+),[""`]User[""`],[""`]globalStorage[""`],[""`]state\.vscdb[""`]\)"
  var countVscode = 0
  result = result.replace(
    patVscode,
    proc(m: RegexMatch2, s: string): string =
      inc countVscode
      let p = s[m.group(0)]
      let home = s[m.group(1)] # full homedir() call expression, verbatim
      let d = s[m.group(2)]
      let mac =
        p & ".join(" & home & ",\"Library\",\"Application Support\"," & d &
        ",\"User\",\"globalStorage\",\"state.vscdb\")"
      let lin =
        p & ".join(" & home & ",\".config\"," & d &
        ",\"User\",\"globalStorage\",\"state.vscdb\")"
      "(process.platform===\"darwin\"?" & mac & ":" & lin & ")",
  )
  if countVscode > 0:
    echo &"  [OK] VSCode/Cursor DB path: {countVscode} match(es)"
  else:
    echo "  [FAIL] VSCode/Cursor DB path: 0 matches"
    allOk = false

  # 3. Zed state DB path
  let patZed =
    re2"([\w$]+(?:\.[\w$]+)*)\.join\(((?:\(0,[\w$]+(?:\.[\w$]+)*\.homedir\)|[\w$]+(?:\.[\w$]+)*\.homedir)\(\)),[""`]Library[""`],[""`]Application Support[""`],[""`]Zed[""`],[""`]db[""`],[""`]0-stable[""`],[""`]db\.sqlite[""`]\)"
  var countZed = 0
  result = result.replace(
    patZed,
    proc(m: RegexMatch2, s: string): string =
      inc countZed
      let p = s[m.group(0)]
      let home = s[m.group(1)] # full homedir() call expression, verbatim
      let mac =
        p & ".join(" & home &
        ",\"Library\",\"Application Support\",\"Zed\",\"db\",\"0-stable\",\"db.sqlite\")"
      let lin =
        p & ".join(" & home &
        ",\".local\",\"share\",\"zed\",\"db\",\"0-stable\",\"db.sqlite\")"
      "(process.platform===\"darwin\"?" & mac & ":" & lin & ")",
  )
  if countZed > 0:
    echo &"  [OK] Zed DB path: {countZed} match(es)"
  else:
    echo "  [FAIL] Zed DB path: 0 matches"
    allOk = false

  if not allOk:
    raise newException(
      ValueError, "fix_detected_projects_linux: Some patterns did not match"
    )

  if result == input:
    raise newException(ValueError, "fix_detected_projects_linux: No changes made")

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_detected_projects_linux <file>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_detected_projects_linux ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  let output = apply(input)
  if output != input:
    writeFile(file, output)
    echo "  [PASS] Detected Projects patched for Linux"
  elif alreadyPatched(output):
    echo "  [PASS] Detected Projects already patched for Linux (idempotent)"
  else:
    echo "  [FAIL] No changes made"
    quit(1)
