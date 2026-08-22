#!/usr/bin/env node
// Computer Use on GNOME Wayland: the main process must never be frozen by a
// hung gnome-portal-bridge (issue #232).
//
// WHY THIS EXISTS
// ---------------
// A reporter on Ubuntu 26.04 / GNOME Wayland hit a bridge that answered nothing.
// Every bridge call on the screenshot and input paths was a BLOCKING
// execFileSync, so one Computer Use action stacked
//   screens 15 s + session-start 30 s + zoom 30 s + x11-bridge zoom 15 s
// of hard main-thread block, and because a failed session-start left no memo the
// NEXT action paid the same bill again. The OS showed "Not Responding".
//
// Three properties keep that from coming back, and this harness pins all three
// against the real js/cu_linux_executor.js (loaded with child_process, fs, os
// and electron stubbed):
//
//   1. THE SCREENSHOT PATH IS ASYNC END TO END. A screenshot on a covered
//      Wayland session must not reach execFileSync/execSync/spawnSync ONCE.
//   2. A FAILED PORTAL SESSION IS LATCHED. After session-start fails, further
//      portal commands fail fast (no spawn at all) until the cooldown lapses;
//      a fresh CU lock clears the latch and retries for real.
//   3. NO x11-bridge FALLBACK ON A COVERED SESSION. Under a rootless XWayland
//      server the X root holds nothing, so `zoom` there answers BadMatch - it
//      buys nothing and costs another timeout. The cascade must go straight to
//      the desktopCapturer last resort, which is what the diagnostics line has
//      always advertised.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import path from "node:path";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const EXECUTOR = join(ROOT, "js", "cu_linux_executor.js");

let pass = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log("  PASS " + msg); }
  else { failures.push(msg); console.log("  FAIL " + msg); }
}

// --- the stub rig -----------------------------------------------------------
// A "bridge" whose every subcommand behaves like the reporter's: it never
// answers, so the call can only end in the timeout. Sync calls are recorded so a
// test can assert the main thread was never blocked; async calls resolve with a
// rejection after a tick, standing in for execFile's ETIMEDOUT callback.
function makeRig({ desktop = "ubuntu:GNOME", sessionType = "wayland" } = {}) {
  const calls = { sync: [], async: [] };
  const timeoutErr = (bin, args) => {
    const e = new Error("spawnSync " + bin + " ETIMEDOUT");
    e.code = "ETIMEDOUT";
    e.cmd = bin + " " + args.join(" ");
    return e;
  };
  const cp = {
    execFileSync(bin, args, opts) {
      // `which` and the one-shot environment probes are not part of the
      // contract under test - they are cheap, cached and run at load time.
      const base = path.basename(String(bin));
      if (base === "which" || base === "systemd-detect-virt" || base === "pgrep") {
        throw new Error("not found");
      }
      calls.sync.push({ bin: base, args: args ? args.slice() : [], opts });
      throw timeoutErr(base, args || []);
    },
    execSync(cmd, opts) {
      calls.sync.push({ bin: "sh", args: [String(cmd)], opts });
      throw new Error("execSync should not be reached");
    },
    spawnSync(bin, args, opts) {
      calls.sync.push({ bin: path.basename(String(bin)), args: args ? args.slice() : [], opts });
      return { status: 1 };
    },
    execFile(bin, args, opts, cb) {
      const base = path.basename(String(bin));
      calls.async.push({ bin: base, args: args ? args.slice() : [], opts });
      setTimeout(() => cb(timeoutErr(base, args || []), "", ""), 0);
    },
    spawn() { return { on() {}, unref() {} }; }
  };
  const electron = {
    screen: {
      getAllDisplays: () => [{
        id: 1, bounds: { x: 0, y: 0, width: 1366, height: 768 },
        workArea: { x: 0, y: 0, width: 1366, height: 768 },
        scaleFactor: 1, label: "eDP-1"
      }],
      getPrimaryDisplay: () => ({
        id: 1, bounds: { x: 0, y: 0, width: 1366, height: 768 },
        workArea: { x: 0, y: 0, width: 1366, height: 768 },
        scaleFactor: 1, label: "eDP-1"
      }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 })
    },
    // The last-resort tier. Empty thumbnail => _captureRegion falls through to
    // its final throw, which is the state under test (the cascade ran out), not
    // a harness failure.
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {}
  };
  const requireStub = (id) => {
    if (id === "child_process") return cp;
    if (id === "electron") return electron;
    if (id === "path") return path;
    if (id === "os") return os;
    if (id === "fs") return {
      readFileSync: () => Buffer.alloc(0), writeFileSync: () => {},
      unlinkSync: () => {}, existsSync: () => false, renameSync: () => {},
      accessSync: () => { throw new Error("no"); },
      readdirSync: () => [], statSync: () => ({ isDirectory: () => false })
    };
    throw new Error("unexpected require: " + id);
  };

  const diag = [];
  const g = {
    __cdbDiag: (m) => diag.push(String(m)),
    __cuGnomeBridgeBin: "/usr/lib/claude-desktop/resources/gnome-portal-bridge",
    __cuX11BridgeBin: "/usr/lib/claude-desktop/resources/x11-bridge",
    __cuWlrootsBridgeBin: "/usr/lib/claude-desktop/resources/wlroots-bridge",
    __cuKwinMode: false
  };
  for (const [k, v] of Object.entries(g)) globalThis[k] = v;
  const savedEnv = { ...process.env };
  process.env.XDG_CURRENT_DESKTOP = desktop;
  process.env.XDG_SESSION_TYPE = sessionType;
  process.env.WAYLAND_DISPLAY = "wayland-0";
  delete process.env.SWAYSOCK;
  delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  delete process.env.NIRI_SOCKET;
  delete process.env.COWORK_SCREENSHOT_CMD;
  delete process.env.X11_BRIDGE_BIN;
  delete process.env.GNOME_PORTAL_BRIDGE_BIN;
  delete process.env.WLROOTS_BRIDGE_BIN;

  const src = readFileSync(EXECUTOR, "utf8");
  // The executor is an IIFE that closes over `require`; hand it the stub.
  // eslint-disable-next-line no-new-func
  new Function("require", "process", src)(requireStub, process);
  const ex = globalThis.__linuxExecutor;

  const restore = () => {
    for (const k of Object.keys(g)) delete globalThis[k];
    delete globalThis.__linuxExecutor;
    delete globalThis.__isVM;
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  };
  // The load-time probes (systemd-detect-virt / which) are not under test.
  calls.sync.length = 0;
  return { ex, calls, diag, restore };
}

const bridgeSyncCalls = (calls) =>
  calls.sync.filter((c) => /bridge$/.test(c.bin) || c.bin === "sh");

// --- 1. the screenshot path never blocks the main thread ---------------------
async function testScreenshotIsAsync() {
  console.log("\n[1] a screenshot on GNOME Wayland blocks the main process ZERO times");
  const rig = makeRig();
  try {
    let threw = null;
    try { await rig.ex.screenshot({}); } catch (e) { threw = e; }
    ok(threw !== null,
       "the cascade runs out and rejects (every tier is dead in this rig): " +
       (threw ? threw.message.slice(0, 60) : "resolved?!"));
    const blocking = bridgeSyncCalls(rig.calls);
    ok(blocking.length === 0,
       "not one synchronous bridge call on the whole screenshot path, was " +
       blocking.length + ": " + blocking.map((c) => c.bin + " " + c.args[0]).join(", "));
    const names = rig.calls.async.map((c) => c.bin + " " + c.args[0]);
    ok(rig.calls.async.length > 0,
       "the bridge WAS actually invoked, asynchronously: " + names.join(", "));
    ok(names.some((n) => n.startsWith("gnome-portal-bridge screens")),
       "including the portal-free `screens` enumeration: " + names.join(", "));
    // The screens timeout is what a stuck D-Bus call costs. It is async now, but
    // it still gates how long the shot takes to give up, so keep it short.
    const screensCall = rig.calls.async.find((c) => c.args[0] === "screens");
    ok(screensCall && screensCall.opts.timeout <= 5000,
       "`screens` keeps a short budget (<= 5s), was " +
       (screensCall ? screensCall.opts.timeout : "n/a"));
  } finally { rig.restore(); }
}

// --- 2. no x11-bridge tier on a covered session ------------------------------
async function testNoX11FallbackWhenCovered() {
  console.log("\n[2] a covered Wayland session never falls through to x11-bridge");
  const rig = makeRig();
  try {
    try { await rig.ex.screenshot({}); } catch (e) { /* expected */ }
    const x11 = [...rig.calls.async, ...rig.calls.sync].filter((c) => c.bin === "x11-bridge");
    ok(x11.length === 0,
       "x11-bridge was not invoked at all (rootless XWayland root => BadMatch, " +
       "pure cost): " + x11.map((c) => c.args.join(" ")).join(" | "));
    ok(rig.diag.some((d) => d.includes("no third-party fallback")),
       "and the cascade says so in the diagnostics log");
  } finally { rig.restore(); }

  // The exotic (uncovered) Wayland path must KEEP its x11-bridge tier - the
  // gate is on "covered", not on "Wayland".
  console.log("\n[2b] an exotic (uncovered) Wayland session KEEPS the x11-bridge tier");
  const exotic = makeRig({ desktop: "COSMIC" });
  try {
    try { await exotic.ex.screenshot({}); } catch (e) { /* expected */ }
    const x11 = [...exotic.calls.async, ...exotic.calls.sync].filter((c) => c.bin === "x11-bridge");
    ok(x11.length > 0,
       "x11-bridge IS still tried on COSMIC/Wayland (XWayland is all it has): " +
       x11.length + " call(s)");
  } finally { exotic.restore(); }
}

// --- 3. the portal failure latch ---------------------------------------------
async function testPortalLatch() {
  console.log("\n[3] a failed portal session is latched, not retried into a freeze");
  const rig = makeRig();
  try {
    // A CU lock is taken: the async ensure runs session-start, which times out.
    await rig.ex.__setLockHeld(true);
    const starts = rig.calls.async.filter((c) => c.args[0] === "session-start");
    ok(starts.length === 1, "the lock hook started the portal session ASYNCHRONOUSLY once: " +
       starts.length + " (sync: " + rig.calls.sync.filter((c) => c.args[0] === "session-start").length + ")");
    ok(rig.diag.some((d) => d.includes("portal session unavailable")),
       "the failure is announced and latched in the diagnostics log");

    // Now the model tries to click. Previously this re-ran the 30 s blocking
    // session-start and then the 30 s command. It must now cost nothing.
    rig.calls.sync.length = 0;
    rig.calls.async.length = 0;
    let clickErr = null;
    try { await rig.ex.click(10, 10, "left", 1, []); } catch (e) { clickErr = e; }
    ok(clickErr !== null, "the click fails (the portal really is down)");
    ok(clickErr && /portal session unavailable/.test(clickErr.message),
       "with an actionable message naming the portal, not a raw ETIMEDOUT: " +
       (clickErr ? clickErr.message.slice(0, 80) : ""));
    const spawned = [...rig.calls.sync, ...rig.calls.async];
    ok(spawned.length === 0,
       "and it spawns NOTHING while latched - zero blocking time, was " +
       spawned.length + " call(s): " + spawned.map((c) => c.bin + " " + c.args[0]).join(", "));

    // A screenshot while latched is equally free.
    rig.calls.sync.length = 0;
    rig.calls.async.length = 0;
    try { await rig.ex.screenshot({}); } catch (e) { /* expected */ }
    const zooms = rig.calls.async.filter((c) => c.args[0] === "zoom");
    ok(zooms.length === 0,
       "a screenshot while latched does not attempt the portal `zoom` either: " + zooms.length);

    // A FRESH lock is a fresh user gesture: the latch must lift so a user who
    // fixed their portal (or dismissed a consent dialog by mistake) can retry.
    rig.calls.async.length = 0;
    await rig.ex.__setLockHeld(false);
    await rig.ex.__setLockHeld(true);
    const retry = rig.calls.async.filter((c) => c.args[0] === "session-start");
    ok(retry.length === 1,
       "a new CU lock clears the latch and really retries session-start: " + retry.length);
  } finally { rig.restore(); }
}

// --- 4. the sync backstop can no longer sit on a click -----------------------
async function testSyncBackstopBudget() {
  console.log("\n[4] the sync session-start backstop keeps a click-sized budget");
  const rig = makeRig();
  try {
    // No lock hook fired: the very first input command hits the sync backstop.
    // It is allowed to block (nothing else can bring the session up in a
    // synchronous caller) but only briefly - the consent dialog belongs to the
    // async lock path, which keeps the full 30 s.
    try { await rig.ex.click(10, 10, "left", 1, []); } catch (e) { /* expected */ }
    const sync = rig.calls.sync.filter((c) => c.args[0] === "session-start");
    ok(sync.length === 1, "the backstop ran exactly once: " + sync.length);
    ok(sync.length === 1 && sync[0].opts.timeout <= 8000,
       "with a <= 8s budget, was " + (sync[0] ? sync[0].opts.timeout : "n/a") +
       "ms (30s here is what the OS calls Not Responding)");
    const total = rig.calls.sync.reduce((n, c) => n + (c.opts && c.opts.timeout ? c.opts.timeout : 0), 0);
    ok(total <= 8000,
       "and the WHOLE synchronous budget of one failed click is <= 8s, was " + total + "ms");
  } finally { rig.restore(); }
}

async function main() {
  try {
    await testScreenshotIsAsync();
    await testNoX11FallbackWhenCovered();
    await testPortalLatch();
    await testSyncBackstopBudget();
  } catch (e) {
    console.error("\nHARNESS ERROR: " + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
  console.log("");
  if (failures.length) {
    console.log("FAILED " + failures.length + " of " + (pass + failures.length) + " checks:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  console.log("ALL " + pass + " CHECKS PASSED");
}

main();
