import Foundation

// MARK: - Occurrence rule

enum Occurrence {
    /// Does `task` appear on day `d`? (docs/DATA_FORMAT.md "Occurrence rule")
    static func occurs(_ task: TaskItem, on d: String) -> Bool {
        guard let r = task.recurrence else { return d == task.date }
        if d < task.date { return false }
        if let u = r.until, !u.isEmpty, d > u { return false }
        if task.skipDates[d] == true { return false }
        let interval = max(1, r.interval)
        switch r.freq {
        case .daily:
            return Day.between(task.date, d) % interval == 0
        case .weekdays:
            return Day.weekday(d) <= 5
        case .weekly:
            let days = r.byWeekday.isEmpty ? [Day.weekday(task.date)] : r.byWeekday
            guard days.contains(Day.weekday(d)) else { return false }
            let weeks = Day.between(Day.monday(of: task.date), Day.monday(of: d)) / 7
            return weeks % interval == 0
        case .monthly:
            guard let s = Day.parts(task.date), let p = Day.parts(d) else { return false }
            let target = min(s.d, Day.daysInMonth(year: p.y, month: p.m))
            guard p.d == target else { return false }
            let months = (p.y * 12 + p.m) - (s.y * 12 + s.m)
            return months % interval == 0
        }
    }

    static func isDone(_ task: TaskItem, on d: String) -> Bool {
        task.isRecurring ? task.doneDates[d] == true : task.done
    }

    /// Kanban column of a task on a given day.
    static func status(_ task: TaskItem, on d: String) -> TaskStatus {
        if isDone(task, on: d) { return .done }
        return task.status == .doing ? .doing : .todo
    }

    /// Up to `count` occurrence days starting at `from` (inclusive), scanning at most `horizon` days.
    static func next(_ task: TaskItem, from: String, count: Int, horizon: Int = 400) -> [String] {
        guard task.isRecurring else { return task.date >= from ? [task.date] : [] }
        var out: [String] = []
        var d = max(from, task.date)
        var i = 0
        while out.count < count && i < horizon {
            if let u = task.recurrence?.until, !u.isEmpty, d > u { break }
            if occurs(task, on: d) { out.append(d) }
            d = Day.add(d, days: 1); i += 1
        }
        return out
    }

    static func tasks(_ tasks: [TaskItem], on d: String) -> [TaskItem] {
        tasks.filter { occurs($0, on: d) }.sorted { $0.order < $1.order }
    }
}

// MARK: - Mutations that follow the spec

enum TaskOps {
    /// Mark done/undone for a given day, keeping status/doneDates/completedAt consistent.
    static func setDone(_ t: inout TaskItem, _ done: Bool, on d: String, now: Date = Date()) {
        if t.isRecurring {
            if done { t.doneDates[d] = true } else { t.doneDates.removeValue(forKey: d) }
            if !done && t.status == .done { t.status = .todo }
        } else {
            t.done = done
            t.completedAt = done ? ISO.string(now) : nil
            t.status = done ? .done : (t.status == .done ? .todo : t.status)
        }
    }

    static func setStatus(_ t: inout TaskItem, _ s: TaskStatus, on d: String) {
        if s == .done { setDone(&t, true, on: d) }
        else {
            setDone(&t, false, on: d)
            t.status = s
        }
    }

    /// Rollover per spec. Returns number of tasks moved.
    @discardableResult
    static func rollover(_ tasks: inout [TaskItem], today: String) -> Int {
        var n = 0
        for i in tasks.indices where !tasks[i].isRecurring && !tasks[i].done && tasks[i].date < today {
            tasks[i].rolledFrom = tasks[i].rolledFrom ?? tasks[i].date
            tasks[i].date = today
            n += 1
        }
        return n
    }

    static func snooze(_ t: inout TaskItem, to d: String) {
        t.date = d
        t.rolledFrom = nil
    }

    static func overdueDays(_ t: TaskItem, today: String) -> Int {
        guard let r = t.rolledFrom, !t.done else { return 0 }
        return max(0, Day.between(r, today))
    }

    /// Delete one occurrence of a recurring task.
    static func skip(_ t: inout TaskItem, on d: String) {
        t.skipDates[d] = true
        t.doneDates.removeValue(forKey: d)
    }
}

// MARK: - Streaks & stats

enum Streaks {
    static func habitScheduled(_ h: Habit, _ d: String) -> Bool {
        h.days.isEmpty || h.days.contains(Day.weekday(d))
    }

    /// Consecutive scheduled days ending today (or yesterday if today isn't logged yet) present in `log`.
    static func habit(_ h: Habit, today: String) -> Int {
        var d = h.log[today] == true ? today : Day.add(today, days: -1)
        var n = 0
        for _ in 0..<5000 {
            if habitScheduled(h, d) {
                if h.log[d] == true { n += 1 } else { break }
            }
            d = Day.add(d, days: -1)
        }
        return n
    }

    /// Days on which at least one task was completed.
    static func completionDays(_ tasks: [TaskItem]) -> Set<String> {
        var s = Set<String>()
        for t in tasks {
            if t.isRecurring { for (k, v) in t.doneDates where v { s.insert(k) } }
            else if t.done { s.insert(t.completedAt.flatMap(ISO.dayKey) ?? t.date) }
        }
        return s
    }

    static func current(_ days: Set<String>, today: String) -> Int {
        var d = days.contains(today) ? today : Day.add(today, days: -1)
        var n = 0
        while days.contains(d) { n += 1; d = Day.add(d, days: -1) }
        return n
    }

    static func best(_ days: Set<String>) -> Int {
        var best = 0
        for d in days where !days.contains(Day.add(d, days: -1)) {
            var n = 1; var c = Day.add(d, days: 1)
            while days.contains(c) { n += 1; c = Day.add(c, days: 1) }
            best = max(best, n)
        }
        return best
    }
}

struct DayStats { var total = 0; var done = 0
    var ratio: Double { total == 0 ? 0 : Double(done) / Double(total) }
}

enum Stats {
    static func day(_ tasks: [TaskItem], _ d: String) -> DayStats {
        var s = DayStats()
        for t in tasks where Occurrence.occurs(t, on: d) {
            s.total += 1
            if Occurrence.isDone(t, on: d) { s.done += 1 }
        }
        return s
    }

    /// Stats for every day in [from, to], computed in one pass (non-recurring tasks are bucketed by date).
    static func range(_ tasks: [TaskItem], from: String, to: String) -> [String: DayStats] {
        var out: [String: DayStats] = [:]
        let recurring = tasks.filter(\.isRecurring)
        for t in tasks where !t.isRecurring && t.date >= from && t.date <= to {
            out[t.date, default: DayStats()].total += 1
            if t.done { out[t.date, default: DayStats()].done += 1 }
        }
        if !recurring.isEmpty {
            var d = from
            while d <= to {
                for t in recurring where Occurrence.occurs(t, on: d) {
                    out[d, default: DayStats()].total += 1
                    if t.doneDates[d] == true { out[d, default: DayStats()].done += 1 }
                }
                d = Day.add(d, days: 1)
            }
        }
        return out
    }

    static func topTags(_ tasks: [TaskItem], limit: Int = 8) -> [(String, Int)] {
        var c: [String: Int] = [:]
        for t in tasks { for g in t.tags { c[g, default: 0] += 1 } }
        return c.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.prefix(limit).map { ($0.key, $0.value) }
    }

    static func focusMinutes(_ sessions: [FocusSession], weekOf today: String, weekStartsOn: Int) -> Int {
        let start = Day.weekStart(of: today, weekStartsOn: weekStartsOn)
        let end = Day.add(start, days: 6)
        return sessions.filter { $0.kind == .focus }.reduce(0) { acc, s in
            guard let d = ISO.dayKey(s.start), d >= start, d <= end else { return acc }
            return acc + s.minutes
        }
    }
}

// MARK: - Search, wiki links, templates

struct SearchHit: Identifiable, Equatable {
    enum Kind: String { case task, subtask, tag, note }
    var id: String
    var date: String
    var kind: Kind
    var text: String
    var taskId: String?
}

enum Search {
    static func run(_ data: AppData, query raw: String, limit: Int = 300) -> [SearchHit] {
        let q = raw.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return [] }
        let tagQ = q.hasPrefix("#") ? String(q.dropFirst()) : nil
        var hits: [SearchHit] = []
        for t in data.tasks {
            if let tq = tagQ {
                if t.tags.contains(where: { $0.contains(tq) }) {
                    hits.append(SearchHit(id: "tag-\(t.id)", date: t.date, kind: .tag, text: t.title, taskId: t.id))
                }
                continue
            }
            if t.title.lowercased().contains(q) {
                hits.append(SearchHit(id: "t-\(t.id)", date: t.date, kind: .task, text: t.title, taskId: t.id))
            } else if t.tags.contains(where: { $0.contains(q) }) {
                hits.append(SearchHit(id: "tag-\(t.id)", date: t.date, kind: .tag, text: t.title + "  #" + t.tags.joined(separator: " #"), taskId: t.id))
            }
            for s in t.subtasks where s.title.lowercased().contains(q) {
                hits.append(SearchHit(id: "s-\(t.id)-\(s.id)", date: t.date, kind: .subtask, text: "\(t.title) › \(s.title)", taskId: t.id))
            }
        }
        if tagQ == nil {
            for (d, n) in data.notes where !n.locked {
                for (i, line) in n.markdown.components(separatedBy: "\n").enumerated() where line.lowercased().contains(q) {
                    hits.append(SearchHit(id: "n-\(d)-\(i)", date: d, kind: .note, text: line.trimmingCharacters(in: .whitespaces), taskId: nil))
                }
            }
        }
        return Array(hits.sorted { $0.date != $1.date ? $0.date > $1.date : $0.id < $1.id }.prefix(limit))
    }

    static func grouped(_ hits: [SearchHit]) -> [(String, [SearchHit])] {
        var order: [String] = []
        var g: [String: [SearchHit]] = [:]
        for h in hits { if g[h.date] == nil { order.append(h.date) }; g[h.date, default: []].append(h) }
        return order.map { ($0, g[$0]!) }
    }

    /// Subsequence fuzzy score; nil = no match. Higher is better.
    static func fuzzy(_ query: String, _ text: String) -> Int? {
        let q = Array(query.lowercased().filter { !$0.isWhitespace })
        if q.isEmpty { return 0 }
        let t = Array(text.lowercased())
        var qi = 0, score = 0, last = -2
        for (i, ch) in t.enumerated() where qi < q.count && ch == q[qi] {
            score += (i == last + 1) ? 5 : 1
            if i == 0 || t[i - 1] == " " { score += 3 }
            last = i; qi += 1
        }
        guard qi == q.count else { return nil }
        if text.lowercased().hasPrefix(query.lowercased()) { score += 10 }
        return score - t.count / 10
    }
}

enum WikiLinks {
    static let pattern = try! NSRegularExpression(pattern: #"\[\[(\d{4}-\d{2}-\d{2})\]\]"#)

    static func links(in md: String) -> [String] {
        let ns = md as NSString
        return pattern.matches(in: md, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) }
    }

    static func backlinks(to day: String, notes: [String: Note]) -> [String] {
        notes.filter { $0.key != day && !$0.value.locked && $0.value.markdown.contains("[[\(day)]]") }.map(\.key).sorted(by: >)
    }

    /// Replace [[YYYY-MM-DD]] with a markdown link to notemaker://day/YYYY-MM-DD
    static func linkify(_ md: String) -> String {
        let ns = md as NSString
        return pattern.stringByReplacingMatches(in: md, range: NSRange(location: 0, length: ns.length),
                                                withTemplate: "[$1](notemaker://day/$1)")
    }
}

enum Templates {
    static let builtIns: [NoteTemplate] = [
        NoteTemplate(name: "Daily journal", markdown: """
        # {{weekday}}, {{date}}

        ## Gratitude
        -

        ## Top 3 priorities
        1.
        2.
        3.

        ## Notes

        ## Reflection
        """),
        NoteTemplate(name: "Meeting notes", markdown: """
        ## Meeting — {{date}}

        **Attendees:**

        **Agenda**
        -

        **Notes**

        **Action items**
        - [ ]
        """),
        NoteTemplate(name: "Weekly review", markdown: """
        # Weekly review — {{date}}

        ## Wins
        -

        ## Challenges
        -

        ## Lessons learned
        -

        ## Next week's focus
        - [ ]
        """),
    ]

    static func apply(_ t: NoteTemplate, day: String) -> String {
        t.markdown.replacingOccurrences(of: "{{date}}", with: Day.longDate(day))
            .replacingOccurrences(of: "{{weekday}}", with: Day.weekdayName(day))
    }
}

// MARK: - Markdown export

enum MarkdownExport {
    static func day(_ data: AppData, _ d: String, unlocked: [String: String] = [:]) -> String {
        var out = "# \(Day.longDate(d))\n\n"
        let ts = Occurrence.tasks(data.tasks, on: d)
        if !ts.isEmpty {
            out += "## Tasks\n\n"
            for t in ts {
                var line = "- [\(Occurrence.isDone(t, on: d) ? "x" : " ")] \(t.title)"
                if t.priority != .none { line += " (!\(t.priority.rawValue))" }
                if !t.tags.isEmpty { line += " " + t.tags.map { "#\($0)" }.joined(separator: " ") }
                if let r = t.reminder { line += " ⏰ \(r)" }
                out += line + "\n"
                for s in t.subtasks { out += "  - [\(s.done ? "x" : " ")] \(s.title)\n" }
            }
            out += "\n"
        }
        if let n = data.notes[d] {
            if n.locked {
                if let p = unlocked[d] { out += "## Note\n\n\(p)\n\n" } else { out += "## Note\n\n_(locked)_\n\n" }
            } else if !n.markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                out += "## Note\n\n\(n.markdown)\n\n"
            }
        }
        return out
    }

    static func week(_ data: AppData, containing d: String, unlocked: [String: String] = [:]) -> String {
        let start = Day.weekStart(of: d, weekStartsOn: data.settings.weekStartsOn)
        var out = "# Week of \(Day.longDate(start))\n\n"
        for i in 0..<7 {
            let day = Day.add(start, days: i)
            out += MarkdownExport.day(data, day, unlocked: unlocked).replacingOccurrences(of: "\n## ", with: "\n### ")
                .replacingOccurrences(of: "# \(Day.longDate(day))", with: "## \(Day.longDate(day))")
        }
        return out
    }
}
