#!/usr/bin/env node
// The show-at-launch gate must never hide a window the user did not ask to hide
// (issue #233).
//
// WHY THIS EXISTS
// ---------------
// gnome-session and Plasma re-launch saved clients after a reboot WITHOUT
// passing --startup, so a user with "start in system tray" enabled got the main
// window on every login. The fix widened upstream's argv check with a
// heuristic: if the graphical session started less than 60s ago, treat the
// launch as a session restore and keep the window hidden.
//
// That heuristic had no notion of whether the user wanted a hidden start at
// all. So clicking the launcher icon within a minute of logging in - the most
// ordinary thing a person does after a reboot - created the main window with
// show:false. The reporter saw a tray icon, no window, and needed a second
// click (which takes the already-running activation path) to get in.
//
// js/startup_session_restore_gate.js now requires BOTH conditions:
//
//   1. an ENABLED XDG autostart entry exists - i.e. the user actually asked for
//      a hidden start. This is the condition that fixes #233.
//   2. the graphical session started under 60s ago.
//
// and fails safe towards SHOWING the window on every error path, because a
// window that is wrongly hidden is invisible and hard to report, while one that
// is wrongly shown is a minor annoyance.
//
// This harness pins that truth table against the real gate source, evaluated
// with process/require shimmed so the socket age, the autostart entry and the
// session type can all be controlled.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const gateSrc = readFileSync(
  join(repo, "js", "startup_session_restore_gate.js"),
  "utf8"
);

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${actual}`);
    pass++;
  } else {
    console.log(`  FAIL ${label} -> got ${actual}, expected ${expected}`);
    failures.push(label);
  }
}

const scratch = join(tmpdir(), `cdb-startup-gate-${process.pid}`);
const EXEC = "/usr/lib/claude-desktop/claude";
const ENTRY_NAME = basename(EXEC) + ".desktop";

// Write an autostart entry into <home>/.config/autostart (or an explicit
// XDG_CONFIG_HOME) and return that home dir.
function makeHome(entryBody, { xdgConfigHome = null } = {}) {
  const home = join(scratch, `home-${Math.random().toString(36).slice(2)}`);
  const cfg = xdgConfigHome || join(home, ".config");
  if (entryBody !== null) {
    mkdirSync(join(cfg, "autostart"), { recursive: true });
    writeFileSync(join(cfg, "autostart", ENTRY_NAME), entryBody);
  } else {
    mkdirSync(home, { recursive: true });
  }
  return { home, cfg };
}

const ENABLED_ENTRY = [
  "[Desktop Entry]",
  "Type=Application",
  "Name=Claude",
  `Exec="${EXEC}" --startup`,
  "X-GNOME-Autostart-enabled=true",
  "",
].join("\n");

// Evaluate the real gate with process/require shimmed.
function runGate({ env, socketAgeMs, socketPath, execPath = EXEC }) {
  const diagLines = [];
  const fsShim = {
    readFileSync,
    statSync(p) {
      if (socketPath !== null && p === socketPath) {
        if (socketAgeMs === null) {
          const e = new Error("ENOENT");
          e.code = "ENOENT";
          throw e;
        }
        return { mtimeMs: Date.now() - socketAgeMs };
      }
      const e = new Error("ENOENT: " + p);
      e.code = "ENOENT";
      throw e;
    },
  };
  const requireShim = (name) => {
    if (name === "path") return path;
    if (name === "fs") return fsShim;
    if (name === "os") return { homedir: () => env.HOME };
    throw new Error("unexpected require: " + name);
  };
  const processShim = {
    env,
    execPath,
    platform: "linux",
    getuid: () => 1000,
  };
  const globalShim = {
    __cdbDiag: (s) => diagLines.push(s),
  };
  const fn = new Function(
    "require",
    "process",
    "globalThis",
    `return (${gateSrc});`
  );
  return { result: fn(requireShim, processShim, globalShim), diagLines };
}

try {
  mkdirSync(scratch, { recursive: true });

  console.log(
    "\n[1] a user who never asked for a hidden start is NEVER suppressed"
  );
  {
    const { home } = makeHome(null);
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 1000, // session literally just started
      socketPath: "/run/user/1000/wayland-0",
    });
    check("no autostart entry, socket 1s old (issue #233)", result, false);
  }
  {
    const { home } = makeHome(
      ENABLED_ENTRY.replace(
        "X-GNOME-Autostart-enabled=true",
        "X-GNOME-Autostart-enabled=false"
      )
    );
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 1000,
      socketPath: "/run/user/1000/wayland-0",
    });
    check("entry with X-GNOME-Autostart-enabled=false", result, false);
  }
  {
    const { home } = makeHome(ENABLED_ENTRY + "Hidden=true\n");
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 1000,
      socketPath: "/run/user/1000/wayland-0",
    });
    check("entry with Hidden=true", result, false);
  }

  console.log(
    "\n[2] a user who DID ask for a hidden start keeps session-restore suppression"
  );
  {
    const { home } = makeHome(ENABLED_ENTRY);
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 5000,
      socketPath: "/run/user/1000/wayland-0",
    });
    check("enabled entry + session 5s old (PR #67 case)", result, true);
  }
  {
    const { home } = makeHome(ENABLED_ENTRY);
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 120000,
      socketPath: "/run/user/1000/wayland-0",
    });
    check("enabled entry + session 120s old", result, false);
  }

  console.log("\n[3] session types and path handling");
  {
    const { home } = makeHome(ENABLED_ENTRY);
    const { result } = runGate({
      env: { HOME: home }, // no WAYLAND_DISPLAY -> X11
      socketAgeMs: 5000,
      socketPath: "/run/user/1000/bus",
    });
    check("X11 falls back to the session bus socket", result, true);
  }
  {
    const { home } = makeHome(ENABLED_ENTRY);
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "/run/user/1000/wl-abs" },
      socketAgeMs: 5000,
      socketPath: "/run/user/1000/wl-abs",
    });
    check("absolute WAYLAND_DISPLAY is used as-is", result, true);
  }
  {
    const xdg = join(scratch, "xdgconf");
    const { home } = makeHome(ENABLED_ENTRY, { xdgConfigHome: xdg });
    const { result } = runGate({
      env: { HOME: home, XDG_CONFIG_HOME: xdg, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 5000,
      socketPath: "/run/user/1000/wayland-0",
    });
    check("XDG_CONFIG_HOME is honoured", result, true);
  }

  console.log("\n[4] fail-safe direction is always 'show the window'");
  {
    const { home } = makeHome(ENABLED_ENTRY);
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: null, // socket missing (no /run/user, exotic setup)
      socketPath: "/run/user/1000/wayland-0",
    });
    check("unreadable compositor socket", result, false);
  }

  console.log("\n[5] the decision is recorded for issue reports");
  {
    const { home } = makeHome(ENABLED_ENTRY);
    const { diagLines } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 5000,
      socketPath: "/run/user/1000/wayland-0",
    });
    check(
      "a [startup-gate] line is emitted",
      diagLines.length === 1 && diagLines[0].startsWith("[startup-gate] "),
      true
    );
  }

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("ALL " + pass + " CHECKS PASSED");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
