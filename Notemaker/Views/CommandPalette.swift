import SwiftUI

/// ⌘K palette: fuzzy match over commands, dates and tasks.
struct CommandPalette: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var selection = 0
    @FocusState private var focused: Bool

    struct Item: Identifiable {
        let id: String
        let title: String
        let subtitle: String
        let icon: String
        let run: () -> Void
    }

    var body: some View {
        let items = results()
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "command").foregroundStyle(.secondary)
                TextField("Type a command, a date (tomorrow, fri, 2026-12-01) or a task…", text: $query)
                    .textFieldStyle(.plain).font(.title3).focused($focused)
                    .onSubmit { execute(items) }
                    .onKeyPress(.downArrow) { selection = min(selection + 1, max(0, items.count - 1)); return .handled }
                    .onKeyPress(.upArrow) { selection = max(selection - 1, 0); return .handled }
                    .onKeyPress(.escape) { dismiss(); return .handled }
            }
            .padding(14)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                            HStack(spacing: 10) {
                                Image(systemName: item.icon).frame(width: 20).foregroundStyle(i == selection ? .white : .secondary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.title).lineLimit(1)
                                    if !item.subtitle.isEmpty {
                                        Text(item.subtitle).font(.caption).foregroundStyle(i == selection ? .white.opacity(0.8) : .secondary).lineLimit(1)
                                    }
                                }
                                Spacer()
                                if i == selection { Image(systemName: "return").font(.caption) }
                            }
                            .foregroundStyle(i == selection ? .white : .primary)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(RoundedRectangle(cornerRadius: 6).fill(i == selection ? Color.accentColor : .clear))
                            .contentShape(Rectangle())
                            .onTapGesture { selection = i; execute(items) }
                            .id(i)
                        }
                        if items.isEmpty { Text("No matches").foregroundStyle(.secondary).padding() }
                    }
                    .padding(6)
                }
                .onChange(of: selection) { _, s in proxy.scrollTo(s) }
            }
        }
        .frame(width: 560, height: 420)
        .onAppear { focused = true }
        .onChange(of: query) { _, _ in selection = 0 }
    }

    private func execute(_ items: [Item]) {
        guard items.indices.contains(selection) else { return }
        let item = items[selection]
        dismiss()
        DispatchQueue.main.async { item.run() }
    }

    private func commands() -> [Item] {
        var c: [Item] = SidebarItem.allCases.map { v in
            Item(id: "view-\(v.rawValue)", title: "Show \(v.title)", subtitle: "⌘\((SidebarItem.allCases.firstIndex(of: v) ?? 0) + 1)", icon: v.icon) {
                store.view = v; if v == .search { store.focusSearch += 1 }
            }
        }
        c += [
            Item(id: "new", title: "New Task", subtitle: "⌘N", icon: "plus.circle") { store.view = .day; store.focusQuickAdd += 1 },
            Item(id: "today", title: "Go to Today", subtitle: "⌘T", icon: "sun.max") { store.goToday() },
            Item(id: "search", title: "Search Everything", subtitle: "⌘F", icon: "magnifyingglass") { store.view = .search; store.focusSearch += 1 },
            Item(id: "review", title: "Daily Review", subtitle: "⇧⌘R", icon: "checkmark.seal") { store.sheet = .review },
            Item(id: "forward", title: "Forward Incomplete Tasks to Next Day", subtitle: "", icon: "arrow.right.circle") { store.forwardIncomplete(from: store.selectedDay) },
            Item(id: "focus", title: store.focus.isActive ? "Stop Focus Timer" : "Start Focus Timer", subtitle: store.task(store.selectedTaskId)?.title ?? "", icon: "timer") {
                if store.focus.isActive { store.focus.stop() } else { store.focus.start(taskId: store.selectedTaskId) }
            },
            Item(id: "templates", title: "Manage Note Templates", subtitle: "", icon: "doc.on.doc") { store.sheet = .templates },
            Item(id: "export", title: "Export Backup (JSON)", subtitle: "⇧⌘E", icon: "square.and.arrow.up") { store.exportBackup() },
            Item(id: "import", title: "Import Backup", subtitle: "⇧⌘I", icon: "square.and.arrow.down") { store.importBackup() },
            Item(id: "md-day", title: "Export Day as Markdown", subtitle: "", icon: "doc.plaintext") { store.exportMarkdown(week: false) },
            Item(id: "md-week", title: "Export Week as Markdown", subtitle: "", icon: "doc.plaintext") { store.exportMarkdown(week: true) },
            Item(id: "theme-light", title: "Theme: Light", subtitle: "", icon: "sun.min") { store.updateSettings { $0.theme = .light } },
            Item(id: "theme-dark", title: "Theme: Dark", subtitle: "", icon: "moon") { store.updateSettings { $0.theme = .dark } },
            Item(id: "theme-system", title: "Theme: System", subtitle: "", icon: "circle.lefthalf.filled") { store.updateSettings { $0.theme = .system } },
            Item(id: "undo", title: "Undo", subtitle: "⌘Z", icon: "arrow.uturn.backward") { store.undo() },
            Item(id: "redo", title: "Redo", subtitle: "⇧⌘Z", icon: "arrow.uturn.forward") { store.redo() },
            Item(id: "settings", title: "Settings", subtitle: "⌘,", icon: "gearshape") { openSettingsWindow() },
            Item(id: "help", title: "Keyboard Shortcuts", subtitle: "⌘/", icon: "keyboard") { store.sheet = .help },
            Item(id: "about", title: "About Notemaker", subtitle: "", icon: "info.circle") { showAboutPanel() },
        ]
        return c
    }

    /// Dates understood by the palette: today/tomorrow/yesterday, weekday names, YYYY-MM-DD, "in N days", "next week".
    private func dateItem() -> Item? {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return nil }
        var day: String?
        if q == "yesterday" { day = Day.add(store.today, days: -1) }
        else if Day.isValid(q) { day = q }
        else {
            let r = QuickAdd.parse(q, today: store.today)
            if r.dateExplicit && r.title.isEmpty { day = r.date }
        }
        guard let d = day else { return nil }
        return Item(id: "date-\(d)", title: "Go to \(Day.longDate(d))", subtitle: d, icon: "calendar") { store.go(d) }
    }

    private func results() -> [Item] {
        let q = query.trimmingCharacters(in: .whitespaces)
        var scored: [(Int, Item)] = []
        if let d = dateItem() { scored.append((1000, d)) }
        for c in commands() { if let s = Search.fuzzy(q, c.title) { scored.append((s + 20, c)) } }
        if !q.isEmpty {
            var seen = 0
            for t in store.data.tasks.sorted(by: { $0.date > $1.date }) {
                guard seen < 40, let s = Search.fuzzy(q, t.title) else { continue }
                seen += 1
                let day = t.isRecurring ? (Occurrence.next(t, from: store.today, count: 1).first ?? t.date) : t.date
                scored.append((s, Item(id: "task-\(t.id)", title: t.title,
                                       subtitle: "Task · \(Day.longDate(day))" + (t.isRecurring ? " · repeats" : ""),
                                       icon: Occurrence.isDone(t, on: day) ? "checkmark.circle.fill" : "circle") {
                    store.selectedTaskId = t.id; store.go(day)
                }))
            }
        }
        return Array(scored.sorted { $0.0 > $1.0 }.map(\.1).prefix(60))
    }
}

struct HelpSheet: View {
    @Environment(\.dismiss) private var dismiss
    private let rows: [(String, String)] = [
        ("⌘N", "New task (focus quick add)"), ("⌘K", "Command palette"), ("⌘F", "Search everything"),
        ("⌘T", "Go to today"), ("⌘← / ⌘→", "Previous / next day (outside text fields)"),
        ("⌘1 … ⌘7", "Day, Calendar, Planner, Board, Habits, Insights, Search"),
        ("⌘Z / ⇧⌘Z", "Undo / redo (text undo inside the editor)"), ("⇧⌘R", "Daily review"),
        ("⇧⌘P", "Start focus on the selected task"), ("⌥⌘F", "Forward incomplete tasks"),
        ("⇧⌘E / ⇧⌘I", "Export / import JSON backup"), ("⌘,", "Settings"), ("⌘/", "This help"),
        ("⌫", "Delete selected task (occurrence for recurring)"),
    ]
    private let grammar: [(String, String)] = [
        ("#tag", "add a tag"), ("!high !med !low  (!1 !2 !3)", "priority"),
        ("today, tomorrow, tmr, mon…sun", "date"), ("next week, in 3 days, in 2 weeks, 2026-12-01", "date"),
        ("at 9, 3pm, 3:30pm, 15:30", "reminder time"), ("every day / weekday / week / month, every mon", "repeat"),
        ("~4", "pomodoro estimate"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Text("Keyboard Shortcuts").font(.title2.weight(.semibold)); Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
                ForEach(rows, id: \.0) { k, v in
                    GridRow { Text(k).font(.body.monospaced()).foregroundStyle(.tint); Text(v) }
                }
            }
            Divider()
            Text("Quick-add grammar").font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
                ForEach(grammar, id: \.0) { k, v in
                    GridRow { Text(k).font(.callout.monospaced()); Text(v).foregroundStyle(.secondary) }
                }
            }
            Text("Example: “Call Raj tomorrow 3pm #work !high”").font(.callout).foregroundStyle(.secondary)
        }
        .padding(24).frame(width: 560)
    }
}
