import AppKit
import WebKit
import CryptoKit
import UniformTypeIdentifiers

/// Native side of docs/DESKTOP_BRIDGE.md.
@MainActor
final class WebBridge: NSObject, WKScriptMessageHandler {
    static let shellVersion = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "2.1.0"
    static let maxBlob = VaultCrypto.maxBlobBytes
    static let maxDocument = 200 * 1024 * 1024
    static let maxSaveBytes = 1 << 30   // files.save (transfer files up to 1 GB)

    weak var webView: WKWebView?
    /// Directories whose pages may talk to the bridge (the bundled web UI, and the self-test page).
    var allowedRoots: [URL] = []
    var pageReady = false
    var selfTestMode = false
    var logCalls = false
    private var queuedEvents: [[String: Any]] = []

    var onChrome: ((NSColor) -> Void)?
    var onStorageSaved: (() -> Void)?
    var onSelfTestDone: (([String: Any]) -> Void)?
    var onSelfTestTrigger: ((String, String, @escaping (Bool) -> Void) -> Void)?
    var windowProvider: (() -> NSWindow?)?

    let services = NativeServices()

    // MARK: Events

    func send(_ type: String, _ data: [String: Any] = [:]) {
        var detail = data
        detail["type"] = type
        guard pageReady, let wv = webView else {
            if logCalls { print("bridge → event \(type) (queued until the page is ready)"); fflush(stdout) }
            queuedEvents.append(detail); return
        }
        if logCalls { print("bridge → event \(type)" + (type == "openTransfer" ? " (\((data["base64"] as? String)?.count ?? 0) base64 chars)" : "")); fflush(stdout) }
        wv.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('notemaker-native', { detail: detail }));",
                               arguments: ["detail": detail], in: nil, in: .page, completionHandler: nil)
    }

    func pageDidLoad() {
        pageReady = true
        let q = queuedEvents; queuedEvents = []
        for e in q { var d = e; let t = d.removeValue(forKey: "type") as? String ?? ""; send(t, d) }
    }

    func pageWillReload() { pageReady = false }

    // MARK: Origin check

    func isTrusted(_ message: WKScriptMessage) -> Bool {
        guard message.webView === webView, message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "file",
              let url = message.frameInfo.request.url ?? webView?.url, url.isFileURL else { return false }
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        return allowedRoots.contains { path.hasPrefix($0.standardizedFileURL.resolvingSymlinksInPath().path + "/") }
    }

    // MARK: Transport

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard isTrusted(message) else {
            NSLog("Notemaker bridge: rejected message from untrusted origin")
            return
        }
        guard let body = message.body as? [String: Any], let method = body["method"] as? String,
              let idNum = body["id"] as? NSNumber else { return }
        let id = idNum.intValue
        let params = body["params"] as? [String: Any] ?? [:]
        if logCalls { print("bridge ← \(method)"); fflush(stdout) }
        handle(method, params) { [weak self] result in
            guard id > 0 else { return }   // id 0 = fire-and-forget shell message
            self?.reply(id, result)
        }
    }

    private func reply(_ id: Int, _ result: Result<Any, BridgeError>) {
        guard let wv = webView else { return }
        var args: [String: Any] = ["id": id]
        switch result {
        case .success(let v): args["result"] = v; args["err"] = NSNull()
        case .failure(let e): args["result"] = NSNull(); args["err"] = e.message
        }
        if logCalls, case .failure(let e) = result { print("bridge → error: \(e.message)"); fflush(stdout) }
        wv.callAsyncJavaScript("window.__notemakerNativeReply(id, result, err);", arguments: args, in: nil, in: .page, completionHandler: nil)
    }

    // MARK: Dispatch

    func handle(_ method: String, _ p: [String: Any], _ done: @escaping (Result<Any, BridgeError>) -> Void) {
        do {
            switch method {
            // storage
            case "storage.load":
                let url = DataFile.defaultURL
                if FileManager.default.fileExists(atPath: url.path) {
                    let d = try Data(contentsOf: url)
                    guard let s = String(data: d, encoding: .utf8) else { throw BridgeError("data.json is not UTF-8") }
                    done(.success(["json": s]))
                } else if !selfTestMode, let v1 = Migration.findMacV1Defaults(),
                          var migrated = try? Migration.fromMacV1(tasksData: v1.tasks, notesData: v1.notes) {
                    // First launch after the v1 macOS app: convert its UserDefaults (left in place as a backup).
                    migrated.templates = Templates.builtIns
                    let json = try migrated.jsonData()
                    try FileManager.default.createDirectory(at: DataFile.root, withIntermediateDirectories: true)
                    try json.write(to: url, options: [.atomic])
                    done(.success(["json": String(decoding: json, as: UTF8.self)]))
                } else {
                    done(.success(["json": NSNull()]))
                }
            case "storage.save":
                let json = try Validate.string(p["json"], "json", max: Self.maxDocument)
                let data = Data(json.utf8)
                guard (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else { throw BridgeError("json must be a JSON object") }
                try FileManager.default.createDirectory(at: DataFile.root, withIntermediateDirectories: true)
                try data.write(to: DataFile.defaultURL, options: [.atomic])
                done(.success(["ok": true]))
                onStorageSaved?()

            // blobs
            case "blobs.put":
                let id = try Validate.uuid(p["id"], "id")
                let iv = try Validate.base64(p["iv"], "iv", maxBytes: 12)
                guard iv.count == 12 else { throw BridgeError("iv must be 12 bytes") }
                let ct = try Validate.base64(p["ct"], "ct", maxBytes: Self.maxBlob + 16)
                guard ct.count >= 16 else { throw BridgeError("ct is too short") }
                try services.putBlob(id: id, data: iv + ct)
                done(.success(["ok": true]))
            case "blobs.get":
                let id = try Validate.uuid(p["id"], "id")
                if let d = services.getBlob(id: id), d.count >= 28 {
                    done(.success(["iv": d.prefix(12).base64EncodedString(), "ct": d.dropFirst(12).base64EncodedString()]))
                } else { done(.success(NSNull())) }
            case "blobs.delete":
                services.deleteBlob(id: try Validate.uuid(p["id"], "id"))
                done(.success(["ok": true]))

            // Secure Enclave
            case "se.available":
                done(.success(["available": SecureEnclaveKeys.isAvailable, "device": SecureEnclaveKeys.deviceName]))
            case "se.createSlot":
                let slotId = try Validate.uuid(p["slotId"], "slotId")
                let label = try Validate.string(p["label"], "label", max: 200)
                let vdk = try Validate.base64(p["vdk"], "vdk", maxBytes: 32)
                guard vdk.count == 32 else { throw BridgeError("vdk must be 32 bytes") }
                let (slot, loc) = try SecureEnclaveKeys.createSlot(slotId: slotId, label: label, vdk: vdk)
                if logCalls { print("bridge   se handle stored in: \(loc.rawValue)"); fflush(stdout) }
                done(.success(try Self.jsonObject(slot)))
            case "se.unwrapSlot":
                let raw = try Validate.dict(p["slot"], "slot")
                _ = try Validate.uuid(raw["id"], "slot.id")
                let slot = try JSONDecoder().decode(Keyslot.self, from: JSONSerialization.data(withJSONObject: raw))
                guard slot.type == "secure-enclave" else { throw BridgeError("slot.type must be secure-enclave") }
                DispatchQueue.global(qos: .userInitiated).async {
                    let r: Result<Any, BridgeError>
                    do { r = .success(["vdk": try SecureEnclaveKeys.unwrapSlot(slot).base64EncodedString()]) }
                    catch { r = .failure(BridgeError(error.localizedDescription)) }
                    DispatchQueue.main.async { done(r) }
                }
            case "se.deleteSlot":
                SecureEnclaveKeys.delete(slotId: try Validate.uuid(p["slotId"], "slotId"))
                done(.success(["ok": true]))

            // notifications
            case "notify.permission":
                services.notificationStatus { done(.success(["status": $0])) }
            case "notify.request":
                services.requestNotifications { done(.success(["status": $0])) }
            case "notify.sync":
                guard let items = p["items"] as? [[String: Any]] else { throw BridgeError("items must be an array") }
                guard items.count <= 64 else { throw BridgeError("at most 64 notifications") }
                let parsed = try items.map { i -> NativeServices.Reminder in
                    let id = try Validate.string(i["id"], "items[].id", max: 200)
                    let title = try Validate.string(i["title"], "items[].title", max: 500)
                    let bodyText = try Validate.optString(i["body"], "items[].body", max: 2000) ?? ""
                    let at = try Validate.string(i["at"], "items[].at", max: 40)
                    guard let date = ISO.date(at) else { throw BridgeError("items[].at must be an ISO timestamp") }
                    let day = try Validate.string(i["day"], "items[].day", max: 10)
                    guard Day.isValid(day) else { throw BridgeError("items[].day must be YYYY-MM-DD") }
                    return .init(id: id, title: title, body: bodyText, at: date, day: day)
                }
                services.syncNotifications(parsed) { done(.success(["scheduled": $0])) }
            case "notify.show":
                services.showNotification(title: try Validate.string(p["title"], "title", max: 500),
                                          body: try Validate.optString(p["body"], "body", max: 2000) ?? "")
                done(.success(["ok": true]))

            // files / clipboard / app
            case "files.save":
                let name = try Validate.string(p["suggestedName"], "suggestedName", max: 255)
                _ = try Validate.optString(p["mime"], "mime", max: 200)
                // Transfer files can be hundreds of MB: only check the size here; decode + write happen off the main thread.
                let b64 = try Validate.string(p["base64"], "base64", max: (Self.maxSaveBytes / 3 + 2) * 4)
                services.saveFile(name: name, base64: b64, window: windowProvider?()) { path, error in
                    if let error { done(.failure(BridgeError(error))); return }
                    done(.success(path.map { ["saved": true, "path": $0] as [String: Any] } ?? ["saved": false]))
                }
            case "clipboard.write":
                let text = try Validate.string(p["text"], "text", max: 1_000_000)
                var clear: Int? = nil
                if let v = p["clearAfterSeconds"], !(v is NSNull) { clear = try Validate.int(v, "clearAfterSeconds", range: 1...3600) }
                services.writeClipboard(text, clearAfter: clear)
                done(.success(["ok": true]))
            case "app.setBadge":
                services.setBadge(try Validate.int(p["count"], "count", range: 0...999_999))
                done(.success(["ok": true]))
            case "app.setFocusTimer":
                let label = try Validate.optString(p["label"], "label", max: 40)
                let phase = try Validate.optString(p["phase"], "phase", max: 10)
                guard phase == nil || phase == "focus" || phase == "break" else { throw BridgeError("phase must be focus or break") }
                services.setFocusTimer(label: label, phase: phase)
                done(.success(["ok": true]))
            case "app.openExternal":
                let s = try Validate.string(p["url"], "url", max: 4000)
                guard let url = URL(string: s), let scheme = url.scheme?.lowercased(),
                      ["http", "https", "mailto"].contains(scheme) else { throw BridgeError("only http(s) and mailto URLs") }
                NSWorkspace.shared.open(url)
                done(.success(["ok": true]))

            // shell-internal
            case "shell.chrome":
                if let s = p["background"] as? String, let c = Self.parseCSSColor(s) { onChrome?(c) }
                done(.success(["ok": true]))
            case "shell.log":
                if logCalls, let m = p["message"] as? String { print("page: \(m.prefix(500))"); fflush(stdout) }
                done(.success(["ok": true]))
            case "selftest.trigger":
                guard selfTestMode, let trigger = onSelfTestTrigger else { throw BridgeError("unknown method") }
                let action = try Validate.string(p["action"], "action", max: 40)
                let arg = try Validate.string(p["arg"] ?? "", "arg", max: 100_000)
                trigger(action, arg) { ok in done(.success(["ok": ok])) }
            case "selftest.done":
                guard selfTestMode else { throw BridgeError("unknown method") }
                onSelfTestDone?(p)
                done(.success(["ok": true]))
            default:
                throw BridgeError("unknown method: \(method)")
            }
        } catch let e as BridgeError {
            done(.failure(e))
        } catch {
            done(.failure(BridgeError(error.localizedDescription)))
        }
    }

    static func jsonObject<T: Encodable>(_ v: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(v))
    }

    /// "rgb(r, g, b)" / "rgba(r, g, b, a)" → NSColor
    static func parseCSSColor(_ s: String) -> NSColor? {
        let nums = s.replacingOccurrences(of: "rgba(", with: "").replacingOccurrences(of: "rgb(", with: "")
            .replacingOccurrences(of: ")", with: "").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard nums.count >= 3 else { return nil }
        let a = nums.count >= 4 ? nums[3] : 1
        guard a > 0.5 else { return nil }
        return NSColor(srgbRed: nums[0] / 255, green: nums[1] / 255, blue: nums[2] / 255, alpha: 1)
    }
}
