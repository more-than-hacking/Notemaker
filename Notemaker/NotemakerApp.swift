import SwiftUI
import AppKit

extension AppStore {
    static let shared = AppStore()
}

/// First responder if it is a text view (the note editor or a focused text field's field editor).
func focusedTextView() -> NSTextView? { NSApp.keyWindow?.firstResponder as? NSTextView }

@main
struct NotemakerApp: App {
    @StateObject private var store = AppStore.shared
    @StateObject private var focus = AppStore.shared.focus

    init() {
        Reminders.shared.onOpenDay = { day in AppStore.shared.go(day) }
    }

    var body: some Scene {
        WindowGroup("Notemaker", id: "main") {
            RootView()
                .environmentObject(store)
                .environmentObject(store.focus)
                .frame(minWidth: 900, minHeight: 600)
                .onOpenURL { url in
                    // notemaker://day/YYYY-MM-DD
                    if url.scheme == "notemaker", url.host == "day" { store.go(url.lastPathComponent) }
                }
        }
        .defaultSize(width: 1240, height: 800)
        .commands { AppCommands(store: store) }

        SwiftUI.Settings {
            SettingsView()
                .environmentObject(store)
        }

        MenuBarExtra(isInserted: Binding(get: { focus.menuBarVisible },
                                          set: { v in if focus.menuBarVisible != v { focus.menuBarVisible = v } })) {
            FocusMenu().environmentObject(store).environmentObject(focus)
        } label: {
            FocusMenuLabel(focus: focus)
        }
        .menuBarExtraStyle(.window)
    }
}

struct AppCommands: Commands {
    @ObservedObject var store: AppStore

    var body: some Commands {
        CommandGroup(replacing: .appInfo) {
            Button("About Notemaker") { showAboutPanel() }
        }
        CommandGroup(replacing: .newItem) {
            Button("New Task") { store.view = .day; store.focusQuickAdd += 1 }
                .keyboardShortcut("n")
        }
        CommandGroup(after: .newItem) {
            Divider()
            Button("Export Backup (JSON)…") { store.exportBackup() }.keyboardShortcut("e", modifiers: [.command, .shift])
            Button("Import Backup…") { store.importBackup() }.keyboardShortcut("i", modifiers: [.command, .shift])
            Divider()
            Button("Export Day as Markdown…") { store.exportMarkdown(week: false) }
            Button("Export Week as Markdown…") { store.exportMarkdown(week: true) }
        }
        CommandGroup(replacing: .undoRedo) {
            Button("Undo") {
                if focusedTextView() != nil { NSApp.sendAction(Selector(("undo:")), to: nil, from: nil) } else { store.undo() }
            }.keyboardShortcut("z")
            Button("Redo") {
                if focusedTextView() != nil { NSApp.sendAction(Selector(("redo:")), to: nil, from: nil) } else { store.redo() }
            }.keyboardShortcut("z", modifiers: [.command, .shift])
        }
        CommandGroup(replacing: .textEditing) {
            Button("Search Everything") { store.view = .search; store.focusSearch += 1 }
                .keyboardShortcut("f")
        }
        CommandMenu("Go") {
            Button("Command Palette…") { store.sheet = .palette }.keyboardShortcut("k")
            Divider()
            Button("Today") { store.goToday() }.keyboardShortcut("t")
            Button("Previous Day") {
                if let tv = focusedTextView() { tv.moveToBeginningOfLine(nil) } else { store.shiftDay(-1) }
            }.keyboardShortcut(.leftArrow)
            Button("Next Day") {
                if let tv = focusedTextView() { tv.moveToEndOfLine(nil) } else { store.shiftDay(1) }
            }.keyboardShortcut(.rightArrow)
            Divider()
            ForEach(SidebarItem.allCases) { item in
                Button(item.title) { store.view = item; if item == .search { store.focusSearch += 1 } }
                    .keyboardShortcut(item.shortcut)
            }
        }
        CommandMenu("Tasks") {
            Button("Forward Incomplete to Next Day") { store.forwardIncomplete(from: store.selectedDay) }
                .keyboardShortcut("f", modifiers: [.command, .option])
            Button("Daily Review…") { store.sheet = .review }
                .keyboardShortcut("r", modifiers: [.command, .shift])
            Divider()
            Button("Start Focus on Selected Task") { store.focus.start(taskId: store.selectedTaskId) }
                .keyboardShortcut("p", modifiers: [.command, .shift])
            Button("Stop Focus Timer") { store.focus.stop() }
            Divider()
            Button("Note Templates…") { store.sheet = .templates }
        }
        CommandGroup(replacing: .help) {
            Button("Keyboard Shortcuts") { store.sheet = .help }.keyboardShortcut("/")
        }
    }
}

func showAboutPanel() {
    let credits = NSAttributedString(string: "Daily tasks, notes, habits and focus — in sync with the Notemaker web app via JSON backups.",
                                     attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor])
    var opts: [NSApplication.AboutPanelOptionKey: Any] = [.credits: credits, .applicationName: "Notemaker"]
    if let icon = NSImage(named: "Notemaker") ?? NSApp.applicationIconImage { opts[.applicationIcon] = icon }
    NSApp.activate(ignoringOtherApps: true)
    NSApp.orderFrontStandardAboutPanel(options: opts)
}

func openSettingsWindow() {
    NSApp.activate(ignoringOtherApps: true)
    if !NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil) {
        NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
    }
}
