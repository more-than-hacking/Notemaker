import Foundation
import CryptoKit

// Notemaker core tests — compiled with Notemaker/Core/*.swift by Tests-mac/run.sh.
// Usage: notemaker-tests [--root <repo>] | --import <path.json>

var failures = 0
var passes = 0
func check(_ cond: Bool, _ name: String, _ detail: @autoclosure () -> String = "") {
    if cond { passes += 1 } else { failures += 1; print("  ✗ \(name) \(detail())") }
}
func eq<T: Equatable>(_ a: T, _ b: T, _ name: String) { check(a == b, name, "→ got \(a), expected \(b)") }
func section(_ s: String) { print("• \(s)") }

let args = CommandLine.arguments
if let i = args.firstIndex(of: "--import"), i + 1 < args.count {
    let path = args[i + 1]
    do {
        let raw = try Data(contentsOf: URL(fileURLWithPath: path))
        let d = try Migration.parseImport(raw)
        print("Imported \(path)")
        print(Migration.summary(d))
        exit(0)
    } catch {
        print("Import failed: \(error.localizedDescription) (\(error))")
        exit(1)
    }
}
if args.contains("--migrate-v1-defaults") {
    // Dry run: read the v1 macOS UserDefaults (read-only) and print counts only.
    guard let v1 = Migration.findMacV1Defaults() else { print("No macOS v1 data found."); exit(0) }
    do {
        let d = try Migration.fromMacV1(tasksData: v1.tasks, notesData: v1.notes) ?? AppData()
        print("macOS v1 data would migrate to:")
        print(Migration.summary(d))
        exit(0)
    } catch { print("v1 migration failed: \(error)"); exit(1) }
}
var root = FileManager.default.currentDirectoryPath
if let i = args.firstIndex(of: "--root"), i + 1 < args.count { root = args[i + 1] }

let today = "2026-11-15"

// MARK: Quick add
section("Quick-add test vectors")
struct QV { let input, title, date: String; let pri: Priority; let tags: [String]; let rem: String?; let rec: Recurrence?; let est: Int }
let vectors: [QV] = [
    QV(input: "Call Raj tomorrow 3pm #work !high", title: "Call Raj", date: "2026-11-16", pri: .high, tags: ["work"], rem: "15:00", rec: nil, est: 0),
    QV(input: "Standup every weekday at 9:30", title: "Standup", date: "2026-11-15", pri: .none, tags: [], rem: "09:30", rec: Recurrence(freq: .weekdays), est: 0),
    QV(input: "Pay rent every month #home !2", title: "Pay rent", date: "2026-11-15", pri: .medium, tags: ["home"], rem: nil, rec: Recurrence(freq: .monthly), est: 0),
    QV(input: "Gym every mon #health", title: "Gym", date: "2026-11-16", pri: .none, tags: ["health"], rem: nil, rec: Recurrence(freq: .weekly, byWeekday: [1]), est: 0),
    QV(input: "Write report in 3 days ~4", title: "Write report", date: "2026-11-18", pri: .none, tags: [], rem: nil, rec: nil, est: 4),
    QV(input: "Plan sprint next week !low", title: "Plan sprint", date: "2026-11-16", pri: .low, tags: [], rem: nil, rec: nil, est: 0),
    QV(input: "Review 2026-12-01 at 14", title: "Review", date: "2026-12-01", pri: .none, tags: [], rem: "14:00", rec: nil, est: 0),
    QV(input: "Read #book #fun", title: "Read", date: "2026-11-15", pri: .none, tags: ["book", "fun"], rem: nil, rec: nil, est: 0),
]
for v in vectors {
    let r = QuickAdd.parse(v.input, today: today)
    eq(r.title, v.title, "[\(v.input)] title")
    eq(r.date, v.date, "[\(v.input)] date")
    eq(r.priority, v.pri, "[\(v.input)] priority")
    eq(r.tags, v.tags, "[\(v.input)] tags")
    eq(r.reminder, v.rem, "[\(v.input)] reminder")
    eq(r.recurrence?.freq, v.rec?.freq, "[\(v.input)] recurrence freq")
    if v.rec?.freq == .weekly { eq(r.recurrence?.byWeekday ?? [], v.rec!.byWeekday, "[\(v.input)] byWeekday") }
    eq(r.estimate, v.est, "[\(v.input)] estimate")
}
// extra grammar checks
do {
    let r = QuickAdd.parse("Lunch tmr at 12pm !m", today: today)
    eq(r.title, "Lunch", "tmr title"); eq(r.date, "2026-11-16", "tmr date"); eq(r.reminder, "12:00", "12pm"); eq(r.priority, .medium, "!m")
    let r2 = QuickAdd.parse("Call fri 3:30pm", today: today)
    eq(r2.date, "2026-11-20", "fri"); eq(r2.reminder, "15:30", "3:30pm")
    let r3 = QuickAdd.parse("Swim sunday 15:30", today: today)
    eq(r3.date, "2026-11-15", "sunday counts today"); eq(r3.reminder, "15:30", "15:30")
    let r4 = QuickAdd.parse("Room 9 cleanup", today: today)
    eq(r4.title, "Room 9 cleanup", "bare number not a time"); eq(r4.reminder, nil, "bare number no reminder")
    let r5 = QuickAdd.parse("Trip in 2 weeks daily", today: today)
    eq(r5.date, "2026-11-29", "in 2 weeks"); eq(r5.recurrence?.freq, .daily, "daily")
    let r6 = QuickAdd.parse("Sync every week", today: today)
    eq(r6.recurrence?.byWeekday ?? [], [7], "every week → weekday of date")
}

// MARK: Occurrence rule
section("Occurrence rule")
func rec(_ date: String, _ r: Recurrence) -> TaskItem { var t = TaskItem(title: "r", date: date); t.recurrence = r; return t }
do {
    let plain = TaskItem(title: "p", date: "2026-11-15")
    check(Occurrence.occurs(plain, on: "2026-11-15"), "plain on its day")
    check(!Occurrence.occurs(plain, on: "2026-11-16"), "plain not other day")

    let daily = rec("2026-11-10", Recurrence(freq: .daily))
    check(!Occurrence.occurs(daily, on: "2026-11-09"), "daily before start")
    check(Occurrence.occurs(daily, on: "2026-11-10") && Occurrence.occurs(daily, on: "2026-12-31"), "daily every day")
    let daily3 = rec("2026-11-10", Recurrence(freq: .daily, interval: 3))
    check(Occurrence.occurs(daily3, on: "2026-11-13") && !Occurrence.occurs(daily3, on: "2026-11-12"), "daily interval 3")
    check(Occurrence.occurs(daily3, on: "2027-01-01") == (Day.between("2026-11-10", "2027-01-01") % 3 == 0), "daily interval across years")
    var dailyUntil = rec("2026-11-10", Recurrence(freq: .daily, until: "2026-11-20"))
    check(Occurrence.occurs(dailyUntil, on: "2026-11-20") && !Occurrence.occurs(dailyUntil, on: "2026-11-21"), "until inclusive")
    dailyUntil.skipDates["2026-11-12"] = true
    check(!Occurrence.occurs(dailyUntil, on: "2026-11-12") && Occurrence.occurs(dailyUntil, on: "2026-11-13"), "skipDates")

    let wd = rec("2026-11-15", Recurrence(freq: .weekdays))
    check(!Occurrence.occurs(wd, on: "2026-11-15"), "weekdays: Sunday no")
    check(Occurrence.occurs(wd, on: "2026-11-16") && Occurrence.occurs(wd, on: "2026-11-20"), "weekdays Mon/Fri")
    check(!Occurrence.occurs(wd, on: "2026-11-21"), "weekdays: Saturday no")

    let wk = rec("2026-11-18", Recurrence(freq: .weekly)) // Wednesday, empty byWeekday
    check(Occurrence.occurs(wk, on: "2026-11-25") && !Occurrence.occurs(wk, on: "2026-11-24"), "weekly default weekday")
    let wkBy = rec("2026-11-16", Recurrence(freq: .weekly, byWeekday: [1, 3, 5]))
    check(Occurrence.occurs(wkBy, on: "2026-11-18") && Occurrence.occurs(wkBy, on: "2026-11-20") && !Occurrence.occurs(wkBy, on: "2026-11-19"), "weekly byWeekday")
    let wk2 = rec("2026-11-18", Recurrence(freq: .weekly, interval: 2, byWeekday: [1, 3])) // Wed; week of Mon 11-16
    check(Occurrence.occurs(wk2, on: "2026-11-18"), "biweekly first")
    check(!Occurrence.occurs(wk2, on: "2026-11-16"), "biweekly before start (Mon same week)")
    check(!Occurrence.occurs(wk2, on: "2026-11-23") && !Occurrence.occurs(wk2, on: "2026-11-25"), "biweekly off week")
    check(Occurrence.occurs(wk2, on: "2026-11-30") && Occurrence.occurs(wk2, on: "2026-12-02"), "biweekly on week")

    let m31 = rec("2026-01-31", Recurrence(freq: .monthly))
    check(Occurrence.occurs(m31, on: "2026-02-28"), "monthly 31st → Feb 28")
    check(!Occurrence.occurs(m31, on: "2026-02-27"), "monthly not Feb 27")
    check(Occurrence.occurs(m31, on: "2026-04-30") && Occurrence.occurs(m31, on: "2026-03-31"), "monthly Apr 30 / Mar 31")
    check(!Occurrence.occurs(m31, on: "2026-03-30"), "monthly not Mar 30")
    let m31leap = rec("2028-01-31", Recurrence(freq: .monthly))
    check(Occurrence.occurs(m31leap, on: "2028-02-29"), "monthly leap Feb 29")
    let m2 = rec("2026-11-15", Recurrence(freq: .monthly, interval: 2))
    check(!Occurrence.occurs(m2, on: "2026-12-15") && Occurrence.occurs(m2, on: "2027-01-15"), "monthly interval 2")
    eq(Occurrence.next(daily3, from: "2026-11-15", count: 3), ["2026-11-16", "2026-11-19", "2026-11-22"], "next occurrences")
}

// MARK: Rollover & snooze
section("Rollover / snooze / status")
do {
    var a = TaskItem(title: "a", date: "2026-11-10")
    var b = TaskItem(title: "b", date: "2026-11-12"); b.rolledFrom = "2026-11-08"
    var c = TaskItem(title: "c", date: "2026-11-10"); TaskOps.setDone(&c, true, on: "2026-11-10")
    let d = rec("2026-11-01", Recurrence(freq: .daily))
    let e = TaskItem(title: "e", date: "2026-11-20")
    var list = [a, b, c, d, e]
    let n = TaskOps.rollover(&list, today: today)
    eq(n, 2, "rollover count")
    eq(list[0].date, today, "rolled date"); eq(list[0].rolledFrom, "2026-11-10", "rolledFrom set")
    eq(list[1].rolledFrom, "2026-11-08", "rolledFrom kept"); eq(list[2].date, "2026-11-10", "done stays")
    eq(list[3].date, "2026-11-01", "recurring stays"); eq(list[4].date, "2026-11-20", "future stays")
    eq(TaskOps.overdueDays(list[0], today: today), 5, "overdue days")
    a = list[0]; TaskOps.snooze(&a, to: "2026-11-18")
    eq(a.date, "2026-11-18", "snooze date"); eq(a.rolledFrom, nil, "snooze clears rolledFrom")
    b = list[1]
    TaskOps.setStatus(&b, .doing, on: today); eq(b.status, .doing, "status doing")
    TaskOps.setStatus(&b, .done, on: today); check(b.done && b.status == .done && b.completedAt != nil, "status done ⇒ done")
    var r = rec("2026-11-01", Recurrence(freq: .daily))
    TaskOps.setDone(&r, true, on: today); check(r.doneDates[today] == true && !r.done, "recurring doneDates")
    eq(Occurrence.status(r, on: today), .done, "recurring status done on day"); eq(Occurrence.status(r, on: "2026-11-16"), .todo, "recurring todo other day")
    TaskOps.skip(&r, on: today); check(!Occurrence.occurs(r, on: today) && r.doneDates[today] == nil, "skip occurrence")
}

// MARK: Streaks
section("Streaks")
do {
    var h = Habit(name: "run")
    h.log = ["2026-11-15": true, "2026-11-14": true, "2026-11-13": true, "2026-11-11": true]
    eq(Streaks.habit(h, today: today), 3, "habit streak incl today")
    h.log["2026-11-15"] = nil
    eq(Streaks.habit(h, today: today), 2, "habit streak from yesterday")
    var w = Habit(name: "mwf", days: [1, 3, 5]) // Mon/Wed/Fri
    w.log = ["2026-11-13": true, "2026-11-11": true, "2026-11-09": true, "2026-11-04": true]
    eq(Streaks.habit(w, today: today), 3, "habit scheduled-days streak skips unscheduled")
    let days: Set<String> = ["2026-11-15", "2026-11-14", "2026-11-10", "2026-11-09", "2026-11-08", "2026-11-07"]
    eq(Streaks.current(days, today: today), 2, "current streak")
    eq(Streaks.best(days), 4, "best streak")
    eq(Streaks.current(["2026-11-14", "2026-11-13"], today: today), 2, "current streak from yesterday")
    eq(Streaks.current(["2026-11-12"], today: today), 0, "broken streak")
}

// MARK: Migration
section("Migration (macOS v1 + web v1)")
do {
    // Exact UserDefaults JSON as written by v1 (default JSONEncoder: Date = seconds since 2001-01-01)
    let t1 = 785_000_000.0, t2 = 785_090_000.0
    let tasksJSON = """
    [{"id":"8E1C1F43-6A55-4C7B-9D38-0B4C4C2E1A01","title":"Old task","isCompleted":true,"date":\(t1),"createdAt":\(t1)},
     {"id":"8E1C1F43-6A55-4C7B-9D38-0B4C4C2E1A02","title":"Open task","isCompleted":false,"date":\(t2),"createdAt":\(t2)}]
    """
    let notesJSON = """
    [{"id":"8E1C1F43-6A55-4C7B-9D38-0B4C4C2E1A03","content":"Hello **v1**","date":\(t1),"createdAt":\(t1)}]
    """
    let m = try Migration.fromMacV1(tasksData: Data(tasksJSON.utf8), notesData: Data(notesJSON.utf8))!
    eq(m.tasks.count, 2, "mac v1 task count")
    let d1 = Day.key(Date(timeIntervalSinceReferenceDate: t1))
    eq(m.tasks[0].date, d1, "mac v1 date → day key")
    eq(m.tasks[0].id, "8E1C1F43-6A55-4C7B-9D38-0B4C4C2E1A01", "mac v1 id")
    check(m.tasks[0].done && m.tasks[0].status == .done, "mac v1 done")
    check(!m.tasks[1].done && m.tasks[1].status == .todo, "mac v1 open")
    eq(m.tasks[0].createdAt, ISO.string(Date(timeIntervalSinceReferenceDate: t1)), "mac v1 createdAt ISO")
    eq(m.notes[d1]?.markdown, "Hello **v1**", "mac v1 note")
    check(try Migration.fromMacV1(tasksData: nil, notesData: nil) == nil, "mac v1 nothing to migrate")

    let web1 = """
    {"version":"1.0","exportDate":"2026-02-01T10:00:00.000Z",
     "tasks":[{"id":"1700000000000","title":"Web task","date":"2026-02-01","completed":false,"createdAt":"2026-02-01T09:00:00.000Z",
               "subtasks":[{"id":"1700000000001","title":"sub","completed":true}]}],
     "notes":[{"date":"2026-02-01","content":"# Web note","createdAt":"2026-02-01T09:00:00.000Z"}]}
    """
    let w = try Migration.parseImport(Data(web1.utf8))
    eq(w.tasks.count, 1, "web v1 tasks"); eq(w.tasks.first?.subtasks.first?.done, true, "web v1 subtask done")
    eq(w.tasks.first?.id, "1700000000000", "web v1 id"); eq(w.notes["2026-02-01"]?.markdown, "# Web note", "web v1 note")
} catch { check(false, "migration threw \(error)") }

// MARK: Crypto
section("Crypto (docs/crypto-test-vector.json)")
do {
    let url = URL(fileURLWithPath: root).appendingPathComponent("docs/crypto-test-vector.json")
    let raw = try Data(contentsOf: url)
    struct Vec: Decodable { let passcode: String; let plaintext: String; let cipher: Cipher; let lockHash: LockHash }
    let v = try JSONDecoder().decode(Vec.self, from: raw)
    let plain = try NoteCrypto.decrypt(v.cipher, passcode: v.passcode)
    eq(plain, v.plaintext, "decrypt WebCrypto vector")
    check(NoteCrypto.verify(v.passcode, v.lockHash), "lockHash verifies")
    check(!NoteCrypto.verify("wrong", v.lockHash), "lockHash rejects wrong passcode")
    do { _ = try NoteCrypto.decrypt(v.cipher, passcode: "wrong"); check(false, "wrong passcode must throw") }
    catch NoteCrypto.CryptoError.wrongPasscode { check(true, "wrong passcode error") }
    let c = try NoteCrypto.encrypt("round ✓ trip", passcode: "pw", iterations: 1000)
    eq(try NoteCrypto.decrypt(c, passcode: "pw"), "round ✓ trip", "encrypt→decrypt")
    eq(Data(base64Encoded: c.iv)?.count, 12, "iv 12 bytes"); eq(Data(base64Encoded: c.salt)?.count, 16, "salt 16 bytes")
} catch { check(false, "crypto threw \(error)") }

// MARK: Round trip
section("v2 JSON round trip")
do {
    var data = AppData()
    var t = TaskItem(title: "Full", date: "2026-11-15")
    t.priority = .high; t.tags = ["work"]; t.subtasks = [Subtask(title: "s")]; t.status = .doing; t.order = 3
    t.recurrence = Recurrence(freq: .weekly, interval: 2, byWeekday: [1, 3], until: "2027-01-01")
    t.doneDates = ["2026-11-16": true]; t.skipDates = ["2026-11-18": true]; t.reminder = "09:00"
    t.timeBlock = TimeBlock(start: "10:00", end: "10:30"); t.pomodoros = Pomodoros(estimate: 4, done: 1)
    t.rolledFrom = "2026-11-10"; t.notes = "n"
    data.tasks = [t, TaskItem(title: "Plain", date: "2026-11-14")]
    data.notes = ["2026-11-15": Note(markdown: "# Hi [[2026-11-14]]")]
    var locked = Note(); locked.locked = true; locked.cipher = try NoteCrypto.encrypt("secret", passcode: "pw", iterations: 1000)
    data.notes["2026-11-14"] = locked
    var h = Habit(name: "Read", color: "#FF0000", days: [1, 2]); h.log = ["2026-11-15": true]
    data.habits = [h]
    data.templates = Templates.builtIns
    data.focusSessions = [FocusSession(taskId: t.id, start: "2026-11-15T10:00:00Z", end: "2026-11-15T10:25:00Z", minutes: 25, kind: .focus)]
    data.settings.lockHash = LockHash(salt: "AA==", iterations: 1000, hash: "BB==")
    data.settings.reviewTime = nil
    let json = try data.jsonData()
    let back = try JSONDecoder().decode(AppData.self, from: json)
    check(back == data, "encode → decode equal")
    let obj = try JSONSerialization.jsonObject(with: json) as! [String: Any]
    eq(obj["version"] as? Int, 2, "version 2"); eq(obj["app"] as? String, "notemaker", "app")
    let tj = (obj["tasks"] as! [[String: Any]])[0]
    eq(tj["date"] as? String, "2026-11-15", "task date string"); eq(tj["priority"] as? String, "high", "priority string")
    eq(tj["status"] as? String, "doing", "status string"); check(tj["createdAt"] is String, "createdAt is ISO string")
    eq((tj["timeBlock"] as? [String: String])?["start"], "10:00", "timeBlock HH:MM")
    eq(((tj["recurrence"] as? [String: Any])?["byWeekday"] as? [Int]), [1, 3], "byWeekday")
    eq((tj["doneDates"] as? [String: Bool])?["2026-11-16"], true, "doneDates map")
    check((obj["settings"] as! [String: Any])["reviewTime"] is NSNull, "reviewTime null encoded")
    check((obj["notes"] as? [String: Any])?["2026-11-15"] != nil, "notes keyed by date")
    // unknown fields survive
    let withExtra = #"{"app":"notemaker","version":2,"futureField":{"a":[1,2]},"tasks":[{"id":"x","title":"t","date":"2026-11-15","webOnly":"keep"}],"notes":{},"settings":{"theme":"dark","newSetting":7}}"#
    let e = try JSONDecoder().decode(AppData.self, from: Data(withExtra.utf8))
    let reObj = try JSONSerialization.jsonObject(with: try e.jsonData()) as! [String: Any]
    check(reObj["futureField"] != nil, "unknown root field preserved")
    eq(((reObj["tasks"] as! [[String: Any]])[0]["webOnly"] as? String), "keep", "unknown task field preserved")
    eq(((reObj["settings"] as! [String: Any])["newSetting"] as? Int), 7, "unknown settings field preserved")
} catch { check(false, "round trip threw \(error)") }

// MARK: Search, wiki links, markdown, templates
section("Search / wiki links / markdown / templates")
do {
    var data = AppData()
    var t = TaskItem(title: "Buy milk", date: "2026-11-14"); t.tags = ["errand"]; t.subtasks = [Subtask(title: "oat milk")]
    data.tasks = [t, TaskItem(title: "Other", date: "2026-11-15")]
    data.notes["2026-11-15"] = Note(markdown: "Remember the milk\nsee [[2026-11-14]]")
    var ln = Note(); ln.locked = true; ln.markdown = ""; data.notes["2026-11-13"] = ln
    let hits = Search.run(data, query: "milk")
    eq(hits.count, 3, "search hits (title, subtask, note)")
    eq(Search.grouped(hits).map(\.0), ["2026-11-15", "2026-11-14"], "search grouped by date desc")
    eq(Search.run(data, query: "#err").count, 1, "tag search")
    eq(WikiLinks.backlinks(to: "2026-11-14", notes: data.notes), ["2026-11-15"], "backlinks")
    eq(WikiLinks.linkify("a [[2026-11-14]] b"), "a [2026-11-14](notemaker://day/2026-11-14) b", "linkify")
    check(Search.fuzzy("gtd", "Go to day") != nil && Search.fuzzy("xyz", "Go to day") == nil, "fuzzy")
    let blocks = MarkdownParser.parse("# T\n- [x] a\n  - b\n> q\n| h1 | h2 |\n|---|---|\n| 1 | 2 |\n```\ncode\n```")
    eq(blocks.count, 6, "markdown blocks")
    if case .table(let hdr, let rows) = blocks[4] { eq(hdr, ["h1", "h2"], "table header"); eq(rows, [["1", "2"]], "table rows") } else { check(false, "table parsed") }
    eq(MarkdownParser.toggleCheckbox("- [ ] a", line: 0), "- [x] a", "toggle checkbox")
    let applied = Templates.apply(NoteTemplate(name: "x", markdown: "{{weekday}} {{date}}"), day: today)
    eq(applied, "Sunday Sunday, November 15, 2026", "template placeholders")
    eq(Day.weekStart(of: today, weekStartsOn: 1), "2026-11-09", "week start Monday")
    eq(Day.weekStart(of: today, weekStartsOn: 0), "2026-11-15", "week start Sunday")
    var s1 = FocusSession(taskId: nil, start: ISO.string(HM.date(day: "2026-11-12", time: "10:00")!), end: "", minutes: 25, kind: .focus)
    let s2 = FocusSession(taskId: nil, start: ISO.string(HM.date(day: "2026-11-02", time: "10:00")!), end: "", minutes: 50, kind: .focus)
    eq(Stats.focusMinutes([s1, s2], weekOf: today, weekStartsOn: 1), 25, "focus minutes this week")
    s1.kind = .break
    eq(Stats.focusMinutes([s1], weekOf: today, weekStartsOn: 1), 0, "breaks not counted")
    check(MarkdownExport.week(data, containing: today).contains("Buy milk"), "week markdown export")
    var mixed = data.tasks
    mixed.append(rec("2026-11-01", Recurrence(freq: .weekly, byWeekday: [2, 4])))
    TaskOps.setDone(&mixed[0], true, on: "2026-11-14")
    TaskOps.setDone(&mixed[2], true, on: "2026-11-05")
    let rangeStats = Stats.range(mixed, from: "2026-11-01", to: "2026-11-20")
    var rangeOK = true
    var dd = "2026-11-01"
    while dd <= "2026-11-20" {
        let a = Stats.day(mixed, dd), b = rangeStats[dd] ?? DayStats()
        if a.total != b.total || a.done != b.done { rangeOK = false }
        dd = Day.add(dd, days: 1)
    }
    check(rangeOK, "Stats.range matches Stats.day")
}

// MARK: Web fixture
section("Web fixture tests-web/fixtures/sample-v2.json")
let fixture = URL(fileURLWithPath: root).appendingPathComponent("tests-web/fixtures/sample-v2.json")
if FileManager.default.fileExists(atPath: fixture.path) {
    do {
        let raw = try Data(contentsOf: fixture)
        let d = try JSONDecoder().decode(AppData.self, from: raw)
        print(Migration.summary(d).split(separator: "\n").map { "    " + $0 }.joined(separator: "\n"))
        let original = try JSONSerialization.jsonObject(with: raw)
        let re = try JSONSerialization.jsonObject(with: try d.jsonData())
        var lost: [String] = []
        func compare(_ a: Any, _ b: Any?, _ path: String) {
            guard let b = b else { lost.append("\(path) (missing)"); return }
            if let ao = a as? [String: Any] {
                guard let bo = b as? [String: Any] else { lost.append("\(path) (type)"); return }
                for (k, v) in ao { compare(v, bo[k], "\(path).\(k)") }
            } else if let aa = a as? [Any] {
                guard let ba = b as? [Any], ba.count == aa.count else { lost.append("\(path) (array)"); return }
                for (i, v) in aa.enumerated() { compare(v, ba[i], "\(path)[\(i)]") }
            } else if !((a as AnyObject).isEqual(b)) {
                lost.append("\(path): \(a) → \(b)")
            }
        }
        compare(original, re, "$")
        check(lost.isEmpty, "web fixture re-encodes without losing/changing fields", lost.prefix(20).joined(separator: "\n      "))
        let again = try JSONDecoder().decode(AppData.self, from: try d.jsonData())
        check(again == d, "web fixture decode→encode→decode stable")
        // Locked notes + lockHash produced by the web app (passcode from docs/crypto-test-vector.json)
        if let vraw = try? Data(contentsOf: URL(fileURLWithPath: root).appendingPathComponent("docs/crypto-test-vector.json")),
           let vobj = try? JSONSerialization.jsonObject(with: vraw) as? [String: Any], let pass = vobj["passcode"] as? String {
            for (day, n) in d.notes where n.locked {
                if let c = n.cipher, let plain = try? NoteCrypto.decrypt(c, passcode: pass) {
                    check(!plain.isEmpty, "web fixture locked note \(day) decrypts")
                    print("    locked note \(day) decrypted (\(plain.count) chars)")
                } else { check(false, "web fixture locked note \(day) decrypts") }
            }
            if let lh = d.settings.lockHash { check(NoteCrypto.verify(pass, lh), "web fixture lockHash verifies") }
        }
        // Occurrences of the web fixture's recurring tasks are computable
        for t in d.tasks where t.isRecurring {
            check(!Occurrence.next(t, from: t.date, count: 1).isEmpty, "recurring \(t.title) has an occurrence")
        }
    } catch { check(false, "web fixture threw \(error)") }
} else {
    print("    (not present — skipped)")
}

let v1fixture = URL(fileURLWithPath: root).appendingPathComponent("tests-web/fixtures/v1-export.json")
if FileManager.default.fileExists(atPath: v1fixture.path) {
    section("Web v1 export fixture tests-web/fixtures/v1-export.json")
    do {
        let d = try Migration.parseImport(try Data(contentsOf: v1fixture))
        check(!d.tasks.isEmpty, "web v1 fixture imports tasks")
        check(d.tasks.allSatisfy { Day.isValid($0.date) }, "web v1 fixture dates valid")
        check(d.tasks.allSatisfy { ($0.status == .done) == $0.done }, "web v1 fixture status consistent")
        print("    tasks \(d.tasks.count), notes \(d.notes.count)")
    } catch { check(false, "web v1 fixture threw \(error)") }
}

// MARK: Vault (docs/VAULT_FORMAT.md + docs/vault-test-vector.json)
section("Vault vector (docs/vault-test-vector.json)")
do {
    let raw = try Data(contentsOf: URL(fileURLWithPath: root).appendingPathComponent("docs/vault-test-vector.json"))
    let obj = try JSONSerialization.jsonObject(with: raw) as! [String: Any]
    func b64(_ k: String) -> Data { Data(base64Encoded: obj[k] as! String)! }
    func b64url(_ s: String) -> Data {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)!
    }
    let vdk = b64("vdk"), recoveryBytes = b64("recoveryBytes"), prf = b64("prfOutput")
    let vault = try JSONDecoder().decode(VaultData.self, from: JSONSerialization.data(withJSONObject: obj["vault"]!))
    eq(vault.mode, "hardware+recovery", "vault mode decoded")
    eq(vault.keyslots.count, 3, "3 keyslots decoded")

    // Recovery key encode / decode / checksum
    eq(RecoveryKey.encode(recoveryBytes), obj["recoveryKey"] as! String, "recovery key encodes to vector")
    eq(try RecoveryKey.decode(obj["recoveryKey"] as! String), recoveryBytes, "recovery key decodes")
    let messy = (obj["recoveryKey"] as! String).lowercased().replacingOccurrences(of: "-", with: " ")
        .replacingOccurrences(of: "0", with: "o").replacingOccurrences(of: "1", with: "l")
    eq(try RecoveryKey.decode(messy), recoveryBytes, "recovery key parse: lower case, spaces, O→0, L→1")
    var typo = Array(obj["recoveryKey"] as! String)
    typo[3] = typo[3] == "A" ? "B" : "A"
    do { _ = try RecoveryKey.decode(String(typo)); check(false, "typo must fail checksum") }
    catch RecoveryKey.RKError.badChecksum { check(true, "typo → checksum failure") }
    catch { check(false, "typo → checksum failure", "\(error)") }
    do { _ = try RecoveryKey.decode("ABCDE-12345"); check(false, "short key must fail") }
    catch RecoveryKey.RKError.badLength { check(true, "short key → length error") }
    for _ in 0..<20 {
        let r = VaultCrypto.randomBytes(32)
        let k = RecoveryKey.encode(r)
        if k.count != 65 || (try? RecoveryKey.decode(k)) != r { check(false, "random recovery key round trip"); break }
    }
    check(true, "20 random recovery keys round trip (11 groups of 5)")

    // Keyslots
    let rec = vault.keyslots.first { $0.type == "recovery" }!
    eq(try VaultCrypto.unwrapRecovery(rec, recoveryBytes: recoveryBytes), vdk, "recovery slot → VDK")
    do { _ = try VaultCrypto.unwrapRecovery(rec, recoveryBytes: VaultCrypto.randomBytes(32)); check(false, "wrong recovery key must fail") }
    catch { check(true, "wrong recovery key rejected") }
    check(VaultCrypto.checkVerifier(vault.verifier, vdk: vdk), "verifier accepts VDK")
    check(!VaultCrypto.checkVerifier(vault.verifier, vdk: VaultCrypto.randomBytes(32)), "verifier rejects other key")

    let jwk = obj["seSoftwarePrivateJwk"] as! [String: Any]
    let seSoft = try P256.KeyAgreement.PrivateKey(rawRepresentation: b64url(jwk["d"] as! String))
    let se = vault.keyslots.first { $0.type == "secure-enclave" }!
    eq(Data(base64Encoded: se.publicKey!)!, seSoft.publicKey.x963Representation, "SE slot publicKey = software key's public key")
    eq(try VaultCrypto.unwrapSecureEnclave(se) { try seSoft.sharedSecretFromKeyAgreement(with: $0) }, vdk,
       "secure-enclave slot unwrapped with the software P-256 key → VDK")
    let pk = vault.keyslots.first { $0.type == "passkey-prf" }!
    eq(try VaultCrypto.unwrapPasskey(pk, prfOutput: prf), vdk, "passkey-prf slot unwrapped with prfOutput → VDK")
    eq(pk.credentialId, "dGVzdC1jcmVkZW50aWFs", "passkey slot fields preserved (credentialId)")

    // Items
    let expected = obj["expectedPayloads"] as! [String: Any]
    for r in vault.items {
        let plain = try VaultCrypto.decryptItemJSON(r, vdk: vdk)
        let got = try JSONSerialization.jsonObject(with: plain) as! NSDictionary
        check(got.isEqual(to: expected[r.id] as! [String: Any]), "item \(r.id.suffix(1)) decrypts to expected payload")
        let item = try VaultCrypto.decryptItem(r, vdk: vdk)
        let re = try JSONSerialization.jsonObject(with: JSONEncoder().encode(item.payload)) as! NSDictionary
        check(re.isEqual(to: expected[r.id] as! [String: Any]), "item \(r.id.suffix(1)) (\(item.payload.type)) payload re-encodes losslessly")
        do { var bad = r; bad.id = UUID().uuidString; _ = try VaultCrypto.decryptItemJSON(bad, vdk: vdk); check(false, "AAD must bind item id") }
        catch { check(true, "item \(r.id.suffix(1)) AAD bound to its id") }
    }
    // Blob
    let fileItem = try VaultCrypto.decryptItem(vault.items.first { $0.id.hasSuffix("4") }!, vdk: vdk)
    let blobBox = vault.blobs![fileItem.payload.blobId]!
    let stored = Data(base64Encoded: blobBox.iv)! + Data(base64Encoded: blobBox.ct)!
    let bytes = try VaultCrypto.decryptBlob(stored, blobId: fileItem.payload.blobId, vdk: vdk)
    eq(bytes, b64("fileBytes"), "blob decrypts to fileBytes")
    eq(VaultCrypto.sha256Hex(bytes), fileItem.payload.sha256, "blob sha256 matches item")
    eq(bytes.count, fileItem.payload.size, "blob size matches item")

    // Vault document round trip, incl. passkey slot + blobs; and through AppData (top-level "vault")
    let reVault = try JSONDecoder().decode(VaultData.self, from: JSONEncoder().encode(vault))
    check(reVault == vault, "vault decode → encode → decode equal")
    let reObj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(vault)) as! NSDictionary
    check(reObj.isEqual(to: obj["vault"] as! [String: Any]), "vault re-encodes to the identical JSON")
    var doc = AppData()
    doc.extra["vault"] = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: obj["vault"]!))
    let docObj = try JSONSerialization.jsonObject(with: try JSONDecoder().decode(AppData.self, from: doc.jsonData()).jsonData()) as! [String: Any]
    check((docObj["vault"] as? NSDictionary)?.isEqual(to: obj["vault"] as! [String: Any]) == true, "top-level vault preserved through v2 data round trip")
} catch { check(false, "vault vector threw \(error)") }

section("Vault: new vault round trip + SE wrap math (software keys)")
do {
    let vdk = VaultCrypto.randomBytes(32)
    let (v0, recovery) = try VaultCrypto.newVault(vdk: vdk, mode: .hardwareRecovery)
    var v = v0
    check(recovery != nil && v.keyslots.count == 1, "hardware+recovery creates a recovery slot")
    let (hw, noRec) = try VaultCrypto.newVault(vdk: vdk, mode: .hardwareOnly)
    check(noRec == nil && hw.keyslots.isEmpty && hw.mode == "hardware-only", "hardware-only has no recovery slot")
    // "secure-enclave" slot exactly as se.createSlot builds it, with a software stand-in for the SE key
    let fakeSE = P256.KeyAgreement.PrivateKey()
    let slotId = UUID().uuidString.lowercased()
    let seSlot = try VaultCrypto.wrapForSecureEnclave(vdk: vdk, sePublicKey: fakeSE.publicKey, slotId: slotId, label: "Mac", device: "Test")
    eq(Data(base64Encoded: seSlot.ephemeralPublicKey!)!.count, 65, "ephemeral key X9.63 65 bytes")
    eq(Data(base64Encoded: seSlot.ct)!.count, 48, "SE slot ct 48 bytes")
    eq(try VaultCrypto.unwrapSecureEnclave(seSlot) { try fakeSE.sharedSecretFromKeyAgreement(with: $0) }, vdk, "SE slot unwraps with its key")
    do { _ = try VaultCrypto.unwrapSecureEnclave(seSlot) { try P256.KeyAgreement.PrivateKey().sharedSecretFromKeyAgreement(with: $0) }; check(false, "other key must fail") }
    catch { check(true, "SE slot rejects a different key") }
    var moved = seSlot; moved.id = UUID().uuidString
    do { _ = try VaultCrypto.unwrapSecureEnclave(moved) { try fakeSE.sharedSecretFromKeyAgreement(with: $0) }; check(false, "slot AAD must bind id") }
    catch { check(true, "SE slot AAD bound to slot id") }
    // independent HKDF check: CryptoKit's SharedSecret HKDF == our HKDF over the raw secret
    let eph = Data(base64Encoded: seSlot.ephemeralPublicKey!)!
    let ss = try fakeSE.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: eph))
    let k1 = ss.hkdfDerivedSymmetricKey(using: SHA256.self, salt: eph, sharedInfo: Data(VaultCrypto.infoSE.utf8), outputByteCount: 32)
    let k2 = VaultCrypto.hkdf(ikm: ss.withUnsafeBytes { Data($0) }, salt: eph, info: VaultCrypto.infoSE)
    check(k1.withUnsafeBytes { Data($0) } == k2.withUnsafeBytes { Data($0) }, "HKDF matches CryptoKit SharedSecret HKDF")
    v.keyslots.append(seSlot)
    // items of every type
    var login = VaultPayload(type: .login, title: "Bank"); login.username = "me"; login.password = PasswordGenerator.generate(.init())
    var card = VaultPayload(type: .card, title: "Visa"); card.number = "4111"; card.fields = [VaultField(label: "PIN", value: "1", secret: true)]
    let blobId = UUID().uuidString.lowercased()
    let fileBytes = Data("hello vault".utf8)
    var file = VaultPayload(type: .file, title: "Doc"); file.fileName = "a.txt"; file.mime = "text/plain"
    file.size = fileBytes.count; file.blobId = blobId; file.sha256 = VaultCrypto.sha256Hex(fileBytes)
    var note = VaultPayload(type: .note, title: "Secret"); note.markdown = "# hi"; note.favorite = true; note.tags = ["x"]
    let payloads = [note, login, card, file]
    for p in payloads { v.items.append(try VaultCrypto.encryptItem(p, id: UUID().uuidString.lowercased(), vdk: vdk, createdAt: ISO.string())) }
    let blob = try VaultCrypto.encryptBlob(fileBytes, blobId: blobId, vdk: vdk)
    v.blobs = [blobId: VaultCipherBox(iv: blob.prefix(12).base64EncodedString(), ct: blob.dropFirst(12).base64EncodedString())]
    let decoded = try JSONDecoder().decode(VaultData.self, from: JSONEncoder().encode(v))
    let vdk2 = try VaultCrypto.unwrapRecovery(decoded.keyslots[0], recoveryBytes: try RecoveryKey.decode(RecoveryKey.encode(recovery!)))
    eq(vdk2, vdk, "recovery key (via printed form) unlocks the new vault")
    check(VaultCrypto.checkVerifier(decoded.verifier, vdk: vdk2), "new vault verifier ok")
    eq(try decoded.items.map { try VaultCrypto.decryptItem($0, vdk: vdk2).payload }, payloads, "all item types round trip")
    let b = decoded.blobs![blobId]!
    eq(try VaultCrypto.decryptBlob(Data(base64Encoded: b.iv)! + Data(base64Encoded: b.ct)!, blobId: blobId, vdk: vdk2), fileBytes, "blob round trip")
    let again = try VaultCrypto.encryptItem(note, id: decoded.items[0].id, vdk: vdk, createdAt: decoded.items[0].createdAt)
    check(again.iv != decoded.items[0].iv, "re-encrypting an item uses a fresh IV")
    do { _ = try VaultCrypto.encryptBlob(Data(count: VaultCrypto.maxBlobBytes + 1), blobId: blobId, vdk: vdk); check(false, "25 MB limit") }
    catch { check(true, "blobs over 25 MB rejected") }
} catch { check(false, "vault round trip threw \(error)") }

section("Password generator")
do {
    var o = PasswordGenerator.Options(); o.length = 32
    let pw = PasswordGenerator.generate(o)
    eq(pw.count, 32, "length 32")
    check(pw.contains { $0.isUppercase } && pw.contains { $0.isLowercase } && pw.contains { $0.isNumber } && pw.contains { !$0.isLetter && !$0.isNumber }, "every enabled class present")
    check(!pw.contains { PasswordGenerator.lookAlikes.contains($0) }, "no look-alikes")
    o.length = 3; eq(PasswordGenerator.generate(o).count, 8, "min length 8")
    o.length = 500; eq(PasswordGenerator.generate(o).count, 64, "max length 64")
    o = .init(); o.upper = false; o.symbols = false; o.digits = false; o.length = 12
    check(PasswordGenerator.generate(o).allSatisfy { $0.isLowercase }, "lowercase only")
    check(PasswordGenerator.strength("abc") == 0 && PasswordGenerator.strength(PasswordGenerator.generate(.init())) == 4, "strength meter")
}

section("Bridge parameter validation")
do {
    check((try? Validate.uuid("aaaaaaaa-0000-4000-8000-000000000001", "id")) != nil, "UUID accepted")
    for bad: Any in ["../x", "aaaaaaaa-0000-4000-8000-00000000000", 42, "aaaaaaaa-0000-4000-8000-000000000001/.."] {
        check((try? Validate.uuid(bad, "id")) == nil, "UUID rejected: \(bad)")
    }
    check((try? Validate.base64("AAAA", "x", maxBytes: 3)) != nil, "base64 ok")
    check((try? Validate.base64("AAAAAA==", "x", maxBytes: 3)) == nil, "base64 over limit rejected")
    check((try? Validate.base64("@@@@", "x", maxBytes: 10)) == nil, "bad base64 rejected")
    check((try? Validate.int(NSNumber(value: true), "n", range: 0...5)) == nil, "bool is not a number")
    check((try? Validate.int(NSNumber(value: 2.5), "n", range: 0...5)) == nil, "fraction rejected")
    eq(try Validate.int(NSNumber(value: 3), "n", range: 0...5), 3, "int ok")
    check((try? Validate.string(String(repeating: "x", count: 11), "s", max: 10)) == nil, "string length limit")
}

print("\n\(passes) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
