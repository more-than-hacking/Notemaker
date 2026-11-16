import AppKit
import WebKit
import UserNotifications
import UniformTypeIdentifiers

@main
enum NotemakerMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}

/// Native macOS shell that hosts the bundled web UI (docs/DESKTOP_BRIDGE.md).
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let bridge = WebBridge()
    private var notificationDelegate: NotificationDelegate?
    private var quitting = false
    private var quitReplied = false
    private var lastChrome: NSColor?
    private var termSource: DispatchSourceSignal?

    private let args = CommandLine.arguments
    private var selfTest: Bool { args.contains("--bridge-selftest") }

    private var resourcesURL: URL { Bundle.main.resourceURL ?? URL(fileURLWithPath: ".") }
    private var webRoot: URL { resourcesURL.appendingPathComponent("web", isDirectory: true) }
    private var selfTestRoot: URL { resourcesURL.appendingPathComponent("selftest", isDirectory: true) }

    // MARK: Launch

    func applicationWillFinishLaunching(_ notification: Notification) {
        if selfTest {
            DataFile.rootOverride = FileManager.default.temporaryDirectory
                .appendingPathComponent("notemaker-selftest-\(ProcessInfo.processInfo.processIdentifier)", isDirectory: true)
        }
        // Must be set before launch finishes so a click that launched the app is delivered.
        let nd = NotificationDelegate { day in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let d = NSApp.delegate as? AppDelegate else { return }
                    d.showWindow()
                    if Day.isValid(day) { d.bridge.send("openDay", ["day": day]) }
                }
            }
        }
        notificationDelegate = nd
        if Bundle.main.bundleIdentifier != nil { UNUserNotificationCenter.current().delegate = nd }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.mainMenu = buildMenu()
        buildWindow()
        observeLockEvents()
        // SIGTERM (e.g. `kill`) quits through the normal path, so the page can flush and lock the vault.
        signal(SIGTERM, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        src.setEventHandler { NSApp.terminate(nil) }
        src.resume()
        termSource = src
        bridge.services.onStatusItemClick = { [weak self] in
            self?.showWindow()
            self?.bridge.send("menu", ["command": "focus.toggle"])
        }
        if selfTest { runSelfTest() } else { loadWebUI() }
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: BridgeScript.source(shellVersion: WebBridge.shellVersion),
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.add(bridge, name: "notemaker")
        config.userContentController = ucc
        config.websiteDataStore = .default()        // keeps localStorage for the first-launch migration
        config.preferences.isElementFullscreenEnabled = false
        config.applicationNameForUserAgent = "NotemakerDesktop/\(WebBridge.shellVersion)"

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        if #available(macOS 13.3, *) { webView.isInspectable = UserDefaults.standard.bool(forKey: "NotemakerWebInspector") || selfTest }
        webView.setValue(false, forKey: "drawsBackground")   // show the window colour until the page paints

        bridge.webView = webView
        bridge.allowedRoots = selfTest ? [selfTestRoot] : [webRoot]
        bridge.selfTestMode = selfTest
        bridge.logCalls = args.contains("--bridge-log") || selfTest
        bridge.windowProvider = { [weak self] in self?.window }
        bridge.onChrome = { [weak self] c in self?.applyChrome(c) }
        bridge.onStorageSaved = { [weak self] in if self?.quitting == true { self?.finishQuit() } }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Notemaker"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unifiedCompact
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.backgroundColor = .windowBackgroundColor
        if !window.setFrameUsingName("NotemakerMainWindow") { window.center() }
        window.setFrameAutosaveName("NotemakerMainWindow")
        window.makeKeyAndOrderFront(nil)
    }

    private func loadWebUI() {
        let index = webRoot.appendingPathComponent("index.html")
        guard FileManager.default.fileExists(atPath: index.path) else {
            webView.loadHTMLString("<h2 style='font:15px -apple-system;padding:2em'>The web UI is missing from the app bundle (Contents/Resources/web). Rebuild with ./build.sh.</h2>", baseURL: nil)
            return
        }
        webView.loadFileURL(index, allowingReadAccessTo: webRoot)
    }

    /// Match the transparent titlebar to the page header colour.
    private func applyChrome(_ c: NSColor) {
        guard c != lastChrome else { return }
        lastChrome = c
        window.backgroundColor = c
        let rgb = c.usingColorSpace(.sRGB) ?? c
        let luminance = 0.2126 * rgb.redComponent + 0.7152 * rgb.greenComponent + 0.0722 * rgb.blueComponent
        let wanted = NSAppearance(named: luminance < 0.5 ? .darkAqua : .aqua)
        if window.appearance?.name != wanted?.name { window.appearance = wanted }
    }

    func showWindow() {
        guard let window else { return }   // may be called before launch finishes (open-file at launch)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: Window / app lifecycle

    /// Closing the window hides it, so the page (focus timer, unsaved state) keeps running.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    /// notemaker://day/YYYY-MM-DD opens that day.
    /// notemaker://day/YYYY-MM-DD URLs, and .notemaker transfer files (double-click, Open With, Dock-icon drop).
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if url.scheme == "notemaker", url.host == "day" {
                let day = url.lastPathComponent
                if Day.isValid(day) { showWindow(); bridge.send("openDay", ["day": day]) }
            } else if url.isFileURL {
                openTransferFile(url)
            }
        }
    }

    static let maxTransferBytes = 1 << 30   // 1 GB (docs/TRANSFER_FORMAT.md)

    /// Read a .notemaker file off the main thread and send `openTransfer` (queued until the page is ready).
    func openTransferFile(_ url: URL, completion: ((Bool) -> Void)? = nil) {
        showWindow()
        let name = url.lastPathComponent
        guard url.pathExtension.lowercased() == "notemaker" else {
            alert("“\(name)” isn’t a Notemaker transfer file.", "Transfer files end in .notemaker. To restore an older JSON backup, use File → Import….")
            completion?(false); return
        }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= Self.maxTransferBytes else {
            alert("“\(name)” is too large.", "Transfer files can be at most 1 GB; this one is \(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).")
            completion?(false); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let result: Result<String, Error> = Result { try Data(contentsOf: url, options: .mappedIfSafe).base64EncodedString() }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                switch result {
                case .success(let b64):
                    self.bridge.send("openTransfer", ["fileName": name, "base64": b64])
                    self.showWindow()
                    completion?(true)
                case .failure(let e):
                    self.alert("Couldn’t open “\(name)”.", e.localizedDescription)
                    completion?(false)
                }
            }
        }
    }

    private func alert(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.alertStyle = .warning
        if let window, window.isVisible { a.beginSheetModal(for: window) } else { a.runModal() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard bridge.pageReady, !selfTest else { return .terminateNow }
        quitting = true
        bridge.send("lock", ["reason": "quit"])
        bridge.send("beforeQuit")
        // Wait up to 1 s for a storage.save, then quit anyway.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.finishQuit() }
        return .terminateLater
    }

    private func finishQuit() {
        guard quitting, !quitReplied else { return }
        quitReplied = true
        if bridge.logCalls { print("quit: replying to terminate"); fflush(stdout) }
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    // MARK: Vault lock triggers

    private func observeLockEvents() {
        let ws = NSWorkspace.shared.notificationCenter
        ws.addObserver(self, selector: #selector(willSleep), name: NSWorkspace.willSleepNotification, object: nil)
        ws.addObserver(self, selector: #selector(screenLocked), name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(screenLocked),
                                                            name: NSNotification.Name("com.apple.screenIsLocked"), object: nil)
    }

    @objc private func willSleep() { bridge.send("lock", ["reason": "sleep"]) }
    @objc private func screenLocked() { bridge.send("lock", ["reason": "screen-lock"]) }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let scheme = url.scheme?.lowercased() ?? ""
        if url.isFileURL {
            let path = url.standardizedFileURL.resolvingSymlinksInPath().path
            let ok = bridge.allowedRoots.contains { path.hasPrefix($0.standardizedFileURL.resolvingSymlinksInPath().path + "/") }
            decisionHandler(ok && !action.shouldPerformDownload ? .allow : .cancel)
            return
        }
        if scheme == "about" || scheme == "data" || (scheme == "blob" && !action.shouldPerformDownload && action.targetFrame?.isMainFrame == false) {
            decisionHandler(.allow); return
        }
        if ["http", "https", "mailto"].contains(scheme) { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { bridge.pageWillReload() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        bridge.pageDidLoad()
        guard bridge.logCalls, !selfTest else { return }
        let js = "JSON.stringify({title: document.title, elements: document.getElementsByTagName('*').length, " +
                 "textChars: (document.body && document.body.innerText || '').length, secure: window.isSecureContext, " +
                 "subtle: !!(window.crypto && crypto.subtle), localStorageKeys: Object.keys(localStorage).length})"
        webView.evaluateJavaScript(js) { r, e in
            print("page loaded: \(r ?? e?.localizedDescription ?? "")"); fflush(stdout)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("Notemaker: web content process terminated — reloading")
        bridge.pageWillReload()
        if selfTest { runSelfTest() } else { loadWebUI() }
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { resp in completionHandler(resp == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor () -> Void) {
        let a = NSAlert()
        a.messageText = "Notemaker"
        a.informativeText = message
        a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = "Notemaker"
        a.informativeText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let a = NSAlert()
        a.messageText = "Notemaker"
        a.informativeText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = field
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    // MARK: Menu

    @objc func menuCommand(_ sender: NSMenuItem) {
        guard let cmd = sender.representedObject as? String else { return }
        showWindow()
        bridge.send("menu", ["command": cmd])
    }

    @objc func menuUndo(_ sender: Any?) {
        webView.evaluateJavaScript("window.__notemakerMenuUndo && window.__notemakerMenuUndo('undo')", completionHandler: nil)
    }
    @objc func menuRedo(_ sender: Any?) {
        webView.evaluateJavaScript("window.__notemakerMenuUndo && window.__notemakerMenuUndo('redo')", completionHandler: nil)
    }
    @objc func showAbout(_ sender: Any?) {
        var opts: [NSApplication.AboutPanelOptionKey: Any] = [
            .credits: NSAttributedString(string: "Daily tasks, notes, habits, focus and a hardware-protected vault.",
                                         attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor])]
        if let icon = NSImage(contentsOf: resourcesURL.appendingPathComponent("Notemaker.icns")) { opts[.applicationIcon] = icon }
        NSApp.orderFrontStandardAboutPanel(options: opts)
    }
    @objc func zoomIn(_ sender: Any?) { webView.pageZoom = min(2.0, webView.pageZoom + 0.1) }
    @objc func zoomOut(_ sender: Any?) { webView.pageZoom = max(0.6, webView.pageZoom - 0.1) }
    @objc func zoomReset(_ sender: Any?) { webView.pageZoom = 1.0 }
    @objc func reloadPage(_ sender: Any?) { webView.reload() }

    private func buildMenu() -> NSMenu {
        let main = NSMenu()
        func cmd(_ title: String, _ command: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: #selector(menuCommand(_:)), keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.representedObject = command
            i.target = self
            return i
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target
            return i
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            top.submenu = m
            main.addItem(top)
            return top
        }

        let services = NSMenu(title: "Services")
        NSApp.servicesMenu = services
        let servicesItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: ""); servicesItem.submenu = services
        _ = submenu("Notemaker", [
            item("About Notemaker", #selector(showAbout(_:)), target: self),
            .separator(),
            cmd("Settings…", "view:settings", ","),
            .separator(),
            servicesItem,
            .separator(),
            item("Hide Notemaker", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Notemaker", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = submenu("File", [
            cmd("New Task", "newTask", "n"),
            .separator(),
            cmd("Export…", "export", "e", [.command, .shift]),
            cmd("Import…", "import", "i", [.command, .shift]),
            .separator(),
            cmd("Move to a New Mac…", "transfer"),
            cmd("Restore from Another Device…", "restore"),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        _ = submenu("Edit", [
            item("Undo", #selector(menuUndo(_:)), "z", target: self),
            item("Redo", #selector(menuRedo(_:)), "z", [.command, .shift], target: self),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            cmd("Search…", "search", "f"),
            cmd("Command Palette…", "palette", "k"),
        ])
        let views: [(String, String)] = [("Day", "day"), ("Calendar", "calendar"), ("Planner", "planner"), ("Board", "board"),
                                         ("Habits", "habits"), ("Insights", "insights"), ("Vault", "vault"), ("Settings", "settings")]
        var viewItems = views.enumerated().map { i, v in cmd(v.0, "view:\(v.1)", String(i + 1)) }
        viewItems += [
            .separator(),
            item("Actual Size", #selector(zoomReset(_:)), "0", target: self),
            item("Zoom In", #selector(zoomIn(_:)), "+", target: self),
            item("Zoom Out", #selector(zoomOut(_:)), "-", target: self),
            .separator(),
            item("Reload", #selector(reloadPage(_:)), "r", [.command, .option], target: self),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ]
        _ = submenu("View", viewItems)
        _ = submenu("Go", [
            cmd("Today", "today", "t"),
            cmd("Previous Day", "prevDay", "["),
            cmd("Next Day", "nextDay", "]"),
            .separator(),
            cmd("Daily Review…", "review", "r", [.command, .shift]),
            cmd("Start / Stop Focus Timer", "focus.toggle", "p", [.command, .shift]),
            cmd("Lock Vault", "lockVault", "l", [.command, .shift]),
        ])
        let windowMenu = submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])
        NSApp.windowsMenu = windowMenu.submenu
        let help = submenu("Help", [])
        NSApp.helpMenu = help.submenu
        return main
    }

    private func findMenuItem(command: String) -> NSMenuItem? {
        func search(_ m: NSMenu?) -> NSMenuItem? {
            for i in m?.items ?? [] {
                if i.representedObject as? String == command { return i }
                if let f = search(i.submenu) { return f }
            }
            return nil
        }
        return search(NSApp.mainMenu)
    }

    // MARK: Self-test (--bridge-selftest)

    private func runSelfTest() {
        let page = selfTestRoot.appendingPathComponent("selftest.html")
        guard FileManager.default.fileExists(atPath: page.path) else {
            print("SELFTEST: selftest.html missing from bundle"); exit(2)
        }
        bridge.onSelfTestTrigger = { [weak self] action, arg, done in
            guard let self else { return }
            switch action {
            case "menu":
                // Fire the real menu item for a command (proves it exists and is wired up).
                guard let item = self.findMenuItem(command: arg) else { done(false); return }
                self.menuCommand(item)
                done(true)
            case "openTransfer":
                let url = FileManager.default.temporaryDirectory.appendingPathComponent("Selftest transfer.notemaker")
                try? Data(arg.utf8).write(to: url)
                self.openTransferFile(url) { ok in try? FileManager.default.removeItem(at: url); done(ok) }
            case "infoPlist":
                let info = Bundle.main.infoDictionary ?? [:]
                let docs = info["CFBundleDocumentTypes"] as? [[String: Any]] ?? []
                let utis = info["UTExportedTypeDeclarations"] as? [[String: Any]] ?? []
                done(docs.contains { ($0["LSItemContentTypes"] as? [String])?.contains("com.mth.notemaker.transfer") == true }
                     && utis.contains { $0["UTTypeIdentifier"] as? String == "com.mth.notemaker.transfer" })
            default: done(false)
            }
        }
        bridge.onSelfTestDone = { result in
            let ok = (result["failed"] as? Int ?? 1) == 0
            if let lines = result["lines"] as? [String] { lines.forEach { print($0) } }
            print("SELFTEST RESULT: \(ok ? "PASS" : "FAIL") (\(result["passed"] ?? 0) passed, \(result["failed"] ?? 0) failed)")
            fflush(stdout)
            try? FileManager.default.removeItem(at: DataFile.root)
            exit(ok ? 0 : 1)
        }
        webView.loadFileURL(page, allowingReadAccessTo: selfTestRoot)
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
            print("SELFTEST: timed out"); fflush(stdout); exit(3)
        }
    }
}
