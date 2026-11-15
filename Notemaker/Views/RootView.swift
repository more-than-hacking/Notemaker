import SwiftUI

struct RootView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var focus: FocusTimer
    @State private var showDatePicker = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        NavigationSplitView {
            Sidebar()
                .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 280)
        } detail: {
            detail
                .toolbar { toolbar }
                .navigationTitle(title)
                .navigationSubtitle(subtitle)
        }
        .sheet(item: $store.sheet) { s in
            switch s {
            case .palette: CommandPalette().environmentObject(store).environmentObject(focus)
            case .help: HelpSheet()
            case .review: ReviewSheet(day: store.selectedDay).environmentObject(store)
            case .templates: TemplatesSheet().environmentObject(store)
            }
        }
        .alert("Notemaker", isPresented: Binding(get: { store.lastError != nil }, set: { if !$0 { store.lastError = nil } })) {
            Button("OK") { store.lastError = nil }
        } message: { Text(store.lastError ?? "") }
    }

    private var title: String {
        switch store.view {
        case .day, .planner, .board: return Day.longDate(store.selectedDay)
        default: return store.view.title
        }
    }

    private var subtitle: String {
        let d = store.selectedDay
        if d == store.today { return "Today" }
        let n = Day.between(store.today, d)
        if n == 1 { return "Tomorrow" }
        if n == -1 { return "Yesterday" }
        return n > 0 ? "In \(n) days" : "\(-n) days ago"
    }

    @ViewBuilder private var detail: some View {
        switch store.view {
        case .day: DayView()
        case .calendar: CalendarView()
        case .planner: PlannerView()
        case .board: BoardView()
        case .habits: HabitsView()
        case .insights: InsightsView()
        case .search: SearchView()
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            Button { store.shiftDay(-1) } label: { Image(systemName: "chevron.left") }.help("Previous day (⌘←)")
            Button("Today") { store.goToday() }.help("Today (⌘T)")
            Button { store.shiftDay(1) } label: { Image(systemName: "chevron.right") }.help("Next day (⌘→)")
            // A field-style DatePicker inside the toolbar re-measured itself endlessly (constant
            // layout passes → ~20% CPU and a spinning cursor). A button + popover avoids that.
            Button { showDatePicker.toggle() } label: { Image(systemName: "calendar") }
                .help("Go to date…")
                .popover(isPresented: $showDatePicker, arrowEdge: .bottom) {
                    DatePicker("", selection: Binding(get: { Day.date(store.selectedDay) ?? Date() },
                                                      set: { let k = Day.key($0); if store.selectedDay != k { store.selectedDay = k; showDatePicker = false } }),
                               displayedComponents: .date)
                        .labelsHidden().datePickerStyle(.graphical).padding(10)
                }
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if focus.isActive {
                FocusToolbarChip()
            }
            Button { store.undo() } label: { Image(systemName: "arrow.uturn.backward") }
                .help("Undo (⌘Z)").disabled(!store.undoManager.canUndo)
            Button { store.redo() } label: { Image(systemName: "arrow.uturn.forward") }
                .help("Redo (⇧⌘Z)").disabled(!store.undoManager.canRedo)
            Button { store.sheet = .review } label: { Image(systemName: "checkmark.seal") }.help("Daily review (⇧⌘R)")
            Button { store.sheet = .palette } label: { Image(systemName: "command") }.help("Command palette (⌘K)")
            Menu {
                Button("Export Backup (JSON)…") { store.exportBackup() }
                Button("Import Backup…") { store.importBackup() }
                Divider()
                Button("Export Day as Markdown…") { store.exportMarkdown(week: false) }
                Button("Export Week as Markdown…") { store.exportMarkdown(week: true) }
                Divider()
                Picker("Appearance", selection: Binding(get: { store.data.settings.theme }, set: { t in store.updateSettings { $0.theme = t } })) {
                    Text("System").tag(ThemeSetting.system)
                    Text("Light").tag(ThemeSetting.light)
                    Text("Dark").tag(ThemeSetting.dark)
                }
                Divider()
                Button("Settings…") { openSettingsWindow() }
                Button("Keyboard Shortcuts") { store.sheet = .help }
            } label: { Image(systemName: "ellipsis.circle") }
        }
    }
}

struct Sidebar: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        VStack(spacing: 0) {
            List(selection: Binding(get: { store.view }, set: { if let v = $0, store.view != v { store.view = v } })) {
                Section("Views") {
                    ForEach(SidebarItem.allCases) { item in
                        Label(item.title, systemImage: item.icon)
                            .badge(badge(item))
                            .tag(item)
                    }
                }
                if !store.allTags.isEmpty {
                    Section("Tags") {
                        ForEach(store.allTags.prefix(12), id: \.self) { t in
                            Button {
                                store.tagFilter = store.tagFilter == t ? nil : t
                                store.view = .day
                            } label: {
                                HStack {
                                    Circle().fill(Color.tag(t)).frame(width: 8, height: 8)
                                    Text(t)
                                    Spacer()
                                    if store.tagFilter == t { Image(systemName: "line.3.horizontal.decrease.circle.fill").foregroundStyle(.tint) }
                                }
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            MiniDayStats()
        }
    }

    private func badge(_ item: SidebarItem) -> Int {
        guard item == .day else { return 0 }
        return store.tasks(on: store.today).filter { !Occurrence.isDone($0, on: store.today) }.count
    }
}

struct MiniDayStats: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        let s = Stats.day(store.data.tasks, store.selectedDay)
        let streak = Streaks.current(Streaks.completionDays(store.data.tasks), today: store.today)
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            HStack {
                Text("\(s.done)/\(s.total) done").font(.caption.weight(.medium))
                Spacer()
                Label("\(streak)", systemImage: "flame.fill").font(.caption).foregroundStyle(.orange).help("Current streak")
            }
            ProgressView(value: s.ratio).tint(.green)
        }
        .padding(.horizontal, 12).padding(.bottom, 10)
    }
}

struct FocusToolbarChip: View {
    @EnvironmentObject var focus: FocusTimer
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: focus.phase == .focus ? "timer" : "cup.and.saucer")
            Text(focus.label).monospacedDigit()
            Button { focus.togglePause() } label: { Image(systemName: focus.paused ? "play.fill" : "pause.fill") }.buttonStyle(.plain)
            Button { focus.stop() } label: { Image(systemName: "stop.fill") }.buttonStyle(.plain)
        }
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(Capsule().fill((focus.phase == .focus ? Color.red : Color.green).opacity(0.15)))
        .help(focus.taskTitle ?? "Focus timer")
    }
}

struct FocusMenuLabel: View {
    @ObservedObject var focus: FocusTimer
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: focus.phase == .break ? "cup.and.saucer.fill" : "timer")
            Text(focus.label).monospacedDigit()
        }
    }
}

struct FocusMenu: View {
    @EnvironmentObject var focus: FocusTimer
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(focus.phase == .break ? "Break" : "Focus").font(.headline)
            if let t = focus.taskTitle { Text(t).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
            Text(focus.label).font(.system(size: 34, weight: .semibold, design: .rounded)).monospacedDigit()
            ProgressView(value: min(1, max(0, focus.progress)))
            HStack {
                Button(focus.paused ? "Resume" : "Pause") { focus.togglePause() }
                Button("Stop", role: .destructive) { focus.stop() }
                Spacer()
                Button("Open") { NSApp.activate(ignoringOtherApps: true) }
            }
        }
        .padding(14).frame(width: 240)
    }
}
