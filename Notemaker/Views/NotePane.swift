import SwiftUI

enum EditorMode: String, CaseIterable, Identifiable {
    case edit = "Edit", split = "Split", preview = "Preview"
    var id: String { rawValue }
    var icon: String { switch self { case .edit: return "pencil"; case .split: return "rectangle.split.2x1"; case .preview: return "eye" } }
}

struct NotePane: View {
    @EnvironmentObject var store: AppStore
    let day: String
    @StateObject private var editor = EditorController()
    @AppStorage("editorMode") private var mode: EditorMode = .split
    @State private var passcode = ""
    @State private var passError: String?
    @State private var showLockPopover = false
    @State private var showBacklinks = true

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if store.isLocked(day) && !store.isUnlocked(day) {
                lockedView
            } else {
                if mode != .preview { formatBar; Divider() }
                content
                backlinks
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Label("Note", systemImage: store.isLocked(day) ? "lock.fill" : "note.text").font(.headline)
            if let n = store.note(day) {
                Text("Edited \(relative(n.updatedAt))").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Menu {
                ForEach(store.data.templates) { t in
                    Button(t.name) { applyTemplate(t) }
                }
                Divider()
                Button("Manage Templates…") { store.sheet = .templates }
            } label: { Label("Template", systemImage: "doc.on.doc") }
                .menuStyle(.borderlessButton).fixedSize()
                .disabled(store.isLocked(day) && !store.isUnlocked(day))
            lockButton
            Picker("", selection: $mode) {
                ForEach(EditorMode.allCases) { m in Image(systemName: m.icon).help(m.rawValue).tag(m) }
            }
            .pickerStyle(.segmented).labelsHidden().fixedSize()
        }
        .controlSize(.small)
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    @ViewBuilder private var lockButton: some View {
        if store.isLocked(day) {
            if store.isUnlocked(day) {
                Menu {
                    Button("Lock Now") { store.relock(day) }
                    Button("Remove Lock (store as plain text)") { store.removeLock(day) }
                } label: { Image(systemName: "lock.open") }
                    .menuStyle(.borderlessButton).fixedSize().help("Private note (unlocked)")
            }
        } else {
            Button { showLockPopover = true; passcode = ""; passError = nil } label: { Image(systemName: "lock") }
                .buttonStyle(.borderless).help("Make this note private")
                .popover(isPresented: $showLockPopover) { lockPopover }
        }
    }

    private var lockPopover: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Lock this note").font(.headline)
            if store.hasPasscode {
                Text("The note is encrypted (AES-GCM) with your notes passcode.").font(.caption).foregroundStyle(.secondary)
                SecureField("Passcode", text: $passcode).onSubmit(doLock)
                if let e = passError { Text(e).font(.caption).foregroundStyle(.red) }
                HStack { Spacer(); Button("Lock", action: doLock).keyboardShortcut(.defaultAction) }
            } else {
                Text("Set a notes passcode in Settings → Privacy first.").font(.callout)
                Button("Open Settings…") { showLockPopover = false; openSettingsWindow() }
            }
        }
        .padding(14).frame(width: 280)
    }

    private func doLock() {
        if store.lock(day, passcode: passcode) { showLockPopover = false; passcode = "" } else { passError = "Wrong passcode." }
    }

    private var lockedView: some View {
        VStack(spacing: 12) {
            Image(systemName: "lock.fill").font(.system(size: 40)).foregroundStyle(.secondary)
            Text("This note is private").font(.title3.weight(.semibold))
            Text("Enter your passcode to decrypt it. The plain text stays in memory only.").font(.callout).foregroundStyle(.secondary)
            HStack {
                SecureField("Passcode", text: $passcode).frame(width: 200).onSubmit(doUnlock)
                Button("Unlock", action: doUnlock).keyboardShortcut(.defaultAction)
            }
            if let e = passError { Text(e).foregroundStyle(.red).font(.callout) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: day) { _, _ in passcode = ""; passError = nil }
    }

    private func doUnlock() {
        if store.unlock(day, passcode: passcode) { passcode = ""; passError = nil } else { passError = "Wrong passcode." }
    }

    private var textBinding: Binding<String> {
        Binding(get: { store.markdown(day) }, set: { store.setMarkdown(day, $0) })
    }

    @ViewBuilder private var content: some View {
        switch mode {
        case .edit:
            MarkdownTextView(text: textBinding, documentID: day, controller: editor)
        case .preview:
            MarkdownPreview(markdown: store.markdown(day), onToggleCheckbox: toggle)
        case .split:
            HSplitView {
                MarkdownTextView(text: textBinding, documentID: day, controller: editor).frame(minWidth: 180)
                MarkdownPreview(markdown: store.markdown(day), onToggleCheckbox: toggle).frame(minWidth: 180)
                    .background(Color(nsColor: .controlBackgroundColor))
            }
        }
    }

    private func toggle(_ line: Int) {
        store.setMarkdown(day, MarkdownParser.toggleCheckbox(store.markdown(day), line: line))
    }

    private var formatBar: some View {
        HStack(spacing: 2) {
            fmt("bold", "Bold") { editor.wrap("**", "**") }
            fmt("italic", "Italic") { editor.wrap("_", "_") }
            fmt("strikethrough", "Strikethrough") { editor.wrap("~~", "~~") }
            fmt("chevron.left.forwardslash.chevron.right", "Inline code") { editor.wrap("`", "`", placeholder: "code") }
            Divider().frame(height: 16).padding(.horizontal, 4)
            Menu {
                Button("Heading 1") { editor.prefixLines("# ") }
                Button("Heading 2") { editor.prefixLines("## ") }
                Button("Heading 3") { editor.prefixLines("### ") }
            } label: { Image(systemName: "textformat.size") }.menuStyle(.borderlessButton).fixedSize().help("Heading")
            fmt("list.bullet", "Bulleted list") { editor.prefixLines("- ") }
            fmt("list.number", "Numbered list") { editor.prefixLines("1. ") }
            fmt("checklist", "Checklist") { editor.prefixLines("- [ ] ") }
            fmt("text.quote", "Quote") { editor.prefixLines("> ") }
            fmt("decrease.indent", "Outdent") { editor.indent(true) }
            fmt("increase.indent", "Indent") { editor.indent(false) }
            Divider().frame(height: 16).padding(.horizontal, 4)
            fmt("link", "Link") { editor.wrap("[", "](https://)", placeholder: "link") }
            fmt("calendar.badge.plus", "Link to a day ([[YYYY-MM-DD]])") { editor.insert("[[\(Day.add(day, days: -1))]]") }
            fmt("tablecells", "Table") { editor.insertBlock("| Column 1 | Column 2 |\n| --- | --- |\n| | |\n") }
            fmt("curlybraces", "Code block") { editor.wrap("```\n", "\n```", placeholder: "code") }
            fmt("minus", "Horizontal rule") { editor.insertBlock("\n---\n") }
            Spacer()
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 8).padding(.vertical, 4)
    }

    private func fmt(_ icon: String, _ help: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon).frame(width: 22, height: 20) }.help(help)
    }

    @ViewBuilder private var backlinks: some View {
        let links = WikiLinks.backlinks(to: day, notes: store.data.notes)
        let outgoing = WikiLinks.links(in: store.markdown(day))
        if !links.isEmpty || !outgoing.isEmpty {
            Divider()
            DisclosureGroup(isExpanded: $showBacklinks) {
                VStack(alignment: .leading, spacing: 4) {
                    if !links.isEmpty {
                        Text("Linked from").font(.caption).foregroundStyle(.secondary)
                        FlowRow(items: links) { d in store.go(d) }
                    }
                    if !outgoing.isEmpty {
                        Text("Links to").font(.caption).foregroundStyle(.secondary)
                        FlowRow(items: Array(NSOrderedSet(array: outgoing)) as? [String] ?? outgoing) { d in store.go(d) }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Label("Backlinks (\(links.count))", systemImage: "link").font(.caption.weight(.semibold))
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
        }
    }

    private func applyTemplate(_ t: NoteTemplate) {
        let text = Templates.apply(t, day: day)
        if store.markdown(day).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            store.setMarkdown(day, text)
        } else {
            store.appendToNote(day, text)
        }
    }

    private func relative(_ iso: String) -> String {
        guard let d = ISO.date(iso) else { return "" }
        let f = RelativeDateTimeFormatter(); f.unitsStyle = .short
        return f.localizedString(for: d, relativeTo: Date())
    }
}

struct FlowRow: View {
    let items: [String]
    let action: (String) -> Void
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(items, id: \.self) { d in
                    Button { action(d) } label: {
                        Text("\(Day.weekdayShort[Day.weekday(d) - 1]) \(d)").font(.caption)
                    }.buttonStyle(.bordered).controlSize(.small)
                }
            }
        }
    }
}
