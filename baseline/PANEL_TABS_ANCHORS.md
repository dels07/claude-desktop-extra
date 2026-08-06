# Panel tabs — upstream anchor inventory

**Validated against Claude Desktop 1.24012.9** (2026-08-06).

Everything the panel-tabs feature reaches into remote claude.ai markup or its React
fiber. Re-validate this list on every upstream bump: a green build proves the Nim
patterns still matched the bundle, **not** that these DOM/fiber anchors still exist —
they live in remote code that changes without a desktop release.

Why this lives in `baseline/` rather than only in the README patch row: the README row
describes what the feature *does*, for a reader. This is a per-release audit checklist
with expected values and a re-derivation procedure, which is what `baseline/` docs are
for and what the release audit actually reads.

## How to re-derive, without any scratchpad file

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

Losing any of these does not merely disable the feature — it needs a code change. They
are checked at runtime and each failure now refuses and warns rather than guessing, but
the *feature* stops working until the assumption is re-established.

| # | Assumption | Where | Expected on 1.24012.9 | If it breaks |
|---|---|---|---|---|
| A1 | **The empty, ABSOLUTELY POSITIONED shell.** The chat column is the row child that owns ≥ 1 `.tiles-shell`, whose shells are **all empty** (no `[data-pane-root]` / `.epitaxy-view-panel` in any of them), of which **≥ 1 is `position: absolute`**, and which is not one of our tagged columns. Exactly one row child may qualify — two ⇒ refuse. The pick is then **held** (`stickyChat`) and re-decided only when the held element stops qualifying | `panel_tabs_page.js` — `chatLooksRight`, `stickyChatOk`, `chatColumnOf`, `looksLikeRow` | row children `chat, .tiles-handle, STACK(diff,terminal), .tiles-handle, STACK(preview,tasks)`; shells/shells-with-a-pane = chat **1/0**, handles **0/–**, each stack **2/2** (1 empty shell of 5 document-wide). **Position: chat's shell `absolute`** (inline `position:absolute;top/bottom/left:0;min-width:320px`), all four side shells `static` with a byte-identical inline style carrying no `position` | No single qualifying chat column ⇒ refuse to arm, warn `no-chat-column`, drop our bar, leave upstream's split. If a side shell ever becomes `absolute` (or chat's `static`) the discriminator weakens — stickiness bounds that to the first identification. Fix `chatLooksRight` |
| A2 | **Nesting depth.** Leaf wrapper → row is at most `MAX_CHAIN_HOPS = 12` parent hops | `panel_tabs_page.js` — `resolveChain` | 2 hops for a tile inside a stack, 1 for a row-level tile | Row unresolvable ⇒ hide nothing, warn `no-row`. Raise the budget |
| A3 | **The literal tile id `"chat"`.** Used to separate the chat pane from side panes | `panel_tabs_page.js` — `isNonChatPane`, `resolveColumns`; `panel_tabs_layout.js` — `sideTileIds`, `geometry` | `tid(chatPane) === "chat"` | The chat tile counts as a side panel ⇒ it gets a tab and can be hidden. Grep the literal and update |

## The rest

**Nine anchors, all read-only.** This feature never presses one of upstream's controls
except the active pane's own `Close` and `Expand`/`Collapse`, both of which the user asked
for. Four anchors were dropped on 2026-08-06 with the `+` open-panel menu — the header
openers (`harvest.openActions`), upstream's `Session actions` button and its
`role="menuitemcheckbox"` entries, the `[data-open]` portal's `data-closed` linger, and
`html[data-window-blurred]`. All four existed only for the availability probe that drove
that menu; nothing reads them now.

| Anchor | Where | Expected on 1.24012.9 |
|---|---|---|
| `[data-pane-root]`, fallback `.epitaxy-view-panel` | `harvest.panes` | present on every pane |
| `memoizedProps.tileId` on an ancestor fiber, searched not hop-counted | `harvest.tileIdOf` | observed at hops 1 / 39 / 51 — never hardcode |
| `.tiles-shell` (one per column; a bare query returns the CHAT column's, which is empty) | page `SHELL_SELECTOR` | one per column; see A1 for the position split |
| `.tiles-handle` resize dividers, `role="separator"` | page `HANDLE_SELECTOR` | row: vertical 12 px; in-stack: horizontal 12 px |
| Chrome-row buttons by `aria-label`: `Expand` / `Collapse` / `Close` | `harvest.chromeButtons` | `Collapse` replaces `Expand` while that tile is expanded |
| `.epitaxy-pane-close-control` | `harvest.chromeRow` | present in each pane's chrome row |
| **`Browser` opens tile `preview`; `Files` opens tile `browser`** | page `KINDS` (chip names only) | measured, not guessable — see step 3 above |
| `localStorage["epitaxy.sidePaneStore.v1"]` → `state.tileLayout.root`, `state.currentSessionId`, `state.tileLayoutBySession`; nodes `{kind:"stack"\|"tile", tileId, flex, children}` | `panel_tabs_layout.js` | version 4 blob; `expandedTile` is **never persisted** |
| `/epitaxy/<sessionId>` in the path, as the session-id fallback | page `sessionId` | matches `[A-Za-z0-9_-]+` |
| Theme tokens are **bare HSL triplets** (`hsl(var(--bg-100, 232 23.4% 18.4%))`) | page `CSS` | see `baseline/THEME_TOKEN_MAP.md` |

## Runtime warnings that mean an anchor moved

All via `__cdbDiag`/`console.warn`, prefixed `[cdb-tabs]`, in
`~/.config/Claude/logs/claude-patches.log`. Each is `warnOnce`.

| Key | Means |
|---|---|
| `anchor-rot` | upstream's mirror lists side panels but **no pane root resolved** — `[data-pane-root]` or `tileId` moved |
| `no-row` | A2 (or A1) — the row could not be resolved; nothing is hidden |
| `no-chat-column` | A1 — **no** row child positively identifies as the chat column, or **more than one** does. Ambiguity is refused, never resolved by document order |
| `no-column-wrapper` | a side pane has no `.tiles-shell` parent to tag |
| `shared-chat-column` | one wrapper holds both the chat pane and a side pane |
| `hold-watchdog` | no active column resolved for 1500 ms; unarmed back to upstream's split |
| `no-expand-control` | no `Expand`/`Collapse` on the active pane's chrome row |
| `sticky-expand-timeout` | upstream did not remount within 1200 ms of a collapse |
