import Foundation

/// JavaScript injected at document start into the main frame (docs/DESKTOP_BRIDGE.md "Detection"/"Transport").
enum BridgeScript {
    static func source(shellVersion: String) -> String {
        """
        (function () {
          if (window.NotemakerNative) return;
          var seq = 0;
          var pending = new Map();
          var post = function (msg) { window.webkit.messageHandlers.notemaker.postMessage(msg); };
          Object.defineProperty(window, "__notemakerNativeReply", {
            configurable: false, writable: false,
            value: function (id, result, errorMessage) {
              var p = pending.get(id);
              if (!p) return;
              pending.delete(id);
              if (errorMessage !== null && errorMessage !== undefined) p.reject(new Error(errorMessage));
              else p.resolve(result === undefined ? null : result);
            }
          });
          var api = {
            isDesktop: true,
            platform: "macos",
            shellVersion: "\(shellVersion)",
            request: function (method, params) {
              return new Promise(function (resolve, reject) {
                var id = ++seq;
                pending.set(id, { resolve: resolve, reject: reject });
                try { post({ id: id, method: String(method), params: params === undefined ? {} : params }); }
                catch (e) { pending.delete(id); reject(e); }
              });
            }
          };
          Object.defineProperty(window, "NotemakerNative", { value: Object.freeze(api), configurable: false, writable: false });

          // Report uncaught errors to the shell log (printed with --bridge-log).
          window.addEventListener("error", function (e) {
            try { post({ id: 0, method: "shell.log", params: { message: "JS error: " + e.message + " @ " + (e.filename || "").split("/").pop() + ":" + e.lineno } }); } catch (x) {}
          });
          window.addEventListener("unhandledrejection", function (e) {
            try { post({ id: 0, method: "shell.log", params: { message: "Unhandled rejection: " + (e.reason && e.reason.message || e.reason) } }); } catch (x) {}
          });

          // Shell helpers (not part of the web contract).
          document.documentElement.classList.add("notemaker-desktop", "notemaker-macos");
          document.documentElement.style.setProperty("--native-titlebar-height", "28px");

          // Undo/Redo from the native menu: native text undo inside editable fields, otherwise a menu event.
          Object.defineProperty(window, "__notemakerMenuUndo", {
            configurable: false, writable: false,
            value: function (kind) {
              var a = document.activeElement;
              var editable = a && (a.isContentEditable || a.tagName === "TEXTAREA" ||
                (a.tagName === "INPUT" && /^(text|search|url|email|password|tel|number|)$/i.test(a.type || "")));
              if (editable) { document.execCommand(kind); return; }
              window.dispatchEvent(new CustomEvent("notemaker-native", { detail: { type: "menu", command: kind } }));
            }
          });

          // Keep the native titlebar the same colour as the page header (cheap: only on theme changes).
          var lastBg = "";
          var reportChrome = function () {
            var pick = function (el) {
              if (!el) return "";
              var c = getComputedStyle(el).backgroundColor;
              return (c && c !== "transparent" && c !== "rgba(0, 0, 0, 0)") ? c : "";
            };
            var bg = pick(document.querySelector(".topbar")) || pick(document.body) || pick(document.documentElement);
            if (bg && bg !== lastBg) { lastBg = bg; try { post({ id: 0, method: "shell.chrome", params: { background: bg } }); } catch (e) {} }
          };
          var schedule = function () { clearTimeout(schedule.t); schedule.t = setTimeout(reportChrome, 50); };
          document.addEventListener("DOMContentLoaded", function () {
            reportChrome();
            var opts = { attributes: true, attributeFilter: ["class", "style", "data-theme"] };
            new MutationObserver(schedule).observe(document.documentElement, opts);
            if (document.body) new MutationObserver(schedule).observe(document.body, opts);
            if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule);
          });
        })();
        """
    }
}
