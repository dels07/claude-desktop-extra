# Spinner / Brand-Glyph Replacement via Webview Injection

**Status:** Implemented and shipped. The runtime engine is `js/spinner_injector.js`,
installed by `patches/core/add_feature_custom_themes.nim`; every bundled palette carries a
spinner, and a theme switch re-themes the glyph live. These notes remain the design
record: why injection rather than a bundle patch, how the glyph is identified, and what
the failure modes are. The shape catalog is in
[SPINNER_SHAPES.md](SPINNER_SHAPES.md).

**Goal:** Replace the Anthropic 7-point "starburst/asterisk" brand glyph that
claude.ai renders as the greeting icon and the in-progress loading/thinking
spinner, swapping in an arbitrary per-theme shape (e.g. a Super Mario mushroom),
**without** breaking unrelated UI, and keeping the color following the theme accent.

---

## 0. Why injection (not a bundle string-replace)

The star SVG is rendered by **remote claude.ai code**, not the local Electron bundle.
Verified against the freshly-extracted bundle
(`tmp/app.asar.contents/.vite/build/index.js`): none of the candidate signals appear
there:

| Signal | In local bundle? |
|--------|------------------|
| `fill-current` | NO |
| star path prefix `m19.6 66.5` | NO |
| `text-accent-brand` | NO |
| `viewBox="0 0 100 100"` | NO |

So a Nim string-replace patch is impossible. We must inject JS into the webview, the
same way the theme patch already injects CSS.

### Reuse the existing injection hook

`patches/core/add_feature_custom_themes.nim` already installs (lines ~218-229):

```js
_app.on("web-contents-created", function(_ev, wc){
  wc.on("dom-ready", function(){
    var url = wc.getURL() || "";
    if (url.indexOf("devtools://") === 0) return;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) return;
    wc.insertCSS(__cdb_css);
    wc.executeJavaScript(__cdb_js); // <-- spinner installer goes here
  });
});
```

`dom-ready` fires once per navigation/document. For a SPA like claude.ai the document
is **not** reloaded on in-app navigation, so the installer must itself be resilient to
later DOM churn (MutationObserver) rather than relying on re-injection.

The same `executeJavaScript` path is **also** used as the live channel: on every theme
switch the main process re-runs the injector file, with the new spec prepended, in every
open window. A second run does not install a second engine - it pushes the new spec into
the one already there (section 6).

**The spinner spec is serialized into the injected JS string by the main process**
(from the active theme's `spinner` key, whether that theme is a built-in, a gaming
palette, a community palette, or one of yours in `claude-desktop-bin.jsonc`), exactly
like `__cdb_css` is built. The runtime JS does **not** read the config file itself - the
main side serializes the spec to JSON and string-concatenates it into the script as
`var __CDB_SPINNER_SPEC = <json|null>;`, so the renderer receives a literal object.

---

## 1. Identifying the glyph reliably

The star glyph appears in multiple places (greeting header, in-progress "thinking"
spinner, possibly app logo / send button). We want to catch the **brand/loading**
instances and not, say, an unrelated icon that happens to share a wrapper class.

### Candidate signals (ranked)

| # | Signal | Precision | Stability | Verdict |
|---|--------|-----------|-----------|---------|
| a | `<svg viewBox="0 0 100 100">` containing exactly one `<path>` whose `d` **starts with the known star coordinates** | **Highest** | The path is the literal Anthropic logo geometry - extremely unlikely to be reused for anything that is *not* the brand glyph. Coordinates are stable across releases (it's the logo). | **PRIMARY matcher** |
| b | Wrapper classes `text-accent-brand` / `fill-current` | Medium | Tailwind utility classes; `text-accent-brand` is reasonably brand-specific but could appear on other accent-colored icons. `fill-current` is extremely generic. | Secondary / confirmation only |
| c | Ancestor context (`.font-display` greeting vs animated thinking state) | Low | Distinguishes *instances* but not the glyph itself; brittle to layout refactors. | Do **not** gate on this - we *want* to catch all instances |

**Decision: match on the path-`d` prefix (signal a).** It is the single most precise,
self-describing signal: the geometry *is* the brand mark. We do not need the wrapper
classes, the viewBox, or the ancestor - though we additionally require
`viewBox="0 0 100 100"` as a cheap pre-filter so the observer skips the vast majority
of SVGs without a substring scan.

### The known star path

From the user-provided live DOM, the path begins:

```
m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 ...Z
```

The snippet was truncated (`...`) in the middle, so we do **not** have the complete
path string and must **not** hardcode the full `d` as an equality check. Instead match
on a **distinctive leading substring** that is long enough to be unique but short
enough to survive minor coordinate re-emission:

```
PATH_SIGNATURE = "m19.6 66.5 19.7-11"
```

This 18-char prefix is the start of the upper-left ray of the asterisk and is highly
distinctive (no other icon would start a path at exactly `19.6 66.5` then draw
`19.7-11`). We test with `indexOf` rather than `startsWith`, so a prepended `M0 0` or
normalized whitespace ahead of the run does not defeat it.

**As shipped the matcher carries three fragments, not one:** the original run, its
continuation (`19.7-11 .3-1-.3-.5`) and a looser slice of the same run
(`66.5 19.7-11`). A path matches if it contains *any* of them, so upstream re-emitting a
single coordinate run does not blind the matcher. A theme's `match` replaces the whole
set and accepts either a string or an array of strings.

> **Maintenance note (version-sensitive):** if Anthropic ever re-exports the logo with
> coordinates that miss all three fragments, the signature set must be updated. This is
> exactly the kind of remote-rendered value that this repo cannot pin - so the installer
> logs a one-line diagnostic (`[spinner] themed N glyph(s)`) so the user can tell from
> the webview console whether the signature still matches after an upstream change. Treat
> a sudden `themed 0` as "the logo geometry changed", not "feature removed". A per-theme
> `match` fixes it without a rebuild.

---

## 2. Replacement technique

### Options

| Approach | How | Pros | Cons |
|----------|-----|------|------|
| **(a) Rewrite `<path>` children of the matched `<svg>`** | Keep the `<svg>` element, keep its `viewBox` and `class` (incl. `fill-current`), replace its inner `<path>` markup with the spec's paths | Inherits theme accent via `fill-current` -> `--accent-brand` for any `currentColor` path; keeps claude.ai's own wrapper/animation classes; minimal DOM disturbance; multi-color possible by adding explicit `fill` on extra paths | Must set inner SVG markup; React may later re-render the SVG and revert it (handled by re-observation + idempotency marker) |
| (b) Replace entire inner SVG markup of wrapper | `wrapper.innerHTML = "<svg ...>...</svg>"` | Total control of viewBox/markup | Loses claude.ai's own `class`/animation on the `<svg>`; more to get right; same React-revert risk |
| (c) CSS-only (hide svg + `mask-image`/`background` on wrapper) | `svg{display:none}` + wrapper gets a data-URI mask | No JS DOM writes | Can't swap an inline path with CSS; mask needs a stable box (wrapper size varies: `w-8`, smaller thinking spinner); single-color only (mask) or needs layered backgrounds for multicolor; fragile sizing | 

### Decision: **(a)** - rewrite the `<path>` children, keep the `<svg>`.

Rationale: keeping the original `<svg>` (with its `viewBox="0 0 100 100"` and its
`fill-current` class) means:

- single-color shapes that use `fill="currentColor"` automatically follow the theme
  accent (because `fill-current` resolves `currentColor` to `text-accent-brand`);
- claude.ai's own animation classes on the `<svg>`/wrapper keep working;
- the box size (`w-8` greeting, smaller thinking) is preserved because we don't touch
  the wrapper.

We set the paths by clearing the SVG's existing children and inserting new
`<path>` elements built from the spec (using `document.createElementNS` for correctness
in the SVG namespace - **not** `innerHTML`, which is unreliable for SVG content and
trips strict CSP/Trusted-Types). If the spec provides a different `viewBox`, we update
the `<svg>`'s `viewBox` attribute too (default keeps `0 0 100 100`).

### Idempotency, SPA re-renders, and no observer loops

Three concerns, three guards:

1. **Don't re-process the same node.** After replacing, stamp the `<svg>` with
   `data-cdb-spinner="<specVersion>"`. The matcher skips any `<svg>` already carrying
   the *current* version stamp. (Including a version/hash lets a theme change
   re-process previously-stamped nodes.)

2. **Survive SPA re-renders.** React may unmount/remount the greeting or re-render the
   thinking spinner, producing brand-new `<svg>` nodes (without our stamp). A persistent
   `MutationObserver` on `document.documentElement` (`childList:true, subtree:true`)
   re-runs the matcher on added subtrees, so new instances get replaced too. We also do
   **one** initial full-document sweep at install time for nodes already present.

3. **Avoid infinite observer loops.** Our own DOM writes (clearing children, adding
   paths, setting `data-cdb-spinner`) are mutations the observer would see. Two
   safeguards:
   - The matcher early-returns on any `<svg>` already stamped with the current version,
     so re-seeing our own output is a cheap no-op.
   - We wrap each replacement in a re-entrancy flag (`__cdb_busy`) and, more robustly,
     **disconnect the observer is not needed** because the stamp check already breaks
     the loop; but we additionally **debounce** processing via `requestAnimationFrame`
     so a burst of mutations collapses into one sweep. (Disconnect/reconnect around our
     writes is offered as an even stricter alternative in the code comments, but the
     stamp guard alone is sufficient and avoids missing concurrent external mutations.)

Performance: the observer callback only scans `addedNodes` (and their `querySelectorAll`
for nested svgs), not the whole document, and the per-svg test is a cheap
`viewBox` attribute compare before any `d` substring scan. Cost is negligible.

---

## 3. Per-theme spinner spec format

Add an optional `spinner` object to a theme (in `claude-desktop-bin.json`, either under
a built-in theme override or a custom theme). Shape:

```jsonc
{
  "activeTheme": "mario",
  "themes": {
    "mario": {
      "--accent-brand": "0 84% 52%",
      // ... other CSS vars ...
      "category": "gaming",              // optional; groups the theme in the picker
      "spinner": {
        "viewBox": "0 0 100 100",        // optional, default "0 0 100 100"
        "match": "m19.6 66.5 19.7-11",   // optional override of the signature set
        "animation": "spin",             // optional: "spin"|"bounce"|"pulse"|"flip"|null
        "paths": [
          { "d": "M...", "fill": "#E52521" },
          { "d": "M...", "fill": "#FFFFFF" },
          { "d": "M...", "fill": "currentColor" }
        ],
        "paths2": [ /* second sprite frame - required iff animation is "flip" */ ]
      }
    }
  }
}
```

### Field semantics

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `paths` | array of `{d, fill?}` | (required) | Ordered `<path>` elements. `fill` omitted or `"currentColor"` -> follows theme accent via `fill-current`. Explicit hex/`hsl()` -> fixed color (needed for multi-color shapes like the mushroom). |
| `paths2` | array of `{d, fill?}` | `[]` | The second sprite frame. **Required if and only if** `animation` is `"flip"`: a `flip` spec without it is refused, and on any other animation it is ignored with a diagnostic line. |
| `viewBox` | string | `"0 0 100 100"` | SVG coordinate system. Keep `0 0 100 100` to match the original and avoid resizing surprises. |
| `match` | string \| array of strings | the built-in three-fragment signature set | Lets a theme override detection if upstream geometry changes, without rebuilding the patch. Replaces the whole set. |
| `animation` | string\|null | `null` | Optional injected animation (see section 4). `null` = inherit whatever claude.ai applies. An unrecognized name is ignored with a diagnostic line. |

A theme may also carry a sibling **`category`** string (outside `spinner`).
`"category": "gaming"` gives it its own divider-separated section in the
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> picker and in Settings -> Extra -> Themes,
independently of the tier it resolves from - which is how `mario` sits in the Gaming
section while still being a built-in.

### Build-time validation

Every bundled theme's spec is parsed and asserted while the Nim patch compiles
(`validateSpinner` in `patches/core/add_feature_custom_themes.nim`): `spinner` must be an
object, `paths` must hold at least one real `{d: "..."}` entry, any `fill` must be a
string, `animation` must be one of `pulse|spin|bounce|flip`, `viewBox` must be a string,
and `paths2` must be present exactly when the animation is `flip`. A contract violation
**fails the build loud** instead of shipping a glyph that cannot render. The community
generator adds slug-parity, path-data tokenizing and fill-contrast gates on top.

The **default star** is effectively `{ "paths": [{ "d": "<full star path>", "fill":
"currentColor" }] }` - single path, accent-colored. A mushroom needs multiple paths
with explicit fills (red cap, white spots/face, optional dark outline).

### How the injected JS consumes it

The Nim/main side serializes the active theme's `spinner` object to JSON and bakes it
into the script as `var SPEC = <json>;`. The IIFE:

1. installs the engine once per window (a re-run only pushes the new spec);
2. validates the spec and refuses a malformed one, leaving the glyph on screen alone;
3. computes a `specVersion` (cheap hash of the normalized spec) for the idempotency stamp;
4. installs the sweep + observer described above;
5. for each matched `<svg>`: stashes the original children + `viewBox` for a later
   restore, sets `viewBox` if provided, removes existing children, appends one `<path>`
   per `SPEC.paths` entry (namespaced; two `<g data-cdb-frame>` groups for `flip`),
   applies the optional animation class, stamps `data-cdb-spinner=specVersion`;
6. treats a **null/empty** spec as "restore Claude's own glyph" rather than "do nothing" -
   the engine and its observer stay armed so a later apply can still theme the page.

---

## 4. Animation

The original is a static glyph; claude.ai animates it during loading via its **own**
CSS classes on the wrapper/`<svg>` (e.g. a pulse/spin while "thinking"). Because we keep
the original `<svg>` and wrapper (approach a), **those classes still apply to our
replaced paths for free** - we generally do nothing and inherit the existing motion.

If a theme wants an *additional* or *custom* motion (`animation: "spin"|"bounce"|
"pulse"|"flip"`), a scoped keyframes block is injected and a class added to the replaced
`<svg>`:

```css
@keyframes cdbSpin   { to   { transform: rotate(360deg); } }
@keyframes cdbBounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-12%)} }
@keyframes cdbPulse  { 0%,100%{opacity:1} 50%{opacity:.45} }
@keyframes cdbFlipA  { from { opacity: 1 } to { opacity: 0 } }
@keyframes cdbFlipB  { from { opacity: 0 } to { opacity: 1 } }
svg[data-cdb-spinner].cdb-anim-spin   { animation: cdbSpin 1s linear infinite;        transform-origin:50% 50%; transform-box:fill-box; }
svg[data-cdb-spinner].cdb-anim-bounce { animation: cdbBounce .8s ease-in-out infinite; transform-origin:50% 50%; transform-box:fill-box; }
svg[data-cdb-spinner].cdb-anim-pulse  { animation: cdbPulse 1.2s ease-in-out infinite; }
svg[data-cdb-spinner].cdb-anim-flip [data-cdb-frame="1"] { animation: cdbFlipA 1s steps(2,jump-none) infinite; }
svg[data-cdb-spinner].cdb-anim-flip [data-cdb-frame="2"] { animation: cdbFlipB 1s steps(2,jump-none) infinite; }
```

**All five keyframe names ship with every theme's CSS**, whichever animation the active
theme uses. That is a live-switching requirement: the sheet already on the page must
carry the keyframes the *next* shape may want, or a switch would land on a shape whose
animation has no definition.

**`flip` is a two-frame sprite cycle, not a tween.** The renderer emits both frames at
once, each wrapped in `<g data-cdb-frame="1">` / `<g data-cdb-frame="2">`, and the
`steps(2, jump-none)` pair above hard-cuts their opacity at ~2 frames/sec. No
interpolation, so a hero silhouette reads as taking a step rather than sliding.

Notes to avoid **fighting** claude.ai's own animation:

- Only add the `cdb-anim-*` class when `SPEC.animation` is set; otherwise leave motion
  entirely to claude.ai.
- Use `transform-box: fill-box; transform-origin: 50% 50%` so a `spin` rotates about the
  glyph's own center regardless of the SVG box.
- If both our animation and claude.ai's apply `transform`/`animation` to the *same*
  element they will conflict (last-wins / shorthand override). Scoping our rule to the
  `<svg>` while claude.ai typically animates a *wrapper* avoids most clashes; if a theme
  reports jitter, prefer `animation: null` and rely on the native motion.
- The keyframes can be injected via the existing `wc.insertCSS()` path (append to
  `__cdb_css`) so it lives in the CSS layer, not the JS string.

---

## 5. Ready-to-test MUSHROOM SVG (Super Mario, viewBox `0 0 100 100`)

Recognizable red-cap mushroom: domed red cap, white circular spots on the cap, pale
stem/face, dark outline optional. Drop the `paths` array straight into a theme's
`spinner`. Colors: `#E52521` cap, `#FFFFFF` spots/face, `#3A2A1A` outline (optional),
`#F2C9A0`/`#FAD9C0` face shading optional.

```jsonc
"spinner": {
  "viewBox": "0 0 100 100",
  "animation": "bounce",
  "paths": [
    {
      "comment": "dark outline (drawn first, behind) - optional; remove for flat look",
      "d": "M50 10c-21 0-38 15-38 35 0 6 3 10 8 12 2 1 4 2 4 5v16c0 5 4 9 9 9h34c5 0 9-4 9-9V67c0-3 2-4 4-5 5-2 8-6 8-12 0-20-17-35-38-35z",
      "fill": "#3A2A1A"
    },
    {
      "comment": "red cap (dome)",
      "d": "M50 14c-19 0-34 13-34 31 0 5 3 8 7 9 3 1 6 1 9 1h36c3 0 6 0 9-1 4-1 7-4 7-9 0-18-15-31-34-31z",
      "fill": "#E52521"
    },
    {
      "comment": "pale face / stem area (lower band)",
      "d": "M30 56h40v16c0 4-3 7-7 7H37c-4 0-7-3-7-7V56z",
      "fill": "#FAD9C0"
    },
    {
      "comment": "white spot - large, center-left of cap",
      "d": "M38 30a8 8 0 1 0 0.01 0z",
      "fill": "#FFFFFF"
    },
    {
      "comment": "white spot - top center",
      "d": "M57 22a5 5 0 1 0 0.01 0z",
      "fill": "#FFFFFF"
    },
    {
      "comment": "white spot - right of cap",
      "d": "M68 36a6 6 0 1 0 0.01 0z",
      "fill": "#FFFFFF"
    },
    {
      "comment": "left eye",
      "d": "M42 64a3 3 0 1 0 0.01 0z",
      "fill": "#3A2A1A"
    },
    {
      "comment": "right eye",
      "d": "M58 64a3 3 0 1 0 0.01 0z",
      "fill": "#3A2A1A"
    }
  ]
}
```

> The `comment` keys are ignored by the consumer (only `d` and `fill` are read); they
> are there for readability and can be stripped. If JSONC comments aren't acceptable in
> the real config, delete the `"comment"` lines. The circle-via-arc trick
> (`a R R 0 1 0 0.01 0z`) draws a full circle of radius `R` for the spots/eyes.

A **minimal flat** variant (no outline, 3 colors) for first testing:

```jsonc
"spinner": {
  "viewBox": "0 0 100 100",
  "paths": [
    { "d": "M50 14c-19 0-34 13-34 31 0 5 3 8 7 9 3 1 6 1 9 1h36c3 0 6 0 9-1 4-1 7-4 7-9 0-18-15-31-34-31z", "fill": "#E52521" },
    { "d": "M30 56h40v16c0 4-3 7-7 7H37c-4 0-7-3-7-7V56z", "fill": "#FAD9C0" },
    { "d": "M38 30a8 8 0 1 0 0.01 0z", "fill": "#FFFFFF" },
    { "d": "M57 22a5 5 0 1 0 0.01 0z", "fill": "#FFFFFF" },
    { "d": "M68 36a6 6 0 1 0 0.01 0z", "fill": "#FFFFFF" }
  ]
}
```

---

## 6. The injected engine (`js/spinner_injector.js`)

The runtime installer ships as `js/spinner_injector.js` - a self-guarding ES5 IIFE,
`staticRead` into the Nim patch and evaluated with `var __CDB_SPINNER_SPEC = <json|null>;`
prepended. Read that file for the authoritative code; this section records its contract.

### Installed once, driven many times

```js
window.__cdbSpinnerApply(spec)   // (re-)theme every glyph; returns {ok, applied, restored}
window.__cdbSpinnerApply(null)   // restore Claude's own glyph
window.__cdbSpinner = {
  spec,            // the validated spec in effect (null = stock glyph)
  version,         // its hash - the value in the data-cdb-spinner stamp
  apply,           // same function as __cdbSpinnerApply
  restore(),       // apply(null)
  sweep(root),     // re-run the matcher under root with the current spec
  managed(),       // how many <svg> elements the engine owns right now
  disconnect()     // stop the MutationObserver
};
```

The file installs the engine only if `window.__cdbSpinnerApply` is not already a
function. So the main process can re-run it per window on every theme switch: the second
run skips installation (no duplicate observers) and just calls `apply()` with the new
spec. That single property is what makes spinner shapes switch live.

### Original-glyph custody

`apply()` can put the star back because the engine never loses it. Before the **first**
swap of an element, its child nodes and `viewBox` are cloned onto the element itself
(`__cdbSpinnerOrig`), and the first such capture is also kept as a document-wide fallback
for glyph elements the SPA cloned from one of ours. The stash is skipped for an element
that already carries our stamp - its children are ours, not the original, and stashing
them would make a later restore hand back *our* shape as "Claude's own".

Restoring re-inserts the stashed children, puts the original `viewBox` back (removing the
attribute if there wasn't one), drops every `cdb-anim-*` class and the
`data-cdb-spinner` stamp, and forgets the element.

### The other guards

- **Reshaped elements are tracked** in a `MANAGED` list, pruned against
  `document.documentElement.contains()` on each apply, so the list follows the live page.
- **The observer always sweeps with the *current* spec**, not the one baked in at
  injection time, so a glyph rendered after a switch gets the new shape.
- **Validation refuses rather than half-renders:** no usable `{d}` entry, or `flip`
  without `paths2`, logs `[spinner] refusing spinner spec: ...` and leaves the glyph as
  it is.
- **`createElementNS` + `setAttribute` only** - never `innerHTML`, which is unreliable
  for SVG and trips strict CSP / Trusted Types.
- **Idempotency stamp doubles as the loop breaker:** re-seeing our own DOM writes is a
  cheap no-op, so the observer needs no disconnect/reconnect dance. Bursts collapse into
  one `requestAnimationFrame`-scheduled sweep.
- **Diagnostics:** `[spinner] themed N glyph(s) (X re-themed, Y new)` on an apply,
  `[spinner] restored N glyph(s) to Claude's own` on a revert. A sudden `0` means the
  logo geometry drifted, not that the feature is gone.

### Driving it from the DevTools console

Everything above is reachable live, which is how a new shape gets iterated without a
rebuild: define `window.__CDB_SPINNER_SPEC` and paste the file (section 7's checklist),
then call `__cdbSpinnerApply` with successive specs. See
[SPINNER_SHAPES.md](SPINNER_SHAPES.md#how-to-swap-or-test-a-shape-live-no-rebuild) for the
step-by-step recipe.

---

## 7. Risks & live-test checklist

The runtime match is inherently fragile (remote-rendered, version-sensitive) and cannot be
validated from the bundle alone, so it is checked in the running app. Three suites cover
the parts that are checkable offline - `scripts/test-spinner-main.mjs` (what a switch
pushes into each window), `scripts/test-spinner-dom.mjs` (re-theme, revert and the flip
frames in headless Chromium) and `scripts/test-picker-gaming.mjs` (the picker's sections);
`scripts/validate-patches.sh` runs all three.

### Risks

- **Star-signature drift.** If Anthropic re-exports the logo geometry past all three
  fragments, nothing matches and `themed 0` appears in the console. Mitigation: the
  `match` field lets a theme override the signature set without a rebuild; the console
  diagnostic makes the failure visible.
- **Over-matching.** If the star path is reused by an icon we did *not* want to change
  (e.g. a tiny inline logo in a menu), it'll be swapped too. The `viewBox 0 0 100 100`
  pre-filter plus the very specific path signature make collateral hits unlikely, but
  verify the app logo (see checklist).
- **React revert race.** React may re-render a matched `<svg>` right after we patch it,
  briefly showing the star before the observer re-patches. Usually imperceptible; if it
  flickers, the rAF debounce can be lowered to `0`/microtask.
- **CSP / Trusted Types.** We use `createElementNS` + `setAttribute` (not `innerHTML`),
  which is allowed under strict CSP; do **not** switch to `innerHTML` for SVG.
- **Animation conflict.** Theme `animation` + claude.ai's own animation on overlapping
  elements can clash; `animation: null` avoids this.
- **Cloned glyphs.** A glyph element the SPA cloned from one we already reshaped has our
  children, not the star's. The document-wide fallback capture is what lets those be
  restored on revert; without it a revert would leave our shape behind on those nodes.

### Live-test checklist (user runs the patched build)

1. **Greeting glyph replaced** - the greeting header icon shows the theme's shape, not the
   star.
2. **Thinking/loading spinner replaced** - start a message; the in-progress spinner
   shows the shape (and animates, whether via claude.ai's motion or `SPEC.animation`).
3. **App logo NOT broken** - any window-chrome / titlebar / sidebar brand logo is either
   intentionally changed *consistently* or left intact; confirm nothing is blank or
   mis-sized. (If the logo uses the same path+viewBox and you want it left alone, tighten
   the matcher with an ancestor check - but default is "replace all brand glyphs".)
4. **Color follows theme accent** - single-color/`currentColor` paths render in the
   theme's `--accent-brand`; explicit-fill paths (the mushroom cap, the dragon ball)
   render as specified.
5. **No console errors** - open the webview DevTools console; expect only
   `[spinner] themed N glyph(s)` lines, no exceptions, no Trusted-Types violations.
6. **SPA navigation keeps working** - navigate between chats/Projects/settings and back;
   newly rendered greeting/spinner instances still get replaced (observer working), and
   navigation itself is unaffected (no freeze from the observer).
7. **Idempotency** - leave the app open through several re-renders; confirm no runaway
   CPU (observer not looping) and the glyph doesn't flicker between shapes.
8. **Theme switch is live** - switch themes from the picker or Settings -> Extra -> Themes
   without relaunching: the glyph takes the new shape (and the new animation) in every
   open window immediately. Switch to a theme with a `flip` shape and confirm the
   two-frame cut, then back.
9. **Revert is clean** - pick **Claude default**: the star comes back in every window, and
   the console reports `restored N glyph(s) to Claude's own`. Then pick a theme again -
   the shape must return, proving the restore did not break the matcher.

### How to iterate fast without rebuilding

Paste `js/spinner_injector.js` into the **webview DevTools console** (right-click ->
Inspect on the claude.ai view, or the app's devtools) after defining
`window.__CDB_SPINNER_SPEC = { ...the spinner object... }`. This validates the matcher
and shape live before committing it to the patch. After that, `__cdbSpinnerApply(spec)`
swaps shapes without re-pasting, `window.__cdbSpinner.sweep(document)` re-runs the
matcher, `window.__cdbSpinner.managed()` reports how many glyphs the engine owns, and
`window.__cdbSpinner.disconnect()` stops the observer.

---

## 8. How it was built

- **Where:** `patches/core/add_feature_custom_themes.nim` owns it - the same patch that owns
  the `web-contents-created`/`dom-ready` injection and reads `claude-desktop-bin.jsonc`.
  It `staticRead`s `js/spinner_injector.js` and serializes the active theme's `spinner`
  to JSON, prepended as `var __CDB_SPINNER_SPEC = <json|null>;`.
- **Live channel:** the same payload is re-evaluated in every open window on a theme
  switch, so the engine's `apply()` does the re-theme. Nothing about a theme switch needs
  a restart.
- **Keyframes:** the section-4 CSS is appended to `__cdb_css` and ships via `insertCSS` -
  all five animation names for every theme, so a switch can never land on a shape whose
  animation has no keyframes.
- **Guard:** the file installs the engine only if it is not already installed, and
  validates every spec before touching the DOM, so a re-run or a malformed spec is safe.
  The build-time `validateSpinner` assertions (section 3) are the strict half: a bundled
  spec that violates the contract fails the build rather than shipping.
- **Break risk:** LOW-MEDIUM. No regex on the local bundle (so the *patch* won't fail to
  apply on upstream bumps), but the **runtime match** depends on remote geometry; that
  risk is surfaced via the console diagnostic, not a build failure.
