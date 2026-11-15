import Foundation
import AppKit

/// Pomodoro timer. A finished focus period increments the task's `pomodoros.done`,
/// logs a FocusSession and starts the break; a finished break logs a break session.
final class FocusTimer: ObservableObject {
    enum Phase: String { case idle, focus, `break` }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var taskId: String?
    @Published private(set) var remaining: TimeInterval = 0
    @Published private(set) var paused = false
    @Published var menuBarVisible = false

    weak var store: AppStore?
    private var endsAt: Date?
    private var startedAt: Date?
    private var plannedMinutes = 0
    private var timer: Timer?

    var isActive: Bool { phase != .idle }
    var label: String {
        let s = max(0, Int(remaining.rounded()))
        return String(format: "%02d:%02d", s / 60, s % 60)
    }
    var taskTitle: String? { store?.task(taskId)?.title }
    var progress: Double {
        guard plannedMinutes > 0 else { return 0 }
        return 1 - remaining / Double(plannedMinutes * 60)
    }

    func start(taskId: String?) {
        guard let store else { return }
        if phase == .focus { logSession(completed: false) }
        self.taskId = taskId
        begin(.focus, minutes: max(1, store.data.settings.focusMinutes))
        Reminders.shared.requestAuthorization()
    }

    func startBreak() {
        guard let store else { return }
        begin(.break, minutes: max(1, store.data.settings.breakMinutes))
    }

    private func begin(_ p: Phase, minutes: Int) {
        phase = p
        plannedMinutes = minutes
        startedAt = Date()
        endsAt = Date().addingTimeInterval(TimeInterval(minutes * 60))
        remaining = TimeInterval(minutes * 60)
        paused = false
        menuBarVisible = true
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
    }

    func togglePause() {
        guard isActive else { return }
        if paused {
            endsAt = Date().addingTimeInterval(remaining)
            paused = false
        } else {
            paused = true
        }
    }

    func stop() {
        if phase == .focus { logSession(completed: false) }
        timer?.invalidate(); timer = nil
        phase = .idle; taskId = nil; remaining = 0; paused = false; endsAt = nil
        menuBarVisible = false
    }

    private func tick() {
        guard isActive, !paused, let endsAt else { return }
        remaining = max(0, endsAt.timeIntervalSinceNow)
        if remaining <= 0 { finish() }
    }

    private func finish() {
        timer?.invalidate(); timer = nil
        let finished = phase
        logSession(completed: true)
        if finished == .focus {
            Reminders.shared.notifyNow(title: "Focus session complete 🍅",
                                       body: (taskTitle.map { "\($0) — " } ?? "") + "time for a \(store?.data.settings.breakMinutes ?? 5)-minute break.")
            startBreak()
        } else {
            Reminders.shared.notifyNow(title: "Break is over", body: "Ready for the next focus session?")
            phase = .idle; taskId = nil; remaining = 0; menuBarVisible = false
        }
    }

    /// Records the session; a completed focus period also increments pomodoros.done.
    private func logSession(completed: Bool) {
        guard let store, let start = startedAt else { return }
        let end = Date()
        let minutes = completed ? plannedMinutes : Int(end.timeIntervalSince(start) / 60)
        startedAt = nil
        guard minutes >= 1 else { return }
        let session = FocusSession(taskId: taskId, start: ISO.string(start), end: ISO.string(end), minutes: minutes,
                                   kind: phase == .break ? .break : .focus)
        let tid = taskId
        let isFocus = phase == .focus
        store.mutate(isFocus ? "Focus Session" : "Break") { data in
            data.focusSessions.append(session)
            if completed && isFocus, let tid, let i = data.tasks.firstIndex(where: { $0.id == tid }) {
                data.tasks[i].pomodoros.done += 1
            }
        }
    }
}
