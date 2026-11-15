import SwiftUI
import UserNotifications

struct SettingsView: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        TabView {
            GeneralSettings().tabItem { Label("General", systemImage: "gearshape") }
            FocusPlannerSettings().tabItem { Label("Focus & Planner", systemImage: "timer") }
            PrivacySettings().tabItem { Label("Privacy", systemImage: "lock") }
            DataSettings().tabItem { Label("Data", systemImage: "externaldrive") }
        }
        .environmentObject(store)
        .frame(width: 520)
        .padding(.vertical, 8)
    }
}

private func timeBinding(_ store: AppStore, _ get: @escaping (Settings) -> String, _ set: @escaping (inout Settings, String) -> Void) -> Binding<Date> {
    Binding(get: { HM.date(day: Day.today(), time: get(store.data.settings)) ?? Date() },
            set: { d in store.updateSettings { set(&$0, HM.string(HM.nowMinutes(d))) } })
}

struct GeneralSettings: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var reminders = Reminders.shared

    var body: some View {
        Form {
            Picker("Appearance", selection: Binding(get: { store.data.settings.theme }, set: { t in store.updateSettings { $0.theme = t } })) {
                Text("System").tag(ThemeSetting.system)
                Text("Light").tag(ThemeSetting.light)
                Text("Dark").tag(ThemeSetting.dark)
            }
            .pickerStyle(.segmented)
            Picker("Week starts on", selection: Binding(get: { store.data.settings.weekStartsOn }, set: { v in store.updateSettings { $0.weekStartsOn = v } })) {
                Text("Monday").tag(1)
                Text("Sunday").tag(0)
                Text("Saturday").tag(6)
            }
            Toggle("Roll unfinished tasks over to today (at launch and midnight)", isOn: Binding(
                get: { store.data.settings.autoRollover },
                set: { v in
                    store.updateSettings { $0.autoRollover = v }
                    if v { store.mutate("Rollover") { TaskOps.rollover(&$0.tasks, today: Day.today()) } }
                }))
            Toggle("Prompt for a daily review", isOn: Binding(
                get: { store.data.settings.reviewTime != nil },
                set: { v in store.updateSettings { $0.reviewTime = v ? ($0.reviewTime ?? "18:00") : nil } }))
            if store.data.settings.reviewTime != nil {
                DatePicker("Review time", selection: timeBinding(store, { $0.reviewTime ?? "18:00" }, { $0.reviewTime = $1 }),
                           displayedComponents: .hourAndMinute)
            }
            LabeledContent("Notifications") {
                HStack {
                    Text(statusText).foregroundStyle(.secondary)
                    if reminders.authorization == .notDetermined {
                        Button("Allow…") { reminders.requestAuthorization() }
                    } else if reminders.authorization == .denied {
                        Button("Open System Settings") {
                            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!)
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { reminders.refreshStatus() }
    }

    private var statusText: String {
        switch reminders.authorization {
        case .authorized, .provisional, .ephemeral: return "Allowed"
        case .denied: return "Denied"
        default: return "Not requested"
        }
    }
}

struct FocusPlannerSettings: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        Form {
            Section("Focus timer") {
                Stepper("Focus: \(store.data.settings.focusMinutes) min", value: Binding(
                    get: { store.data.settings.focusMinutes }, set: { v in store.updateSettings { $0.focusMinutes = v } }), in: 1...120)
                Stepper("Break: \(store.data.settings.breakMinutes) min", value: Binding(
                    get: { store.data.settings.breakMinutes }, set: { v in store.updateSettings { $0.breakMinutes = v } }), in: 1...60)
            }
            Section("Planner") {
                DatePicker("Day starts", selection: timeBinding(store, { $0.dayStart }, { $0.dayStart = $1 }), displayedComponents: .hourAndMinute)
                DatePicker("Day ends", selection: timeBinding(store, { $0.dayEnd }, { $0.dayEnd = $1 }), displayedComponents: .hourAndMinute)
            }
        }
        .formStyle(.grouped)
    }
}

struct PrivacySettings: View {
    @EnvironmentObject var store: AppStore
    @State private var old = ""
    @State private var new1 = ""
    @State private var new2 = ""
    @State private var message: String?
    @State private var ok = false
    @State private var busy = false

    var body: some View {
        Form {
            Section {
                Text(store.hasPasscode
                     ? "A notes passcode is set. Locked notes are encrypted with AES-GCM-256 using a key derived from it (PBKDF2-SHA256, 210 000 iterations). Only a verification hash is stored."
                     : "Set a passcode to make individual day notes private. The passcode itself is never stored — if you forget it, locked notes cannot be recovered.")
                    .font(.callout).foregroundStyle(.secondary)
                if store.hasPasscode { SecureField("Current passcode", text: $old) }
                SecureField("New passcode", text: $new1)
                SecureField("Repeat new passcode", text: $new2)
                HStack {
                    if let m = message { Text(m).foregroundStyle(ok ? .green : .red).font(.callout) }
                    Spacer()
                    if busy { ProgressView().controlSize(.small) }
                    Button(store.hasPasscode ? "Change Passcode" : "Set Passcode", action: apply)
                        .disabled(new1.isEmpty || busy)
                }
            }
            Section {
                let locked = store.data.notes.values.filter(\.locked).count
                LabeledContent("Locked notes", value: "\(locked)")
                LabeledContent("Unlocked this session", value: "\(store.unlockedNotes.count)")
                Button("Lock all notes now") { for d in store.unlockedNotes.keys { store.relock(d) } }
                    .disabled(store.unlockedNotes.isEmpty)
            }
        }
        .formStyle(.grouped)
    }

    private func apply() {
        guard new1 == new2 else { ok = false; message = "The new passcodes don't match."; return }
        busy = true
        DispatchQueue.main.async {
            let err = store.changePasscode(old: store.hasPasscode ? old : nil, new: new1)
            busy = false
            ok = err == nil
            message = err ?? "Passcode saved."
            if ok { old = ""; new1 = ""; new2 = "" }
        }
    }
}

struct DataSettings: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        Form {
            Section("Backup") {
                Text("Backups use the shared Notemaker v2 JSON format and can be imported into the web app (and vice versa). Import also accepts web v1 backups.")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Button("Export Backup…") { store.exportBackup() }
                    Button("Import Backup…") { store.importBackup() }
                }
            }
            Section("Storage") {
                LabeledContent("Data file") { Text(store.dataFileURL.path).font(.caption).textSelection(.enabled).lineLimit(2) }
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([store.dataFileURL]) }
                LabeledContent("Contents", value: "\(store.data.tasks.count) tasks · \(store.data.notes.count) notes · \(store.data.habits.count) habits")
            }
        }
        .formStyle(.grouped)
    }
}
