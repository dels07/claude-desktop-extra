# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# "Start at login" / "Start in system tray" on Linux.
#
# History (three layers, all targeting the Windows MSIX):
#   1. isStartupOnLoginEnabled() called Electron getLoginItemSettings() (returns
#      undefined on Linux) -> Settings toggle always showed disabled.
#   2. setStartupOnLoginEnabled() used Electron setLoginItemSettings() which on
#      Linux does NOT add --startup to the Exec line -> main window always shown.
#   3. GNOME session restore re-launches saved apps WITHOUT --startup -> the main
#      window pops up after every reboot.
# We used to patch all three (anchor: the env-var short-circuit
# CLAUDE_AVOID_READING_LOGING_ITEM_SETTINGS, and the "Toggling" debug log).
#
# The official Linux .deb UPSTREAMED layers 1 and 2 natively:
#   - read:  function ico(){...exists(zmA())...readFile(zmA())...!rco(...)}  reads
#            the XDG autostart .desktop and parses Hidden / X-GNOME-Autostart-enabled.
#   - write: function nco(A){...} writes/removes it, building the file with
#            function tco(){return["[Desktop Entry]","Type=Application",
#              `Name=${app.getName()}`,`Exec=${eco(process.execPath)} --startup`,
#              "X-GNOME-Autostart-enabled=true",""].join(...)}
#   - dir:   J6A() = (XDG_CONFIG_HOME||~/.config)/autostart
#   - file:  zmA() = `${basename(process.execPath)}.desktop`  (profile-aware: our
#            per-profile Electron binary has a distinct basename, so each profile
#            manages its own autostart entry — same outcome our old patch hand-rolled)
#   - setStartupOnLoginEnabled(A){...nco(A).catch(...)"Failed to update XDG autostart entry"}
# The Exec line already carries --startup, so an autostart launch hides the window.
#
# Layer 3 was NOT upstreamed: the window-show gate is purely
#   wco=!<proc>.argv.includes("--startup")
# and the whole bundle has ZERO /run/user and ZERO gnome-session references. A
# GNOME session-restore relaunch (no --startup) therefore still shows the window.
#
# So per AGENTS.md Rule 6:
#   - P1 (read) + P2 (write): convert to REGRESSION GUARDS that positively assert
#     the native XDG autostart read/write end-state is present (FAIL loud if a
#     future bump removes it — that would silently break the Settings toggle and
#     re-introduce the always-visible-window bug).
#   - P3 (session-restore detection): ACTIVE patch — widen the single
#     argv.includes("--startup") gate with js/startup_session_restore_gate.js,
#     which suppresses ONLY when an enabled XDG autostart entry exists AND the
#     graphical session started under 60s ago. Requiring the autostart entry is
#     what keeps an ordinary launch visible (issue #233).
#   - P4 (autostart Exec): ACTIVE patch — build the entry from CLAUDE_LAUNCHER so
#     a login launch goes through our launcher rather than the bundled Electron.

import std/[os, strutils]
import regex

# The session-restore predicate lives in js/ so it is reviewable, syntax-checked
# and unit-tested (scripts/tests/linux/test-startup-gate.mjs). It is a bare JS
# expression, inlined verbatim into upstream's show-at-launch gate. Comments in
# it are /* */ only - a // comment would swallow the minified code that follows
# it on the same line.
const GATE_JS = staticRead("../../js/startup_session_restore_gate.js")
const GATE_MARKER = "__cdb_startup_gate_v2__"

proc apply*(input: string): string =
  var patchesApplied = 0
  const expectedPatches = 4

  # ── P1 (guard): native XDG autostart READ ────────────────────────────────
  # isStartupOnLoginEnabled now delegates to a read helper, and the autostart dir
  # resolver + filename builder are the positive proof that Linux reads the real
  # XDG autostart .desktop (not Electron's broken getLoginItemSettings()).
  var m1: RegexMatch2
  let readDelegates =
    input.find(re2"""isStartupOnLoginEnabled\(\)\{return [\w$]+\(\)\}""", m1)
  # v1.26832.0: node builtins are reached through namespace aliases
  # (I.default.join / dt.default.homedir) and string literals became
  # backticks, so allow member chains and either quoting.
  let autostartDir = input.find(
    re2"""XDG_CONFIG_HOME\|\|[\w$]+(?:\.[\w$]+)*\.join\([\w$]+(?:\.[\w$]+)*\.homedir\(\),["`]\.config["`]\);return [\w$]+(?:\.[\w$]+)*\.join\([\w$]+,["`]autostart["`]\)""",
    m1,
  )
  let autostartFile = input.find(
    re2"""return`\$\{[\w$]+(?:\.[\w$]+)*\.basename\(process\.execPath\)\}\.desktop`""",
    m1,
  )
  if readDelegates and autostartDir and autostartFile:
    echo "  [OK] isStartupOnLoginEnabled reads XDG autostart natively " &
      "((XDG_CONFIG_HOME||~/.config)/autostart, basename(execPath).desktop) — guard satisfied"
    patchesApplied += 1
  else:
    echo "  [FAIL] Native XDG autostart READ path missing (delegate=" & $readDelegates &
      " dir=" & $autostartDir & " file=" & $autostartFile & ")"
    echo "         Upstream may have regressed startup-on-login; re-audit fix_startup_settings P1."

  # ── P2 (guard): native XDG autostart WRITE (with --startup) ───────────────
  # The .desktop builder must still emit BOTH the `--startup` flag (so autostart
  # launches hide the window) and X-GNOME-Autostart-enabled. The write helper's
  # error log is the second positive anchor.
  var m2: RegexMatch2
  let desktopBuilder = input.find(
    re2"""\[Desktop Entry\]["`],["`]Type=Application["`],["`]Name=\$\{[\w$]+\.app\.getName\(\)\}["`],["`]Exec=\$\{.*?\} --startup["`],["`]X-GNOME-Autostart-enabled=true["`]""",
    m2,
  )
  let writeErrLog = "Failed to update XDG autostart entry" in input
  if desktopBuilder and writeErrLog:
    echo "  [OK] setStartupOnLoginEnabled writes XDG autostart natively " &
      "(Exec=… --startup, X-GNOME-Autostart-enabled=true) — guard satisfied"
    patchesApplied += 1
  else:
    echo "  [FAIL] Native XDG autostart WRITE path missing (builder=" & $desktopBuilder &
      " errlog=" & $writeErrLog & ")"
    echo "         If the --startup flag or X-GNOME-Autostart-enabled disappeared, the"
    echo "         autostart window-hide / toggle would break; re-audit fix_startup_settings P2."

  # ── P3 (active patch): session-restore detection ─────────────────────────
  # Upstream's only gate is `<proc>.argv.includes("--startup")`, and
  # gnome-session / Plasma re-launch saved clients after a reboot WITHOUT that
  # flag, so a user who asked for a hidden start got the window on every login.
  # We widen the gate with the predicate in js/startup_session_restore_gate.js,
  # which suppresses only when an ENABLED XDG autostart entry exists AND the
  # graphical session started under 60s ago. Requiring the autostart entry is
  # what keeps an ordinary launch visible: without it, clicking the launcher
  # icon shortly after login produced a hidden window (issue #233).
  # Idempotency: positively assert OUR injected marker is present.
  if GATE_MARKER in input:
    echo "  [INFO] session-restore detection: already patched (" & GATE_MARKER & ")"
    patchesApplied += 1
  elif "_b.mtimeMs" in input:
    # The superseded v1 predicate suppressed on the socket mtime alone. Never
    # treat it as "already patched" - that would silently ship the #233 bug.
    echo "  [FAIL] input carries the superseded v1 session-restore predicate"
    echo "         (_b.mtimeMs). Re-extract a clean bundle."
  else:
    # v1.26832.0: `--startup` is a template literal and process is reached via a
    # namespace alias (L.default.argv), so accept either quoting and member chains.
    let pattern3 = re2"""([\w$]+(?:\.[\w$]+)*)\.argv\.includes\(["`]--startup["`]\)"""
    var count3 = 0
    result = input.replace(
      pattern3,
      proc(m: RegexMatch2, s: string): string =
        inc count3
        let processVar = s[m.group(0)]
        # The result MUST be parenthesized: upstream negates this expression
        # (`showWindow ??= !<proc>.argv.includes("--startup")`) and `!` binds
        # tighter than `||`. Without the parens the injected heuristic would
        # read `(!includes)||restore` and *show* the window on session restore
        # - the exact opposite of what this patch is for.
        "(" & processVar &
          ".argv.includes(\"--startup\")||process.platform===\"linux\"&&" &
          GATE_JS.strip() & ")",
    )
    if count3 == 1:
      echo "  [OK] session-restore detection: augmented argv --startup gate (1 match)"
      patchesApplied += 1
    elif count3 == 0:
      echo "  [FAIL] session-restore: argv.includes(\"--startup\") gate not found"
    else:
      echo "  [FAIL] session-restore: expected 1 argv --startup site, found " & $count3 &
        " - re-audit (the window-show gate may have changed shape)"
  if result.len == 0:
    result = input

  # ── P4 (active patch): autostart entry must point at OUR launcher ─────────
  # Upstream builds the XDG autostart entry as
  #   `Exec=${<shellQuote>(process.execPath)} --startup`
  # i.e. the BUNDLED ELECTRON BINARY (/usr/lib/claude-desktop/claude), not our
  # launcher (/usr/bin/claude-desktop). A login launch would therefore start with
  # none of the launcher's setup: no --ozone-platform=wayland (so on a Wayland
  # session the autostarted instance comes up under XWayland while a later manual
  # launch is native Wayland - two windowing regimes against one instance lock),
  # no --enable-features=UseOzonePlatform,GlobalShortcutsPortal, no PATH repair
  # (Cowork cannot find qemu), no --password-store, no systemd scope (the portal
  # identity that persists Computer Use grants), and for a named profile no
  # --user-data-dir - so the autostarted instance would silently share the
  # DEFAULT profile's userData.
  #
  # The launcher exports CLAUDE_LAUNCHER (its own resolved path, or the AppImage
  # path), so Exec points back at it, and --profile=<name> is re-added from
  # CLAUDE_PROFILE. Falls back to upstream's process.execPath when the env var is
  # absent (someone ran the Electron binary directly).
  # Idempotency: positively assert OUR injected CLAUDE_LAUNCHER read is present.
  if "CLAUDE_LAUNCHER" in result:
    echo "  [INFO] autostart Exec already points at the launcher (idempotent)"
    patchesApplied += 1
  else:
    let pattern4 = re2"""(Exec=\$\{)([\w$]+)(\(process\.execPath\)\} --startup)"""
    var count4 = 0
    result = result.replace(
      pattern4,
      proc(m: RegexMatch2, s: string): string =
        inc count4
        let shellQuote = s[m.group(1)]
        s[m.group(0)] & shellQuote & "(process.env.CLAUDE_LAUNCHER||process.execPath)}" &
          "${process.env.CLAUDE_PROFILE?\" --profile=\"+" &
          "process.env.CLAUDE_PROFILE.replace(/[^A-Za-z0-9._-]/g,\"\"):\"\"}" &
          " --startup",
    )
    if count4 == 1:
      echo "  [OK] autostart Exec now points at the launcher (1 match)"
      patchesApplied += 1
    elif count4 == 0:
      echo "  [FAIL] autostart .desktop Exec builder not found (re-audit P4)"
    else:
      echo "  [FAIL] expected 1 autostart Exec site, found " & $count4

  if patchesApplied < expectedPatches:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $expectedPatches & " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_startup_settings <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_startup_settings ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Startup settings: native XDG autostart confirmed + session-restore detection injected"
  else:
    echo "  [PASS] Startup settings: native XDG autostart confirmed (session-restore already patched)"
