// Injected at document start into the main frame of the Notemaker window (Windows / Linux / Android).
// Implements window.NotemakerNative from docs/DESKTOP_BRIDGE.md + docs/PLATFORMS.md on top of Tauri's IPC:
//   request(method, params) → invoke("bridge", { method, params })   (one Rust command, validated there)
//   native events            → DOM CustomEvent("notemaker-native", { detail: { type, ...data } })
// Placeholders (__NM_PLATFORM__ …) are filled in by src/lib.rs.
(function () {
  if (window.NotemakerNative) return;
  var PLATFORM = "__NM_PLATFORM__";
  var invoke = function (method, params) {
    var t = window.__TAURI_INTERNALS__;
    if (!t || typeof t.invoke !== "function") return Promise.reject(new Error("bridge unavailable"));
    return t.invoke("bridge", { method: method, params: params });
  };
  var asError = function (e) {
    if (e instanceof Error) return e;
    return new Error(typeof e === "string" ? e : (e && e.message) || String(e));
  };
  var api = {
    isDesktop: true,                 // "has a native shell" (also true on Android, see isMobile)
    isMobile: PLATFORM === "android",
    platform: PLATFORM,
    shellVersion: "__NM_VERSION__",
    request: function (method, params) {
      try {
        return invoke(String(method), params === undefined || params === null ? {} : params)
          .then(function (r) { return r === undefined ? null : r; }, function (e) { throw asError(e); });
      } catch (e) { return Promise.reject(asError(e)); }
    }
  };
  Object.defineProperty(window, "NotemakerNative", { value: Object.freeze(api), configurable: false, writable: false });

  var dispatch = function (detail) {
    window.dispatchEvent(new CustomEvent("notemaker-native", { detail: detail }));
  };
  // Called by the shell (webview eval). A transfer file is announced only; its bytes come over IPC.
  Object.defineProperty(window, "__notemakerNativeEvent", {
    configurable: false, writable: false,
    value: function (detail) {
      if (!detail || typeof detail.type !== "string") return;
      if (detail.type === "__transfer") {
        invoke("shell.takeTransfer", {}).then(function (t) {
          if (t && typeof t.base64 === "string") dispatch({ type: "openTransfer", fileName: t.fileName, base64: t.base64 });
        }, function () { /* already taken */ });
        return;
      }
      dispatch(detail);
    }
  });

  // The page is ready for events once it has loaded (the web app binds its listeners while loading).
  window.addEventListener("load", function () {
    setTimeout(function () { invoke("shell.ready", {}).catch(function () {}); }, 0);
  });

  // Report uncaught errors to the shell log (printed with --bridge-log).
  var log = function (m) { try { invoke("shell.log", { message: String(m).slice(0, 500) }).catch(function () {}); } catch (x) {} };
  window.addEventListener("error", function (e) {
    log("JS error: " + e.message + " @ " + String(e.filename || "").split("/").pop() + ":" + e.lineno);
  });
  window.addEventListener("unhandledrejection", function (e) {
    log("Unhandled rejection: " + ((e.reason && e.reason.message) || e.reason));
  });

  // Shell helpers (not part of the web contract).
  // WebView2 runs this before <html> exists, so add the classes once the document element is there.
  var addClasses = function () {
    var el = document.documentElement;
    if (!el) return false;
    el.classList.add("notemaker-desktop", "notemaker-" + PLATFORM);
    return true;
  };
  if (!addClasses()) document.addEventListener("readystatechange", function once() {
    if (addClasses()) document.removeEventListener("readystatechange", once);
  });

  // Undo/Redo from a native menu: native text undo inside editable fields, otherwise a menu event.
  Object.defineProperty(window, "__notemakerMenuUndo", {
    configurable: false, writable: false,
    value: function (kind) {
      var a = document.activeElement;
      var editable = a && (a.isContentEditable || a.tagName === "TEXTAREA" ||
        (a.tagName === "INPUT" && /^(text|search|url|email|password|tel|number|)$/i.test(a.type || "")));
      if (editable) { document.execCommand(kind); return; }
      dispatch({ type: "menu", command: kind });
    }
  });

  // Android draws edge-to-edge: keep the UI clear of the status bar, navigation bar, camera cutout and keyboard,
  // and keep the status-bar icons readable on the page's header colour.
  var bars = window.NotemakerSystemBars;
  if (PLATFORM === "android" && bars) {
    var pending = null;
    var applyInsets = function (i) {
      if (i) pending = i;
      var el = document.documentElement;
      if (!el || !pending) return;
      ["top", "right", "bottom", "left"].forEach(function (k) {
        var n = Number(pending[k]);
        el.style.setProperty("--nm-inset-" + k, (isFinite(n) && n > 0 ? Math.min(n, 400) : 0) + "px");
      });
    };
    Object.defineProperty(window, "__notemakerInsets", { configurable: false, writable: false, value: applyInsets });
    try { applyInsets(JSON.parse(bars.insets())); } catch (e) {}
    document.addEventListener("readystatechange", function () { applyInsets(); });

    var lastLight = null, queued = false;
    var reportBars = function () {
      queued = false;
      var t = document.querySelector(".topbar") || document.body;
      if (!t) return;
      var m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(getComputedStyle(t).backgroundColor || "");
      if (!m) return;
      var light = (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 > 0.55;
      if (light !== lastLight) { lastLight = light; try { bars.setLightBackground(light); } catch (e) {} }
    };
    var queueReport = function () { if (!queued) { queued = true; requestAnimationFrame(reportBars); } };
    document.addEventListener("DOMContentLoaded", function () {
      reportBars();
      var mo = new MutationObserver(queueReport);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
      mo.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme"] });
      try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", queueReport); } catch (e) {}
    });
  }
})();
