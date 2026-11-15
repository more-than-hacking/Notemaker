import SwiftUI

struct SearchView: View {
    @EnvironmentObject var store: AppStore
    @FocusState private var focused: Bool

    var body: some View {
        let hits = Search.run(store.data, query: store.searchQuery)
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search tasks, subtasks, #tags and notes across all days", text: $store.searchQuery)
                    .textFieldStyle(.plain).font(.title3).focused($focused)
                if !store.searchQuery.isEmpty {
                    Text("\(hits.count) result\(hits.count == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary)
                    Button { store.searchQuery = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            .padding(14)
            Divider()
            if store.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty {
                ContentUnavailableView("Search everything", systemImage: "magnifyingglass",
                                       description: Text("Matches task titles, subtasks, tags (start with #) and the text of unlocked notes."))
            } else if hits.isEmpty {
                ContentUnavailableView.search(text: store.searchQuery)
            } else {
                List {
                    ForEach(Search.grouped(hits), id: \.0) { day, items in
                        Section {
                            ForEach(items) { h in
                                Button { open(h) } label: {
                                    HStack(spacing: 8) {
                                        Image(systemName: icon(h.kind)).foregroundStyle(.secondary).frame(width: 18)
                                        highlighted(h.text).lineLimit(2)
                                        Spacer()
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        } header: {
                            HStack {
                                Text(Day.longDate(day))
                                if day == store.today { Text("Today").foregroundStyle(.tint) }
                            }
                        }
                    }
                }
                .listStyle(.inset)
            }
        }
        .onAppear { focused = true }
        .onChange(of: store.focusSearch) { _, _ in focused = true }
    }

    private func open(_ h: SearchHit) {
        store.selectedTaskId = h.taskId
        store.go(h.date)
    }

    private func icon(_ k: SearchHit.Kind) -> String {
        switch k { case .task: return "checkmark.circle"; case .subtask: return "list.bullet.indent"; case .tag: return "tag"; case .note: return "note.text" }
    }

    private func highlighted(_ text: String) -> Text {
        var a = AttributedString(text)
        let q = store.searchQuery.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        if !q.isEmpty, let r = a.range(of: q, options: .caseInsensitive) {
            a[r].backgroundColor = Color.yellow.opacity(0.35)
            a[r].font = .body.bold()
        }
        return Text(a)
    }
}
