import SwiftUI

struct TemplatesSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var selection: String?
    @State private var name = ""
    @State private var markdown = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Note Templates").font(.title2.weight(.semibold))
                Spacer()
                Button("Done") { commit(); dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding(16)
            Divider()
            HSplitView {
                VStack(spacing: 0) {
                    List(selection: Binding(get: { selection }, set: { v in guard v != selection else { return }; commit(); selection = v; load() })) {
                        ForEach(store.data.templates) { t in Text(t.name.isEmpty ? "Untitled" : t.name).tag(t.id) }
                    }
                    HStack {
                        Button { add() } label: { Image(systemName: "plus") }
                        Button { delete() } label: { Image(systemName: "minus") }.disabled(selection == nil)
                        Spacer()
                        Button("Restore built-ins") {
                            store.mutate("Restore Templates") { d in
                                for b in Templates.builtIns where !d.templates.contains(where: { $0.name == b.name }) { d.templates.append(b) }
                            }
                        }.controlSize(.small)
                    }
                    .buttonStyle(.borderless).padding(8)
                }
                .frame(minWidth: 200, maxWidth: 260)
                VStack(alignment: .leading, spacing: 8) {
                    if selection != nil {
                        TextField("Name", text: $name).textFieldStyle(.roundedBorder)
                        TextEditor(text: $markdown).font(.system(.body, design: .monospaced))
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.secondary.opacity(0.2)))
                        Text("Placeholders: {{date}} → long date, {{weekday}} → weekday name.").font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Spacer()
                            Button("Save") { commit() }
                            Button("Insert into \(Day.longDate(store.selectedDay))") {
                                commit()
                                let t = NoteTemplate(name: name, markdown: markdown)
                                let text = Templates.apply(t, day: store.selectedDay)
                                if store.markdown(store.selectedDay).isEmpty { store.setMarkdown(store.selectedDay, text) } else { store.appendToNote(store.selectedDay, text) }
                                dismiss()
                            }
                        }
                    } else {
                        ContentUnavailableView("Select a template", systemImage: "doc.on.doc")
                    }
                }
                .padding(12)
                .frame(minWidth: 360)
            }
        }
        .frame(width: 760, height: 520)
        .onAppear { selection = store.data.templates.first?.id; load() }
    }

    private func load() {
        guard let t = store.data.templates.first(where: { $0.id == selection }) else { name = ""; markdown = ""; return }
        name = t.name; markdown = t.markdown
    }

    private func commit() {
        guard let id = selection, let t = store.data.templates.first(where: { $0.id == id }),
              t.name != name || t.markdown != markdown else { return }
        let n = name, m = markdown
        store.mutate("Edit Template") { d in
            if let i = d.templates.firstIndex(where: { $0.id == id }) { d.templates[i].name = n; d.templates[i].markdown = m }
        }
    }

    private func add() {
        commit()
        let t = NoteTemplate(name: "New template", markdown: "# {{weekday}}, {{date}}\n\n")
        store.mutate("Add Template") { $0.templates.append(t) }
        selection = t.id; load()
    }

    private func delete() {
        guard let id = selection else { return }
        store.mutate("Delete Template") { $0.templates.removeAll { $0.id == id } }
        selection = store.data.templates.first?.id; load()
    }
}
