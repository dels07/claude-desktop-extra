# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Second-instance (single-instance-lock) activation diagnostics on Linux.
#
# Launching Claude while it is already running makes the new process fail
# requestSingleInstanceLock(), fire a `second-instance` event in the RUNNING
# process, and exit. The running process is then supposed to reveal and focus
# its window. Upstream logs nothing at all on that path unless its 500ms argv
# dedupe fires, so a failed reveal leaves no evidence anywhere (issue #233:
# "No corresponding 'already visible' or 'showing window' log line appears").
#
# We inject js/second_instance_diag.js into the "use strict" preamble, which
# registers our own `second-instance` listener BEFORE the bundle registers its
# own. Electron calls listeners in registration order, so ours runs first and
# captures the window state upstream is about to act on, then samples the
# resulting reveal after upstream's handler returns and again at +500ms/+2s.
#
# It records the received argv/cwd, whether Chromium forwarded an
# --xdg-activation-token (the Wayland raise depends on one, and the bundle
# itself never reads one), any additionalData, and per-window
# visible/focused/minimized/geometry/display - including the "NO WINDOWS EXIST"
# case, which is upstream dropping the activation because its `V &&
# !V.isDestroyed()` guard ran before the main window was created.
#
# Behaviour-neutral: it adds a listener and changes nothing else. It also hooks
# only a public Electron event, so there are no minified anchors to re-fit on an
# upstream bump - which is the point, since this has to survive long enough to
# collect reports.
#
# Output lands in ~/.config/Claude/logs/claude-patches.log (profile/3p-aware)
# via __cdbDiag, resolved lazily at call time because the CU preamble defines it
# later in the same bundle.

import std/[os, strformat, strutils]

const EXPECTED_PATCHES = 1

const DIAG_JS = staticRead("../../js/second_instance_diag.js")

# Bumped whenever the snippet's shape changes, so idempotency asserts THIS
# version's injected end-state rather than "something of ours is present".
const DIAG_MARKER = "__cdb_si_diag_v1__"

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  if DIAG_MARKER in result:
    echo "  [INFO] second-instance diagnostics already injected (" & DIAG_MARKER & ")"
    patchesApplied += 1
  else:
    if result.startsWith("\"use strict\";"):
      result = "\"use strict\";" & DIAG_JS & result[len("\"use strict\";") .. ^1]
      echo "  [OK] second-instance diagnostics injected after \"use strict\""
    else:
      result = DIAG_JS & result
      echo "  [OK] second-instance diagnostics prepended"
    # Positive end-state assertion: the marker must be in the output we return.
    if DIAG_MARKER notin result:
      echo "  [FAIL] injection did not land (" & DIAG_MARKER & " absent from output)"
      raise newException(
        ValueError, "fix_second_instance_diag: injected marker missing from output"
      )
    patchesApplied += 1

  if patchesApplied < EXPECTED_PATCHES:
    raise newException(
      ValueError,
      &"fix_second_instance_diag: Only {patchesApplied}/{EXPECTED_PATCHES} patches applied",
    )

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_second_instance_diag <file>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_second_instance_diag ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  let output = apply(input)
  if output != input:
    writeFile(file, output)
    echo "  [PASS] Diagnostics injected"
  else:
    echo "  [PASS] No changes needed (already injected)"
