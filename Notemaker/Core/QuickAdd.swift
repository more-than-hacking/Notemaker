import Foundation

/// Quick-add grammar (docs/DATA_FORMAT.md). Recognised tokens are removed from the title.
struct QuickAddResult: Equatable {
    var title: String
    var date: String
    var dateExplicit = false
    var priority: Priority = .none
    var tags: [String] = []
    var reminder: String? = nil
    var recurrence: Recurrence? = nil
    var estimate: Int = 0

    /// Human-readable summary for the live preview.
    var summary: [String] {
        var s: [String] = []
        if dateExplicit { s.append("📅 \(date)") }
        if priority != .none { s.append("❗️\(priority.rawValue)") }
        if !tags.isEmpty { s.append(tags.map { "#\($0)" }.joined(separator: " ")) }
        if let r = reminder { s.append("⏰ \(r)") }
        if let r = recurrence {
            var t = "🔁 \(r.freq.rawValue)"
            if r.interval > 1 { t += " ×\(r.interval)" }
            if r.freq == .weekly, !r.byWeekday.isEmpty { t += " " + r.byWeekday.map { Day.weekdayShort[$0 - 1] }.joined(separator: ",") }
            s.append(t)
        }
        if estimate > 0 { s.append("🍅 \(estimate)") }
        return s
    }

    func makeTask(order: Double) -> TaskItem {
        var t = TaskItem(title: title, date: date)
        t.priority = priority; t.tags = tags; t.reminder = reminder; t.recurrence = recurrence
        t.pomodoros = Pomodoros(estimate: estimate, done: 0); t.order = order
        return t
    }
}

enum QuickAdd {
    private static let weekdayWords: [(String, Int)] = [
        ("monday", 1), ("tuesday", 2), ("wednesday", 3), ("thursday", 4), ("friday", 5), ("saturday", 6), ("sunday", 7),
        ("tues", 2), ("thurs", 4), ("thur", 4),
        ("mon", 1), ("tue", 2), ("wed", 3), ("thu", 4), ("fri", 5), ("sat", 6), ("sun", 7),
    ]
    private static var weekdayAlt: String { weekdayWords.map(\.0).joined(separator: "|") }
    private static func weekdayNum(_ w: String) -> Int? { weekdayWords.first { $0.0 == w.lowercased() }?.1 }

    /// Next occurrence of weekday `w` (1…7), today counts.
    static func nextWeekday(_ w: Int, from today: String) -> String {
        Day.add(today, days: (w - Day.weekday(today) + 7) % 7)
    }

    static func parse(_ input: String, today: String, defaultDate: String? = nil) -> QuickAddResult {
        var s = " " + input + " "
        var r = QuickAddResult(title: "", date: defaultDate ?? today)
        var recurrenceWeekday: Int? = nil

        /// Find the first match of `pattern`, remove it from `s`, return capture groups.
        func take(_ pattern: String) -> [String?]? {
            guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
            let ns = s as NSString
            guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
            var groups: [String?] = []
            for i in 0..<m.numberOfRanges {
                let rg = m.range(at: i)
                groups.append(rg.location == NSNotFound ? nil : ns.substring(with: rg))
            }
            s = ns.replacingCharacters(in: m.range, with: " ")
            return groups
        }
        let B = #"(?<=\s)"#, E = #"(?=\s)"#

        // Recurrence
        if let g = take(B + #"every\s+(\d+)\s+(days?|weeks?|months?)"# + E) {
            let n = Int(g[1] ?? "1") ?? 1
            let u = (g[2] ?? "").lowercased()
            r.recurrence = Recurrence(freq: u.hasPrefix("day") ? .daily : u.hasPrefix("week") ? .weekly : .monthly, interval: max(1, n))
        } else if take(B + #"(?:every\s+weekday|weekdays)"# + E) != nil {
            r.recurrence = Recurrence(freq: .weekdays)
        } else if take(B + #"(?:every\s+day|daily)"# + E) != nil {
            r.recurrence = Recurrence(freq: .daily)
        } else if take(B + #"(?:every\s+week|weekly)"# + E) != nil {
            r.recurrence = Recurrence(freq: .weekly)
        } else if take(B + #"(?:every\s+month|monthly)"# + E) != nil {
            r.recurrence = Recurrence(freq: .monthly)
        } else if let g = take(B + "every\\s+(\(weekdayAlt))" + E), let w = weekdayNum(g[1] ?? "") {
            r.recurrence = Recurrence(freq: .weekly, byWeekday: [w])
            recurrenceWeekday = w
        }

        // Dates
        if let g = take(B + #"(\d{4}-\d{2}-\d{2})"# + E), let d = g[1], Day.isValid(d) {
            r.date = d; r.dateExplicit = true
        }
        if !r.dateExplicit, take(B + #"next\s+week"# + E) != nil {
            r.date = Day.add(today, days: 8 - Day.weekday(today)); r.dateExplicit = true
        }
        if !r.dateExplicit, let g = take(B + #"in\s+(\d+)\s+(days?|weeks?)"# + E) {
            let n = Int(g[1] ?? "0") ?? 0
            r.date = Day.add(today, days: (g[2] ?? "").lowercased().hasPrefix("week") ? n * 7 : n); r.dateExplicit = true
        }
        if !r.dateExplicit, let g = take(B + #"(today|tomorrow|tmr|tmrw)"# + E) {
            r.date = (g[1] ?? "").lowercased() == "today" ? today : Day.add(today, days: 1); r.dateExplicit = true
        }
        if !r.dateExplicit, let g = take(B + "(\(weekdayAlt))" + E), let w = weekdayNum(g[1] ?? "") {
            r.date = nextWeekday(w, from: today); r.dateExplicit = true
        }
        if !r.dateExplicit, let w = recurrenceWeekday {
            r.date = nextWeekday(w, from: today)
        }
        if var rec = r.recurrence, rec.freq == .weekly, rec.byWeekday.isEmpty {
            rec.byWeekday = [Day.weekday(r.date)]; r.recurrence = rec
        }

        // Time
        func hm(_ h: String?, _ m: String?, _ ap: String?) -> String? {
            guard var hour = Int(h ?? ""), let minute = Int(m ?? "0"), (0...59).contains(minute) else { return nil }
            if let ap = ap?.lowercased() {
                guard (1...12).contains(hour) else { return nil }
                if ap == "pm" && hour != 12 { hour += 12 }
                if ap == "am" && hour == 12 { hour = 0 }
            }
            guard (0...23).contains(hour) else { return nil }
            return String(format: "%02d:%02d", hour, minute)
        }
        if let g = take(B + #"at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?"# + E) {
            r.reminder = hm(g[1], g[2], g[3])
        } else if let g = take(B + #"(\d{1,2})(?::(\d{2}))?\s*(am|pm)"# + E) {
            r.reminder = hm(g[1], g[2], g[3])
        } else if let g = take(B + #"(\d{1,2}):(\d{2})"# + E) {
            r.reminder = hm(g[1], g[2], nil)
        }

        // Priority
        if let g = take(B + #"!(high|medium|med|low|h|m|l|1|2|3)"# + E) {
            switch (g[1] ?? "").lowercased() {
            case "high", "h", "1": r.priority = .high
            case "medium", "med", "m", "2": r.priority = .medium
            default: r.priority = .low
            }
        }
        // Estimate
        if let g = take(B + #"~(\d+)"# + E) { r.estimate = Int(g[1] ?? "0") ?? 0 }
        // Tags (all)
        while let g = take(B + #"#([\p{L}\p{N}_\-/]+)"# + E) {
            let t = Tags.normalize(g[1] ?? "")
            if !t.isEmpty && !r.tags.contains(t) { r.tags.append(t) }
        }

        r.title = s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return r
    }
}
