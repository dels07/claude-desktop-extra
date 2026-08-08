# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Log silently-suppressed main-webview renderer deaths (#128).
#
# The main webview's "render-process-gone" handler logs and reloads only when
# it decides to act. Every death it decides to swallow -- an expected kill it
# has counted, a "clean-exit", or a "killed" that arrives while the app is
# quitting -- leaves no trace in main.log at all, so a renderer that dies (->
# blank view, claude.ai re-login) is invisible after the fact. Log those.
#
# Pure observability: the handler's own condition is re-emitted verbatim and
# its value is passed straight through, so which deaths get reloaded is
# unchanged. Only the silent path gains a log line.

import std/[os, strutils]
import regex

# Literal substring of the injected log line; absent from the fresh bundle.
const AppliedMarker = "Main webview render process gone (suppressed)"

proc apply*(input: string): string =
  if AppliedMarker in input:
    echo "  [OK] suppressed renderer-gone log: already applied"
    return input

  # Up to v1.24012.9 the suppression was an inline early-return branch:
  #   .on("render-process-gone",async(i,r)=>{if(KG>0||r.reason==="killed"||r.reason==="clean-exit"){KG>0&&KG--;return}if(D.info("Main webview render process gone: %o
  # v1.26832.0 hoisted the whole decision into a predicate and inverted the
  # branch, so there is no early-return statement left to inject into:
  #   e.on(`render-process-gone`,async(t,a)=>{if(Ia(a)&&!(a.reason===`killed`&&(await new Promise(...)),...)&&!e.isDestroyed()){if(o.o.info(`Main webview render process gone: %o`,a),...
  # The handler now logs only when it acts; every suppressed death is still
  # silent, which is the gap #128 is about.
  #
  # Injection: wrap the whole `if` condition in an arrow call that logs when
  # the condition came out false. The condition itself is captured and
  # re-emitted verbatim -- it contains an `await`, which stays legal because
  # the argument expression is still evaluated in the enclosing async arrow.
  #
  # The condition is captured as a run of non-brace characters, spelled as
  # three concatenated runs because the regex library caps a repetition range
  # at 100 (and nesting the bound blows up NFA construction at compile time).
  # 112 chars in v1.26832.0, so 300 is the headroom. Excluding braces both
  # bounds the match and keeps it from running past the `{` that opens the
  # handler body, so the nine other render-process-gone registrations cannot
  # reach this pattern's tail.
  #
  # The trailing `.info(<q>Main webview render process gone: %o` both pins this
  # site (10 render-process-gone registrations exist; only this one logs that
  # message) and captures the logger identifier, which is now a dotted
  # namespace reference (`o.o`) rather than a bare local.
  # Count policy: require >= 1 and echo the actual count -- the insertion
  # is correct for N copies of the registration, while 0 matches means
  # upstream changed the code and the patch must fail loudly.
  let pattern =
    re2"""(\.on\(["`]render-process-gone["`],async\(([\w$]+),([\w$]+)\)=>\{if\()([^{}]{1,100}[^{}]{0,100}[^{}]{0,100})(\)\{if\(([\w$]+(?:\.[\w$]+)*)\.info\(["`]Main webview render process gone: %o)"""
  var count = 0
  result = input.replace(
    pattern,
    proc(m: RegexMatch2, s: string): string =
      inc count
      # group(0) is the whole prefix; group(1) is the (unused) event arg.
      let details = s[m.group(2)] # RenderProcessGoneDetails
      let cond = s[m.group(3)] # upstream's "should we handle this?" expression
      let tail = s[m.group(4)] # closing paren of the if + start of its body
      let logger = s[m.group(5)] # module-level logger
      s[m.group(0)] & "(__cdbRpgHandled=>{if(!__cdbRpgHandled)" & logger &
        """.info("Main webview render process gone (suppressed): %o",{reason:""" &
        details & ".reason,exitCode:" & details & ".exitCode});return __cdbRpgHandled})(" &
        cond & ")" & tail,
  )
  if count == 0:
    if "Main webview render process gone" in input:
      echo "  [INFO] Found 'Main webview render process gone' in file but pattern didn't match"
    echo "  [FAIL] suppressed renderer-gone pattern: 0 matches (may need pattern update)"
    quit(1)
  echo "  [OK] suppressed renderer-gone log: " & $count & " match(es)"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_renderer_gone_suppressed_log <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_renderer_gone_suppressed_log ==="
  echo "  Target: " & filePath
  let input = readFile(filePath)
  let output = apply(input)
  writeFile(filePath, output)
  echo "  [PASS] Suppressed renderer-gone log patched successfully"
