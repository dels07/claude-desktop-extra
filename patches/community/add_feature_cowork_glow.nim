# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Let the pulsing Cowork glow be held still from Settings -> Extra -> Features,
# for laptops and machines without much graphics power.
#
# The Cowork hero carries an element with class `.cowork-hero-glow`, and the
# remote claude.ai stylesheet gives it:
#
#   .cowork-hero-glow { animation: 3.2s ease-in-out infinite cowork-hero-glow-pulse }
#   @keyframes cowork-hero-glow-pulse { 0%,to { opacity:.55 } 50% { opacity:1 } }
#
# `infinite` is the part that matters. The animation never ends, so for as long as
# a Cowork view is open the compositor is handed work every frame and the display
# pipeline never idles - on a laptop that is battery spent on decoration. An
# opacity animation is cheap while it is GPU-composited, but this is Linux: our
# own launcher falls back to `--disable-gpu-compositing` on software/llvmpipe
# setups and to `--disable-gpu` outright when the GPU is blocklisted, and in those
# configurations the glow is redrawn on the CPU for every one of those frames.
#
# Upstream's only escape hatch is `prefers-reduced-motion: reduce`, an OS-wide
# setting that flattens every other animation in the app along with it; this gives
# the glow its own switch instead.
#
# No frame-time or power figure is claimed: the rationale is the mechanism above -
# an unending animation plus our software-rendering fallbacks - not a benchmark.
#
# The class carries nothing but the animation - the gradient and blur come from
# utilities on the same element - so `animation: none` alone would leave the glow
# parked at its own opacity, i.e. brighter than the pulse's average rather than
# calmer. "calm" therefore pins BOTH: no animation, and a fixed opacity (default
# .55, the dim end of upstream's own range).
#
# Applied with webContents.insertCSS so no page-side script is needed, and
# removed/re-inserted on change so the switch takes effect in every open window
# without a restart. globalThis.__cdbCoworkGlow is the API the Extra settings
# page reaches through its ipcMain handlers (mirroring globalThis.__cdbThemes).
#
# NOTE: `animate-[conway-pulse-glow_2s_ease-in-out_infinite]` also exists in the
# same stylesheet and looks related, but `@keyframes conway-pulse-glow` is not
# defined anywhere in the shipped CSS, so that utility animates nothing and is
# deliberately NOT targeted.
#
# Break risk: LOW for the injection - same "use strict" anchor as
# fix_cowork_font, no regex against minified app code. The selector belongs to
# the remote claude.ai SPA, so a deploy can rename it; the CSS then simply
# matches nothing and the glow keeps pulsing as it does today.

import std/[os, strutils]

const INJECTION = """;(function(){
if(typeof process==="undefined"||!process.versions||!process.versions.electron)return;
var _e=require("electron"),_app=_e.app,_fs=require("fs"),_path=require("path");
function __cdbG_log(m){try{(globalThis.__cdbDiag||function(){})("[cowork-glow] "+m)}catch(e){}}

var __cdbG_DEFAULT_OPACITY=0.55;
var __cdbG_mode="pulse",__cdbG_opacity=__cdbG_DEFAULT_OPACITY;
// wc -> key returned by insertCSS, so it can be removed again on change.
var __cdbG_keys=new WeakMap();
var __cdbG_tracked=[];

function __cdbG_strip(s){
return s.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,function(m,q){return q?q:""})
        .replace(/,(\s*[}\]])/g,"$1");
}
function __cdbG_read(p){
try{var r=_fs.readFileSync(p,"utf8");return JSON.parse(__cdbG_strip(r))}catch(e){return null}
}
// New name first, legacy name as a fallback: the one-time
// claude-desktop-bin -> -extra migration lives in the custom-themes patch
// (globalThis.__cdbCfgMigrate) and same-anchor prefix injections stack in
// reverse, so it may not have run yet when this does. Reading both makes the
// order moot instead of losing a pre-rename config on the first launch.
function __cdbG_pick(d,newName,oldName){
var v=__cdbG_read(_path.join(d,newName));
return v!==null?v:__cdbG_read(_path.join(d,oldName));
}
// .json then .jsonc, .jsonc wins - the same precedence the theme engine uses.
function __cdbG_cfg(){
try{(globalThis.__cdbCfgMigrate||function(){})()}catch(e){}
var d=_app.getPath("userData"),out={};
var a=__cdbG_pick(d,"claude-desktop-extra.json","claude-desktop-bin.json");
var b=__cdbG_pick(d,"claude-desktop-extra.jsonc","claude-desktop-bin.jsonc");
var k;
if(a&&typeof a==="object")for(k in a)out[k]=a[k];
if(b&&typeof b==="object")for(k in b)out[k]=b[k];
return out;
}
function __cdbG_clampOpacity(v){
var n=typeof v==="number"?v:parseFloat(v);
if(!isFinite(n))return __cdbG_DEFAULT_OPACITY;
if(n<0)n=0;if(n>1)n=1;
return n;
}
function __cdbG_css(){
return ".cowork-hero-glow{animation:none!important;opacity:"+__cdbG_opacity+"!important}";
}
function __cdbG_isClaude(wc){
try{var u=wc.getURL()||"";return u.indexOf("claude.ai")!==-1||u.indexOf("claude.com")!==-1}catch(e){return false}
}
function __cdbG_clear(wc){
var k=__cdbG_keys.get(wc);
if(k===undefined)return;
__cdbG_keys.delete(wc);
try{wc.removeInsertedCSS(k)}catch(e){}
}
// Returns whether this webContents was handled, so switching back to "pulse"
// reports the windows it cleared rather than a misleading zero.
function __cdbG_push(wc){
if(!wc||wc.isDestroyed()||!__cdbG_isClaude(wc))return false;
__cdbG_clear(wc);
if(__cdbG_mode!=="calm")return true;
try{
var p=wc.insertCSS(__cdbG_css());
if(p&&typeof p.then==="function")p.then(function(k){__cdbG_keys.set(wc,k)}).catch(function(){});
return true;
}catch(e){return false}
}
function __cdbG_pushAll(){
var n=0;
for(var i=0;i<__cdbG_tracked.length;i++){
var wc=__cdbG_tracked[i];
try{if(wc.isDestroyed())continue}catch(e){continue}
if(__cdbG_push(wc))n++;
}
return n;
}

// The Extra settings page reaches these through validated ipcMain handlers.
globalThis.__cdbCoworkGlow={
version:1,
read:function(){return {mode:__cdbG_mode,opacity:__cdbG_opacity,defaultOpacity:__cdbG_DEFAULT_OPACITY}},
set:function(mode){
if(mode!=="pulse"&&mode!=="calm")return {ok:false,error:"mode must be \"pulse\" or \"calm\""};
__cdbG_mode=mode;
var n=__cdbG_pushAll();
__cdbG_log("mode="+mode+" applied to "+n+" window(s)");
return {ok:true,mode:mode,windows:n};
}
};

try{
var c0=__cdbG_cfg();
if(c0.coworkGlow==="calm")__cdbG_mode="calm";
__cdbG_opacity=__cdbG_clampOpacity(c0.coworkGlowOpacity===undefined?__cdbG_DEFAULT_OPACITY:c0.coworkGlowOpacity);
__cdbG_log("startup mode="+__cdbG_mode+" opacity="+__cdbG_opacity);
}catch(e){}

_app.on("web-contents-created",function(_ev,wc){
if(__cdbG_tracked.indexOf(wc)<0)__cdbG_tracked.push(wc);
wc.on("destroyed",function(){
var i=__cdbG_tracked.indexOf(wc);
if(i>=0)__cdbG_tracked.splice(i,1);
});
// insertCSS applies to the current document only, so re-apply per navigation.
wc.on("dom-ready",function(){try{__cdbG_push(wc)}catch(e){}});
});
})();"""

const MARKER = "__cdbCoworkGlow"

proc apply*(input: string): string =
  result = input

  # Idempotency: assert OUR injected end-state is present, not merely that some
  # pre-patch pattern is gone (CLAUDE.md rule 6).
  if MARKER in result:
    echo "  [OK] cowork glow: injection already present (idempotent)"
    return

  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & INJECTION & result[strictPrefix.len .. ^1]
    echo "  [OK] cowork glow injected after \"use strict\""
  else:
    result = INJECTION & result
    echo "  [OK] cowork glow prepended"

  if MARKER notin result:
    echo "  [FAIL] cowork glow: injection not present after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_cowork_glow <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_cowork_glow ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] cowork glow applied"
  else:
    if MARKER notin output:
      echo "  [FAIL] No changes made and injection is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
