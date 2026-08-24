// Second-instance (single-instance-lock) activation diagnostics for Linux.
//
// When Claude is already running and the user launches it again - clicking the
// launcher icon, running `claude-desktop`, opening a claude:// link - the new
// process fails requestSingleInstanceLock(), fires a `second-instance` event in
// the RUNNING process, and exits. The running process is then supposed to reveal
// and focus its window. Upstream logs NOTHING on that path unless its argv
// dedupe fires, so when the reveal does not happen there is no evidence at all
// (issue #233).
//
// This adds evidence and nothing else - it changes no behaviour. We register our
// own `second-instance` listener from the "use strict" preamble, i.e. BEFORE the
// bundle registers its own, so Electron calls ours first and we can capture the
// window state upstream is about to act on. The reveal that follows is then
// sampled immediately after upstream's synchronous handler returns, and again at
// +500ms and +2s to catch an asynchronous or compositor-deferred map.
//
// Deliberately hooks only the public Electron event, so there are no minified
// anchors here to re-fit on an upstream bump.
//
// Output goes to ~/.config/Claude/logs/claude-patches.log (profile/3p-aware) via
// __cdbDiag, which the CU preamble defines later in the same bundle - so the
// sink is resolved lazily at call time, never at install time.
;(function () {
  if (process.platform !== "linux") return;
  /*__cdb_si_diag_v1__*/
  var _e = require("electron");

  function diag(msg) {
    try {
      var sink = globalThis.__cdbDiag;
      if (typeof sink === "function") sink("[second-instance] " + msg);
    } catch (_) {}
  }

  function describe(w) {
    try {
      if (w.isDestroyed()) return "#?=destroyed";
      var b = w.getBounds();
      var disp = "?";
      try {
        disp = String(_e.screen.getDisplayMatching(b).id);
      } catch (_) {}
      return (
        "#" + w.id +
        " vis=" + (w.isVisible() ? 1 : 0) +
        " foc=" + (w.isFocused() ? 1 : 0) +
        " min=" + (w.isMinimized() ? 1 : 0) +
        " geo=" + b.x + "," + b.y + "," + b.width + "x" + b.height +
        " display=" + disp
      );
    } catch (e) {
      return "#? probe-failed:" + (e && e.message);
    }
  }

  function snapshot(tag) {
    try {
      var wins = _e.BrowserWindow.getAllWindows();
      if (!wins.length) {
        // The single most damning state: the activation arrived before the main
        // window existed, so upstream's `V && !V.isDestroyed()` guard dropped it.
        diag(tag + " NO WINDOWS EXIST (activation has nothing to reveal)");
        return;
      }
      var parts = [];
      for (var i = 0; i < wins.length; i++) parts.push(describe(wins[i]));
      diag(tag + " " + parts.join(" | "));
    } catch (e) {
      diag(tag + " snapshot failed: " + (e && e.message));
    }
  }

  function session() {
    var env = process.env;
    return (
      "session=" + (env.XDG_SESSION_TYPE || "?") +
      " desktop=" + (env.XDG_CURRENT_DESKTOP || "?") +
      " wayland=" + (env.WAYLAND_DISPLAY ? "yes" : "no")
    );
  }

  try {
    _e.app.on("second-instance", function (_ev, argv, cwd, extra) {
      var token = "unknown";
      try {
        token = "absent";
        for (var i = 0; i < (argv || []).length; i++) {
          if (
            typeof argv[i] === "string" &&
            argv[i].indexOf("--xdg-activation-token") === 0
          ) {
            token = "present";
            break;
          }
        }
      } catch (_) {}

      var extraDesc = "none";
      try {
        if (extra !== undefined) extraDesc = JSON.stringify(extra);
      } catch (_) {
        extraDesc = "unserialisable";
      }

      diag(
        "received " + session() +
        " activationToken=" + token +
        " additionalData=" + extraDesc +
        " cwd=" + JSON.stringify(cwd || "") +
        " argv=" + JSON.stringify(argv || [])
      );
      snapshot("before:");
      // Upstream's listener runs after ours and reveals synchronously; setImmediate
      // lands right after it returns.
      setImmediate(function () {
        snapshot("after-handler:");
      });
      setTimeout(function () {
        snapshot("after+500ms:");
      }, 500);
      setTimeout(function () {
        snapshot("after+2000ms:");
      }, 2000);
    });

    _e.app.whenReady().then(function () {
      diag("diagnostics active (" + session() + ")");
    }, function () {});
  } catch (e) {
    // Never let diagnostics break startup.
    try {
      require("fs").writeSync(
        2,
        "[second-instance] failed to install diagnostics: " + (e && e.message) + "\n"
      );
    } catch (_) {}
  }
})();
