import Foundation

/// Calendar-day arithmetic on "YYYY-MM-DD" strings in the local time zone.
/// Day keys compare correctly as strings.
enum Day {
    static var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone.current
        return c
    }()

    static func key(_ date: Date) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    static func today(_ now: Date = Date()) -> String { key(now) }

    /// Midday of that day, avoids DST edge cases.
    static func date(_ key: String) -> Date? {
        guard let p = parts(key) else { return nil }
        return calendar.date(from: DateComponents(year: p.y, month: p.m, day: p.d, hour: 12))
    }

    static func parts(_ key: String) -> (y: Int, m: Int, d: Int)? {
        let s = key.split(separator: "-")
        guard s.count == 3, s[0].count == 4, let y = Int(s[0]), let m = Int(s[1]), let d = Int(s[2]),
              (1...12).contains(m), (1...31).contains(d) else { return nil }
        return (y, m, d)
    }

    static func isValid(_ key: String) -> Bool {
        guard let p = parts(key), let d = date(key) else { return false }
        let c = calendar.dateComponents([.year, .month, .day], from: d)
        return c.year == p.y && c.month == p.m && c.day == p.d
    }

    static func add(_ key: String, days n: Int) -> String {
        guard let d = date(key), let r = calendar.date(byAdding: .day, value: n, to: d) else { return key }
        return Self.key(r)
    }

    static func add(_ key: String, months n: Int) -> String {
        guard let d = date(key), let r = calendar.date(byAdding: .month, value: n, to: d) else { return key }
        return Self.key(r)
    }

    /// b − a in whole days.
    static func between(_ a: String, _ b: String) -> Int {
        guard let da = date(a), let db = date(b) else { return 0 }
        return calendar.dateComponents([.day], from: da, to: db).day ?? 0
    }

    /// 1 = Monday … 7 = Sunday
    static func weekday(_ key: String) -> Int {
        guard let d = date(key) else { return 1 }
        let w = calendar.component(.weekday, from: d) // 1 = Sunday
        return w == 1 ? 7 : w - 1
    }

    static func monday(of key: String) -> String { add(key, days: -(weekday(key) - 1)) }

    /// First day of the week containing `key`, where weekStartsOn uses 0 = Sunday, 1 = Monday … 6 = Saturday.
    static func weekStart(of key: String, weekStartsOn: Int) -> String {
        let startIso = weekStartsOn % 7 == 0 ? 7 : weekStartsOn % 7 // to 1..7
        let diff = (weekday(key) - startIso + 7) % 7
        return add(key, days: -diff)
    }

    static func daysInMonth(year: Int, month: Int) -> Int {
        guard let d = calendar.date(from: DateComponents(year: year, month: month, day: 1, hour: 12)),
              let r = calendar.range(of: .day, in: .month, for: d) else { return 30 }
        return r.count
    }

    static let weekdayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    static let weekdayShort = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    static func weekdayName(_ key: String) -> String { weekdayNames[weekday(key) - 1] }

    /// e.g. "Sunday, November 15, 2026"
    static func longDate(_ key: String) -> String {
        guard let d = date(key) else { return key }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = "EEEE, MMMM d, yyyy"
        return f.string(from: d)
    }

    static func monthTitle(year: Int, month: Int) -> String {
        let names = ["January", "February", "March", "April", "May", "June", "July", "August",
                     "September", "October", "November", "December"]
        return "\(names[max(0, min(11, month - 1))]) \(year)"
    }
}

/// ISO-8601 UTC timestamps.
enum ISO {
    private static let withFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    static func string(_ d: Date = Date()) -> String { withFrac.string(from: d) }
    static func date(_ s: String) -> Date? { withFrac.date(from: s) ?? plain.date(from: s) }
    /// Local day of an ISO timestamp.
    static func dayKey(_ s: String) -> String? { date(s).map(Day.key) }
}

/// "HH:MM" times of day.
enum HM {
    static func minutes(_ s: String) -> Int? {
        let p = s.split(separator: ":")
        guard p.count == 2, let h = Int(p[0]), let m = Int(p[1]), (0...23).contains(h), (0...59).contains(m) else { return nil }
        return h * 60 + m
    }
    static func string(_ minutes: Int) -> String {
        let m = max(0, min(24 * 60 - 1, minutes))
        return String(format: "%02d:%02d", m / 60, m % 60)
    }
    static func nowMinutes(_ now: Date = Date()) -> Int {
        let c = Day.calendar.dateComponents([.hour, .minute], from: now)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }
    /// Concrete Date for a day key + "HH:MM".
    static func date(day: String, time: String) -> Date? {
        guard let p = Day.parts(day), let mins = minutes(time) else { return nil }
        return Day.calendar.date(from: DateComponents(year: p.y, month: p.m, day: p.d, hour: mins / 60, minute: mins % 60))
    }
}
