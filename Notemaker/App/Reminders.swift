import Foundation
import AppKit
import UserNotifications

/// Task reminders and focus-timer notifications via UNUserNotificationCenter.
final class Reminders: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = Reminders()
    static let prefix = "task-"

    @Published var authorization: UNAuthorizationStatus = .notDetermined
    var onOpenDay: ((String) -> Void)?
    private var work: DispatchWorkItem?

    private var center: UNUserNotificationCenter? {
        // UNUserNotificationCenter requires a bundled app; avoid crashing when run as a bare binary.
        Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
    }

    override init() {
        super.init()
        center?.delegate = self
        refreshStatus()
    }

    func refreshStatus() {
        center?.getNotificationSettings { s in
            DispatchQueue.main.async { self.authorization = s.authorizationStatus }
        }
    }

    func requestAuthorization(_ done: ((Bool) -> Void)? = nil) {
        guard let center else { done?(false); return }
        center.requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
            DispatchQueue.main.async {
                self.refreshStatus()
                done?(ok)
            }
        }
    }

    func rescheduleDebounced(_ data: AppData) {
        work?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.reschedule(data) }
        work = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: w)
    }

    /// Remove all pending task reminders and schedule the upcoming ones (next 14 days, ≤ 5 per recurring task).
    func reschedule(_ data: AppData, now: Date = Date()) {
        guard let center else { return }
        let requests = Reminders.plan(data, now: now)
        center.getPendingNotificationRequests { pending in
            let old = pending.map(\.identifier).filter { $0.hasPrefix(Reminders.prefix) }
            center.removePendingNotificationRequests(withIdentifiers: old)
            for r in requests { center.add(r) }
        }
    }

    static func plan(_ data: AppData, now: Date) -> [UNNotificationRequest] {
        let today = Day.key(now)
        var out: [UNNotificationRequest] = []
        for t in data.tasks {
            guard let time = t.reminder, HM.minutes(time) != nil else { continue }
            let days = t.isRecurring ? Occurrence.next(t, from: today, count: 5, horizon: 14)
                                     : (t.date >= today && !t.done ? [t.date] : [])
            for d in days where !Occurrence.isDone(t, on: d) {
                guard let fire = HM.date(day: d, time: time), fire > now else { continue }
                let c = UNMutableNotificationContent()
                c.title = t.title
                c.body = "Reminder · \(time)" + (t.tags.isEmpty ? "" : "  " + t.tags.map { "#\($0)" }.joined(separator: " "))
                c.sound = .default
                c.userInfo = ["day": d, "taskId": t.id]
                let comps = Day.calendar.dateComponents([.year, .month, .day, .hour, .minute], from: fire)
                let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
                out.append(UNNotificationRequest(identifier: "\(prefix)\(t.id)-\(d)", content: c, trigger: trigger))
            }
        }
        out.sort { ($0.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate() ?? .distantFuture
                 < ($1.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate() ?? .distantFuture }
        return Array(out.prefix(60)) // macOS keeps at most 64 pending requests
    }

    func notifyNow(title: String, body: String) {
        guard let center else { NSSound.beep(); return }
        let c = UNMutableNotificationContent()
        c.title = title; c.body = body; c.sound = .default
        center.add(UNNotificationRequest(identifier: "focus-\(UUID().uuidString)", content: c, trigger: nil))
    }

    // Show banners while the app is frontmost.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let d = response.notification.request.content.userInfo["day"] as? String {
            DispatchQueue.main.async {
                NSApp.activate(ignoringOtherApps: true)
                self.onOpenDay?(d)
            }
        }
        completionHandler()
    }
}
