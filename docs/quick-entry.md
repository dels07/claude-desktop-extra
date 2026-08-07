# Quick Entry

Setting up the hotkey, per desktop. For the short version, see [Quick Entry in the README](../README.md#quick-entry).

A global-hotkey popup (default `Ctrl+Alt+Space`) that opens a compact Claude prompt on the monitor where your cursor is. It works out of the box on **KDE Plasma**, **Hyprland**, and **Sway** via `xdg-desktop-portal` GlobalShortcuts.

Bind the toggle to any key with:
```bash
claude-desktop --toggle
```
This toggles Quick Entry in ~5-25 ms via a Unix domain socket, starting the app if it isn't running.

On **GNOME** the portal silently fails to register the hotkey - run once after install:
```bash
claude-desktop --install-gnome-hotkey                 # default Ctrl+Alt+Space
claude-desktop --install-gnome-hotkey '<Super>space'  # or any accelerator
```
This binds the key directly via `gsettings`, bypassing the portal. See [wayland.md](../wayland.md#quick-entry-hotkey-not-firing-on-gnome). Run `claude-desktop --diagnose` to check hotkey status.
