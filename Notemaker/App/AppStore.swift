import SwiftUI
import AppKit
import UniformTypeIdentifiers

enum SidebarItem: String, CaseIterable, Identifiable {
    case day, calendar, planner, board, habits, insights, search
    var id: String { rawValue }
    var title: String {
        switch self {
        case .day: return "Day"
        case .calendar: return "Calendar"
        case .planner: return "Planner"
        case .board: return "Board"
        case .habits: return "Habits"
        case .insights: return "Insights"
        case .search: return "Search"
        }
    }
    var icon: String {
        switch self {
        case .day: return "sun.max"
        case .calendar: return "calendar"
        case .planner: return "clock"
        case .board: return "rectangle.split.3x1"
        case .habits: return "repeat.circle"
        case .insights: return "chart.bar.xaxis"
        case .search: return "magnifyingglass"
        }
    }
    var shortcut: KeyEquivalent { KeyEquivalent(Character(String((SidebarItem.allCases.firstIndex(of: self) ?? 0) + 1))) }
}

enum ActiveSheet: String, Identifiable {
    case palette, help, review, templates
    var id: String { rawValue }
}

enum StatusFilter: String, CaseIterable, Identifiable { case all = "All", active = "Active", completed = "Completed"; var id: String { rawValue } }
enum SortMode: String, CaseIterable, Identifiable { case manual = "Manual", priority = "Priority"; var id: String { rawValue } }

/// Single source of truth for the app. Every user-visible change goes through `mutate`,
/// which registers an undo step and schedules a debounced atomic save.
final class AppStore: ObservableObject {
    @Published var data: AppData
    @Published var selectedDay: String = Day.today()
    @Published var view: SidebarItem = .day
    @Published var selectedTaskId: String?
    @Published var sheet: ActiveSheet?
    @Published var statusFilter: StatusFilter = .all
    @Published var priorityFilter: Priority? = nil
    @Published var tagFilter: String? = nil
    @Published var sortMode: SortMode = .manual
    @Published var searchQuery: String = ""
    @Published var focusQuickAdd = 0          // bump to focus the quick-add field
    @Published var focusSearch = 0
    @Published var unlockedNotes: [String: String] = [:]   // plaintext of locked notes (memory only)
    @Published var lastError: String?
    @Published var today: String = Day.today()

    let undoManager = UndoManager()
    let focus = FocusTimer()
    private var noteKeys: [String: (key: Data, salt: Data, iterations: Int)] = [:]
    private var saveWork: DispatchWorkItem?
    private var noteEncryptWork: [String: DispatchWorkItem] = [:]
    private var ticker: Timer?
    private let fileURL: URL

    init(fileURL: URL = DataFile.defaultURL) {
        self.fileURL = fileURL
        var loaded: AppData
        var loadError: String?
        do {
            if let d = try DataFile.load(fileURL) {
                loaded = d
            } else if let v1 = Migration.findMacV1Defaults(),
                      let migrated = try Migration.fromMacV1(tasksData: v1.tasks, notesData: v1.notes) {
                loaded = migrated      // v1 keys are intentionally kept as a backup
                loaded.templates = Templates.builtIns
            } else {
                loaded = AppData()
                loaded.templates = Templates.builtIns
            }
        } catch {
            if FileManager.default.fileExists(atPath: fileURL.path) {
                // Never overwrite an unreadable data file: keep a copy aside and start fresh.
                loadError = "Could not read data.json (\(error.localizedDescription)). A copy was saved as data.corrupt.json."
                let backup = fileURL.deletingLastPathComponent().appendingPathComponent("data.corrupt.json")
                try? FileManager.default.removeItem(at: backup)
                try? FileManager.default.copyItem(at: fileURL, to: backup)
            } else {
                loadError = "Could not migrate the v1 data (\(error.localizedDescription)). The v1 data was left untouched."
            }
            loaded = AppData()
            loaded.templates = Templates.builtIns
        }
        data = loaded
        lastError = loadError
        if loaded.settings.autoRollover { TaskOps.rollover(&data.tasks, today: today) }
        if loadError == nil { saveNow() }   // don't create data.json over a failed load/migration
        focus.store = self
        ticker = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.tick() }
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            self?.flushNoteEncryption()
            self?.saveNow()
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            applyAppearance(self.data.settings.theme)
            Reminders.shared.reschedule(self.data)
        }
    }

    // MARK: Persistence

    func scheduleSave() {
        saveWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.saveNow() }
        saveWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: w)
    }

    func saveNow() {
        saveWork?.cancel(); saveWork = nil
        do { try DataFile.save(data, to: fileURL) } catch { lastError = "Save failed: \(error.localizedDescription)" }
    }

    var dataFileURL: URL { fileURL }

    // MARK: Mutation + undo

    /// Apply a change with undo support. Undo restores the previous snapshot, but keeps the current
    /// notes/settings unless the change itself touched them (note text has its own text undo).
    func mutate(_ name: String, touchesNotes: Bool = false, touchesSettings: Bool = false, _ f: (inout AppData) -> Void) {
        let old = data
        var new = data
        f(&new)
        guard new != old else { return }
        data = new
        registerUndo(old, name: name, touchesNotes: touchesNotes, touchesSettings: touchesSettings)
        afterChange(remindersChanged: true)
    }

    private func registerUndo(_ snapshot: AppData, name: String, touchesNotes: Bool, touchesSettings: Bool) {
        undoManager.registerUndo(withTarget: self) { s in
            var snap = snapshot
            if !touchesNotes { snap.notes = s.data.notes }
            if !touchesSettings { snap.settings = s.data.settings }
            let current = s.data
            s.data = snap
            s.registerUndo(current, name: name, touchesNotes: touchesNotes, touchesSettings: touchesSettings)
            s.afterChange(remindersChanged: true)
        }
        undoManager.setActionName(name)
    }

    func afterChange(remindersChanged: Bool) {
        objectWillChange.send()
        scheduleSave()
        if remindersChanged { Reminders.shared.rescheduleDebounced(data) }
    }

    func undo() { if undoManager.canUndo { undoManager.undo() } }
    func redo() { if undoManager.canRedo { undoManager.redo() } }

    // MARK: Navigation

    func go(_ day: String, view v: SidebarItem? = .day) {
        guard Day.isValid(day) else { return }
        selectedDay = day
        if let v { view = v }
    }
    func shiftDay(_ n: Int) { selectedDay = Day.add(selectedDay, days: n) }
    func goToday() { selectedDay = Day.today(); today = Day.today() }

    // MARK: Periodic work (midnight rollover, review prompt)

    private func tick() {
        let now = Day.today()
        if now != today {
            today = now
            if data.settings.autoRollover {
                var tasks = data.tasks
                if TaskOps.rollover(&tasks, today: now) > 0 { data.tasks = tasks; afterChange(remindersChanged: true) }
            }
        }
        if let rt = data.settings.reviewTime, let mins = HM.minutes(rt), HM.nowMinutes() >= mins,
           UserDefaults.standard.string(forKey: "lastReviewPrompt") != now, sheet == nil {
            UserDefaults.standard.set(now, forKey: "lastReviewPrompt")
            selectedDay = now
            sheet = .review
            NSApp.requestUserAttention(.informationalRequest)
        }
    }

    // MARK: Tasks

    func tasks(on d: String) -> [TaskItem] { Occurrence.tasks(data.tasks, on: d) }

    func filteredTasks(on d: String) -> [TaskItem] {
        var ts = tasks(on: d)
        switch statusFilter {
        case .all: break
        case .active: ts = ts.filter { !Occurrence.isDone($0, on: d) }
        case .completed: ts = ts.filter { Occurrence.isDone($0, on: d) }
        }
        if let p = priorityFilter { ts = ts.filter { $0.priority == p } }
        if let t = tagFilter { ts = ts.filter { $0.tags.contains(t) } }
        if sortMode == .priority {
            ts = ts.enumerated().sorted { a, b in
                a.element.priority.rank != b.element.priority.rank ? a.element.priority.rank > b.element.priority.rank : a.offset < b.offset
            }.map(\.element)
        }
        return ts
    }

    var allTags: [String] { Array(Set(data.tasks.flatMap(\.tags))).sorted() }

    func task(_ id: String?) -> TaskItem? { data.tasks.first { $0.id == id } }

    func nextOrder(on d: String) -> Double { (tasks(on: d).map(\.order).max() ?? -1) + 1 }

    @discardableResult
    func addQuick(_ text: String) -> TaskItem? {
        let r = QuickAdd.parse(text, today: Day.today(), defaultDate: selectedDay)
        guard !r.title.isEmpty else { return nil }
        let t = r.makeTask(order: nextOrder(on: r.date))
        mutate("Add Task") { $0.tasks.append(t) }
        if t.reminder != nil { Reminders.shared.requestAuthorization() }
        return t
    }

    func update(_ id: String, _ name: String = "Edit Task", _ f: (inout TaskItem) -> Void) {
        mutate(name) { d in
            if let i = d.tasks.firstIndex(where: { $0.id == id }) { f(&d.tasks[i]) }
        }
    }

    func toggleDone(_ t: TaskItem, on d: String) {
        let done = !Occurrence.isDone(t, on: d)
        update(t.id, done ? "Complete Task" : "Reopen Task") { TaskOps.setDone(&$0, done, on: d) }
    }

    func setStatus(_ id: String, _ s: TaskStatus, on d: String) {
        update(id, "Move Task") { TaskOps.setStatus(&$0, s, on: d) }
    }

    func delete(_ t: TaskItem, onlyOccurrence day: String? = nil) {
        if let day, t.isRecurring {
            update(t.id, "Delete Occurrence") { TaskOps.skip(&$0, on: day) }
        } else {
            mutate("Delete Task") { $0.tasks.removeAll { $0.id == t.id } }
            if selectedTaskId == t.id { selectedTaskId = nil }
        }
    }

    func move(on d: String, from: IndexSet, to: Int) {
        var ids = filteredTasks(on: d).map(\.id)
        ids.move(fromOffsets: from, toOffset: to)
        mutate("Reorder Tasks") { data in
            for (i, id) in ids.enumerated() {
                if let j = data.tasks.firstIndex(where: { $0.id == id }) { data.tasks[j].order = Double(i) }
            }
        }
    }

    func snooze(_ id: String, to d: String) { update(id, "Snooze Task") { TaskOps.snooze(&$0, to: d) } }

    /// Forward incomplete (non-recurring) tasks of the selected day to the next day.
    func forwardIncomplete(from d: String) {
        let next = Day.add(d, days: 1)
        mutate("Forward Tasks") { data in
            for i in data.tasks.indices where !data.tasks[i].isRecurring && !data.tasks[i].done && data.tasks[i].date == d {
                data.tasks[i].date = next
            }
        }
    }

    // MARK: Notes

    func note(_ d: String) -> Note? { data.notes[d] }
    func isLocked(_ d: String) -> Bool { data.notes[d]?.locked == true }
    func isUnlocked(_ d: String) -> Bool { unlockedNotes[d] != nil }

    /// Current editable markdown of a day (plaintext for unlocked private notes).
    func markdown(_ d: String) -> String {
        if isLocked(d) { return unlockedNotes[d] ?? "" }
        return data.notes[d]?.markdown ?? ""
    }

    /// Text edits: no snapshot undo (the text view has its own), debounced save.
    func setMarkdown(_ d: String, _ md: String) {
        if isLocked(d) {
            guard unlockedNotes[d] != nil, unlockedNotes[d] != md else { return }
            unlockedNotes[d] = md
            scheduleReencrypt(d)
            return
        }
        guard data.notes[d]?.markdown != md else { return }
        if md.isEmpty, data.notes[d] != nil, data.notes[d]?.extra.isEmpty == true {
            data.notes.removeValue(forKey: d)
        } else {
            var n = data.notes[d] ?? Note()
            n.markdown = md; n.updatedAt = ISO.string()
            data.notes[d] = n
        }
        afterChange(remindersChanged: false)
    }

    func appendToNote(_ d: String, _ text: String) {
        let cur = markdown(d)
        let sep = cur.isEmpty ? "" : (cur.hasSuffix("\n\n") ? "" : (cur.hasSuffix("\n") ? "\n" : "\n\n"))
        if isLocked(d) && !isUnlocked(d) { lastError = "Unlock the note first."; return }
        if isLocked(d) { setMarkdown(d, cur + sep + text); return }
        mutate("Edit Note", touchesNotes: true) { data in
            var n = data.notes[d] ?? Note()
            n.markdown = cur + sep + text; n.updatedAt = ISO.string()
            data.notes[d] = n
        }
    }

    // MARK: Private notes

    var hasPasscode: Bool { data.settings.lockHash != nil }

    func verifyPasscode(_ p: String) -> Bool {
        guard let lh = data.settings.lockHash else { return false }
        return NoteCrypto.verify(p, lh)
    }

    func unlock(_ d: String, passcode: String) -> Bool {
        guard let c = data.notes[d]?.cipher, let salt = Data(base64Encoded: c.salt),
              let key = try? NoteCrypto.pbkdf2(passcode, salt: salt, iterations: c.iterations),
              let plain = try? NoteCrypto.decrypt(c, key: key) else { return false }
        noteKeys[d] = (key, salt, c.iterations)
        unlockedNotes[d] = plain
        return true
    }

    func relock(_ d: String) {
        flushNoteEncryption()
        unlockedNotes.removeValue(forKey: d)
        noteKeys.removeValue(forKey: d)
    }

    func lock(_ d: String, passcode: String) -> Bool {
        guard verifyPasscode(passcode) else { return false }
        let plain = data.notes[d]?.markdown ?? ""
        guard let c = try? NoteCrypto.encrypt(plain, passcode: passcode) else { return false }
        mutate("Lock Note", touchesNotes: true) { data in
            var n = data.notes[d] ?? Note()
            n.markdown = ""; n.locked = true; n.cipher = c; n.updatedAt = ISO.string()
            data.notes[d] = n
        }
        unlockedNotes.removeValue(forKey: d)
        return true
    }

    /// Permanently decrypt a note (requires it to be unlocked).
    func removeLock(_ d: String) {
        guard let plain = unlockedNotes[d] else { return }
        noteEncryptWork[d]?.cancel()
        mutate("Remove Note Lock", touchesNotes: true) { data in
            var n = data.notes[d] ?? Note()
            n.markdown = plain; n.locked = false; n.cipher = nil; n.updatedAt = ISO.string()
            data.notes[d] = n
        }
        unlockedNotes.removeValue(forKey: d); noteKeys.removeValue(forKey: d)
    }

    private func scheduleReencrypt(_ d: String) {
        noteEncryptWork[d]?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.reencrypt(d) }
        noteEncryptWork[d] = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: w)
    }

    private func reencrypt(_ d: String) {
        noteEncryptWork[d] = nil
        guard let plain = unlockedNotes[d], let k = noteKeys[d],
              let c = try? NoteCrypto.encrypt(plain, key: k.key, salt: k.salt, iterations: k.iterations) else { return }
        var n = data.notes[d] ?? Note()
        n.cipher = c; n.markdown = ""; n.locked = true; n.updatedAt = ISO.string()
        data.notes[d] = n
        afterChange(remindersChanged: false)
    }

    func flushNoteEncryption() {
        for (d, w) in noteEncryptWork { w.cancel(); reencrypt(d) }
    }

    /// Set or change the passcode; re-encrypts every locked note. Returns an error message on failure.
    func changePasscode(old: String?, new: String) -> String? {
        guard new.count >= 4 else { return "Use at least 4 characters." }
        flushNoteEncryption()
        var notes = data.notes
        if let lh = data.settings.lockHash {
            guard let old, NoteCrypto.verify(old, lh) else { return "Current passcode is wrong." }
            for (d, n) in notes where n.locked {
                guard let c = n.cipher, let plain = try? NoteCrypto.decrypt(c, passcode: old),
                      let nc = try? NoteCrypto.encrypt(plain, passcode: new) else { return "Could not re-encrypt the note of \(d)." }
                notes[d]?.cipher = nc
            }
        }
        guard let lh = try? NoteCrypto.makeLockHash(new) else { return "Could not derive the passcode hash." }
        mutate("Change Passcode", touchesNotes: true, touchesSettings: true) { data in
            data.notes = notes
            data.settings.lockHash = lh
        }
        unlockedNotes = [:]; noteKeys = [:]
        return nil
    }

    // MARK: Settings

    func updateSettings(_ f: (inout Settings) -> Void) {
        let oldTheme = data.settings.theme
        mutate("Change Settings", touchesSettings: true) { f(&$0.settings) }
        if data.settings.theme != oldTheme { applyAppearance(data.settings.theme) }
    }

    // MARK: Habits

    func toggleHabit(_ id: String, on d: String) {
        mutate("Check Habit") { data in
            guard let i = data.habits.firstIndex(where: { $0.id == id }) else { return }
            if data.habits[i].log[d] == true { data.habits[i].log.removeValue(forKey: d) } else { data.habits[i].log[d] = true }
        }
    }

    // MARK: Import / export

    func exportBackup() {
        let p = NSSavePanel()
        p.allowedContentTypes = [.json]
        p.nameFieldStringValue = "notemaker_backup_\(Day.today()).json"
        guard p.runModal() == .OK, let url = p.url else { return }
        flushNoteEncryption()
        var d = data
        d.exportedAt = ISO.string()
        do { try d.jsonData().write(to: url, options: .atomic) } catch { lastError = "Export failed: \(error.localizedDescription)" }
    }

    func importBackup() {
        let p = NSOpenPanel()
        p.allowedContentTypes = [.json]
        p.allowsMultipleSelection = false
        guard p.runModal() == .OK, let url = p.url else { return }
        do {
            let incoming = try Migration.parseImport(try Data(contentsOf: url))
            let a = NSAlert()
            a.messageText = "Import backup"
            a.informativeText = "The file contains:\n\(Migration.summary(incoming))\n\nMerge it with your data, or replace everything? (You can undo.)"
            a.addButton(withTitle: "Merge")
            a.addButton(withTitle: "Replace")
            a.addButton(withTitle: "Cancel")
            switch a.runModal() {
            case .alertFirstButtonReturn:
                mutate("Import", touchesNotes: true) { $0 = Migration.merge($0, incoming) }
            case .alertSecondButtonReturn:
                mutate("Import (Replace)", touchesNotes: true, touchesSettings: true) { data in
                    var inc = incoming
                    if inc.templates.isEmpty { inc.templates = data.templates }
                    data = inc
                }
                unlockedNotes = [:]; noteKeys = [:]
                applyAppearance(data.settings.theme)
            default: break
            }
        } catch {
            lastError = "Import failed: \(error.localizedDescription)"
        }
    }

    func exportMarkdown(week: Bool) {
        flushNoteEncryption()
        let md = week ? MarkdownExport.week(data, containing: selectedDay, unlocked: unlockedNotes)
                      : MarkdownExport.day(data, selectedDay, unlocked: unlockedNotes)
        let p = NSSavePanel()
        p.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        p.nameFieldStringValue = week ? "Notemaker-week-\(Day.weekStart(of: selectedDay, weekStartsOn: data.settings.weekStartsOn)).md"
                                      : "Notemaker-\(selectedDay).md"
        guard p.runModal() == .OK, let url = p.url else { return }
        do { try md.write(to: url, atomically: true, encoding: .utf8) } catch { lastError = "Export failed: \(error.localizedDescription)" }
    }
}
