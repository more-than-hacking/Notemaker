import SwiftUI

struct DayView: View {
    @EnvironmentObject var store: AppStore
    @State private var showInspector = false

    var body: some View {
        HSplitView {
            TasksPane(showInspector: $showInspector)
                .frame(minWidth: 380, idealWidth: 480)
            NotePane(day: store.selectedDay)
                .frame(minWidth: 360)
        }
        .inspector(isPresented: $showInspector) {
            if let id = store.selectedTaskId, store.task(id) != nil {
                TaskInspector(taskId: id).inspectorColumnWidth(min: 260, ideal: 300, max: 400)
            } else {
                ContentUnavailableView("No task selected", systemImage: "checklist", description: Text("Select a task to edit its details."))
                    .inspectorColumnWidth(min: 260, ideal: 300, max: 400)
            }
        }
    }
}

struct TasksPane: View {
    @EnvironmentObject var store: AppStore
    @Binding var showInspector: Bool

    var body: some View {
        let day = store.selectedDay
        let tasks = store.filteredTasks(on: day)
        let stats = Stats.day(store.data.tasks, day)
        VStack(spacing: 0) {
            QuickAddBar()
                .padding([.horizontal, .top], 12)
            FilterBar()
                .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            if tasks.isEmpty {
                ContentUnavailableView {
                    Label(stats.total == 0 ? "No tasks" : "Nothing matches the filters", systemImage: "checklist")
                } description: {
                    Text(stats.total == 0 ? "Type a task above — e.g. “Call Raj tomorrow 3pm #work !high”." : "Clear the filters to see all tasks.")
                }
                .frame(maxHeight: .infinity)
            } else {
                List(selection: Binding(get: { store.selectedTaskId }, set: { v in if store.selectedTaskId != v { store.selectedTaskId = v } })) {
                    ForEach(tasks) { t in
                        TaskRow(task: t, day: day, onOpen: { store.selectedTaskId = t.id; showInspector = true })
                            .tag(t.id)
                    }
                    .onMove(perform: canReorder ? { store.move(on: day, from: $0, to: $1) } : nil)
                }
                .listStyle(.inset(alternatesRowBackgrounds: false))
                .onDeleteCommand {
                    if let t = store.task(store.selectedTaskId) { store.delete(t, onlyOccurrence: t.isRecurring ? day : nil) }
                }
            }
            Divider()
            HStack {
                Text("\(stats.done) of \(stats.total) completed").font(.caption).foregroundStyle(.secondary)
                if stats.total > 0 {
                    ProgressView(value: stats.ratio).frame(width: 80).tint(.green)
                }
                Spacer()
                let incomplete = store.tasks(on: day).filter { !$0.isRecurring && !$0.done && $0.date == day }.count
                Button {
                    store.forwardIncomplete(from: day)
                } label: { Label("Forward \(incomplete) to next day", systemImage: "arrow.right.circle") }
                    .disabled(incomplete == 0)
                    .controlSize(.small)
                Button { showInspector.toggle() } label: { Image(systemName: "sidebar.right") }
                    .controlSize(.small).help("Task details")
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
    }

    private var canReorder: Bool {
        store.sortMode == .manual && store.statusFilter == .all && store.priorityFilter == nil && store.tagFilter == nil
    }
}

struct QuickAddBar: View {
    @EnvironmentObject var store: AppStore
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        let preview = QuickAdd.parse(text, today: store.today, defaultDate: store.selectedDay)
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "plus.circle.fill").foregroundStyle(.tint)
                TextField("Add a task — try “Gym every mon 7am #health !high ~2”", text: $text)
                    .textFieldStyle(.plain)
                    .font(.body)
                    .focused($focused)
                    .onSubmit {
                        if store.addQuick(text) != nil { text = "" }
                    }
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 8).fill(.background).shadow(color: .black.opacity(0.08), radius: 1, y: 1))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? Color.accentColor.opacity(0.6) : Color.secondary.opacity(0.2)))
            if !text.trimmingCharacters(in: .whitespaces).isEmpty {
                HStack(spacing: 8) {
                    Text(preview.title.isEmpty ? "(no title)" : preview.title).font(.caption.weight(.semibold))
                    ForEach(preview.summary, id: \.self) { Text($0).font(.caption) }
                    if preview.date != store.selectedDay {
                        Text("→ \(Day.longDate(preview.date))").font(.caption).foregroundStyle(.orange)
                    }
                }
                .foregroundStyle(.secondary)
                .padding(.leading, 4)
                .transition(.opacity)
            }
        }
        .onChange(of: store.focusQuickAdd) { _, _ in focused = true }
    }
}

struct FilterBar: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        HStack(spacing: 8) {
            Picker("", selection: $store.statusFilter) {
                ForEach(StatusFilter.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden().frame(maxWidth: 230)
            Menu {
                Button("Any priority") { store.priorityFilter = nil }
                Divider()
                ForEach(Priority.allCases.reversed()) { p in Button(p.label) { store.priorityFilter = p } }
            } label: {
                Label(store.priorityFilter.map { $0.label } ?? "Priority", systemImage: "flag")
            }
            .menuStyle(.borderlessButton).fixedSize()
            Menu {
                Button("Any tag") { store.tagFilter = nil }
                Divider()
                ForEach(store.allTags, id: \.self) { t in Button("#\(t)") { store.tagFilter = t } }
            } label: {
                Label(store.tagFilter.map { "#\($0)" } ?? "Tag", systemImage: "tag")
            }
            .menuStyle(.borderlessButton).fixedSize()
            Spacer()
            Picker("Sort", selection: $store.sortMode) {
                ForEach(SortMode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.menu).fixedSize()
            if store.priorityFilter != nil || store.tagFilter != nil || store.statusFilter != .all {
                Button { store.priorityFilter = nil; store.tagFilter = nil; store.statusFilter = .all } label: {
                    Image(systemName: "xmark.circle.fill")
                }.buttonStyle(.plain).foregroundStyle(.secondary).help("Clear filters")
            }
        }
        .controlSize(.small)
    }
}

struct TaskRow: View {
    @EnvironmentObject var store: AppStore
    let task: TaskItem
    let day: String
    var compact = false
    var onOpen: () -> Void = {}
    @State private var expanded = false
    @State private var newSub = ""

    var body: some View {
        let done = Occurrence.isDone(task, on: day)
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Button { store.toggleDone(task, on: day) } label: {
                    Image(systemName: done ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 16))
                        .foregroundStyle(done ? Color.green : Color.priority(task.priority).opacity(task.priority == .none ? 0.6 : 1))
                }
                .buttonStyle(.plain)
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title)
                        .strikethrough(done)
                        .foregroundStyle(done ? .secondary : .primary)
                        .lineLimit(compact ? 2 : nil)
                    meta(done: done)
                }
                Spacer(minLength: 4)
                if !compact && !task.subtasks.isEmpty {
                    Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                        HStack(spacing: 2) {
                            Text("\(task.subtasks.filter(\.done).count)/\(task.subtasks.count)").font(.caption).monospacedDigit()
                            Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2)
                        }.foregroundStyle(.secondary)
                    }.buttonStyle(.plain)
                }
                if !compact {
                    Button { expanded.toggle() } label: { Image(systemName: "plus.square.on.square").foregroundStyle(.tertiary) }
                        .buttonStyle(.plain).help("Add subtask").opacity(task.subtasks.isEmpty ? 1 : 0)
                }
            }
            if expanded && !compact { subtasks }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { onOpen() }
        .contextMenu { TaskContextMenu(task: task, day: day, onOpen: onOpen) }
    }

    @ViewBuilder private func meta(done: Bool) -> some View {
        let overdue = TaskOps.overdueDays(task, today: store.today)
        let hasMeta = task.priority != .none || !task.tags.isEmpty || task.reminder != nil || task.isRecurring
            || overdue > 0 || task.pomodoros.estimate > 0 || task.pomodoros.done > 0 || task.timeBlock != nil || !task.notes.isEmpty
            || task.status == .doing
        if hasMeta {
            HStack(spacing: 4) {
                PriorityBadge(priority: task.priority)
                if task.status == .doing && !done { Badge(text: "Doing", color: .purple) }
                if overdue > 0 && !done { Badge(text: "Overdue \(overdue) day\(overdue == 1 ? "" : "s")", color: .red, systemImage: "exclamationmark.triangle") }
                if let r = task.reminder { Badge(text: r, color: .blue, systemImage: "bell") }
                if let tb = task.timeBlock { Badge(text: "\(tb.start)–\(tb.end)", color: .teal, systemImage: "clock") }
                if let r = task.recurrence { Badge(text: r.freq.label, color: .indigo, systemImage: "repeat") }
                if task.pomodoros.estimate > 0 || task.pomodoros.done > 0 {
                    Badge(text: "\(task.pomodoros.done)/\(task.pomodoros.estimate)", color: .red, systemImage: "timer")
                }
                if !task.notes.isEmpty { Image(systemName: "note.text").font(.caption2).foregroundStyle(.secondary) }
                ForEach(task.tags, id: \.self) { TagChip(tag: $0) }
            }
        }
    }

    private var subtasks: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(task.subtasks) { s in
                HStack(spacing: 6) {
                    Button {
                        store.update(task.id, "Toggle Subtask") { t in
                            if let i = t.subtasks.firstIndex(where: { $0.id == s.id }) { t.subtasks[i].done.toggle() }
                        }
                    } label: { Image(systemName: s.done ? "checkmark.square.fill" : "square").foregroundStyle(s.done ? .green : .secondary) }
                        .buttonStyle(.plain)
                    Text(s.title).strikethrough(s.done).foregroundStyle(s.done ? .secondary : .primary).font(.callout)
                    Spacer()
                    Button {
                        store.update(task.id, "Delete Subtask") { $0.subtasks.removeAll { $0.id == s.id } }
                    } label: { Image(systemName: "xmark").font(.caption2) }.buttonStyle(.plain).foregroundStyle(.tertiary)
                }
            }
            HStack(spacing: 6) {
                Image(systemName: "plus").font(.caption).foregroundStyle(.secondary)
                TextField("Add subtask", text: $newSub)
                    .textFieldStyle(.plain).font(.callout)
                    .onSubmit {
                        let title = newSub.trimmingCharacters(in: .whitespaces)
                        guard !title.isEmpty else { return }
                        store.update(task.id, "Add Subtask") { $0.subtasks.append(Subtask(title: title)) }
                        newSub = ""
                    }
            }
        }
        .padding(.leading, 26)
    }
}

struct TaskContextMenu: View {
    @EnvironmentObject var store: AppStore
    let task: TaskItem
    let day: String
    var onOpen: () -> Void = {}

    var body: some View {
        Button("Edit Details…") { onOpen() }
        Button("Start Focus Session") { store.focus.start(taskId: task.id) }
        Divider()
        Menu("Priority") {
            ForEach(Priority.allCases.reversed()) { p in
                Button { store.update(task.id, "Set Priority") { $0.priority = p } } label: {
                    if task.priority == p { Label(p.label, systemImage: "checkmark") } else { Text(p.label) }
                }
            }
        }
        Menu("Status") {
            ForEach(TaskStatus.allCases) { s in Button(s.label) { store.setStatus(task.id, s, on: day) } }
        }
        if !task.isRecurring {
            Menu("Snooze") {
                Button("Tomorrow") { store.snooze(task.id, to: Day.add(store.today, days: 1)) }
                Button("In 2 days") { store.snooze(task.id, to: Day.add(store.today, days: 2)) }
                Button("Next Monday") { store.snooze(task.id, to: Day.add(store.today, days: 8 - Day.weekday(store.today))) }
                Button("In a week") { store.snooze(task.id, to: Day.add(store.today, days: 7)) }
            }
        }
        Divider()
        if task.isRecurring {
            Button("Delete This Occurrence") { store.delete(task, onlyOccurrence: day) }
            Button("Delete Entire Series", role: .destructive) { store.delete(task) }
        } else {
            Button("Delete", role: .destructive) { store.delete(task) }
        }
    }
}
