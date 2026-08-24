/* __cdb_startup_gate_v2__
   Session-restore detection for upstream's show-at-launch gate.

   Inlined by patches/linux/fix_startup_settings.nim (P3) into
       Omr ??= !( argv.includes("--startup") || process.platform === "linux" && <this> )
   so a `true` here means "treat this launch like --startup", i.e. create the
   main window hidden.

   gnome-session (and Plasma's session manager) re-launch saved clients after a
   reboot WITHOUT passing --startup, so a user who asked for a hidden start got
   the window anyway on every login. There is no env var that marks such a
   launch, hence the heuristic.

   TWO conditions must BOTH hold. Requiring the first is what keeps an ordinary
   launch visible:

     1. The user actually asked for a hidden start - an ENABLED XDG autostart
        entry exists. Someone with autostart switched off has never asked for a
        hidden window, so no launch of theirs may be silently suppressed. (This
        condition is the fix for issue #233: clicking the launcher icon shortly
        after logging in produced a hidden window with born_hidden_reason
        'os_login', a tray icon and no way in short of clicking a second time.)

     2. The graphical session started less than 60s ago.

   FAIL-SAFE DIRECTION IS ALWAYS "SHOW THE WINDOW". Every error path, missing
   file and unreadable socket returns false. Hiding a window the user asked for
   is invisible and hard to report; showing one that could have stayed hidden is
   a minor annoyance.

   Linux compatibility notes:
     - Wayland: the compositor socket is created at graphical login even when
       systemd lingering is on (unlike /run/user/UID/bus, which then survives
       from boot). X11 falls back to the bus socket. Neither mtime advances with
       use, so it marks session start. A mid-session compositor or dbus restart
       recreates the socket and legitimately re-opens the window.
     - WAYLAND_DISPLAY may be an absolute path (the spec allows it), so it is
       only joined against /run/user/UID when it is relative.
     - The autostart entry is read from (XDG_CONFIG_HOME||~/.config)/autostart,
       matching upstream's own reader. It is deliberately NOT userData-based:
       the XDG autostart location is identical in 1p and 3p deployments. It is
       still profile-aware, because each profile runs its own Electron binary
       and the filename derives from basename(process.execPath).
     - No Electron API is touched, so this stays safe wherever the gate is
       evaluated, and it works the same on every distro and session type.
*/
(() => {
  let suppress = false;
  let why = "";
  try {
    const p = require("path");
    const f = require("fs");

    /* 1. Has the user asked for a hidden start? */
    const home = process.env.HOME || require("os").homedir();
    const cfg = process.env.XDG_CONFIG_HOME || p.join(home, ".config");
    const entry = p.join(
      cfg,
      "autostart",
      p.basename(process.execPath) + ".desktop"
    );
    let txt = null;
    try {
      txt = f.readFileSync(entry, "utf8");
    } catch (e) {
      txt = null;
    }
    if (txt === null) {
      why = "no autostart entry (" + entry + ") - never suppress";
    } else if (
      txt.split("\n").some((line) => {
        const s = line.trim();
        return (
          /^Hidden\s*=\s*true$/i.test(s) ||
          /^X-GNOME-Autostart-enabled\s*=\s*false$/i.test(s)
        );
      })
    ) {
      why = "autostart entry disabled - never suppress";
    } else {
      /* 2. Did the graphical session just start? */
      const uid = String(process.getuid());
      const wd = process.env.WAYLAND_DISPLAY;
      const sock = wd
        ? wd.charAt(0) === "/"
          ? wd
          : p.join("/run/user", uid, wd)
        : p.join("/run/user", uid, "bus");
      const age = Date.now() - f.statSync(sock).mtimeMs;
      suppress = age < 60000;
      why =
        "autostart enabled, " + sock + " age " + Math.round(age / 1000) + "s";
    }
  } catch (e) {
    suppress = false;
    why = "probe failed (" + (e && e.message) + ") - never suppress";
  }
  try {
    const d = globalThis.__cdbDiag;
    if (typeof d === "function")
      d("[startup-gate] session-restore suppression=" + suppress + ": " + why);
  } catch (e) {}
  return suppress;
})()
