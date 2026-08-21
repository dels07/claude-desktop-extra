# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Local GrowthBook feature-flag overrides via <userData>/claude-desktop-extra.json.
#
# GrowthBook flags are served by Anthropic (/api/desktop/features) with no local
# override layer (the fcache disk cache is safeStorage-encrypted). This patch adds
# one: every load path (network fetch, disk cache, deployment-mode hardcoded set)
# funnels through a single features-store setter; we hook its head so a user's
# claude-desktop-extra.json (JSONC - comments allowed; auto-created template on
# first run) is merged over the freshly loaded map. Overrides are applied on a
# shallow copy, so the caller's raw payload (which feeds the disk cache) stays
# untouched. Layering: user override > server rollout.
#
# NOTE: flags that our patches force at the call site (enable_local_agent_mode
# etc. rewrite the read to !0) never consult the store, so this file cannot
# affect them - documented in the template and README.
#
# Sub-patches:
#   A: inject js/growthbook_overrides.js (defines globalThis.__cdbApplyGbOverrides)
#      at the very top of index.js (runs before any chunk code)
#   B: hook the features-store setter: function X(e){let t=Mx;Mx=e,Nx=!0;...
#      anchored on the stable log string "[growthbook] loaded %d features (%d changed)"
#
# Sub-patch A used to insert after the leading `"use strict";` directive. That
# anchor DIED in v1.26832.0: the bundle now opens with a Sentry IIFE and has no
# directive prologue, while the literal `"use strict";` still occurs deep inside
# a vendored template literal (`E(`"use strict"; return (`+e+`).constructor;`)`)
# - so a `find`-based anchor reported success while splicing the whole IIFE into
# the middle of a string. We prepend at offset 0 instead: index.js is a CJS
# module with no prologue and is `require`d by index.pre.js (package.json main),
# so offset 0 is both statement-level and earlier than every chunk.
#
# Break risk: LOW - A has no pattern left to break; B anchors on a log string
# that has been stable across releases. If upstream splits the setter or renames
# the log line, B fails loud.

import std/[os, strformat, strutils]
import std/nre

const OVERRIDES_JS = staticRead("../../js/growthbook_overrides.js")
const EXPECTED_PATCHES = 2

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # --- Sub-patch A: helper injection ---------------------------------------
  if result.contains("__CDB_GB_OVERRIDES__"):
    echo "  [OK] growthbook overrides helper already present"
    inc patchesApplied
  else:
    # Prepend at offset 0 (see header note: no directive prologue since v1.26832.0).
    result = OVERRIDES_JS & result
    if result.contains("__CDB_GB_OVERRIDES__"):
      echo "  [OK] growthbook overrides helper prepended to index.js"
      inc patchesApplied
    else:
      echo "  [FAIL] growthbook overrides helper missing after injection"

  # --- Sub-patch B: hook the features-store setter --------------------------
  # v1.19367.0 shape:
  #   function hTt(e){const t=lf;lf=e,AP=!0;const r=Object.keys(lf).length,
  #     n=Object.entries(lf).filter(...);v.info("[growthbook] loaded %d features (%d changed)",...)
  # v1.26832.0 shape (new minifier: `let` instead of `const`, backtick literals,
  # separate `let` for the second binding, dotted logger callee):
  #   function tS(e){let t=Mx;Mx=e,Nx=!0;let n=Object.keys(Mx).length,
  #     i=Object.entries(Mx).filter(...).length;r.o.info(`[growthbook] loaded %d features (%d changed)`,n,i)
  # v1.34493.1 shape: the setter takes a SECOND parameter (a source/status tag,
  # stored first), the dirty flag is gone, and the stored value now funnels
  # through a TRANSFORM - the deployment-mode hardcoded-features filter, which
  # used to be a separate load path calling the setter:
  #   function Fit(e,t){OS=t;let n=DS;DS=jit(e);let r=Object.keys(DS).length,
  #     i=Object.entries(DS).filter(...).length;D.info(`[growthbook] loaded %d features (%d changed)`,r,i)
  # We now wrap the TRANSFORM CALL (`jit(e)`) rather than reassigning the raw
  # parameter: overrides must apply to the map that is actually STORED, after
  # the hardcoded-mode filter - same layering as before, when the hardcoded set
  # itself arrived through the setter's parameter (user override > any rollout).
  if result.contains("=(globalThis.__cdbApplyGbOverrides||"):
    echo "  [OK] features-store setter already hooked"
    inc patchesApplied
  else:
    let setterPat = nre.re(
      r"""(function [\w$]+\(([\w$]+),[\w$]+\)\{[\w$]+=[\w$]+;(?:const|let|var) [\w$]+=[\w$]+;[\w$]+=)([\w$]+\(\2\))(;(?:const|let|var) [\w$]+=Object\.keys\([\w$]+\)\.length[^"`]{0,200}["`]\[growthbook\] loaded %d features \(%d changed\)["`])"""
    )
    var hooked = 0
    let m = result.find(setterPat)
    if m.isSome:
      let cap = m.get.captures
      let head = cap[0]        # "function F(e,t){OS=t;let n=DS;DS="
      let transformCall = cap[2]  # "jit(e)"
      let tail = cap[3]        # ";let r=Object.keys(DS).length...loaded %d features..."
      let hook =
        head & "(globalThis.__cdbApplyGbOverrides||function(x){return x})(" &
        transformCall & ")" & tail
      result = result.replace(m.get.match, hook)
      hooked = 1
    if hooked == 1:
      echo "  [OK] features-store setter hooked (overrides applied on every flag load)"
      inc patchesApplied
    else:
      echo "  [FAIL] features-store setter pattern: 0 matches (loaded-features log line moved?)"

  if patchesApplied < EXPECTED_PATCHES:
    echo &"  [FAIL] Only {patchesApplied}/{EXPECTED_PATCHES} patches applied"
    quit(1)
  echo &"  [PASS] {patchesApplied}/{EXPECTED_PATCHES} growthbook override patches applied"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_growthbook_overrides <index.js>"
    quit(1)
  let path = paramStr(1)
  echo "=== Patch: add_growthbook_overrides ==="
  echo &"  Target: {path}"
  let content = readFile(path)
  let patched = apply(content)
  if patched != content:
    writeFile(path, patched)
