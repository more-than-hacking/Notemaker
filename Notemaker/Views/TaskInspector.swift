import SwiftUI

/// Detail inspector: every field of a task, including the recurrence editor.
struct TaskInspector: View {
    @EnvironmentObject var store: AppStore
    let taskId: String
    @State private var title = ""
    @State private var notes = ""
    @State private var tags = ""
    @State private var newSub = ""

    var body: some View {
        if let t = store.task(taskId) {
            Form {
                Section("Task") {
                    TextField("Title", text: $title).onSubmit(commitText)
                    Picker("Priority", selection: bind(t, \.priority, "Set Priority")) {
                        ForEach(Priority.allCases) { Text($0.label).tag($0) }
                    }
                    Picker("Status", selection: Binding(get: { Occurrence.status(t, on: store.selectedDay) },
                                                       set: { store.setStatus(t.id, $0, on: store.selectedDay) })) {
                        ForEach(TaskStatus.allCases) { Text($0.label).tag($0) }
                    }
                    DatePicker(t.isRecurring ? "Starts" : "Date", selection: Binding(
                        get: { Day.date(t.date) ?? Date() },
                        set: { d in store.update(t.id, "Change Date") { $0.date = Day.key(d); $0.rolledFrom = nil } }),
                               displayedComponents: .date)
                    TextField("Tags (space separated)", text: $tags).onSubmit(commitText)
                    if let r = t.rolledFrom, !t.done {
                        LabeledContent("Rolled over from", value: r)
                    }
                }
                Section("Reminder & planning") {
                    Toggle("Reminder", isOn: Binding(get: { t.reminder != nil }, set: { on in
                        store.update(t.id, "Set Reminder") { $0.reminder = on ? ($0.reminder ?? "09:00") : nil }
                        if on { Reminders.shared.requestAuthorization() }
                    }))
                    if let r = t.reminder {
                        TimeField(label: "At", value: r) { v in store.update(t.id, "Set Reminder") { $0.reminder = v } }
                    }
                    Toggle("Time block", isOn: Binding(get: { t.timeBlock != nil }, set: { on in
                        store.update(t.id, "Time Block") { $0.timeBlock = on ? TimeBlock(start: store.data.settings.dayStart, end: HM.string((HM.minutes(store.data.settings.dayStart) ?? 540) + 30)) : nil }
                    }))
                    if let tb = t.timeBlock {
                        TimeField(label: "Start", value: tb.start) { v in
                            store.update(t.id, "Time Block") { task in
                                let dur = (HM.minutes(tb.end) ?? 0) - (HM.minutes(tb.start) ?? 0)
                                task.timeBlock = TimeBlock(start: v, end: HM.string((HM.minutes(v) ?? 0) + max(15, dur)))
                            }
                        }
                        TimeField(label: "End", value: tb.end) { v in
                            store.update(t.id, "Time Block") { $0.timeBlock?.end = v }
                        }
                    }
                    Stepper("Pomodoros: \(t.pomodoros.done) / \(t.pomodoros.estimate)", value: Binding(
                        get: { t.pomodoros.estimate },
                        set: { v in store.update(t.id, "Estimate") { $0.pomodoros.estimate = max(0, v) } }), in: 0...20)
                    Button { store.focus.start(taskId: t.id) } label: { Label("Start focus session", systemImage: "timer") }
                }
                RecurrenceEditor(task: t)
                Section("Subtasks") {
                    ForEach(t.subtasks) { s in
                        HStack {
                            Toggle(isOn: Binding(get: { s.done }, set: { v in
                                store.update(t.id, "Toggle Subtask") { task in
                                    if let i = task.subtasks.firstIndex(where: { $0.id == s.id }) { task.subtasks[i].done = v }
                                }
                            })) { Text(s.title) }
                            Spacer()
                            Button { store.update(t.id, "Delete Subtask") { $0.subtasks.removeAll { $0.id == s.id } } } label: {
                                Image(systemName: "minus.circle")
                            }.buttonStyle(.borderless)
                        }
                    }
                    TextField("New subtask", text: $newSub).onSubmit {
                        let v = newSub.trimmingCharacters(in: .whitespaces)
                        guard !v.isEmpty else { return }
                        store.update(t.id, "Add Subtask") { $0.subtasks.append(Subtask(title: v)) }
                        newSub = ""
                    }
                }
                Section("Notes") {
                    TextEditor(text: $notes).frame(minHeight: 80).font(.body)
                    Button("Save notes", action: commitText).disabled(notes == t.notes)
                }
                Section {
                    if t.isRecurring {
                        Button("Delete this occurrence") { store.delete(t, onlyOccurrence: store.selectedDay) }
                        Button("Delete entire series", role: .destructive) { store.delete(t) }
                    } else {
                        Button("Delete task", role: .destructive) { store.delete(t) }
                    }
                }
            }
            .formStyle(.grouped)
            .onAppear { load(t) }
            .onChange(of: taskId) { _, _ in if let t = store.task(taskId) { load(t) } }
            .onDisappear(perform: commitText)
        }
    }

    private func load(_ t: TaskItem) {
        title = t.title; notes = t.notes; tags = t.tags.map { "#\($0)" }.joined(separator: " ")
    }

    private func commitText() {
        guard let t = store.task(taskId) else { return }
        let newTags = tags.split(whereSeparator: { $0 == " " || $0 == "," }).map { Tags.normalize(String($0)) }.filter { !$0.isEmpty }
        let newTitle = title.trimmingCharacters(in: .whitespaces)
        guard (newTitle != t.title && !newTitle.isEmpty) || notes != t.notes || newTags != t.tags else { return }
        store.update(t.id, "Edit Task") { task in
            if !newTitle.isEmpty { task.title = newTitle }
            task.notes = notes
            task.tags = Array(NSOrderedSet(array: newTags)) as? [String] ?? newTags
        }
    }

    private func bind<V>(_ t: TaskItem, _ kp: WritableKeyPath<TaskItem, V>, _ name: String) -> Binding<V> {
        Binding(get: { t[keyPath: kp] }, set: { v in store.update(t.id, name) { $0[keyPath: kp] = v } })
    }
}

/// "HH:MM" editor backed by a DatePicker.
struct TimeField: View {
    let label: String
    let value: String
    let onChange: (String) -> Void
    var body: some View {
        DatePicker(label, selection: Binding(
            get: { HM.date(day: Day.today(), time: value) ?? Date() },
            set: { d in onChange(HM.string(HM.nowMinutes(d))) }), displayedComponents: .hourAndMinute)
    }
}

struct RecurrenceEditor: View {
    @EnvironmentObject var store: AppStore
    let task: TaskItem

    var body: some View {
        Section("Repeat") {
            Picker("Repeats", selection: Binding<Freq?>(
                get: { task.recurrence?.freq },
                set: { f in
                    store.update(task.id, "Change Recurrence") { t in
                        if let f {
                            var r = t.recurrence ?? Recurrence(freq: f)
                            r.freq = f
                            if f == .weekly && r.byWeekday.isEmpty { r.byWeekday = [Day.weekday(t.date)] }
                            if f != .weekly { r.byWeekday = [] }
                            if t.recurrence == nil {      // becoming recurring: carry today's completion over
                                if t.done { t.doneDates[t.date] = true }
                                t.done = false; t.completedAt = nil; t.rolledFrom = nil
                                if t.status == .done { t.status = .todo }
                            }
                            t.recurrence = r
                        } else {
                            t.recurrence = nil
                            t.done = t.doneDates[t.date] == true
                            t.status = t.done ? .done : (t.status == .done ? .todo : t.status)
                            t.doneDates = [:]; t.skipDates = [:]
                        }
                    }
                })) {
                Text("Never").tag(Freq?.none)
                ForEach(Freq.allCases) { Text($0.label).tag(Freq?.some($0)) }
            }
            if let r = task.recurrence {
                if r.freq != .weekdays {
                    Stepper("Every \(r.interval) \(unit(r))", value: Binding(
                        get: { r.interval },
                        set: { v in store.update(task.id, "Change Recurrence") { $0.recurrence?.interval = max(1, v) } }), in: 1...52)
                }
                if r.freq == .weekly {
                    HStack(spacing: 4) {
                        ForEach(1...7, id: \.self) { w in
                            let on = r.byWeekday.contains(w)
                            Button(String(Day.weekdayShort[w - 1].prefix(2))) {
                                store.update(task.id, "Change Recurrence") { t in
                                    var days = Set(t.recurrence?.byWeekday ?? [])
                                    if on { days.remove(w) } else { days.insert(w) }
                                    t.recurrence?.byWeekday = days.sorted()
                                }
                            }
                            .buttonStyle(.borderless)
                            .frame(width: 26, height: 22)
                            .background(RoundedRectangle(cornerRadius: 5).fill(on ? Color.accentColor : Color.secondary.opacity(0.12)))
                            .foregroundStyle(on ? .white : .primary)
                        }
                    }
                }
                Toggle("Ends", isOn: Binding(get: { r.until != nil }, set: { on in
                    store.update(task.id, "Change Recurrence") { $0.recurrence?.until = on ? Day.add(task.date, days: 30) : nil }
                }))
                if let u = r.until {
                    DatePicker("Until", selection: Binding(get: { Day.date(u) ?? Date() }, set: { d in
                        store.update(task.id, "Change Recurrence") { $0.recurrence?.until = Day.key(d) }
                    }), displayedComponents: .date)
                }
                let next = Occurrence.next(task, from: store.today, count: 4)
                if !next.isEmpty {
                    LabeledContent("Next", value: next.map { "\(Day.weekdayShort[Day.weekday($0) - 1]) \($0.suffix(5))" }.joined(separator: ", "))
                        .font(.caption)
                }
                if !task.skipDates.isEmpty {
                    LabeledContent("Skipped", value: "\(task.skipDates.count) day(s)")
                    Button("Restore skipped occurrences") { store.update(task.id, "Restore Occurrences") { $0.skipDates = [:] } }
                }
            }
        }
    }

    private func unit(_ r: Recurrence) -> String {
        switch r.freq {
        case .daily: return r.interval == 1 ? "day" : "days"
        case .weekly: return r.interval == 1 ? "week" : "weeks"
        case .monthly: return r.interval == 1 ? "month" : "months"
        case .weekdays: return ""
        }
    }
}
