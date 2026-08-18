# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Fix Quick Entry ready-to-show hang on Wayland.
#
# Electron's 'ready-to-show' event never fires for transparent, frameless
# BrowserWindows on native Wayland. The Quick Entry window (Mlr function)
# awaits this event indefinitely, causing the overlay to never appear.
#
# This patch adds a 100ms timeout to the ready-to-show wait so the Quick
# Entry window proceeds to show even if the event never fires.
# The timeout is 100ms (reduced from 200ms): Chromium first-paint on Wayland
# typically completes in 30-50ms, so 100ms still provides comfortable headroom
# while saving 100ms on every Quick Entry open.

import std/[os, strutils, options]
import std/nre

# Name of the injected timeout resolver. Doubles as the idempotency marker:
# a generic `_r` would collide with minified locals, this cannot.
const TIMEOUT_MARKER = "_qeReadyRace"

proc apply*(input: string): string =
  # The Quick Entry show function waits for ready-to-show. Up to v1.24012.x the
  # minifier expanded optional chaining by hand:
  #   <FLAG>||await(<P>==null?void 0:<P>.catch(<E>=>{<LOG>.error("Quick Entry: Error waiting for ready %o",{error:<E>})}))
  # v1.26832.0 emits the `?.` operator directly and uses backtick template
  # literals:
  #   <FLAG>||await <P>?.catch(<E>=>{<LOG>.error(`Quick Entry: Error waiting for ready %o`,{error:<E>}))
  # v1.32352.1 parenthesizes the awaited expression and the catch callback:
  #   <FLAG>||await(<P>?.catch((<E>=>{...})))
  # so `await` is followed by a space OR an open paren, and the callback and
  # the awaited expression each allow an optional surrounding paren pair. The
  # replacement is built from scratch and self-balanced either way.
  # Variable names change every release (NEe/YEe, nK/AK, etc.) and so does the
  # logger module (`n.o` in v1.26832.0 -- a dotted chunk namespace now). We must
  # REUSE the upstream logger and catch param in the replacement -- hardcoding
  # them (e.g. `R.error`) plants a latent ReferenceError in the rejection branch
  # even though the patch applies cleanly and node --check passes. The whole
  # catch callback is captured and re-emitted verbatim, which keeps the logger,
  # the catch param and the upstream quoting style intact.
  # We wrap this in Promise.race with a 100ms timeout.
  if strutils.contains(input, TIMEOUT_MARKER):
    echo "  [OK] ready-to-show timeout already present (idempotent)"
    return input

  let pat =
    re"""([\w$]+)\|\|await[ (]([\w$]+)\?\.catch\(\(?(([\w$]+)=>\{[\w$]+(?:\.[\w$]+)*\.error\([`"]Quick Entry: Error waiting for ready %o[`"],\{error:\4\}\)\})\)?\)\)?"""

  let m = input.find(pat)
  if m.isSome:
    let match = m.get
    let flagVar = match.captures[0]
    let promiseVar = match.captures[1]
    let catchCb = match.captures[2]
    let newStr =
      flagVar & "||await Promise.race([" & promiseVar & "?.catch(" & catchCb &
      "),new Promise(" & TIMEOUT_MARKER & "=>setTimeout(" & TIMEOUT_MARKER & ",100))])"
    result =
      input[0 ..< match.matchBounds.a] & newStr & input[match.matchBounds.b + 1 .. ^1]
    echo "  [OK] ready-to-show timeout (100ms) added (vars: " & flagVar & ", " &
      promiseVar & ")"
  else:
    echo "  [FAIL] ready-to-show wait pattern not found"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_quick_entry_ready_wayland <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_quick_entry_ready_wayland ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Quick Entry ready-to-show timeout applied"
  else:
    echo "  [WARN] No changes made"
