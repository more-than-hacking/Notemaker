import SwiftUI

/// End-of-day review: triage unfinished tasks and write a short reflection into the day's note.
struct ReviewSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let day: String

    enum Decision: Hashable { case keep, tomorrow, snooze, drop }
    @State private var decisions: [String: Decision] = [:]
    @State private var snoozeDates: [String: Date] = [:]
    @State private var wins = ""
    @State private var blockers = ""
    @State private var focusTomorrow = ""

    var body: some View {
        let tasks = store.tasks(on: day)
        let done = tasks.filter { Occurrence.isDone($0, on: day) }
        let open = tasks.filter { !Occurrence.isDone($0, on: day) }
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading) {
                    Text("Daily Review").font(.title2.weight(.semibold))
                    Text(Day.longDate(day)).foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(done.count)/\(tasks.count) done").font(.headline).foregroundStyle(.green)
            }
            .padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    GroupBox("Completed") {
                        if done.isEmpty { Text("Nothing completed yet — that's ok.").foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
                        ForEach(done) { t in Label(t.title, systemImage: "checkmark.circle.fill").foregroundStyle(.green).frame(maxWidth: .infinity, alignment: .leading) }
                    }
                    if !open.isEmpty {
                        GroupBox("Unfinished") {
                            VStack(spacing: 8) {
                                ForEach(open) { t in openRow(t) }
                            }
                        }
                    }
                    GroupBox("Reflection") {
                        VStack(alignment: .leading, spacing: 8) {
                            field("Wins", $wins, "What went well?")
                            field("Blockers", $blockers, "What got in the way?")
                            field("Tomorrow's focus", $focusTomorrow, "The one thing that matters tomorrow")
                        }
                    }
                    if store.isLocked(day) && !store.isUnlocked(day) {
                        Label("This day's note is locked — unlock it to save the reflection.", systemImage: "lock")
                            .font(.caption).foregroundStyle(.orange)
                    }
                }
                .padding(20)
            }
            Divider()
            HStack {
                Button("Skip Today") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Save Review") { save(open) }.keyboardShortcut(.defaultAction)
            }
            .padding(16)
        }
        .frame(width: 600, height: 640)
    }

    private func openRow(_ t: TaskItem) -> some View {
        HStack {
            Image(systemName: "circle").foregroundStyle(.secondary)
            Text(t.title).lineLimit(1)
            if t.isRecurring { Image(systemName: "repeat").foregroundStyle(.indigo).font(.caption) }
            Spacer()
            Picker("", selection: Binding(get: { decisions[t.id] ?? .keep }, set: { v in if decisions[t.id] != v { decisions[t.id] = v } })) {
                Text("Keep").tag(Decision.keep)
                if !t.isRecurring {
                    Text("Tomorrow").tag(Decision.tomorrow)
                    Text("Snooze…").tag(Decision.snooze)
                }
                Text(t.isRecurring ? "Skip today" : "Drop").tag(Decision.drop)
            }
            .labelsHidden().frame(width: 120)
            if decisions[t.id] == .snooze {
                DatePicker("", selection: Binding(get: { snoozeDates[t.id] ?? Day.date(Day.add(day, days: 2))! },
                                                  set: { v in if snoozeDates[t.id] != v { snoozeDates[t.id] = v } }), in: (Day.date(Day.add(day, days: 1)) ?? Date())...,
                           displayedComponents: .date).labelsHidden().frame(width: 110)
            }
        }
    }

    private func field(_ title: String, _ text: Binding<String>, _ prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.callout.weight(.medium))
            TextField(prompt, text: text, axis: .vertical).lineLimit(2...4).textFieldStyle(.roundedBorder)
        }
    }

    private func save(_ open: [TaskItem]) {
        let decided = decisions
        let snoozes = snoozeDates
        if decided.values.contains(where: { $0 != .keep }) {
            store.mutate("Daily Review") { data in
                for t in open {
                    guard let i = data.tasks.firstIndex(where: { $0.id == t.id }) else { continue }
                    switch decided[t.id] ?? .keep {
                    case .keep: break
                    case .tomorrow: TaskOps.snooze(&data.tasks[i], to: Day.add(day, days: 1))
                    case .snooze: TaskOps.snooze(&data.tasks[i], to: Day.key(snoozes[t.id] ?? Day.date(Day.add(day, days: 2))!))
                    case .drop:
                        if t.isRecurring { TaskOps.skip(&data.tasks[i], on: day) } else { data.tasks.remove(at: i) }
                    }
                }
            }
        }
        let parts = [("Wins", wins), ("Blockers", blockers), ("Tomorrow's focus", focusTomorrow)]
            .filter { !$0.1.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if !parts.isEmpty {
            let doneCount = store.tasks(on: day).filter { Occurrence.isDone($0, on: day) }.count
            var md = "## Daily review\n\n_\(doneCount) task\(doneCount == 1 ? "" : "s") completed._\n\n"
            for (k, v) in parts { md += "**\(k):** \(v.trimmingCharacters(in: .whitespacesAndNewlines))\n\n" }
            store.appendToNote(day, md.trimmingCharacters(in: .newlines) + "\n")
        }
        UserDefaults.standard.set(Day.today(), forKey: "lastReviewPrompt")
        dismiss()
    }
}
