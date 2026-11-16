import Foundation

// Data format v2 — see docs/DATA_FORMAT.md. All coding is explicit so that the JSON
// matches the web app exactly; unknown keys are preserved in `extra`.

enum Priority: String, Codable, CaseIterable, Identifiable {
    case none, low, medium, high
    var id: String { rawValue }
    var rank: Int { switch self { case .high: return 3; case .medium: return 2; case .low: return 1; case .none: return 0 } }
    var label: String { rawValue.capitalized }
}

enum TaskStatus: String, Codable, CaseIterable, Identifiable {
    case todo, doing, done
    var id: String { rawValue }
    var label: String { switch self { case .todo: return "To do"; case .doing: return "Doing"; case .done: return "Done" } }
}

enum Freq: String, Codable, CaseIterable, Identifiable {
    case daily, weekdays, weekly, monthly
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

struct Subtask: Codable, Equatable, Identifiable {
    var id: String = UUID().uuidString
    var title: String
    var done: Bool = false
    var extra: [String: JSONValue] = [:]

    init(id: String = UUID().uuidString, title: String, done: Bool = false) {
        self.id = id; self.title = title; self.done = done
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = c.str("id") ?? c.int("id").map(String.init) ?? UUID().uuidString
        title = c.str("title") ?? ""
        done = c.bool("done") ?? c.bool("completed") ?? false
        extra = c.extras(known: ["id", "title", "done", "completed"])
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("id", id); try c.put("title", title); try c.put("done", done)
    }
}

struct Recurrence: Codable, Equatable {
    var freq: Freq
    var interval: Int = 1
    var byWeekday: [Int] = []
    var until: String? = nil
    var extra: [String: JSONValue] = [:]

    init(freq: Freq, interval: Int = 1, byWeekday: [Int] = [], until: String? = nil) {
        self.freq = freq; self.interval = interval; self.byWeekday = byWeekday; self.until = until
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        freq = Freq(rawValue: c.str("freq") ?? "daily") ?? .daily
        interval = max(1, c.int("interval") ?? 1)
        byWeekday = c.val("byWeekday", [Int].self) ?? []
        until = c.str("until")
        extra = c.extras(known: ["freq", "interval", "byWeekday", "until"])
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("freq", freq.rawValue); try c.put("interval", interval)
        try c.put("byWeekday", byWeekday); try c.putOpt("until", until)
    }
}

struct TimeBlock: Codable, Equatable {
    var start: String
    var end: String
}

struct Pomodoros: Codable, Equatable {
    var estimate: Int = 0
    var done: Int = 0
    init(estimate: Int = 0, done: Int = 0) { self.estimate = estimate; self.done = done }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        estimate = c.int("estimate") ?? 0
        done = c.int("done") ?? 0
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.put("estimate", estimate); try c.put("done", done)
    }
}

struct TaskItem: Codable, Equatable, Identifiable {
    var id: String = UUID().uuidString
    var title: String
    var date: String
    var done: Bool = false
    var completedAt: String? = nil
    var createdAt: String = ISO.string()
    var priority: Priority = .none
    var tags: [String] = []
    var subtasks: [Subtask] = []
    var status: TaskStatus = .todo
    var order: Double = 0
    var recurrence: Recurrence? = nil
    var doneDates: [String: Bool] = [:]
    var skipDates: [String: Bool] = [:]
    var reminder: String? = nil
    var timeBlock: TimeBlock? = nil
    var pomodoros: Pomodoros = Pomodoros()
    var rolledFrom: String? = nil
    var notes: String = ""
    var extra: [String: JSONValue] = [:]

    static let knownKeys: Set<String> = ["id", "title", "date", "done", "completedAt", "createdAt", "priority", "tags",
        "subtasks", "status", "order", "recurrence", "doneDates", "skipDates", "reminder", "timeBlock",
        "pomodoros", "rolledFrom", "notes", "completed"]

    init(title: String, date: String) { self.title = title; self.date = date }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = c.str("id") ?? c.int("id").map(String.init) ?? UUID().uuidString
        title = c.str("title") ?? ""
        date = c.str("date") ?? Day.today()
        done = c.bool("done") ?? c.bool("completed") ?? false
        completedAt = c.str("completedAt")
        createdAt = c.str("createdAt") ?? ISO.string()
        priority = Priority(rawValue: c.str("priority") ?? "none") ?? .none
        tags = (c.val("tags", [String].self) ?? []).map(Tags.normalize).filter { !$0.isEmpty }
        subtasks = c.val("subtasks", [Subtask].self) ?? []
        recurrence = c.val("recurrence", Recurrence.self)
        status = TaskStatus(rawValue: c.str("status") ?? "") ?? (done ? .done : .todo)
        order = c.double("order") ?? 0
        doneDates = c.dateSet("doneDates")
        skipDates = c.dateSet("skipDates")
        reminder = c.str("reminder")
        timeBlock = c.val("timeBlock", TimeBlock.self)
        pomodoros = c.val("pomodoros", Pomodoros.self) ?? Pomodoros()
        rolledFrom = c.str("rolledFrom")
        notes = c.str("notes") ?? ""
        extra = c.extras(known: Self.knownKeys)
        if recurrence == nil { // keep done ⇔ status invariant
            if done { status = .done } else if status == .done { status = .todo }
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("id", id); try c.put("title", title); try c.put("date", date)
        try c.put("done", done); try c.putOpt("completedAt", completedAt); try c.put("createdAt", createdAt)
        try c.put("priority", priority.rawValue); try c.put("tags", tags); try c.put("subtasks", subtasks)
        try c.put("status", status.rawValue)
        if order.rounded() == order && abs(order) < 1e15 { try c.put("order", Int64(order)) } else { try c.put("order", order) }
        try c.putOpt("recurrence", recurrence)
        try c.put("doneDates", doneDates); try c.put("skipDates", skipDates)
        try c.putOpt("reminder", reminder); try c.putOpt("timeBlock", timeBlock)
        try c.put("pomodoros", pomodoros); try c.putOpt("rolledFrom", rolledFrom); try c.put("notes", notes)
    }

    var isRecurring: Bool { recurrence != nil }
}

struct Cipher: Codable, Equatable {
    var alg: String = "AES-GCM-256"
    var kdf: String = "PBKDF2-SHA256"
    var iterations: Int = 210000
    var salt: String
    var iv: String
    var ct: String
}

struct Note: Codable, Equatable {
    var markdown: String = ""
    var updatedAt: String = ISO.string()
    var locked: Bool = false
    var cipher: Cipher? = nil
    var extra: [String: JSONValue] = [:]

    init(markdown: String = "", updatedAt: String = ISO.string()) { self.markdown = markdown; self.updatedAt = updatedAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        markdown = c.str("markdown") ?? c.str("content") ?? ""
        updatedAt = c.str("updatedAt") ?? c.str("createdAt") ?? ISO.string()
        locked = c.bool("locked") ?? false
        cipher = c.val("cipher", Cipher.self)
        extra = c.extras(known: ["markdown", "updatedAt", "locked", "cipher", "content"])
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("markdown", markdown); try c.put("updatedAt", updatedAt)
        try c.put("locked", locked); try c.putOpt("cipher", cipher)
    }
}

struct Habit: Codable, Equatable, Identifiable {
    var id: String = UUID().uuidString
    var name: String
    var color: String = "#4F8EF7"
    var days: [Int] = []
    var createdAt: String = ISO.string()
    var log: [String: Bool] = [:]
    var extra: [String: JSONValue] = [:]

    init(name: String, color: String = "#4F8EF7", days: [Int] = []) { self.name = name; self.color = color; self.days = days }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = c.str("id") ?? UUID().uuidString
        name = c.str("name") ?? ""
        color = c.str("color") ?? "#4F8EF7"
        days = c.val("days", [Int].self) ?? []
        createdAt = c.str("createdAt") ?? ISO.string()
        log = c.dateSet("log")
        extra = c.extras(known: ["id", "name", "color", "days", "createdAt", "log"])
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("id", id); try c.put("name", name); try c.put("color", color); try c.put("days", days)
        try c.put("createdAt", createdAt); try c.put("log", log)
    }
}

struct NoteTemplate: Codable, Equatable, Identifiable {
    var id: String = UUID().uuidString
    var name: String
    var markdown: String
    var extra: [String: JSONValue] = [:]

    init(id: String = UUID().uuidString, name: String, markdown: String) { self.id = id; self.name = name; self.markdown = markdown }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = c.str("id") ?? UUID().uuidString
        name = c.str("name") ?? ""
        markdown = c.str("markdown") ?? ""
        extra = c.extras(known: ["id", "name", "markdown"])
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("id", id); try c.put("name", name); try c.put("markdown", markdown)
    }
}

enum SessionKind: String, Codable { case focus, `break` }

struct FocusSession: Codable, Equatable, Identifiable {
    var id: String = UUID().uuidString
    var taskId: String?
    var start: String
    var end: String
    var minutes: Int
    var kind: SessionKind
    var extra: [String: JSONValue] = [:]

    init(taskId: String?, start: String, end: String, minutes: Int, kind: SessionKind) {
        self.taskId = taskId; self.start = start; self.end = end; self.minutes = minutes; self.kind = kind
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = c.str("id") ?? UUID().uuidString
        taskId = c.str("taskId")
        start = c.str("start") ?? ISO.string()
        end = c.str("end") ?? start
        minutes = c.int("minutes") ?? 0
        kind = SessionKind(rawValue: c.str("kind") ?? "focus") ?? .focus
        extra = c.extras(known: ["id", "taskId", "start", "end", "minutes", "kind"])
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("id", id); try c.putOpt("taskId", taskId); try c.put("start", start); try c.put("end", end)
        try c.put("minutes", minutes); try c.put("kind", kind.rawValue)
    }
}

struct LockHash: Codable, Equatable {
    var salt: String
    var iterations: Int
    var hash: String
}

enum ThemeSetting: String, Codable, CaseIterable, Identifiable {
    case light, dark, system
    var id: String { rawValue }
}

struct Settings: Codable, Equatable {
    var theme: ThemeSetting = .system
    var autoRollover: Bool = true
    var focusMinutes: Int = 25
    var breakMinutes: Int = 5
    var reviewTime: String? = "18:00"
    var weekStartsOn: Int = 1
    var dayStart: String = "07:00"
    var dayEnd: String = "21:00"
    var lockHash: LockHash? = nil
    // Vault (docs/VAULT_FORMAT.md, docs/DESKTOP_BRIDGE.md)
    var vaultAutoLockMinutes: Int = 5
    var vaultBiometryOnly: Bool = false
    var vaultLockOnHide: Bool = false
    var extra: [String: JSONValue] = [:]

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        theme = ThemeSetting(rawValue: c.str("theme") ?? "system") ?? .system
        autoRollover = c.bool("autoRollover") ?? true
        focusMinutes = c.int("focusMinutes") ?? 25
        breakMinutes = c.int("breakMinutes") ?? 5
        if c.contains(AnyKey("reviewTime")) { reviewTime = c.str("reviewTime") } else { reviewTime = "18:00" }
        weekStartsOn = c.int("weekStartsOn") ?? 1
        dayStart = c.str("dayStart") ?? "07:00"
        dayEnd = c.str("dayEnd") ?? "21:00"
        lockHash = c.val("lockHash", LockHash.self)
        vaultAutoLockMinutes = c.int("vaultAutoLockMinutes") ?? 5
        vaultBiometryOnly = c.bool("vaultBiometryOnly") ?? false
        vaultLockOnHide = c.bool("vaultLockOnHide") ?? false
        extra = c.extras(known: ["theme", "autoRollover", "focusMinutes", "breakMinutes", "reviewTime",
                                 "weekStartsOn", "dayStart", "dayEnd", "lockHash",
                                 "vaultAutoLockMinutes", "vaultBiometryOnly", "vaultLockOnHide"])
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("theme", theme.rawValue); try c.put("autoRollover", autoRollover)
        try c.put("focusMinutes", focusMinutes); try c.put("breakMinutes", breakMinutes)
        try c.putOpt("reviewTime", reviewTime); try c.put("weekStartsOn", weekStartsOn)
        try c.put("dayStart", dayStart); try c.put("dayEnd", dayEnd); try c.putOpt("lockHash", lockHash)
        try c.put("vaultAutoLockMinutes", vaultAutoLockMinutes)
        try c.put("vaultBiometryOnly", vaultBiometryOnly); try c.put("vaultLockOnHide", vaultLockOnHide)
    }
}

struct AppData: Codable, Equatable {
    var app: String = "notemaker"
    var version: Int = 2
    var exportedAt: String? = nil
    var tasks: [TaskItem] = []
    var notes: [String: Note] = [:]
    var habits: [Habit] = []
    var templates: [NoteTemplate] = []
    var focusSessions: [FocusSession] = []
    var settings: Settings = Settings()
    var extra: [String: JSONValue] = [:]

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        app = c.str("app") ?? "notemaker"
        version = c.int("version") ?? 2
        exportedAt = c.str("exportedAt")
        tasks = c.val("tasks", [TaskItem].self) ?? []
        notes = c.val("notes", [String: Note].self) ?? [:]
        habits = c.val("habits", [Habit].self) ?? []
        templates = c.val("templates", [NoteTemplate].self) ?? []
        focusSessions = c.val("focusSessions", [FocusSession].self) ?? []
        settings = c.val("settings", Settings.self) ?? Settings()
        extra = c.extras(known: ["app", "version", "exportedAt", "tasks", "notes", "habits", "templates",
                                 "focusSessions", "settings"])
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("app", app); try c.put("version", 2); try c.putOpt("exportedAt", exportedAt)
        try c.put("tasks", tasks); try c.put("notes", notes); try c.put("habits", habits)
        try c.put("templates", templates); try c.put("focusSessions", focusSessions); try c.put("settings", settings)
    }

    static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return e
    }
    func jsonData() throws -> Data { try Self.encoder().encode(self) }
}

enum Tags {
    static func normalize(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespaces).lowercased()
        while t.hasPrefix("#") { t.removeFirst() }
        return t
    }
    /// Deterministic hue from the tag name (FNV-1a), 0…1.
    static func hue(_ tag: String) -> Double {
        var h: UInt32 = 2166136261
        for b in tag.utf8 { h ^= UInt32(b); h = h &* 16777619 }
        return Double(h % 360) / 360.0
    }
}
