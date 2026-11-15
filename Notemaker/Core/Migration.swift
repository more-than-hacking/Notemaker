import Foundation

/// v1 → v2 conversion and import parsing (docs/DATA_FORMAT.md "Migration from v1").
enum Migration {
    // macOS v1 shapes, as encoded by a default JSONEncoder (Date = seconds since 2001-01-01).
    struct MacV1Task: Codable { var id: UUID; var title: String; var isCompleted: Bool; var date: Date; var createdAt: Date }
    struct MacV1Note: Codable { var id: UUID; var content: String; var date: Date; var createdAt: Date }

    enum ImportError: Error, LocalizedError {
        case notJSON, unknownShape
        var errorDescription: String? {
            switch self {
            case .notJSON: return "The file is not valid JSON."
            case .unknownShape: return "The file is not a Notemaker backup (v1 or v2)."
            }
        }
    }

    /// Convert macOS v1 UserDefaults blobs. Returns nil when there is nothing to migrate.
    static func fromMacV1(tasksData: Data?, notesData: Data?) throws -> AppData? {
        if tasksData == nil && notesData == nil { return nil }
        var data = AppData()
        let dec = JSONDecoder()
        if let td = tasksData {
            let old = try dec.decode([MacV1Task].self, from: td)
            var orderByDay: [String: Double] = [:]
            for o in old.sorted(by: { $0.createdAt < $1.createdAt }) {
                let day = Day.key(o.date)
                var t = TaskItem(title: o.title, date: day)
                t.id = o.id.uuidString
                t.done = o.isCompleted
                t.status = o.isCompleted ? .done : .todo
                t.createdAt = ISO.string(o.createdAt)
                t.completedAt = o.isCompleted ? ISO.string(o.createdAt) : nil
                t.order = orderByDay[day, default: 0]
                orderByDay[day] = t.order + 1
                data.tasks.append(t)
            }
        }
        if let nd = notesData {
            let old = try dec.decode([MacV1Note].self, from: nd)
            for o in old.sorted(by: { $0.createdAt < $1.createdAt }) {
                let day = Day.key(o.date)
                if var existing = data.notes[day] {
                    if !o.content.isEmpty { existing.markdown += (existing.markdown.isEmpty ? "" : "\n\n") + o.content }
                    data.notes[day] = existing
                } else if !o.content.isEmpty {
                    data.notes[day] = Note(markdown: o.content, updatedAt: ISO.string(o.createdAt))
                }
            }
        }
        return data
    }

    /// Bundle id of the v1 macOS app (its UserDefaults domain). v2 uses com.mth.notemaker.
    static let v1Domains = ["com.notemaker.app"]

    /// Locate macOS v1 `saved_tasks` / `saved_notes`: the current app's defaults, the v1 bundle's
    /// defaults domain, or the v1 sandbox container's preferences plist. Nothing is modified.
    static func findMacV1Defaults() -> (tasks: Data?, notes: Data?)? {
        var sources: [UserDefaults] = [UserDefaults.standard]
        for d in v1Domains { if let u = UserDefaults(suiteName: d) { sources.append(u) } }
        for u in sources {
            let t = u.data(forKey: "saved_tasks"), n = u.data(forKey: "saved_notes")
            if t != nil || n != nil { return (t, n) }
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        for d in v1Domains {
            let url = home.appendingPathComponent("Library/Containers/\(d)/Data/Library/Preferences/\(d).plist")
            if let dict = NSDictionary(contentsOf: url) {
                let t = dict["saved_tasks"] as? Data, n = dict["saved_notes"] as? Data
                if t != nil || n != nil { return (t, n) }
            }
        }
        return nil
    }

    /// Web v1 (localStorage arrays or the v1 export `{version:"1.0", exportDate, tasks:[], notes:[]}`).
    static func fromWebV1(tasks: [[String: Any]], notes: [[String: Any]]) -> AppData {
        var data = AppData()
        var orderByDay: [String: Double] = [:]
        for o in tasks {
            let day = (o["date"] as? String).map { String($0.prefix(10)) } ?? Day.today()
            var t = TaskItem(title: o["title"] as? String ?? "", date: day)
            if let id = o["id"] as? String { t.id = id } else if let id = o["id"] as? NSNumber { t.id = id.stringValue }
            t.done = o["completed"] as? Bool ?? false
            t.status = t.done ? .done : .todo
            t.createdAt = o["createdAt"] as? String ?? ISO.string()
            t.completedAt = t.done ? t.createdAt : nil
            t.subtasks = (o["subtasks"] as? [[String: Any]] ?? []).map {
                let sid = ($0["id"] as? String) ?? ($0["id"] as? NSNumber)?.stringValue ?? UUID().uuidString
                return Subtask(id: sid, title: $0["title"] as? String ?? "", done: $0["completed"] as? Bool ?? false)
            }
            t.order = orderByDay[day, default: 0]
            orderByDay[day] = t.order + 1
            data.tasks.append(t)
        }
        for o in notes {
            guard let day = (o["date"] as? String).map({ String($0.prefix(10)) }) else { continue }
            let content = o["content"] as? String ?? ""
            let at = o["updatedAt"] as? String ?? o["createdAt"] as? String ?? ISO.string()
            if var n = data.notes[day] { n.markdown += "\n\n" + content; data.notes[day] = n }
            else { data.notes[day] = Note(markdown: content, updatedAt: at) }
        }
        return data
    }

    /// Parse any supported backup file into v2 data.
    static func parseImport(_ raw: Data) throws -> AppData {
        guard let obj = try? JSONSerialization.jsonObject(with: raw) else { throw ImportError.notJSON }
        guard let dict = obj as? [String: Any] else { throw ImportError.unknownShape }
        if dict["notes"] is [[String: Any]] || (dict["version"] as? String)?.hasPrefix("1") == true {
            return fromWebV1(tasks: dict["tasks"] as? [[String: Any]] ?? [], notes: dict["notes"] as? [[String: Any]] ?? [])
        }
        guard dict["tasks"] != nil || dict["notes"] != nil || dict["version"] != nil else { throw ImportError.unknownShape }
        return try JSONDecoder().decode(AppData.self, from: raw)
    }

    /// Merge `incoming` into `base`: new ids are added; same ids are replaced; notes on the same day
    /// keep the more recently updated one.
    static func merge(_ base: AppData, _ incoming: AppData) -> AppData {
        var out = base
        func mergeList<T: Identifiable>(_ a: [T], _ b: [T]) -> [T] where T.ID == String {
            var r = a
            for x in b {
                if let i = r.firstIndex(where: { $0.id == x.id }) { r[i] = x } else { r.append(x) }
            }
            return r
        }
        out.tasks = mergeList(base.tasks, incoming.tasks)
        out.habits = mergeList(base.habits, incoming.habits)
        out.templates = mergeList(base.templates, incoming.templates)
        out.focusSessions = mergeList(base.focusSessions, incoming.focusSessions)
        for (d, n) in incoming.notes {
            if let cur = out.notes[d], (ISO.date(cur.updatedAt) ?? .distantPast) > (ISO.date(n.updatedAt) ?? .distantPast) { continue }
            out.notes[d] = n
        }
        return out
    }

    /// A short summary of entity counts.
    static func summary(_ d: AppData) -> String {
        let recurring = d.tasks.filter(\.isRecurring).count
        let locked = d.notes.values.filter(\.locked).count
        return """
        tasks: \(d.tasks.count) (recurring \(recurring), done \(d.tasks.filter(\.done).count), subtasks \(d.tasks.reduce(0) { $0 + $1.subtasks.count }))
        notes: \(d.notes.count) (locked \(locked))
        habits: \(d.habits.count)
        templates: \(d.templates.count)
        focusSessions: \(d.focusSessions.count)
        settings: theme=\(d.settings.theme.rawValue) autoRollover=\(d.settings.autoRollover) focus=\(d.settings.focusMinutes)/\(d.settings.breakMinutes) lock=\(d.settings.lockHash != nil)
        """
    }
}

/// JSON file persistence: ~/Library/Application Support/Notemaker/data.json
enum DataFile {
    /// Test hook: redirect the whole Notemaker folder (used by the shell's --bridge-selftest).
    nonisolated(unsafe) static var rootOverride: URL? = nil

    /// ~/Library/Application Support/Notemaker
    static var root: URL {
        if let r = rootOverride { return r }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("Notemaker", isDirectory: true)
    }

    static var defaultURL: URL { root.appendingPathComponent("data.json") }

    static func load(_ url: URL = defaultURL) throws -> AppData? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let raw = try Data(contentsOf: url)
        return try JSONDecoder().decode(AppData.self, from: raw)
    }

    static func save(_ data: AppData, to url: URL = defaultURL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.jsonData().write(to: url, options: [.atomic])
    }
}
