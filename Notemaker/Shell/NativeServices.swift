import AppKit
@preconcurrency import UserNotifications

/// Platform services used by the bridge.
@MainActor
final class NativeServices: NSObject {
    struct Reminder { let id: String; let title: String; let body: String; let at: Date; let day: String }

    nonisolated static let reminderPrefix = "nm-reminder-"
    var onStatusItemClick: (() -> Void)?
    private var statusItem: NSStatusItem?
    private var statusTitle: String?

    // MARK: Blobs (vault-blobs/<id>.bin = iv ‖ ct)

    var blobsDir: URL { DataFile.root.appendingPathComponent("vault-blobs", isDirectory: true) }

    func putBlob(id: String, data: Data) throws {
        try FileManager.default.createDirectory(at: blobsDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = blobsDir.appendingPathComponent("\(id).bin")
        try data.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    func getBlob(id: String) -> Data? { try? Data(contentsOf: blobsDir.appendingPathComponent("\(id).bin")) }
    func deleteBlob(id: String) { try? FileManager.default.removeItem(at: blobsDir.appendingPathComponent("\(id).bin")) }

    // MARK: Notifications

    private var center: UNUserNotificationCenter? { Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current() }

    nonisolated static func statusString(_ s: UNAuthorizationStatus) -> String {
        switch s {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        default: return "default"
        }
    }

    func notificationStatus(_ done: @escaping (String) -> Void) {
        guard let center else { done("denied"); return }
        center.getNotificationSettings { s in
            let st = Self.statusString(s.authorizationStatus)
            DispatchQueue.main.async { done(st) }
        }
    }

    func requestNotifications(_ done: @escaping (String) -> Void) {
        guard let center else { done("denied"); return }
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            center.getNotificationSettings { s in
                let st = Self.statusString(s.authorizationStatus)
                DispatchQueue.main.async { done(st) }
            }
        }
    }

    /// Replace all pending Notemaker reminders. Calendar triggers fire even when the app isn't running.
    func syncNotifications(_ items: [Reminder], _ done: @escaping (Int) -> Void) {
        guard let center else { done(0); return }
        let now = Date()
        let requests: [UNNotificationRequest] = items.filter { $0.at > now }.map { r in
            let c = UNMutableNotificationContent()
            c.title = r.title
            c.body = r.body
            c.sound = .default
            c.userInfo = ["day": r.day]
            let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: r.at)
            let safeId = r.id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." }
            return UNNotificationRequest(identifier: Self.reminderPrefix + safeId,
                                         content: c, trigger: UNCalendarNotificationTrigger(dateMatching: comps, repeats: false))
        }
        center.getPendingNotificationRequests { pending in
            let old = pending.map(\.identifier).filter { $0.hasPrefix(Self.reminderPrefix) }
            center.removePendingNotificationRequests(withIdentifiers: old)
            let group = DispatchGroup()
            var ok = 0
            let lock = NSLock()
            for r in requests {
                group.enter()
                center.add(r) { err in
                    if err == nil { lock.lock(); ok += 1; lock.unlock() }
                    group.leave()
                }
            }
            group.notify(queue: .main) { done(ok) }
        }
    }

    func showNotification(title: String, body: String) {
        guard let center else { NSSound.beep(); return }
        let c = UNMutableNotificationContent()
        c.title = title; c.body = body; c.sound = .default
        center.add(UNNotificationRequest(identifier: "nm-now-\(UUID().uuidString)", content: c, trigger: nil))
    }

    // MARK: Files

    /// NSSavePanel; the base64 payload (up to 1 GB decoded) is decoded and written off the main thread.
    func saveFile(name: String, base64: String, window: NSWindow?, _ done: @escaping (String?, String?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (name as NSString).lastPathComponent   // e.g. "Notemaker transfer 2026-11-16.notemaker"
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        panel.allowsOtherFileTypes = true      // no allowedContentTypes: any extension (incl. .notemaker) is kept as typed
        let finish: (NSApplication.ModalResponse) -> Void = { resp in
            guard resp == .OK, let url = panel.url else { done(nil, nil); return }
            DispatchQueue.global(qos: .userInitiated).async {
                var err: String?
                if let data = Data(base64Encoded: base64) {
                    do { try data.write(to: url, options: [.atomic]) } catch { err = error.localizedDescription }
                } else {
                    err = "base64 is not valid"
                }
                DispatchQueue.main.async { err == nil ? done(url.path, nil) : done(nil, err) }
            }
        }
        if let window { panel.beginSheetModal(for: window, completionHandler: finish) } else { finish(panel.runModal()) }
    }

    // MARK: Clipboard

    static let concealedType = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
    static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    /// `concealed`: clipboard managers skip it (nspasteboard.org markers) and it never leaves this Mac
    /// (current-host-only = no Universal Clipboard / Handoff).
    func writeClipboard(_ text: String, clearAfter seconds: Int?, concealed: Bool = false, pasteboard: NSPasteboard = .general) {
        let pb = pasteboard
        pb.clearContents()
        if concealed {
            pb.prepareForNewContents(with: .currentHostOnly)
            pb.setString(text, forType: .string)
            pb.setData(Data(), forType: Self.concealedType)
            pb.setData(Data(), forType: Self.transientType)
        } else {
            pb.setString(text, forType: .string)
        }
        guard let seconds else { return }
        let count = pb.changeCount
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(seconds)) {
            if pb.changeCount == count { pb.clearContents() }
        }
    }

    // MARK: Dock badge & status item

    func setBadge(_ n: Int) {
        let label: String? = n > 0 ? String(n) : nil
        if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }
    }

    func setFocusTimer(label: String?, phase: String?) {
        guard let label else {
            if let s = statusItem { NSStatusBar.system.removeStatusItem(s); statusItem = nil; statusTitle = nil }
            return
        }
        if statusItem == nil {
            let s = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            s.button?.target = self
            s.button?.action = #selector(statusClicked)
            s.button?.imagePosition = .imageLeading
            statusItem = s
        }
        let title = " " + label
        guard title != statusTitle else { return }      // avoid needless redraws every second
        statusTitle = title
        let symbol = phase == "break" ? "cup.and.saucer.fill" : "timer"
        statusItem?.button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: phase ?? "focus")
        statusItem?.button?.attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)])
        statusItem?.button?.toolTip = phase == "break" ? "Notemaker — break" : "Notemaker — focus"
    }

    @objc private func statusClicked() { onStatusItemClick?() }
}

/// UNUserNotificationCenter delegate (its callbacks are not main-actor bound).
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    let onOpenDay: @Sendable (String) -> Void
    init(onOpenDay: @escaping @Sendable (String) -> Void) { self.onOpenDay = onOpenDay }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let day = response.notification.request.content.userInfo["day"] as? String { onOpenDay(day) }
        completionHandler()
    }
}
