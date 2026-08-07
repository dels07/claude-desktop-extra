# Claude Desktop for Linux

[![Claude Desktop](https://img.shields.io/endpoint?url=https://patrickjaja.github.io/claude-desktop-extra/badges/version-check.json)](https://claude.ai/download)
[![Build & Release](https://github.com/patrickjaja/claude-desktop-extra/actions/workflows/build-and-release.yml/badge.svg)](https://github.com/patrickjaja/claude-desktop-extra/actions/workflows/build-and-release.yml)
[![Website](https://img.shields.io/badge/Website-Landing_Page-a78bfa?logo=github)](https://patrickjaja.github.io/claude-desktop-extra/)
[![Reddit](https://img.shields.io/badge/Reddit-Discussion-FF4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/ClaudeAI/comments/1r871b0/claude_desktop_on_linux_chat_cowork_code/)

[![Pacman repo](https://img.shields.io/endpoint?url=https://patrickjaja.github.io/claude-desktop-extra/badges/pacman-repo.json)](https://github.com/patrickjaja/claude-desktop-extra#arch-linux--manjaro-pacman-repository)
[![APT repo](https://img.shields.io/endpoint?url=https://patrickjaja.github.io/claude-desktop-extra/badges/apt-repo.json)](https://github.com/patrickjaja/claude-desktop-extra#debian--ubuntu-apt-repository)
[![RPM repo](https://img.shields.io/endpoint?url=https://patrickjaja.github.io/claude-desktop-extra/badges/rpm-repo.json)](https://github.com/patrickjaja/claude-desktop-extra#fedora--rhel-dnf-repository)
[![AppImage](https://img.shields.io/endpoint?url=https://patrickjaja.github.io/claude-desktop-extra/badges/appimage.json)](https://github.com/patrickjaja/claude-desktop-extra#appimage-any-distro)
[![Nix flake](https://img.shields.io/endpoint?url=https://patrickjaja.github.io/claude-desktop-extra/badges/nix.json)](https://github.com/patrickjaja/claude-desktop-extra#nixos--nix)

**Anthropic's official Claude Desktop Linux build, repackaged for the distros Anthropic doesn't ship - plus Linux-only extras.**

Anthropic publishes an official Claude Desktop [Linux `.deb`](https://code.claude.com/docs/en/desktop-linux) (Ubuntu 22.04+ / Debian 12+, amd64 + arm64). This project - **claude-desktop-extra** - takes that official build, repackages it for **Arch, Fedora/RHEL, NixOS, and AppImage** (and offers its own Debian/Ubuntu `.deb`), and layers on five Linux-only value-adds the official build lacks:

- [**Computer Use**](#computer-use) - desktop automation (screenshot, click, type, scroll, teach mode).
- [**Custom Themes**](#custom-themes) - 97 bundled dual light/dark palettes (7 built-in, 6 gaming, 84 community), each with its own loading spinner, switchable live from a Ctrl+Shift+T picker, or roll your own.
- [**Multiple Profiles**](#multiple-profiles) - run several instances side by side, each logged in to a different account with fully isolated state.
- [**Quick Entry**](#quick-entry) - global hotkey popup (Ctrl+Alt+Space), multi-monitor and Wayland-aware.
- [**Hardware Buddy**](#patches) - enables the Nibblet BLE pet device on Linux: forces the feature flag so the BLE transport arms, and turns on Chromium Web Bluetooth (via BlueZ) so the in-app scan can find the device - both are off by default upstream on Linux.

Everything else - Chat, Cowork, Claude Code, Browser Tools, 3P/enterprise inference - is the **official upstream build**, preserved through the repackage. Where its shared cross-platform bundle still gates a feature to macOS/Windows or misbehaves on a Linux desktop, we ship a **Linux fix** (see [Patches](#patches) - each entry states exactly why it exists).

> **If you run Ubuntu 22.04+ / Debian 12+,** Anthropic's [official `.deb`](https://code.claude.com/docs/en/desktop-linux) installs the base app directly. Use this project if you're on Arch/Fedora/RHEL/Nix/AppImage, or if you want the five value-adds and Linux fixes above.

<details>
<summary><b>Table of contents</b></summary>

- [Installation](#installation)
- [Computer Use](#computer-use)
- [Custom Themes](#custom-themes)
- [Multiple Profiles](#multiple-profiles)
- [Quick Entry](#quick-entry)
- [Cowork setup (needs /dev/kvm)](#cowork-setup-needs-devkvm)
- [Third-Party / Enterprise Inference](#third-party--enterprise-inference)
- [Patches](#patches)
- [Command-line flags](#command-line-flags)
- [Environment Variables](#environment-variables)
- [Feature Flag Overrides (advanced)](#feature-flag-overrides-advanced)
- [Debugging](#debugging)
- [Known Limitations](#known-limitations)
- [Automation](#automation)
- [Repository Structure](#repository-structure)
- [See Also](#see-also)
- [Legal Notice](#legal-notice)

</details>

## Installation

Pick your distro below. [Computer Use](#computer-use) works out of the box everywhere - all backends are bundled, nothing to install. The only optional dependency to care about is **Cowork** (agent workspace VM), listed per distro - it needs QEMU/KVM on the host, see [Cowork setup](#cowork-setup-needs-devkvm).

### Arch Linux / Manjaro (Pacman Repository)
```bash
# Add repository + import signing key (one-time setup)
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/install-pacman.sh | sudo bash

# Install (also brings the system up to date, as Arch requires)
sudo pacman -Syu claude-desktop-extra
```

Updates arrive via `sudo pacman -Syu` (AUR helpers wrap pacman, so `yay -Syu` picks them up too). Packages and the repository database are GPG-signed with the same key as our APT and RPM repos.

**Alternative: AUR.** The same PKGBUILD is published as [`claude-desktop-extra`](https://aur.archlinux.org/packages/claude-desktop-extra), updated by CI on every release. It builds from the checksummed release tarball; the pacman repo above ships the same content pre-built and is the recommended path.

```bash
yay -S claude-desktop-extra
```

**Optional deps.** **Cowork** (agent workspace VM) is **not auto-installed** (pacman skips `optdepends`) - install QEMU/KVM once, see [Cowork setup](#cowork-setup-needs-devkvm). Also optional: `nodejs` (system MCP servers), `sqlite` (project detection), `claude-code`.

<details>
<summary>Advanced: manual <code>pacman.conf</code> setup (without the install script)</summary>

The install script only automates these steps. Append to `/etc/pacman.conf` (on aarch64 the section name is `[claude-desktop-extra-aarch64]`; the `Server` line and the package name stay the same):

```ini
[claude-desktop-extra]
SigLevel = Required DatabaseRequired
Server = https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download
```

Then import the signing key, **verify its fingerprint**, and locally sign it:

```bash
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/gpg-key.asc -o /tmp/claude-desktop-extra.asc
gpg --show-keys --with-fingerprint /tmp/claude-desktop-extra.asc
# Must print: 825A 7D15 D78B ABE4 5646  D5DF 3824 09F5 9790 8867 - stop here if it does not.

sudo pacman-key --init            # no-op on a normal Arch install; needed on fresh keyrings, containers and chroots
sudo pacman-key --add /tmp/claude-desktop-extra.asc
sudo pacman-key --lsign-key 825A7D15D78BABE45646D5DF382409F597908867
sudo pacman -Syu claude-desktop-extra
```

The fingerprint check is what makes this trustworthy (see [Verifying the repository signing key](#verifying-the-repository-signing-key)). Both key steps are required: under `SigLevel = Required` pacman rejects the repo until the key carries your local signature, and `--lsign-key` fails with a cryptic "There is no secret key available to sign with" if the keyring was never initialised, hence the `--init`.
</details>

<details>
<summary>Build from source with <code>makepkg</code> (no third-party repository)</summary>

The `PKGBUILD` is generated and CI-tested on every release, and published as a release asset alongside `.SRCINFO` and `claude-desktop-extra.install`:

```bash
mkdir claude-desktop-extra && cd claude-desktop-extra
base=https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download
curl -fsSL -O "$base/PKGBUILD" -O "$base/claude-desktop-extra.install"
makepkg -si
```
</details>

### Debian / Ubuntu (APT Repository)

> **Requires Ubuntu 22.04+ / Debian 12+** (glibc 2.34 or newer). Debian 11 (bullseye) is no longer supported.

```bash
# Add repository (one-time setup)
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/install.sh | sudo bash

# Install
sudo apt install claude-desktop-extra
```
Updates are automatic via `sudo apt update && sudo apt upgrade`.

**Optional deps.** **Cowork** (agent workspace VM) packages are auto-installed by `apt` (`Recommends`, mirroring Anthropic's official `.deb`); only the one-time `kvm` group step remains - see [Cowork setup](#cowork-setup-needs-devkvm).

<details>
<summary>Manual .deb install (without APT repo)</summary>

```bash
wget https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download/claude-desktop-extra_1.24012.11-2_amd64.deb
sudo dpkg -i claude-desktop-extra_*_amd64.deb
```
</details>

### Fedora / RHEL (DNF Repository)
```bash
# Add repository (one-time setup)
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/install-rpm.sh | sudo bash

# Install
sudo dnf install claude-desktop-extra
```
Updates are automatic via `sudo dnf upgrade`.

**Optional deps.** **Cowork** (agent workspace VM) packages are auto-installed by `dnf` (weak deps); only the one-time `kvm` group step remains - see [Cowork setup](#cowork-setup-needs-devkvm).

<details>
<summary>Manual .rpm install (without DNF repo)</summary>

```bash
wget https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download/claude-desktop-extra-1.24012.11-2.x86_64.rpm
sudo dnf install ./claude-desktop-extra-*.x86_64.rpm
```
</details>

### NixOS / Nix
```bash
# Try without installing
nix run github:patrickjaja/claude-desktop-extra

# Or add to flake.nix
nix profile install github:patrickjaja/claude-desktop-extra
```

<details>
<summary>NixOS flake configuration</summary>

```nix
{
  inputs.claude-desktop.url = "github:patrickjaja/claude-desktop-extra";

  # In your system config:
  environment.systemPackages = [
    inputs.claude-desktop.packages.x86_64-linux.default
  ];
}
```
</details>

> **Note:** Update by running `nix flake update` to pull the latest version. `nix run` always fetches the latest.

> **Optional deps on Nix: wired automatically.** The flake pulls the Cowork tools (`qemu`, `virtiofsd`, OVMF firmware) from nixpkgs and bakes them into the app's closure - nothing to install. Use `.override { … }` to swap or drop a tool (e.g. `qemu = null;` shrinks the closure if you don't need Cowork). Two host-level steps remain, in NixOS form:
>
> ```nix
> users.users.<you>.extraGroups = [ "kvm" ];  # Cowork: /dev/kvm access (once, needs re-login)
> services.gnome.gnome-keyring.enable = true; # keeps sign-in across restarts (GNOME enables this itself)
> ```
>
> **NixOS Computer Use caveat:** the static bridges (X11 / XWayland / Sway / Hyprland / Niri) run as-is; the glibc-dynamic GNOME/KDE bridges do not - see [Computer Use dependencies](docs/computer-use-dependencies.md#nixos) for the `.override` workaround. If your flake pins a release older than v1.18286.0, virtiofsd and OVMF need manual exposure - see the notes in [`packaging/nix/package.nix`](packaging/nix/package.nix).

### AppImage (Any Distro)

Works on standard and **immutable/atomic distros** - Bazzite, Fedora Silverblue/Kinoite, SteamOS, Universal Blue, NixOS (without the Nix package), and any other glibc-based Linux.

The `claude://` protocol handler (needed for OAuth sign-in) is **automatically registered** on first launch. If you move or rename the AppImage, the registration updates on the next launch.

```bash
# Download from GitHub Releases
wget https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download/Claude_Desktop-1.24012.11-x86_64.AppImage
chmod +x Claude_Desktop-*-x86_64.AppImage
./Claude_Desktop-*-x86_64.AppImage
```

> **Update:** AppImage supports delta updates via [appimagetool](https://github.com/AppImageCommunity/AppImageUpdate) - only changed blocks are downloaded (`appimageupdatetool Claude_Desktop-*.AppImage`, or `--appimage-update` from within). Compatible with [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) and [Gear Lever](https://github.com/mijorus/gearlever). Use `--integrate` / `--unintegrate` / `--diagnose` to manage the protocol handler.
>
> **Optional deps.** For **Cowork** (VM), install QEMU + UEFI firmware + virtiofsd from your host's repos - per-distro commands in [Cowork setup](#cowork-setup-needs-devkvm).

### From Source
```bash
git clone https://github.com/patrickjaja/claude-desktop-extra.git
cd claude-desktop-extra
./scripts/build-local.sh --install
```

> **Note:** Source builds do not receive automatic updates. Pull and rebuild to update.
>
> **Optional deps.** A source build installs the native package for your distro, so the optional deps match that distro's section above; Cowork commands are in [Cowork setup](#cowork-setup-needs-devkvm) (on Arch install them by hand - pacman doesn't pull `optdepends`).

### ARM64 / aarch64 (Raspberry Pi 5, NVIDIA DGX Spark, Jetson, etc.)

ARM64 `.deb`, `.rpm`, AppImage, and Nix packages are available for **Raspberry Pi 5**, **NVIDIA DGX Spark** (Ubuntu 24.04 arm64), and **Jetson** (JetPack/Ubuntu 22.04 arm64). The APT and DNF repos serve both x86_64 and arm64 - your package manager picks the correct architecture automatically. Install exactly as above.

### Migrating from claude-desktop-bin

The project was renamed from `claude-desktop-bin` to `claude-desktop-extra`, and the switch is automatic: the package replaces itself on your next regular upgrade (apt, dnf, and pacman all handle it), and your themes / flag overrides (`claude-desktop-bin.jsonc`) are migrated on first launch.

One exception: an existing `[claude-desktop-bin]` section in `/etc/pacman.conf` points at a temporary transition mirror - replace it with the `[claude-desktop-extra]` stanza from the [Arch section above](#arch-linux--manjaro-pacman-repository) (same `SigLevel`, same signing key; aarch64: `[claude-desktop-extra-aarch64]`).

### Verifying the repository signing key

The APT, DNF and pacman repositories are GPG-signed with the same key. The install scripts import it from GitHub Pages over HTTPS. To verify the key out-of-band, compare its fingerprint against the value published here (this README lives in the git repo, a separate channel from the Pages-hosted key):

```
Key:         Claude Desktop Linux (claude-desktop-bin repo signing key) <patrickjajaa@gmail.com>
Type:        RSA 4096
Fingerprint: 825A 7D15 D78B ABE4 5646  D5DF 3824 09F5 9790 8867
```

```bash
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/gpg-key.asc | gpg --show-keys --with-fingerprint
# The printed fingerprint must match the value above.
```

## Computer Use

**Our exclusive feature - not part of the official Linux build.** Claude Desktop's built-in Computer Use MCP server exposes 27 tools for desktop automation (screenshot, click, type, scroll, drag, clipboard, and more), plus **learn tools** that generate interactive overlay tutorials for any app. Upstream gates it to macOS/Windows and ships no Linux backend; the patch ([`fix_computer_use_linux.nim`](patches/linux/fix_computer_use_linux.nim)) removes the platform gates and injects a Linux executor that auto-detects your session and routes to a bundled first-party bridge: [`x11-bridge`](https://github.com/patrickjaja/x11-bridge) on X11 / XWayland, [`wlroots-bridge`](https://github.com/patrickjaja/wlroots-bridge) on Sway / Hyprland / Niri (native virtual-pointer/keyboard + screencopy + foreign-toplevel protocols), [`gnome-portal-bridge`](https://github.com/patrickjaja/gnome-bridge) on GNOME Wayland (XDG RemoteDesktop + ScreenCast portal, one consent dialog per session, persisted on GNOME 46+; needs PipeWire >= 1.0.5, i.e. Ubuntu 24.04+ / Fedora 40+ / Debian 13+), and [`kwin-portal-bridge`](https://github.com/patrickjaja/kwin-portal-bridge) on KDE Plasma 6.6+. No third-party input/screenshot tools needed; only exotic Wayland compositors fall back to `ydotool`.

**Nothing to install** - the bridges ship inside the package. See **[docs/computer-use.md](docs/computer-use.md)** for how it works, the notes (primary-monitor, app discovery, teach overlay), and links to the [tool reference](baseline/CLAUDE_BUILT_IN_MCP.md#14-computer-use); [Computer Use dependencies](docs/computer-use-dependencies.md) has the per-session matrix and the exotic-compositor `ydotool` fallback.

**KDE Plasma needs 6.6+** for the native KWin route (earlier Plasma lacks the KWin capture-hiding API) - below that, Computer Use falls back to `ydotool`/`spectacle`; updating Plasma restores the full experience. `claude-desktop --diagnose` prints your KWin version and which route is active.

## The "Extra" Settings

This package adds its own section to Claude's Settings dialog: **Extra** - the home of everything this project layers on top of the official build, and where new features land first.

![The Extra section in Claude's Settings: Themes with the Gaming palettes, next to Features](docs/global/2026-07-29_20-21-extra.png)

Three panels today:

- **Extra → Themes** - all **97 bundled palettes** with live color dots; one click applies instantly in every open window. Make Claude Desktop blend into your Linux desktop: palettes matching stock DE looks (ADW/Adwaita, Breeze) sit next to the classics (Catppuccin, Nord, Gruvbox, Rose Pine, Everforest) and a [Gaming collection](#custom-themes).
- **Extra → Community Features** - the optional extras this project adds ([panel tabs](#patches), [diff view modes](#patches), the theme-picker hotkey, a calmer Cowork glow) as switches, with a filter box over them.
- **Extra → Anthropic Features** - the catalogued upstream [feature flags](#feature-flag-overrides-advanced) as switches, no config-file editing needed.
- **Extra → Deployment** - a **1P / 3P switch** plus the whole [third-party inference](#third-party--enterprise-inference) configuration as toggles and fields. Turning 3P on used to be a one-way door without a root shell; here it is a button, and every value is written to your own profile directory.

Every panel ends in the config file behind it, as a link: click the path to open the file, or the **folder** button to show it in your file manager.

Expect this section to grow - Extra is where the project is heading.

## Custom Themes

Recolor the whole app - chat, sidebar, Code/Cowork, dialogs, Quick Entry - by overriding CSS variables, injected into every window via Electron's `insertCSS()`. Each theme is **dual light/dark**: it ships a `light` and a `dark` palette, and the app's own toggle (Settings → Appearance) picks the matching one live. Every built-in is contrast-checked (WCAG AA).

**Quick start** - press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> anywhere in the app. A searchable picker opens with every theme available to you, each card showing a dark and a light row of swatches; click one and it applies immediately in every open window, no restart and no config file. Your choice is saved to `claude-desktop-extra.jsonc` with any comments in it left intact. The same list is also in the app's Settings dialog under **Extra → Themes**, next to an **Extra → Anthropic Features** panel that exposes the [feature flags](#feature-flag-overrides-advanced) as switches.

Prefer the config file? One line is enough, no `themes` block needed:
```bash
echo '{"activeTheme": "mario"}' > ~/.config/Claude/claude-desktop-extra.jsonc
# Restart Claude Desktop, then toggle Settings → Appearance for light/dark
```

The Mario theme ships a **light "overworld"** and a **dark "underground"** variant, with a bouncing mushroom loading spinner:

| Light (overworld) | Dark (underground) |
|-------------------|--------------------|
| ![Mario theme - light](themes/mario/2026-06-26_14-46-chat-light.png) | ![Mario theme - dark](themes/mario/2026-06-26_14-46-chat-dark.png) |

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

**84 community palettes** ship alongside them, converted from the [Noctalia community-palettes](https://github.com/noctalia-dev/community-palettes) collection - Rose Pine, Gruvbox, Everforest, Kanagawa, Solarized, Tokyo Night, the Catppuccin accent variants and more. Each is a full dual light/dark set, so `"activeTheme": "<slug>"` is all it takes, and each carries a spinner glyph drawn from its name or colors. Browse all 97 with their swatches in **[themes/PALETTES.md](themes/PALETTES.md)**.

Each theme can also inject raw `customCss` and replace the loading glyph with a custom SVG. See **[themes/README.md](themes/README.md)** for the schema, CSS-variable reference, contrast tips, and how to author your own.

## Multiple Profiles

Run several Claude Desktop instances side by side, each logged in to a different account, with fully isolated state for both Desktop and the Claude Code CLI it spawns. Useful for separating work from personal accounts, juggling SSO tenants, or testing config without touching your main install.

### Quick start

```bash
# One-time setup per profile
claude-desktop --create-profile=work
claude-desktop --create-profile=personal

# Launch (any of these work)
claude-desktop-work                     # via the per-profile shortcut
claude-desktop --profile=work           # via the system launcher
# …or click "Claude (work)" in your application menu

# Inspect / clean up
claude-desktop --list-profiles
claude-desktop --delete-profile=work    # removes entry points; user data preserved
```

The **default profile** (no `--profile=`, no named shortcut) is byte-identical to a single-instance install - same `~/.config/Claude`, same `~/.claude`, same sockets, same WM identity. You can run it alongside any number of named profiles.

A **named profile** (`--create-profile=NAME`, names match `[a-zA-Z0-9_-]+`, `default` reserved) installs three things in your home dir (no root needed): a per-profile Electron binary at `~/.local/lib/claude-desktop/claude-NAME`, a launcher symlink at `~/.local/bin/claude-desktop-NAME`, and an application-menu entry `Claude (NAME)`. User data is created lazily on first launch.

Three equivalent ways to select a profile at launch: `claude-desktop --profile=NAME`, `CLAUDE_PROFILE=NAME claude-desktop`, or the `claude-desktop-NAME` shortcut (infers the name from its basename). All export `CLAUDE_PROFILE`, which propagates through Electron and any spawned `claude` CLI.

### What's isolated

| Resource | Default profile | Named profile (e.g. `work`) |
|---|---|---|
| Electron userData (login, logs, settings, themes, Cowork sessions/Spaces, portal token) | `~/.config/Claude` | `~/.config/Claude-work` |
| Claude Code config (settings, projects, sessions, plugins) | `~/.claude` | `~/.claude-work` |
| Quick Entry toggle socket | `$XDG_RUNTIME_DIR/claude-desktop-qe.sock` | `…/claude-desktop-qe-work.sock` |
| systemd user scope (cgroup, portal identity) | `app-com.anthropic.Claude-PID.scope` | `app-com.anthropic.Claude-work-PID.scope` |
| WM_CLASS / Wayland app_id (taskbar grouping, Alt-Tab) | `com.anthropic.Claude` | `com.anthropic.Claude` (shared - all profiles group as one app) |
| XDG autostart entry ("Start at login") | `~/.config/autostart/claude.desktop` | `…/claude-work.desktop` |

Plugins, MCP servers, login state, and chat history from one profile are **not** visible in another - profiles are independent installs, not shared views.

### Removing a profile

```bash
claude-desktop --delete-profile=work    # removes the three entry points
rm -rf ~/.config/Claude-work ~/.claude-work   # user data is preserved; delete manually for a clean slate
```

### SSO and URL routing

The `claude://` scheme is registered system-wide and points to the default profile's `.desktop` file. To route SSO callbacks to the profile that started them, claude-desktop-extra uses a marker mechanism ([`fix_profile_url_routing.nim`](patches/core/fix_profile_url_routing.nim)): when a profile calls `shell.openExternal()` on an auth URL it writes a timestamped marker at `$XDG_RUNTIME_DIR/claude-desktop-pending-auth-<profile>`; when the launcher receives a `claude://` callback with no explicit profile it picks the most recent marker (< 5 min old) and re-execs as that profile.

Sequential SSO into any number of profiles is reliable. Two edge cases misroute (the "most recent marker wins" rule): clicking an unrelated outbound link mid-flow, or two SSO flows in flight concurrently - just re-attempt. The marker is `0600` and holds only a timestamp. Escape hatch: `claude-desktop --profile=NAME 'claude://<callback-url>'`.

**Opening shared-artifact links:** a `claude://cowork/shared-artifact?uuid=…` link opens Claude Desktop when clicked as a real hyperlink. Pasting it into a browser address bar won't work (the omnibox treats unknown schemes as a search - a browser security gate). To open a copied link: `xdg-open 'claude://cowork/shared-artifact?uuid=…'`.

### Notes

- **Disk cost.** A named profile needs a real, independently-named binary (not a symlink) so Electron can derive a distinct WM_CLASS / Wayland `app_id` from `/proc/self/exe`. The launcher tries hardlink → reflink (btrfs/xfs CoW) → plain copy in order, so only cross-filesystem installs on a non-CoW disk actually pay the ~200 MB; sibling files (`libffmpeg.so`, `.pak`, `locales/`, …) are always shared symlinks. Package upgrades that leave the copy stale are re-materialised automatically on the next launch.
- **`--profile=NAME` without `--create-profile`** isolates state but not WM identity (window joins the default taskbar entry; suppress the hint with `CLAUDE_PROFILE_QUIET=1`).
- **[Quick Entry](#quick-entry) hotkey is not per-profile** - `--install-gnome-hotkey` targets the default profile; for a named one, bind `claude-desktop --profile=NAME --toggle` by hand.
- **NixOS** may not resolve Wayland portal identity (no `systemd-run --scope`); use `--install-gnome-hotkey`.

## Quick Entry

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
This binds the key directly via `gsettings`, bypassing the portal. See [wayland.md](wayland.md#quick-entry-hotkey-not-firing-on-gnome). Run `claude-desktop --diagnose` to check hotkey status.

## Cowork setup (needs /dev/kvm)

Cowork (and Dispatch) run on the **official native Cowork VM backend** bundled inside the package (cowork-linux-helper + virtiofsd + smol-bin + QEMU/OVMF) - the same backend Anthropic ships in the official Linux build. There's no separate daemon to install; sessions run in a lightweight VM with `$HOME` shared in, which requires **`/dev/kvm`** on the host.

**1. Install QEMU + UEFI firmware + virtiofsd.** The `.deb` / `.rpm` packages pull them automatically (`Recommends` / weak deps, matching Anthropic's official `.deb`), and the Nix flake bakes them into the app's closure. On **Arch** (pacman skips `optdepends`) and for **AppImage or source builds**, install them from your distro's repos:

```bash
# Arch:          sudo pacman -S --needed qemu-system-x86 edk2-ovmf virtiofsd   # aarch64: qemu-system-aarch64 edk2-aarch64
# Fedora:        sudo dnf install qemu-system-x86 edk2-ovmf virtiofsd          # RHEL: qemu-kvm instead of qemu-system-x86 · aarch64: qemu-system-aarch64 edk2-aarch64
# Debian/Ubuntu: sudo apt install qemu-system-x86 ovmf virtiofsd               # arm64: qemu-system-arm qemu-efi-aarch64 · Ubuntu 22.04: no virtiofsd pkg needed (bundled copy is used)
```

**2. Join the `kvm` group** (once - then log out and back in):

```bash
sudo usermod -aG kvm "$USER"        # /dev/kvm access
```

The Claude Code CLI that Cowork/Dispatch drive is managed by the app itself - nothing to install. To pin your own binary, set `CLAUDE_CODE_LOCAL_BINARY=/path/to/claude`.

> A **system virtiofsd is required on everything except Ubuntu 22.x** - the app's capability probe only falls back to the bundled `virtiofsd` on jammy (`/etc/os-release` gate). Without it Cowork reports "Cowork requires QEMU …" even when qemu and firmware are present (issue #177). If your distro installs virtiofsd outside the probed paths (`/usr/libexec`, `/usr/lib`, `/usr/lib/qemu`, `/usr/bin`), point the app at it with `CLAUDE_VIRTIOFSD_PATH=/path/to/virtiofsd`; a custom firmware location can likewise be set with `CLAUDE_OVMF_CODE_PATH=/path/to/OVMF_CODE.fd` (its `*_VARS.fd` sibling must sit next to it). The Nix flake wires all three automatically (see the Nix install section).

> **Arch Linux ARM / EndeavourOS ARM / Manjaro ARM (native aarch64 host, e.g. Raspberry Pi 5):** `edk2-aarch64` is `arch=any` on archlinux.org but Arch Linux ARM's repos don't carry it, so `pacman -S edk2-aarch64` fails with `target not found` even after `-Syu` ([ALARM forum #16140](https://archlinuxarm.org/forum/viewtopic.php?t=16140)). Since the package is architecture-independent, grab it from the x86_64 Arch mirrors and install locally: `curl -L https://archlinux.org/packages/extra/any/edk2-aarch64/download -o edk2-aarch64.pkg.tar.zst && sudo pacman -U ./edk2-aarch64.pkg.tar.zst`.

### Troubleshooting Cowork

Run **`claude-desktop --diagnose`** first - it prints a full capability probe (KVM, vhost_vsock, QEMU, firmware, virtiofsd) and tells you exactly which piece is missing. Common popups and their fixes:

- **"Download failed" / clicking Download does nothing** - almost always missing `kvm` group membership (`sudo usermod -aG kvm "$USER"`, then re-login), or on AppImage/Nix missing firmware or system virtiofsd.
- **"Virtualization isn't fully set up" / "Cowork requires QEMU. Install it with …"** - QEMU, OVMF firmware, or virtiofsd is missing. The popup's `apt` command is upstream's and only correct on Debian/Ubuntu - use your distro's command from [step 1 above](#cowork-setup-needs-devkvm) instead.
- **"Cowork requires the vhost_vsock kernel module"** - on systemd distros this normally never appears: systemd pre-creates `/dev/vhost-vsock` at boot (static device node) and the kernel auto-loads the module the moment QEMU opens it. If you do see it, you are on a non-systemd init (Artix, Void), inside a container, or on a kernel built without the module - load it with `sudo modprobe vhost_vsock` and persist it (`echo vhost_vsock | sudo tee /etc/modules-load.d/vhost_vsock.conf`, or your init's equivalent).
- **Dispatch stops responding or behaves oddly** - the Dispatch conversation keeps its state (including past errors) across restarts, so a broken session stays broken. Reset it: open the **⋮** menu next to the Dispatch title and click **Delete conversation**, then send your request again in the fresh conversation.

  ![Reset Dispatch: ⋮ menu, then Delete conversation](docs/dispatch/reset-dispatch-conversation.png)

No symlinks or manual path configuration are needed: the capability probe searches the distro-native firmware and virtiofsd locations (`/usr/share/edk2/x64/OVMF_CODE.4m.fd`, `/usr/lib/virtiofsd`, …) out of the box. Custom locations can be set via `CLAUDE_OVMF_CODE_PATH` / `CLAUDE_VIRTIOFSD_PATH` (see above).

**CoworkSpaces** are stored locally per account under `~/.config/Claude/local-agent-mode-sessions/` (see [Known Limitations](#known-limitations)).

> **Note - Cowork does not work inside a nested VM.** Because Cowork boots its own lightweight VM (the bundled backend downloads/builds a rootfs and starts it via QEMU/KVM), it needs real, stable access to `/dev/kvm`. Running Claude Desktop inside a hypervisor guest (VirtualBox, VMware, etc.) means Cowork would have to launch a VM *inside* a VM (nested virtualization), which most desktop hypervisors do not support reliably - VirtualBox in particular can hard-crash the entire guest when the nested VM starts. The app itself installs and runs fine in a VM; only the Cowork feature requires a bare-metal host (or a cloud instance with nested virtualization properly enabled).

## Third-Party / Enterprise Inference

**Run Claude Desktop entirely on your own inference backend - no personal claude.ai login required.** Point it at **Bedrock** (AWS), **Vertex AI** (Google Cloud), **Azure AI Foundry** (Microsoft), or any **Anthropic-compatible gateway** (LiteLLM, Portkey, in-house proxies). Chat, Code, and Cowork all work in 3P mode on Linux.

**Our exclusive addition: Settings → Extra → [Deployment](#the-extra-settings).** A **1P / 3P switch** and the full configuration as toggles and fields - provider and credentials, which tabs exist, the workspace and egress allowlists, telemetry, update policy, usage limits. It writes the same schema the enterprise policy file uses, into **your own profile directory** (`~/.config/Claude-3p/configLibrary/`, the store upstream's own 3P Setup uses), so nothing here needs `sudo`, and each [profile](#multiple-profiles) has its own. Two things it deliberately refuses to write: `disableDeploymentModeChooser`, the key that locks a machine into 3P, and `managedMcpServers`, whose entries can start a process - both stay read-only, and remain yours to deploy through the policy file. Stored credentials are write-only: the panel can replace one but never shows it.

Fleet rollouts still take the policy route: `/etc/claude-desktop/managed-settings.json` is read natively by the official build, needs root, and wins over everything local while it is in place (the panel says so, and turns read-only).

The official 3P docs cover only macOS and Windows. **[docs/third-party-inference.md](docs/third-party-inference.md)** is the Linux guide: the [in-app panel](docs/third-party-inference.md#route-a-the-in-app-deployment-panel), a [5-minute LiteLLM quickstart](docs/third-party-inference.md#5-minute-local-quickstart-litellm-container), worked Vertex AI / gateway / Bedrock examples, the [maximum `managed-settings.json`](docs/third-party-inference.md#maximum-managed-settingsjson-every-key), the [`enterprise.json` → `managed-settings.json` migration](docs/third-party-inference.md), and [switching back to personal (1P)](docs/third-party-inference.md#common-gotchas).

## Patches

The official Linux build ships one cross-platform JS bundle: plenty of code paths in it check `process.platform` and only serve `darwin`/`win32`, and some upstream behavior misfires in a Linux desktop environment. We apply a set of surgical JS patches to the `app.asar` at repackage time. Each patch lives in the directory that says what it is for:

- **[`patches/community/`](#community-features)** - optional features you switch on yourself in Settings → **Extra** → **Community Features**. Off unless you ask for them (the theme picker is the exception, on by default).
- **[`patches/core/`](#core-infrastructure)** - always-on infrastructure the rest builds on: the Extra settings pages themselves, the theme engine, the flag-override mechanism, and the multi-profile plumbing.
- **[`patches/linux/`](#linux-compatibility)** - upstream features still gated to macOS/Windows in the shared bundle, or that break in a Linux environment. Always on, nothing to configure.

Every patch here modifies the bundle. When a behavior becomes native in the official build, the patch that injected it is removed; we don't keep assert-only patches.

Every package ships the official build's install tree byte-identical except for the patched `app.asar` (plus our bundled Computer Use bridges in `resources/`), so runtime path resolution (`process.resourcesPath`, `app.isPackaged`) behaves exactly as on the stock Anthropic `.deb`.

Each patch is a self-contained `patches/<group>/*.nim` file compiled to a native binary. Patterns use `[\w$]+` wildcards anchored on stable strings because upstream re-minifies between releases; every sub-patch must match or the build fails, so a broken assumption surfaces at build time, never at runtime. When an update breaks a patch, only that file needs updating - each patch source documents the anchor strings it matches on. Discovery walks the three directories and applies the patches in basename order; `scripts/apply_patches.py` pins the total in `EXPECTED_PATCH_COUNT` and fails the build if it finds a different number, so a patch that is added or dropped is always a deliberate edit.

> **We keep this set as small as possible.** On each upstream release every patch is re-audited against a fresh unpatched bundle - a patch that still applies cleanly isn't proof it's still needed, so each must be confirmed to genuinely do work (or the feature live-tested) to stay. When Anthropic ships a behavior natively, the patch is removed outright. `ls patches/*/*.nim` is the authoritative list of everything in the tree.

### Community features

Optional extras, each with its own switch in Settings → **Extra** → **Community Features**. They reshape first-party surfaces, so they are asked for rather than assumed: turning one off is a full retreat to upstream's own behavior.

| Patch | What it does & why it exists |
|-------|------------------------------|
| `add_feature_theme_picker.nim` | The <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> [theme picker](themes/README.md#theme-picker-ctrlshiftt) - a searchable gallery of every user, gaming, built-in and community theme, grouped in divider-separated sections, with light/dark swatches per palette. Clicking one applies it live and saves it to `claude-desktop-extra.jsonc`, comments intact. Opens via `before-input-event`, so it needs nothing from the app's own bundle. Persisted as `themePicker` (default `true`); the **Theme picker hotkey** switch in the Extra **Community Features** panel turns the shortcut off for anyone who wants <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> back |
| `add_feature_cowork_glow.nim` | A **Motion** switch in the Extra **Community Features** panel that holds the pulsing Cowork glow still - **for laptops and machines without much graphics power**. `.cowork-hero-glow` pulses between 55% and 100% opacity every 3.2 s and never stops, so the compositor never settles; and where the launcher falls back to `--disable-gpu-compositing` (software/llvmpipe) or `--disable-gpu` (blocklisted GPU), those frames are redrawn on the CPU. Upstream silences it only under `prefers-reduced-motion`, an OS-wide setting that flattens every other animation too. The class carries nothing but the animation - the gradient comes from utilities on the same element - so `animation: none` alone would leave it parked *brighter* than the pulse's average; the switch therefore pins both the animation and a fixed opacity (`coworkGlowOpacity`, default `0.55`). Applied with `insertCSS` in every open window, so it takes effect live; persisted as `coworkGlow` and locked in the UI when set by hand in the `.jsonc` |
| `add_feature_diff_views.nim` | A scope dropdown on the Code tab's diff panel - **Working tree**, **Branch changes** (committed work only) and **Latest turn** (what the last conversation turn changed) - plus a fix for the base branch the whole panel compares against. Alongside the dropdown it adds an **expand/collapse-all** button. Upstream's per-file expansion is local component state with no bulk control, and the per-file patch is fetched lazily behind an IntersectionObserver - a file below the viewport has no patch, so its header is `disabled` and cannot be expanded at all. One press therefore expands every file that is loaded and **arms** a sticky mode that keeps expanding files as their patches arrive while you scroll; pressing again collapses everything and switches that off. Collapsing runs bottom-up, because the app scrolls each file into view as it closes and top-down would leave you at the bottom of the diff. The button reads upstream's own `aria-expanded` rather than any class name, never clicks a header whose patch has not loaded, and never re-expands a file you closed by hand. Close the last open file by hand and it disarms itself, so the tooltip never offers a Collapse the button no longer has. Closing the panel or expanding it to fullscreen tears the old instance down rather than leaving an armed one running behind an invisible button. Its icon is Anthropic's own `CaretUpDown`/`CaretDownUp` glyph, but only after two checks agree it will actually draw: the font must be present as a loaded `FontFace`, and a canvas ink probe must find ink at **both** codepoints - the expand caret and the collapse caret, since the button paints either one. The icon font's `.notdef` is empty, so a codepoint that moved in a later release would otherwise render an invisible button - and with the font absent entirely the browser substitutes one whose tofu box an ink check alone would read as success. Either check failing keeps a hand-built SVG caret pair instead. Upstream always diffs the remote default branch against the working tree, so committed and uncommitted work arrive mixed together and a branch cut from `master` in a repo whose `origin/HEAD` is `develop` is measured from the wrong fork point. Rather than render a second diff view, this patch rewrites the arguments of the app's own git IPC (`LocalSessions.getGitDiff` / `getGitDiffStats` / `getGitDiffFilePatch` / `getDiffFileContent`) so the stock renderer draws every mode - syntax highlighting, virtualized scrolling, line comments and theming all keep working. Handlers are wrapped where they are actually registered, on the per-`WebContents` `ipc` object rather than the global `ipcMain`, so nothing depends on a regex against minified code. Base detection scores every candidate (`origin/HEAD`, `main`, `master`, `develop`, `trunk`, the branch's upstream) by how few commits separate its merge-base from `HEAD` and takes the closest fork point; `git config branch.<name>.cdbBaseBranch <ref>` pins it by hand. Refs are resolved to full SHAs before they are handed back, because the app's own resolver tries `origin/<ref>` first and would otherwise turn `HEAD` into `origin/HEAD` and diff a commit against itself. Every ref and path that reaches a git command of ours is checked first - an object id (or the literal `HEAD`) for refs, a repo-relative path for pathspecs - and anything else is refused rather than repaired, because the diff arguments come from remote claude.ai code and git honours option-shaped values anywhere before the `--` separator. A patch or file that would exceed the 2 MiB cap is refused for the same reason: it is killed mid-stream, so serving the prefix would be a wrong answer that looks like a right one. Every refusal falls through to the stock handler and is logged once with its reason. Latest turn compares two `git write-tree` snapshots taken from a temp index at each turn boundary - untracked files included, no commits, stashes or refs left behind - kept **per repository**, because the app spawns its CLI for other directories (plain `$HOME` among them) every few seconds and a single snapshot slot was wiped seconds after it was taken; spawns outside a git work tree are ignored, synthetic `isSynthetic` user frames never move the boundary, every refusal is logged with its reason instead of passing through silently, and the **Latest turn** entry disables itself with an explanation while a repo has no turn recorded. The whole feature is **opt-in**: a **Source control** switch in the Extra **Community Features** panel turns it on, and it is **off by default**, deliberately - it reshapes a first-party surface by rewriting the arguments of Anthropic's own git IPC and correcting the base branch the stock panel compares against, so it is asked for rather than assumed. Off is a full retreat and not a hidden control: no dropdown is injected, the interception is a byte-identical pass-through, the base-branch override stops, no turn snapshots are taken and every remembered mode resets to Working tree. The switch applies live in both directions - turning it on mid-session mounts the dropdown and starts recording turn boundaries from that point without a restart, and until the first turn lands **Latest turn** stays disabled with its usual explanation. The modes arm per repository, once a CLI session has been observed in it: on a mid-session switch-on the dropdown therefore reads **Working tree** until the next message lands, deliberately, because the file list and the per-file content are gated on the same fact and a panel that showed one from the branch and the other from the working tree would be showing two different diffs at once. Persisted as `diffViewModes` (default `false`; "off" is simply the absence of the key), locked in the UI when set by hand in the `.jsonc` |
| `add_feature_diff_views_bridge.nim` | The `window.cdbDiffViews` contextBridge in the `mainView` preload that the dropdown talks through - `state()` and `setMode(mode)`, one fixed channel each with no generic `invoke()` passthrough. The mode is an enum, the project directory is never taken from the page, and every git command we run ourselves is bound to the directory observed on the session's own CLI spawn, so remote code cannot aim it at another checkout |
| `add_feature_panel_tabs.nim` | Puts the Code tab's side panels (diff, terminal, browser, files, artifacts, background tasks) into a tab strip instead of a fixed split - each tab gets the full width of the panel area while the chat column is unaffected. Panels are opened by the app's own controls, exactly as before (its toolbar buttons and its **Session actions** menu) - this patch never opens one, and the reconciler simply adopts whatever appears as a new tab. Hiding is **keyed on absence**: the row holding the chat column and the chain down to the active tile are tagged, and an armed row hides every child that is not the chat column, the active chain or the kept chat<->side divider - so a branch upstream has only just inserted is hidden before it can paint (a tag-driven rule left it visible for ~90 ms, and closing the active branch briefly left nothing carrying the side flex at all). Arming requires row + chat column + chain to all resolve and is dropped otherwise, because an absence-keyed rule on a mis-tagged row would hide the chat column; unarmed means upstream's plain split. Reconciliation runs synchronously in the MutationObserver callback, before paint, with the debounce demoted to a trailing pass. Whole non-active branches are hidden rather than their leaves (upstream nests tile stacks, so hiding leaves alone left an empty branch holding its flex share) and in-stack resize handles go with them. Every open panel stays in upstream's layout and stays **mounted**, so a hidden panel keeps its React state (the diff panel's expanded files survive a switch) and nothing writes the layout on switch, open or close - the trade is that a hidden panel also keeps running. The panel area is sized as a two-pane split (chat vs one panel) held as a **ratio**, not a flex difference, because upstream renormalizes the chat column's flex when branches come and go; so opening or closing a panel cannot move the boundary, and a divider drag re-captures the ratio (armed only on a pointer gesture on the handle with the row's child count unchanged) and persists it per session. Tab chips use upstream's own labels, not tile ids (its `Browser` is tile `preview`, its `Files` is tile `browser`). <kbd>Ctrl</kbd>+<kbd>1</kbd>-<kbd>9</kbd> jump straight to a tab, matched on the physical digit key and ignored while the terminal has focus (Ctrl+Tab cycling is already claimed by the page); the chips live in their own scroller with the expand control pinned as a non-shrinking sibling, so it stays hit-testable when the strip overflows. Closing a tab clicks that pane's own close control; a MutationObserver plus a 2 Hz poll reconciles the tab set against upstream's own DOM on every pane mount, unmount and session switch. Only the active tab and the chat/side ratio are persisted per session (`cdb.panelTabs.v2`) - which panels are open, and their order, come from upstream's layout. Full-width is sticky across a tab switch (collapse, wait for the remount, re-expand - upstream unmounts the other panes while one is expanded); while expanded the strip stays complete by taking the union of the layout's side tiles and the mounted columns, and a tab whose pane is unmounted shows no per-tab ✕, because upstream's own Close control is not in the document either. Off is a full retreat and the default - removing the attributes and the stylesheet restores upstream's real split with no layout write at all, and nothing open is lost. Toggled live from the Extra **Community Features** panel's **Layout** section ("Panel tabs"). **Every DOM/fiber anchor this relies on, with expected values and console recipes to re-derive them, is inventoried in [`baseline/PANEL_TABS_ANCHORS.md`](baseline/PANEL_TABS_ANCHORS.md) - re-validate it on each upstream bump, because a green build proves the Nim patterns matched, not that these remote-code anchors still exist** |
| `add_feature_panel_tabs_bridge.nim` | The `window.cdbTabs` contextBridge in the `mainView` preload that the tab bar talks through - `state()`, `prefRead()` and `prefSet(enabled)`, one fixed channel each with no generic `invoke()` passthrough, because the page behind this preload is remote code |

### Core infrastructure

Always on, and what the rest is built on: the Extra settings pages, the theme engine behind them, the local feature-flag override mechanism, and the plumbing that keeps multiple profiles apart.

| Patch | What it does & why it exists |
|-------|------------------------------|
| `add_feature_custom_themes.nim` | CSS theme injection - 97 bundled dual light/dark palettes (7 curated built-ins, 6 gaming, 84 community), each with its own loading spinner, applied to every window via `insertCSS()`. Upstream has no theming layer beyond the light/dark toggle. Also installs the theme registry (`globalThis.__cdbThemes`) the picker below drives and the live spinner engine, so a switch re-themes colors *and* the loading glyph in every open window instead of on the next start |
| `add_feature_extra_settings.nim` | The rainbow **Extra** group in the app's own Settings dialog, with a **Themes** panel (every user, gaming, built-in and community palette as a swatch row, in the same sections as the picker - one click applies and saves it live), a **Community Features** panel (the switches for the optional features in the table above, with a filter box over them), an **Anthropic Features** panel (all 134 catalogued GrowthBook flags as switches, pre-set to what your account actually gets, with value-carrying flags read-only and the Cowork-breaking flag locked) and a **Deployment** panel ([1P/3P switch](#third-party--enterprise-inference) plus the managed-settings schema as toggles, selects and fields, with a raw-JSON escape hatch). Main-process half: the `cdb-extra:*` / `cdb-flags:*` / `cdb-deploy:*` IPC handlers, the only writer of `growthbookOverrides` in `claude-desktop-extra.json`, the writer of the deployment mode and of the third-party configuration, and the `insertCSS` + `executeJavaScript` injection of the panel UI. Deployment writes only files upstream already reads - the `deploymentMode` key in `<userData>-3p/claude_desktop_config.json` and the applied entry of `<userData>-3p/configLibrary` - so it needs neither root nor a patch to the app's bootstrap; the key catalog is pinned from the bundle's own schema and is re-validated on every upstream bump. The Settings dialog is remote claude.ai markup, so the injector anchors on semantics only (`role="dialog"` plus the visible text of known nav items) and fails soft - if it cannot find the dialog it logs one line and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> remains the way in |
| `add_feature_extra_settings_bridge.nim` | The `window.cdbExtra` contextBridge in the `mainView` preload that the Extra panels talk through. One fixed method per channel and no generic `invoke()` passthrough, because the page behind this preload is remote code; the main side re-validates every sender and argument |
| `add_growthbook_overrides.nim` | [Local feature-flag overrides](#feature-flag-overrides-advanced) via `claude-desktop-extra.jsonc` - hooks the GrowthBook features-store setter so user overrides win over the server rollout. Upstream has no local override mechanism (the flag cache is encrypted). Also applies our built-in Linux force for Hardware Buddy (Nibblet BLE, flag `2358734848`) at the store level so its `onFeatureChange` listener arms the BLE transport; a user override still wins. The in-app scan additionally needs Chromium Web Bluetooth, which the launcher enables via `--enable-blink-features=WebBluetooth` (off by default on Linux), plus the `bluez` daemon running. The commented flag list in that template doubles as the catalog the Extra settings **Anthropic Features** panel renders, and the file's parser accepts a trailing comma so uncommenting a single line is enough |
| `fix_profile_url_routing.nim` | [Multi-profile](#multiple-profiles) SSO: writes a per-profile auth marker before opening SSO URLs so the launcher can route the `claude://` callback to the profile that started the flow |
| `fix_profile_window_title.nim` | Appends the profile name to the window title (`Claude` → `Claude (work)`) so profiles are distinguishable in Alt-Tab/taskbar |
| `fix_quick_entry_cli_toggle.nim` | `claude-desktop --toggle`: toggles Quick Entry in ~5-25 ms via a Unix socket (per-profile path) instead of a ~300 ms Electron spawn - fast enough for a global hotkey |

### Linux compatibility

Upstream ships the same JS bundle to all platforms; these patches open `darwin`/`win32`-only gates for Linux, or fix behavior that only misfires in a Linux desktop environment. Always on and not user-configurable - each one is either a feature you would otherwise not have at all, or a bug you would otherwise hit.

| Patch | What it does & why it exists |
|-------|------------------------------|
| `enable_local_agent_mode.nim` | Enables Claude Code / Local Agent Mode on the host. Several feature checks in the shared bundle return `unavailable` unless `process.platform` is `darwin`/`win32`; this rewrites them to `supported`, marks the capabilities this package ships Linux backends for (Code, plugins, Computer Use) as supported in the feature merger, and turns the Code preference defaults on. Cowork VM support is **not** forced - it follows upstream's native KVM probe - and GrowthBook rollout flags are **not** forced (opt in via [`growthbookOverrides`](#feature-flag-overrides-advanced)). Embedded regression guards assert the app keeps reporting the real platform (`linux`) to claude.ai and that upstream's native Linux Cowork path stays present |
| `fix_app_quit.nim` | The app hung on exit: after the `will-quit` cleanup handler runs, a second `app.quit()` is a no-op on Linux - uses `app.exit(0)` instead |
| `fix_browse_files_linux.nim` | The file dialog offers `openDirectory` only on macOS upstream; adds Linux (Electron supports it natively) |
| `fix_browser_tools_linux.nim` | Enables Chrome browser tools: repoints the native-messaging host to Claude Code's wrapper, extends browser discovery beyond upstream's Chrome+Edge (Chromium, Brave, Vivaldi, Opera), and adds Linux branches for extension auto-install and the DevTools opener - both still macOS/Windows-only upstream |
| `fix_builtin_mcp_browser_env.nim` | Built-in MCP servers run with a filtered env of `HOME,LOGNAME,PATH,SHELL,TERM,USER` - no display variables, fine on macOS, but on Linux the server can't open a browser for OAuth. Adds `DISPLAY`/Wayland/XDG/DBUS/`BROWSER`/`KDE_SESSION_VERSION` (without the last, `xdg-open` on KDE no-ops silently via its `kfmclient` fallback) ([#139](https://github.com/patrickjaja/claude-desktop-extra/issues/139)) |
| `fix_builtin_mcp_open_url_handler.nim` | Parent side of the M365 OAuth browser-open delegation: adds an `open-url` branch (https-only, → `shell.openExternal`) to the built-in MCP host's child-message handler - the same mechanism remote OAuth connectors use ([#139](https://github.com/patrickjaja/claude-desktop-extra/issues/139)) |
| `fix_computer_use_linux.nim` | Enables Computer Use. Upstream gates it to macOS/Windows (platform set, executor factories, enable gate) and ships zero Linux input/screenshot backends. Removes the gates and injects a Linux executor backed by the four bundled first-party bridges (x11-bridge on X11/XWayland, wlroots-bridge on Sway/Hyprland/Niri, gnome-portal-bridge on GNOME Wayland, kwin-portal-bridge on KDE Wayland; ydotool only on exotic compositors) |
| `fix_computer_use_tcc.nim` | Stubs the macOS TCC permission IPC (accessibility / screen recording) with `not_applicable` answers - TCC has no Linux equivalent, and without handlers the renderer's permission checks throw "No handler registered" |
| `fix_cowork_firmware_paths_linux.nim` | The Cowork VM capability probe hardcodes Debian firmware/virtiofsd paths, so on other distros Cowork reports "Download failed" / "requires QEMU" even with QEMU installed. Adds Fedora/RHEL/Arch OVMF and Arch/NixOS virtiofsd locations plus `CLAUDE_OVMF_CODE_PATH`/`CLAUDE_VIRTIOFSD_PATH` overrides for non-FHS setups ([#177](https://github.com/patrickjaja/claude-desktop-extra/issues/177)) |
| `fix_cowork_font.nim` | claude.ai initializes the chat-font preference only when the Chat view mounts; applies it to the Cowork tab too (it fell back to Serif) |
| `fix_cross_device_rename.nim` | Adds an EXDEV copy+delete fallback to `fs.rename()`: downloads land in `/tmp` (usually a separate tmpfs) and are renamed into `~/.config`, which fails across filesystems |
| `fix_detected_projects_linux.nim` | Project detection is gated to macOS and the VS Code/Cursor/Zed state-DB paths are hardcoded macOS locations; opens the gate and adds the Linux paths |
| `fix_dock_bounce.nim` | Upstream focus/attention calls translate to `DEMANDS_ATTENTION` taskbar flashing on KDE/GNOME; suppresses them |
| `fix_epitaxy_autoscroll.nim` | The Code/Cowork transcript stops following a running response. claude.ai keeps it at the bottom by watching a 1px sentinel and sets `overflow-anchor: none`, so a **3px** drift - routine during streaming from sub-pixel layout, `scrollbar-gutter: stable`, font loading or `[contain:strict]` reflow - clears the pinned flag and it never re-pins; measured stranded at 1803px while output kept arriving. Attaches a tolerance-band stick-to-bottom to the main transcript and the floating side chat, released only on a deliberate scroll up |
| `fix_ion_dist_linux.nim` | The 3P config SPA's org-plugins mount path has only macOS/Windows entries; adds `/etc/claude-desktop/org-plugins` and a Linux display branch |
| `fix_marketplace_linux.nim` | Forces host-local mode for plugin operations on Linux and promotes `$HOME`-scoped CLI plugins to user scope ("Personal Plugins") |
| `fix_native_frame.nim` | Upstream builds the integrated titlebar only on Windows and gives Linux the native GTK frame; enables the integrated titlebar on Linux by default (opt out via `CLAUDE_NATIVE_TITLEBAR=1` / `--native-titlebar`) |
| `fix_office365_mcp_open_url.nim` | Child side: the bundled `office365-mcp` server posts `{type:"open-url"}` to the Electron parent instead of spawning `xdg-open`, which is unreliable inside the MCP child process on KDE (silent no-op → 300 s sign-in timeout) ([#139](https://github.com/patrickjaja/claude-desktop-extra/issues/139)) |
| `fix_open_in_editor_linux.nim` | "Open in VS Code / Cursor / Zed / Windsurf" gates on `getApplicationInfoForProtocol`, which answers only on macOS/Windows - Linux editors always showed as not installed. Answers it via an `xdg-mime` shim |
| `fix_process_argv_renderer.nim` | The preload exposes a `process` object without `argv`; the Claude Code SDK web bundle calls `process.argv.includes()`, and the TypeError blocked Dispatch responses from rendering. Injects an empty `argv` |
| `fix_quick_entry_app_id.nim` | Gives Quick Entry its own Wayland `app_id` (`claude-quick-entry`) so shell-extension rules can target it separately from the main window ([#39](https://github.com/patrickjaja/claude-desktop-extra/issues/39)) |
| `fix_quick_entry_position.nim` | [Quick Entry](#quick-entry) opens on the cursor's monitor instead of the primary display and auto-focuses the input; position/focus retries run only on X11 (Wayland doesn't reposition after `show()`) |
| `fix_quick_entry_ready_wayland.nim` | On native Wayland `ready-to-show` never fires for frameless transparent windows, hanging the popup - adds a 100 ms timeout |
| `fix_quick_entry_wayland_blur_guard.nim` | Wayland emits spurious blur events that dismissed Quick Entry immediately; blur-to-dismiss now only counts after the window was actually focused |
| `fix_renderer_gone_suppressed_log.nim` | Logs main-webview renderer deaths upstream silently suppresses - a kernel OOM SIGKILL arrives as reason `killed` and left no trace in `main.log` ([#128](https://github.com/patrickjaja/claude-desktop-extra/issues/128)) |
| `fix_sensitive_dirs_linux.nim` | The sandbox sensitive-directories block list has macOS and Windows entries but none for Linux; adds `.local/share/keyrings`, `.pki`, `.config/autostart` |
| `fix_startup_settings.nim` | Session-restore handling for "Start at login": hides the main window when the launch comes from session restore, and keeps autostart entries per-profile. The base XDG autostart toggle is native upstream (asserted by embedded guards) |
| `fix_tray_dbus.nim` | Serializes tray destroy/recreate (mutex + cleanup delay) - the DBus/StatusNotifier race left ghost tray icons - and drops the recreate-on-theme-change (the Linux tray icon is static) |
| `fix_tray_icon_theme.nim` | Always uses the light tray glyph (`TrayIconLinux-Dark.png`) on Linux: upstream's heuristic only does so on GNOME/dark themes, but Linux tray areas are dark regardless of desktop theme, leaving the icon invisible on light themes |
| `fix_updater_state_linux.nim` | Auto-update is off on Linux, so the updater idles without the `version` fields the frontend reads unchecked (TypeError); adds empty defaults |
| `fix_utility_process_kill.nim` | The post-timeout fallback kill re-sends SIGTERM instead of SIGKILL, so a stuck UtilityProcess survived and blocked exit; sends `SIGKILL` |
| `fix_window_bounds.nim` | Child-view geometry doesn't track window resize on Linux (stale bounds after maximize/snap/fullscreen); re-fits the content view, and blurs Quick Entry before hiding it |

Two active patches embed regression assertions alongside the work they inject: `enable_local_agent_mode.nim` (real-platform reporting to claude.ai, the native Linux Cowork bundle path, SSH MCP passthrough) and `fix_startup_settings.nim` (native XDG autostart read/write).

### Adding your own feature

Every feature on this page started as one `.nim` file. If Claude Desktop doesn't behave the way you need it to on your desktop, you can change that - and the change is small enough that you don't have to make it by hand: **spin up your favorite coding agent in a clone of this repo. The repo's [CLAUDE.md](CLAUDE.md) plus this section is enough context to add a patch end to end.**

Pick where it goes: `patches/community/` if users should be able to turn it off - it gets a switch in Settings → **Extra** → **Community Features** for the cost of one `renderToggleRow` spec, and the setting is persisted per profile in `<userData>/claude-desktop-extra.jsonc`/`.json`, so people change their mind without rebuilding anything. `patches/core/` if it is always-on infrastructure others build on, and `patches/linux/` if it is a compatibility fix that everyone needs and nobody should have to find. The five steps below cover the community case; drop steps 2 and 3 for the other two. `add_feature_panel_tabs.nim` and its `js/panel_tabs_*.js` modules are the reference implementation to copy from.

1. **Write the patch.** Create `patches/community/<name>.nim` with the usual `# @patch-target:` and `# @patch-type: nim` headers. Match minified code with `[\w$]+` wildcards and capture/replace rather than hardcoded names, and keep the real logic in a `js/` file embedded with `staticRead("../../js/<name>_main.js")` so it stays readable and testable. Every sub-patch must fail loud and the "already patched" branch must assert your own injected result is present - see the patch strictness rules in [CLAUDE.md](CLAUDE.md#5b-patch-strictness-rules). If the patch embeds any `js/` file, add a prerequisite line for it in `patches/Makefile`, otherwise editing the JS will not rebuild the binary.
2. **Give it one config key.** Pick a single top-level key in `<userData>/claude-desktop-extra.jsonc` (hand-owned, wins) / `.json` (written by the UI), named after the feature - `panelTabs`, `diffViewModes`, `coworkGlow`, `themePicker`. Read it leniently at runtime: a missing key means the default, a hand-set key in the `.jsonc` locks the switch. `PREF_KEY` in [`js/panel_tabs_main.js`](js/panel_tabs_main.js) is the reference reader.
3. **Add the switch.** Three small pieces: an IPC read/set handler pair in your own patch (`cdb-tabs:pref-read` / `cdb-tabs:pref-set` is the pattern), two wrapper methods in [`js/extra_settings_bridge.js`](js/extra_settings_bridge.js), and one `renderToggleRow` spec in the Community Features panel of [`js/extra_settings_page.js`](js/extra_settings_page.js). The row handles the locked-by-`.jsonc` state and the restart notice for you.
4. **Register it.** Bump `EXPECTED_PATCH_COUNT` in `scripts/apply_patches.py` - the orchestrator refuses to run if discovery and that number disagree.
5. **Document it.** Add a row to the Community features table above stating what the patch does and why it exists, and a `CHANGELOG.md` entry.

## Command-line flags

Flags this project adds on top of the official build (run `claude-desktop --help` for the full list). All are optional; without any, `claude-desktop` just launches the default profile.

| Flag | Description |
|------|-------------|
| `--profile=NAME` | Launch (or target a subcommand at) a named [profile](#multiple-profiles). Also selectable via a `claude-desktop-NAME` shortcut or `CLAUDE_PROFILE=NAME` |
| `--create-profile=NAME` | Create a [profile](#multiple-profiles) (user-local binary, launcher, and menu entry; own login/logs/config) |
| `--delete-profile=NAME` | Remove a profile's entry points (user data preserved) |
| `--list-profiles` | List installed profiles |
| `--toggle` | Toggle the [Quick Entry](#quick-entry) overlay (bind to a global shortcut) |
| `--install-gnome-hotkey [ACCEL]` | Bind the Quick Entry hotkey on GNOME, where the portal doesn't (default `Ctrl+Alt+Space`); `--uninstall-gnome-hotkey` removes it |
| `--1p` / `--3p` | Select personal claude.ai (1P) vs [third-party inference](docs/third-party-inference.md) (3P) mode by persisting the upstream `deploymentMode` key; replaces the removed upstream `--boot-1p-once` flag. The same switch is in the app under Settings → **Extra** → **Deployment**. See [switching back to 1P](docs/third-party-inference.md#common-gotchas) |
| `--native-titlebar` | Use the native window frame instead of the integrated titlebar (same as `CLAUDE_NATIVE_TITLEBAR=1`) |
| `--no-systemd-scope` | Skip the `systemd --user --scope` wrapper for this launch (same as `CLAUDE_DISABLE_SYSTEMD_SCOPE=1`) |
| `--diagnose` | Print session type, portal status, and hotkey state for issue reports |
| `--integrate` / `--unintegrate` | Register / remove the `claude://` handler and menu entry (AppImage only; happens automatically on launch) |

## Environment Variables

`claude-desktop` reads a handful of env vars at launch (all optional). The ones people reach for most:

| Variable | Values | Description |
|----------|--------|-------------|
| `CLAUDE_DISABLE_GPU` | `1`, `full` | Fix white screen on some GPU/driver combos ([#13](https://github.com/patrickjaja/claude-desktop-extra/issues/13)). `1` disables compositing only, `full` disables GPU entirely |
| `CLAUDE_PROFILE` | name | Select a [profile](#multiple-profiles) by name (also `claude-desktop-NAME` / `--profile=NAME`) |
| `CLAUDE_NATIVE_TITLEBAR` | `1` | Restore the native window frame instead of the integrated titlebar (same as `--native-titlebar`) |
| `CLAUDE_USE_XWAYLAND` | `1` | Force XWayland instead of native Wayland. Also fixes "app exits after seconds" GPU crashes ([#180](https://github.com/patrickjaja/claude-desktop-extra/issues/180), see [wayland.md](wayland.md)) |
| `CLAUDE_PASSWORD_STORE` | backend, `auto` | Force the Chromium keyring backend (`gnome-libsecret`, `kwallet6`, `basic`, ...). Default: on desktops Chromium gives no keyring backend (Hyprland, sway, XFCE, ...), a running Secret Service is used automatically so sign-in persists ([#191](https://github.com/patrickjaja/claude-desktop-extra/issues/191)). `auto` disables that detection |
| `CLAUDE_KEEP_TTY` | `1` | Keep the controlling terminal instead of calling `setsid` when launched as a background job on one. Only affects `startx`/`xinit` sessions, where a panel or menu launch would otherwise let the app's `bash -l -i -c` environment probe `SIGTTIN` the whole desktop process group ([#213](https://github.com/patrickjaja/claude-desktop-extra/pull/213)) |

Set permanently in `~/.bashrc` / `~/.zshrc`, or pass per-launch: `CLAUDE_DISABLE_GPU=1 claude-desktop`

**Full list** (profile/config dirs, Vulkan, menu bar, DevTools, systemd-scope, Electron overrides, …) → **[docs/environment-variables.md](docs/environment-variables.md)**.

## Feature Flag Overrides (advanced)

Claude Desktop gates many features behind server-side GrowthBook flags with no built-in local override. This package adds one: **`~/.config/Claude/claude-desktop-extra.jsonc`** (per-profile: the profile's userData dir; auto-created with a commented template on first launch). It is the same config file the [Custom Themes](#custom-themes) use - one file for both. Config files from the previous package name (`claude-desktop-bin.jsonc`, legacy `claude-desktop-bin.json`) are picked up automatically - the file is migrated to the new name on first launch, nothing to do. Uncomment an entry to activate it - comments are allowed:

```jsonc
{
  "growthbookOverrides": {
    "1129419822": true   // ENABLE_TOOL_SEARCH - tool search in local agent sessions
  }
}
```

The file is re-read on every flag load (startup and each periodic refresh) and overrides win over the server rollout; active overrides are logged to `logs/claude-patches.log`. `true`/`false` for switches, numbers/strings/objects for value flags. Most gated features are wired up while the app starts, so restart after changing a flag.

**Full flag catalog:** the auto-created template lists *every* GrowthBook flag the app reads from its feature store, each commented out with a short description - browse it here: **[docs/claude-desktop-extra.jsonc](docs/claude-desktop-extra.jsonc)**. It reflects the version noted in the file header; CI verifies it stays in sync with the shipped template.

**Or flip them in the app:** Settings → **Extra** → **Anthropic Features** renders the same catalog - all 134 flags - as switches, pre-set to what your account actually gets, and writes your changes to `growthbookOverrides` in `claude-desktop-extra.json` (it offers a Restart now button, for the reason above). Value-carrying flags are shown read-only, and a flag you set by hand in the `.jsonc` stays owned by that file - hand edits win per flag ID and the panel will not overwrite them.

**Scope and caveats:** flag IDs are Anthropic-internal and can vanish or change meaning in any release; this is unsupported expert territory - if the app misbehaves, empty the file first. The Computer Use patch forces its own enable gate directly and doesn't consult this file, and server-side account capabilities can't be overridden locally at all. Hardware Buddy (`2358734848`) is force-enabled on Linux through this same store-override mechanism, so a `"2358734848": false` entry here opts back out.

## Debugging

Runtime logs are in `~/.config/Claude/logs/` (`main.log`, `claude.ai-web.log`, `mcp.log`). With a 3P `managed-settings.json` present, logs are under `~/.config/Claude-3p/`; named profiles use `~/.config/Claude-<profile>/`.

```bash
# Tail logs in real-time
tail -f ~/.config/Claude/logs/main.log

# Search for errors across all logs
grep -ri 'error\|exception\|fatal' ~/.config/Claude/logs/

# Launch with DevTools + full logging
CLAUDE_DEV_TOOLS=detach ELECTRON_ENABLE_LOGGING=1 claude-desktop 2>&1 | tee /tmp/claude-debug.log
```

**Clear stale Cowork sessions** (stuck "setting up workspace", or the model replaying old errors):
```bash
rm -rf ~/.config/Claude/local-agent-mode-sessions/
```

Computer Use patches emit `[claude-cu] diagnostics:` lines showing the detected session, available/missing tools, and screenshot cascade. They land in `~/.config/Claude/logs/claude-patches.log` (and on stderr when launched from a terminal) - share that log file when reporting Computer Use issues. The official build discards plain `console.log` output, so the old "run from a terminal and copy the output" advice only shows Chromium noise.

`claude-desktop --diagnose` additionally prints a **Computer Use** section: the installed package version, bundled-bridge presence, and on KDE Wayland the KWin 6.6-gate verdict plus a portal-free `windows` self-test through the kwin-portal-bridge (no consent dialog; window titles are never printed). Attach that output together with `claude-patches.log` - the pair makes most Computer Use reports diagnosable without follow-up questions.

## Known Limitations

- **App identity on Wayland.** `xdg-desktop-portal` resolves unsandboxed apps via the systemd user scope. We launch under `app-com.anthropic.Claude-*.scope` and install the `.desktop` as `com.anthropic.Claude.desktop` - the same reverse-DNS identity the official build uses, and the value Chromium derives the window `app_id` / `WM_CLASS` from - so scope, `app_id`, `StartupWMClass`, and `.desktop` basename all agree. KDE global shortcuts and persistent portal authorizations (screen share / Computer Use consent) attach to that id and survive across sessions.
  - Pinned taskbar/dock shortcuts from an earlier release (`claude-desktop.desktop` or older names) orphan on upgrade - **re-pin once**.
  - Custom X11/Wayland WM rules matching `claude-desktop` (or older `claude` / `com.anthropic.claude-desktop`) need updating to `com.anthropic.Claude`. The window `app_id` is shared across named profiles.
  - KDE screen-share / Computer Use consent granted before the rename is keyed to the old id - re-grant once; it persists from then on.
  - GNOME shell-extension blacklists (Rounded Window Corners, Unite, Blur My Shell) referencing `com.anthropic.claude-quick-entry` should become `claude-quick-entry`.
  - **NixOS** doesn't use `systemd-run --scope`; portal identity may not resolve on GNOME Wayland - use `--install-gnome-hotkey`.
  - **Sandboxes/containers** without a reachable user-systemd (bwrap, distrobox, restricted Flatpaks) auto-skip the scope wrap; force it with `--no-systemd-scope` / `CLAUDE_DISABLE_SYSTEMD_SCOPE=1` if the socket exists but is unreachable ([#89](https://github.com/patrickjaja/claude-desktop-extra/issues/89)).
- **Computer Use targets the primary monitor** - screenshots/clicks can be retargeted with `switch_display`; the teach overlay stays on the primary display. See [Computer Use](#computer-use).
- **CoworkSpaces are local-only** on every platform (no account-sync) - a set created on macOS/Windows won't transfer to Linux. Upstream behavior.

## Automation

CI polls the official apt Packages index every 2 hours, downloads the latest official `.deb` (verifying GPG + SHA256), extracts and patches its `app.asar`, and **validates every patch in Docker** (`makepkg` in `archlinux:base-devel`) before publishing. Each patch exits 1 if its pattern doesn't match, so a broken package never reaches users - the pipeline stops with a clear `[FAIL]` and the published repositories stay on the last-good version until patches are updated.

## Repository Structure

- `.github/workflows/` - GitHub Actions automation (ingest, patch, validate, publish)
- `scripts/` - build, validation, and launcher scripts
- `patches/` - Nim patch sources + Makefile (compiled to native binaries), grouped into `linux/` (Linux compatibility), `community/` (opt-in features) and `core/` (always-on infrastructure)
- `js/` - shared JS snippets embedded by the patches
- `packaging/` - Debian, RPM, AppImage, and Nix build scripts
- `baseline/` - version-sensitive reference docs re-validated each release
- `PKGBUILD.template` - pacman package template

## See Also

- [tweakcc](https://github.com/Piebald-AI/tweakcc) - a CLI tool for customizing Claude Code (system prompts, themes, UI). Same patching-JS-to-make-it-yours energy. Thanks to the Piebald team.

## Legal Notice

> This is an **unofficial community project** for educational and research purposes.
> Claude Desktop is proprietary software owned by **Anthropic PBC**.
>
> This repository contains only build scripts and patches - not the Claude Desktop
> application itself. The upstream binary is downloaded directly from Anthropic
> during the build process.
>
> This project is not affiliated with, endorsed by, or sponsored by Anthropic.
> "Claude" is a trademark of Anthropic PBC.

---

<p align="center"><sub>Built with ❤️ for the Linux community</sub></p>
