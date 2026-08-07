# Custom Themes

The full theme reference. For the short version, see [Custom Themes in the README](../README.md#custom-themes).

Recolor the whole app - chat, sidebar, Code/Cowork, dialogs, Quick Entry - by overriding CSS variables, injected into every window via Electron's `insertCSS()`. Each theme is **dual light/dark**: it ships a `light` and a `dark` palette, and the app's own toggle (Settings → Appearance) picks the matching one live. Every built-in is contrast-checked (WCAG AA).

**Quick start** - press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> anywhere in the app. A searchable picker opens with every theme available to you, each card showing a dark and a light row of swatches; click one and it applies immediately in every open window, no restart and no config file. Your choice is saved to `claude-desktop-extra.jsonc` with any comments in it left intact. The same list is also in the app's Settings dialog under **Extra → Themes**, next to an **Extra → Anthropic Features** panel that exposes the [feature flags](feature-flags.md) as switches.

Prefer the config file? One line is enough, no `themes` block needed:
```bash
echo '{"activeTheme": "mario"}' > ~/.config/Claude/claude-desktop-extra.jsonc
# Restart Claude Desktop, then toggle Settings → Appearance for light/dark
```

The Mario theme ships a **light "overworld"** and a **dark "underground"** variant, with a bouncing mushroom loading spinner:

| Light (overworld) | Dark (underground) |
|-------------------|--------------------|
| ![Mario theme - light](../themes/mario/2026-06-26_14-46-chat-light.png) | ![Mario theme - dark](../themes/mario/2026-06-26_14-46-chat-dark.png) |

**Built-in themes** (each with a light + dark palette and a custom spinner):

| Theme | Light variant | Dark variant | Spinner |
|-------|---------------|--------------|---------|
| `mario` | sky-blue overworld | warm-brick underground | mushroom |
| `sweet` | blush/lavender | deep purple, vivid pink ([Sweet](https://github.com/EliverLara/Sweet)) | blossom |
| `nord` (alias `nordic`) | Snow Storm | Polar Night ([nordtheme.com](https://nordtheme.com)) | snowflake |
| `catppuccin-mocha` | Latte | Mocha ([catppuccin.com](https://catppuccin.com)) | cat |
| `catppuccin-macchiato` | Latte | Macchiato | cat |
| `catppuccin-frappe` | Latte | Frappe | cat |
| `catppuccin-latte` | Latte | Mocha | coffee cup |

**6 gaming palettes** form their own **Gaming** section in the picker and in Settings → Extra → Themes, with Mario joining them: `playstation` (PS1 console gray / charcoal, button-symbol status colors, spinning button glyphs), `gameboy` (DMG shell / pea-green LCD, d-pad), `final-fantasy` (parchment / menu blue, crystal), `zelda` (forest green and gold, a two-frame walking hero), `warcraft` (parchment gold / dark brown, a two-frame peon at work) and `dragonball` (sky and white / deep blue, a spinning 4-star ball). They resolve at built-in rank, so `"activeTheme": "zelda"` is enough.

**84 community palettes** ship alongside them, converted from the [Noctalia community-palettes](https://github.com/noctalia-dev/community-palettes) collection - Rose Pine, Gruvbox, Everforest, Kanagawa, Solarized, Tokyo Night, the Catppuccin accent variants and more. Each is a full dual light/dark set, so `"activeTheme": "<slug>"` is all it takes, and each carries a spinner glyph drawn from its name or colors. Browse all 97 with their swatches in **[themes/PALETTES.md](../themes/PALETTES.md)**.

Each theme can also inject raw `customCss` and replace the loading glyph with a custom SVG. See **[themes/README.md](../themes/README.md)** for the schema, CSS-variable reference, contrast tips, and how to author your own.
