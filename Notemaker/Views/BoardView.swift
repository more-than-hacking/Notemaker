import SwiftUI

/// Kanban board of the selected day (plus overdue tasks when viewing today).
struct BoardView: View {
    @EnvironmentObject var store: AppStore
    @State private var target: TaskStatus?

    var body: some View {
        let day = store.selectedDay
        var tasks = store.tasks(on: day)
        if day == store.today {
            // overdue, not yet rolled tasks (e.g. when auto-rollover is off)
            let overdue = store.data.tasks.filter { !$0.isRecurring && !$0.done && $0.date < day }
            tasks += overdue
        }
        return HStack(alignment: .top, spacing: 12) {
            ForEach(TaskStatus.allCases) { s in
                column(s, tasks.filter { Occurrence.status($0, on: day) == s }, day: day)
            }
        }
        .padding(16)
    }

    private func column(_ s: TaskStatus, _ items: [TaskItem], day: String) -> some View {
        let color: Color = s == .todo ? .blue : s == .doing ? .purple : .green
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(s.label).font(.headline)
                Text("\(items.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    .padding(.horizontal, 6).background(Capsule().fill(Color.secondary.opacity(0.12)))
                Spacer()
            }
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(items) { t in card(t, day: day) }
                    if items.isEmpty {
                        Text("Drop tasks here").font(.callout).foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity, minHeight: 60)
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(RoundedRectangle(cornerRadius: 12).fill(color.opacity(target == s ? 0.14 : 0.05)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(target == s ? color.opacity(0.6) : Color.secondary.opacity(0.15)))
        .dropDestination(for: String.self) { ids, _ in
            for id in ids { store.setStatus(id, s, on: day) }
            return !ids.isEmpty
        } isTargeted: { on in target = on ? s : (target == s ? nil : target) }
    }

    private func card(_ t: TaskItem, day: String) -> some View {
        let overdue = t.date < day ? Day.between(t.date, day) : TaskOps.overdueDays(t, today: store.today)
        return VStack(alignment: .leading, spacing: 6) {
            Text(t.title).font(.callout.weight(.medium)).strikethrough(Occurrence.isDone(t, on: day))
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 4) {
                PriorityBadge(priority: t.priority)
                if overdue > 0 { Badge(text: "Overdue \(overdue)d", color: .red) }
                if t.isRecurring { Image(systemName: "repeat").font(.caption2).foregroundStyle(.indigo) }
                if !t.subtasks.isEmpty {
                    Badge(text: "\(t.subtasks.filter(\.done).count)/\(t.subtasks.count)", systemImage: "checklist")
                }
                ForEach(t.tags, id: \.self) { TagChip(tag: $0) }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)).shadow(color: .black.opacity(0.08), radius: 2, y: 1))
        .draggable(t.id) { Text(t.title).padding(8).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8)) }
        .contextMenu { TaskContextMenu(task: t, day: day) }
        .onTapGesture(count: 2) { store.selectedTaskId = t.id; store.view = .day }
    }
}
