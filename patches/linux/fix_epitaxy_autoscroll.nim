# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Fix the Code / Cowork transcript not following new messages.
#
# The Code and Cowork tabs are rendered by the remote claude.ai SPA (internally
# "epitaxy"). Its transcript scroller keeps itself at the bottom by watching a
# 1px sentinel (`div.absolute.bottom-0.h-px`) with an IntersectionObserver, and
# it sets `overflow-anchor: none`, so the browser offers no help either.
#
# That test is a knife edge. Measured in a live session against the remote SPA
# (2026-07-30): park the transcript at the bottom, nudge scrollTop up by *3
# pixels*, and it never follows again - scrollHeight grew 1280 -> 3080 while
# scrollTop stayed frozen at 641. A 3px drift is routine during streaming
# (sub-pixel layout,
# `scrollbar-gutter: stable both-edges`, fonts loading, `[contain:strict]`
# reflow, touchpad inertia), which is why the view strands mid-stream and only a
# manual scroll brings it back. It is worst in the floating side chat, whose
# viewport is small enough that a few hundred stranded pixels hide everything.
#
# We attach our own stick-to-bottom to the transcript scrollers under
# `.epitaxy-chat-panel-body` and `.epitaxy-side-chat`: a tolerance band instead
# of a single pixel, re-asserted on every content resize/mutation, and released
# the moment the user scrolls up on purpose. See js/fix_epitaxy_autoscroll.js.
#
# Break risk: LOW for the injection - same "use strict" anchor as
# fix_cowork_font, no regex against minified app code. The injected JS keys off
# remote claude.ai class names, so it can be invalidated by a claude.ai deploy
# without a Claude Desktop release; it degrades to a no-op (the sweep simply
# finds nothing) rather than breaking the view.

import std/[os, strutils]

const FIX_JS = staticRead("../../js/fix_epitaxy_autoscroll.js")

proc escapeJs(s: string): string =
  result = s
  result = result.replace("\\", "\\\\")
  result = result.replace("\"", "\\\"")
  result = result.replace("\n", "\\n")
  result = result.replace("\r", "")

const INJECTION =
  """;(function(){
if(typeof process==="undefined"||!process.versions||!process.versions.electron)return;
var _app=require("electron").app;
var __cdbAutoScrollJs=""" & "\"" &
  escapeJs(FIX_JS) &
  "\"" & """;
_app.on("web-contents-created",function(_ev,wc){
wc.on("dom-ready",function(){
try{
var url=wc.getURL()||"";
if(url.indexOf("claude.ai")!==-1||url.indexOf("claude.com")!==-1){
wc.executeJavaScript(__cdbAutoScrollJs).catch(function(){});
}
}catch(e){}
});
});
})();"""

const MARKER = "__cdbAutoScrollJs"

proc apply*(input: string): string =
  result = input

  # Idempotency: assert OUR injected end-state is present, not merely that some
  # pre-patch pattern is gone (CLAUDE.md rule 6).
  if MARKER in result:
    echo "  [OK] epitaxy autoscroll: injection already present (idempotent)"
    return

  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & INJECTION & result[strictPrefix.len .. ^1]
    echo "  [OK] epitaxy autoscroll injected after \"use strict\""
  else:
    result = INJECTION & result
    echo "  [OK] epitaxy autoscroll prepended"

  if MARKER notin result:
    echo "  [FAIL] epitaxy autoscroll: injection not present after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_epitaxy_autoscroll <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_epitaxy_autoscroll ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] epitaxy autoscroll applied"
  else:
    if MARKER notin output:
      echo "  [FAIL] No changes made and injection is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
