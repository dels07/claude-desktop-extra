# Panel tabs - upstream anchor inventory

**Validated against Claude Desktop 1.37937.0** (2026-08-26), against the claude.ai SPA
build observed 2026-08-24 (chunks `c360a9e1c-*` tiles renderer, `c03935b01-*` side-pane
store, `c4db265df-*` pane frame).

**None of these anchors ship in the desktop `app.asar`.** Every one of them is remote
claude.ai code: `data-pane-root`, `epitaxy-view-panel`, `tiles-shell`, `tiles-handle`,
`epitaxy-pane-close-control`, `sidePaneStore`, `tileLayoutBySession`, `expandedTile` and
`tileId` all have **zero** occurrences anywhere in the extracted `app.asar` tree. A desktop
version bump therefore cannot move them, and a bundle diff cannot audit them - the
authority is the SPA chunks themselves (see "How to re-derive statically" below). The only
desktop-side preconditions the feature has are the `mainView.js` preload that carries the
`cdbTabs` bridge (a CommonJS bundle that `require("electron")` and opens with a
`"use strict";` prologue) and the `/epitaxy` route in the main bundle.

Everything else the panel-tabs feature reaches into remote claude.ai markup or its React
fiber. Re-validate this list on every upstream bump: a green build proves the Nim
patterns still matched the bundle, **not** that these DOM/fiber anchors still exist -
they live in remote code that changes without a desktop release.

**The release check is the log, not the bundle.** Because the anchors are remote, the only
evidence about the *live* web app is the `[cdb-tabs]` warning keys in
**`~/.config/Claude/logs/claude.ai-web.log`** - see "Runtime warnings that mean an anchor
moved". Do not look in `claude-patches.log`: it carries only the main-process
`[panel-tabs]` startup line, so it is silent by design and reads as false reassurance. The
static chunk audit and the fixture DOM tests
(`scripts/tests/community/test-panel-tabs-dom.mjs`,
`test-diff-views-expand-dom.mjs`) prove the anchors we can *see* still hold; they cannot
prove the live app renders the same DOM.

The `tileId` fiber prop is shared with diff views: `js/diff_views_page.js` gates its
empty-diff fallback on `tileId === "diff"` so an empty `browser` ("Files") tab cannot
claim it. A move of that prop breaks both features at once.

Version trail: 1.24012.9 (2026-08-06) first inventory; 1.32352.1 (2026-08-21) live CDP
pass after a redeploy introduced the `aria-hidden="true"` `.epitaxy-view-panel` ghost in
the chat shell that A1 now exempts, a `dframe-*` app shell around the epitaxy area, and
the `runs` tile id.

Why this lives in `baseline/` rather than only in the README patch row: the README row
describes what the feature *does*, for a reader. This is a per-release audit checklist
with expected values and a re-derivation procedure, which is what `baseline/` docs are
for and what the release audit actually reads.

## How to re-derive statically, from the shipped SPA chunks

Most of this list is string literals and JSX props in claude.ai's own bundle, so it can be
audited from the chunks alone - no login, no live session, no CDP. The chunk URLs are
public and immutable, and the set the app last loaded is recorded in its HTTP cache keys:

```bash
# 1. Harvest the asset URLs the app most recently fetched.
cd ~/.config/Claude/Cache/Cache_Data
find . -type f -newermt '<yyyy-mm-dd>' | while read f; do
  head -c 600 "$f" | strings -n 20 | grep -m1 -o 'https://assets-proxy[^ ]*\.js'; done | sort -u

# 2. The tiles renderer is the chunk that owns `.tiles-shell`; the biggest few are it.
curl -sS --compressed -O <url>

# 3. From that chunk, walk the ESM import list to the store and pane-frame chunks. The
#    minified binding names change every deploy, so find them from a known call site:
#    e.g. `<ident>(e=>e.tileLayout)` names the store hook, `y(<ident>,{tileId:...})` the
#    pane frame. Then resolve where each is imported from:
head -c 200000 <chunk>.js | grep -aoh 'import{[^}]*as <ident>[,}][^}]*}from"\./[^"]*"'
```

Anchors that fall out of the chunks directly (see the tables below for the expected
shape): the `data-pane-root` producer, the `epitaxy-view-panel` ghost and its
`aria-hidden`, `position:"absolute"` on the chat shell, the `"chat"` tile id, the
`tiles-handle` separator, the `Expand`/`Collapse`/`Close` labels,
`epitaxy-pane-close-control`, the kind -> icon map that enumerates every tile id, the
label -> tileId wiring, and the `epitaxy.sidePaneStore.v1` persist config.

Anchors that still need the live DOM: A2's hop budget, A1's row-children composition and
widths, and the fiber hop distance to `memoizedProps.tileId`.

## How to re-derive live, without any scratchpad file

All of it runs in the Code tab's DevTools console (or over CDP against a build launched
with `--remote-debugging-port`). Nothing below depends on a file that is not in the repo.

```js
// 0. Tile id of a pane, the way the harvester does it (no hardcoded hop count).
const tid = (el) => { const k = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
  let f = el[k], i = 0;
  while (f && i++ < 80) { if (f.memoizedProps && typeof f.memoizedProps.tileId === "string")
    return f.memoizedProps.tileId; f = f.return; } return null; };

// 1. Pane roots and their tile ids.
[...document.querySelectorAll("[data-pane-root]")].map(tid);

// 2. The row's shape: children of the parent of a side pane's wrapper.
const wrap = (t) => [...document.querySelectorAll("[data-pane-root]")]
  .find(p => tid(p) === t).closest(".tiles-shell").parentElement;
[...wrap("diff").parentElement.children].map(c => [c.className,
  Math.round(c.getBoundingClientRect().width),
  [...c.querySelectorAll("[data-pane-root]")].map(tid)]);

// 3. label -> tileId, for the CHIP NAMES (page `KINDS`). Open the panel with the app's
//    OWN control - by hand, or a plain .click() on a toolbar button - and diff the tab
//    set. THE LABELS LIE, so this must be observed, never assumed.
const tabs = () => window.__cdbTabsPage.state().tabs.slice();
const before = tabs();
document.querySelector('button[aria-label="Browser"]').click();
// wait ~3s, then: tabs().filter(t => !before.includes(t))   // the tileId it opened

// 4. The chat column's shell, which is what A1 turns on: exactly one .tiles-shell in
//    the document is EMPTY, and it is the absolutely-positioned one.
[...document.querySelectorAll(".tiles-shell")].map(sh => [
  getComputedStyle(sh).position,
  sh.querySelectorAll("[data-pane-root]").length]);
```

## The three UNSAFE anchors

Losing any of these does not merely disable the feature - it needs a code change. They
are checked at runtime and each failure now refuses and warns rather than guessing, but
the *feature* stops working until the assumption is re-established.

| # | Assumption | Where | Expected on the 2026-08-24 SPA build | If it breaks |
|---|---|---|---|---|
| A1 | **The "empty", ABSOLUTELY POSITIONED shell.** The chat column is the row child that owns ≥ 1 `.tiles-shell`, whose shells are **all empty** - no `[data-pane-root]`, and no `.epitaxy-view-panel` **that is not `aria-hidden="true"`** - of which **≥ 1 is `position: absolute`**, and which is not one of our tagged columns. Exactly one row child may qualify - two ⇒ refuse. The pick is then **held** (`stickyChat`) and re-decided only when the held element stops qualifying. **The aria-hidden exception is load-bearing since 2026-08-21:** a remote redeploy put an `aria-hidden="true"` `.epitaxy-view-panel` ghost inside the chat shell (no pane root, no fiber `tileId`, no chrome), which made the plain emptiness test fail every frame and killed the feature. A REAL pane never carries `aria-hidden="true"` | `panel_tabs_page.js` - `chatLooksRight`, `stickyChatOk`, `chatColumnOf`, `looksLikeRow` | **Both halves of the discriminator are emitted by the tile renderer from the tile id alone**, which is why they are stable: the shell style is `overflowMin ? {..., position:"absolute", top:0, bottom:0, width:"100%", minWidth:overflowMin.width} : {...}`, and `overflowMin` is set for **exactly one** tile - `{width:320}` when the id is `"chat"`, `undefined` otherwise. So the chat shell is `absolute` with `min-width:320px` and every side shell is `static`. In the same renderer the `"chat"` branch returns `<div class="relative isolate min-w-0">` wrapping `<div aria-hidden={true} class="epitaxy-view-panel …">` plus the chat UI, while every other id renders the pane frame with `"data-pane-root":""` and **no** `aria-hidden`. Observed row children (live 2026-08-21): `chat(826px), .tiles-handle(12px), STACK(diff,preview)(957px)`; 1.24012.9: `chat, .tiles-handle, STACK(diff,terminal), .tiles-handle, STACK(preview,tasks)`, shells/shells-with-a-pane = chat **1/0**, handles **0/–**, each stack **2/2** | No single qualifying chat column ⇒ refuse to arm, warn `no-chat-column`, drop our bar, leave upstream's split. If a side shell ever becomes `absolute` (or chat's `static`) the discriminator weakens - stickiness bounds that to the first identification. If upstream ever ships a REAL pane with `aria-hidden="true"`, or drops the ghost's `aria-hidden`, re-derive. Fix `chatLooksRight` |
| A2 | **Nesting depth.** Leaf wrapper → row is at most `MAX_CHAIN_HOPS = 12` parent hops | `panel_tabs_page.js` - `resolveChain` | 2 hops for a tile inside a stack, 1 for a row-level tile | Row unresolvable ⇒ hide nothing, warn `no-row`. Raise the budget |
| A3 | **The literal tile id `"chat"`.** Used to separate the chat pane from side panes | `panel_tabs_page.js` - `isNonChatPane`, `resolveColumns`; `panel_tabs_layout.js` - `sideTileIds`, `geometry` | `tid(chatPane) === "chat"`. The literal is upstream's own in both halves: the tile renderer branches on `"chat"===id` for the ghost and for `overflowMin`, and the side-pane store branches on `"tile"===node.kind && "chat"===node.tileId` when it splits flex | The chat tile counts as a side panel ⇒ it gets a tab and can be hidden. Grep the literal and update |

## The rest

**Nine anchors, all read-only.** This feature never presses one of upstream's controls
except the active pane's own `Close` and `Expand`/`Collapse`, both of which the user asked
for. Four anchors were dropped on 2026-08-06 with the `+` open-panel menu - the header
openers (`harvest.openActions`), upstream's `Session actions` button and its
`role="menuitemcheckbox"` entries, the `[data-open]` portal's `data-closed` linger, and
`html[data-window-blurred]`. All four existed only for the availability probe that drove
that menu; nothing reads them now.

| Anchor | Where | Expected on the 2026-08-24 SPA build |
|---|---|---|
| `[data-pane-root]`, fallback `.epitaxy-view-panel` (fallback skips `aria-hidden="true"` ghosts) | `harvest.panes` | emitted by the pane frame as `{elevation:"panel", "data-pane-root":"", …}` - `elevation:"panel"` is what also produces the `.epitaxy-view-panel` class, so the fallback selector is the same element one level cruder. Present on every pane; the chat shell's ghost carries NEITHER a pane root nor a resolvable `tileId` |
| `memoizedProps.tileId` on an ancestor fiber, searched not hop-counted | `harvest.tileIdOf` | observed at hops 1 / 39 / 51 - never hardcode |
| `.tiles-shell` (one per column; a bare query returns the CHAT column's, which is empty) | page `SHELL_SELECTOR` | one per column; see A1 for the position split |
| `.tiles-handle` resize dividers, `role="separator"` | page `HANDLE_SELECTOR` | rendered as `<div role="separator" aria-orientation="vertical"\|"horizontal" aria-valuenow/min/max class="tiles-handle draggable-none hide-focus-ring …">`; row: vertical 12 px, in-stack: horizontal 12 px |
| Chrome-row buttons by `aria-label`: `Expand` / `Collapse` / `Close` | `harvest.chromeButtons` | one label, chosen as `isExpanded ? "Collapse" : "Expand"` (icons `CollapseMinimizeArrows45` / `ExpandMaximizeArrows45`), so `Collapse` replaces `Expand` while that tile is expanded |
| `.epitaxy-pane-close-control` | `harvest.chromeRow` | present in each pane's chrome row, on the `XCrossCloseMedium` icon button whose `aria-label` is `Close` |
| **`Browser` opens tile `preview`; `Files` opens tile `browser`** | page `KINDS` (chip names only) | measured, not guessable. Upstream's toolbar builds `{pane:"preview", label: externalPreviewAvailable ? "Browser" : "Preview"}` - **the same tile is labelled `Preview` when no external preview is available**, so the word alone never identifies the tile. `Files` is a Session-actions entry that toggles pane `browser`. Upstream's own kind list is its kind -> icon map: `preview, artifact, diff, terminal, browser, simulator, tasks, plan, runs, pr`. `plan` and `runs` have no chip in `KINDS`, so `labelFor()` capitalises the raw id (`Plan`, `Runs`); upstream's word for `artifact` is the plural `Artifacts` |
| `localStorage["epitaxy.sidePaneStore.v1"]` → `state.tileLayout.root`, `state.currentSessionId`, `state.tileLayoutBySession`; nodes `{kind:"stack", direction:"row"\|"column", children}` / `{kind:"tile", tileId, flex}` | `panel_tabs_layout.js` | persist `version: 2` (was 4 on 1.24012.9) - **our reader ignores the version field**, so a version bump is not an anchor. `partialize` persists `tileLayout`, `tileLayoutBySession`, `currentSessionId` (among others); `expandedTile` is **never persisted** |
| `/epitaxy/<sessionId>` in the path, as the session-id fallback | page `sessionId` | matches `[A-Za-z0-9_-]+` |
| Theme tokens are **bare HSL triplets** (`hsl(var(--bg-100, 232 23.4% 18.4%))`) | page `CSS` | see `baseline/THEME_TOKEN_MAP.md` |

## Runtime warnings that mean an anchor moved

All via renderer `console.warn`, prefixed `[cdb-tabs]`, so they land in
`~/.config/Claude/logs/claude.ai-web.log` (only the main-process `[panel-tabs]`
startup line goes through `__cdbDiag` to `claude-patches.log`). Each is `warnOnce`.

Because the anchors are remote, this log IS the release check - there is nothing in the
bundle to diff. Read it as: warnings clustered before a fix and silence after it means the
fix is holding against live claude.ai; fresh warnings mean a redeploy moved something.
Confirm the page code actually ran in the silent window (look for `[cdb-dv]` lines in the
same file) before reading silence as health. On the 1.37937.0 check every recorded
`[cdb-tabs]` warning predated the 2026-08-22 fix, with none since across 52 later lines
including 36 `[cdb-dv]` entries.

| Key | Means |
|---|---|
| `anchor-rot` | upstream's mirror lists side panels but **no pane root resolved** - `[data-pane-root]` or `tileId` moved |
| `no-row` | A2 (or A1) - the row could not be resolved; nothing is hidden |
| `no-chat-column` | A1 - **no** row child positively identifies as the chat column, or **more than one** does. Ambiguity is refused, never resolved by document order |
| `no-column-wrapper` | a side pane has no `.tiles-shell` parent to tag |
| `shared-chat-column` | one wrapper holds both the chat pane and a side pane |
| `hold-watchdog` | no active column resolved for 1500 ms; unarmed back to upstream's split |
| `no-expand-control` | no `Expand`/`Collapse` on the active pane's chrome row |
| `sticky-expand-timeout` | upstream did not remount within 1200 ms of a collapse |
