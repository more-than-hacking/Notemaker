import SwiftUI

/// Time-blocking planner: drag tasks from the unscheduled list onto 30-minute slots.
struct PlannerView: View {
    @EnvironmentObject var store: AppStore
    private let rowH: CGFloat = 34
    private let labelW: CGFloat = 56
    @State private var dropTarget: Int?

    var body: some View {
        let day = store.selectedDay
        let tasks = store.tasks(on: day)
        let start = HM.minutes(store.data.settings.dayStart) ?? 7 * 60
        let end = max(start + 60, HM.minutes(store.data.settings.dayEnd) ?? 21 * 60)
        let slots = Array(stride(from: start, to: end, by: 30))
        HSplitView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Unscheduled").font(.headline).padding(12)
                Divider()
                let unscheduled = tasks.filter { $0.timeBlock == nil }
                if unscheduled.isEmpty {
                    ContentUnavailableView("All planned", systemImage: "calendar.badge.checkmark",
                                           description: Text("Every task of this day has a time block."))
                } else {
                    List(unscheduled) { t in
                        HStack {
                            Image(systemName: "line.3.horizontal").foregroundStyle(.tertiary)
                            TaskRow(task: t, day: day, compact: true)
                        }
                        .draggable(t.id) { Text(t.title).padding(6).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6)) }
                    }
                    .listStyle(.inset)
                }
                Text("Drag a task onto the timeline. Default length 30 min.").font(.caption).foregroundStyle(.secondary).padding(12)
            }
            .frame(minWidth: 240, idealWidth: 300, maxWidth: 420)

            ScrollViewReader { proxy in
                ScrollView {
                    ZStack(alignment: .topLeading) {
                        VStack(spacing: 0) {
                            ForEach(Array(slots.enumerated()), id: \.offset) { i, m in
                                HStack(spacing: 0) {
                                    Text(m % 60 == 0 ? HM.string(m) : "")
                                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                        .frame(width: labelW, alignment: .trailing).padding(.trailing, 6)
                                        .offset(y: -rowH / 2 + 6)
                                    Rectangle()
                                        .fill(dropTarget == m ? Color.accentColor.opacity(0.15) : Color.clear)
                                        .overlay(alignment: .top) {
                                            Rectangle().fill(Color.secondary.opacity(m % 60 == 0 ? 0.25 : 0.1)).frame(height: 1)
                                        }
                                        .dropDestination(for: String.self) { ids, _ in
                                            guard let id = ids.first else { return false }
                                            schedule(id, at: m, limit: end)
                                            return true
                                        } isTargeted: { on in dropTarget = on ? m : (dropTarget == m ? nil : dropTarget) }
                                }
                                .frame(height: rowH)
                                .id(i)
                            }
                        }
                        ForEach(tasks.filter { $0.timeBlock != nil }) { t in
                            block(t, dayStart: start, dayEnd: end, day: day)
                        }
                        if day == store.today {
                            let now = HM.nowMinutes()
                            if now >= start && now <= end {
                                HStack(spacing: 0) {
                                    Circle().fill(Color.red).frame(width: 8, height: 8)
                                    Rectangle().fill(Color.red).frame(height: 1.5)
                                }
                                .padding(.leading, labelW + 2)
                                .offset(y: CGFloat(now - start) / 30 * rowH - 4)
                                .allowsHitTesting(false)
                            }
                        }
                    }
                    .padding(.vertical, 14).padding(.trailing, 14)
                }
                .onAppear {
                    if day == store.today { proxy.scrollTo(max(0, (HM.nowMinutes() - start) / 30 - 2), anchor: .top) }
                }
            }
            .frame(minWidth: 380)
        }
    }

    private func schedule(_ id: String, at m: Int, limit: Int) {
        store.update(id, "Schedule Task") { t in
            let dur = t.timeBlock.map { (HM.minutes($0.end) ?? 0) - (HM.minutes($0.start) ?? 0) } ?? 30
            t.timeBlock = TimeBlock(start: HM.string(m), end: HM.string(min(24 * 60 - 1, m + max(30, dur))))
        }
    }

    @ViewBuilder
    private func block(_ t: TaskItem, dayStart: Int, dayEnd: Int, day: String) -> some View {
        if let tb = t.timeBlock, let s = HM.minutes(tb.start), let e = HM.minutes(tb.end) {
            let top = CGFloat(max(0, s - dayStart)) / 30 * rowH
            let height = max(rowH * 0.8, CGFloat(max(15, e - max(s, dayStart))) / 30 * rowH - 2)
            let done = Occurrence.isDone(t, on: day)
            let color = t.tags.first.map(Color.tag) ?? (t.priority != .none ? Color.priority(t.priority) : Color.accentColor)
            HStack(alignment: .top, spacing: 6) {
                RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 4)
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.title).font(.callout.weight(.medium)).strikethrough(done).lineLimit(height > rowH * 1.2 ? 2 : 1)
                    if height > rowH * 1.2 {
                        Text("\(tb.start)–\(tb.end) · \(e - s) min").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                HStack(spacing: 2) {
                    Button { resize(t.id, by: -30) } label: { Image(systemName: "minus") }.help("Shorten by 30 min")
                    Button { resize(t.id, by: 30) } label: { Image(systemName: "plus") }.help("Extend by 30 min")
                    Button { store.update(t.id, "Clear Time Block") { $0.timeBlock = nil } } label: { Image(systemName: "xmark") }.help("Unschedule")
                }
                .buttonStyle(.borderless).font(.caption2)
            }
            .padding(.vertical, 4).padding(.trailing, 6)
            .frame(height: height, alignment: .top)
            .background(RoundedRectangle(cornerRadius: 6).fill(color.opacity(done ? 0.08 : 0.18)))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(color.opacity(0.4)))
            .padding(.leading, labelW + 10)
            .offset(y: top + 1)
            .draggable(t.id) { Text(t.title).padding(6).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6)) }
            .contextMenu { TaskContextMenu(task: t, day: day) }
        }
    }

    private func resize(_ id: String, by delta: Int) {
        store.update(id, "Resize Time Block") { t in
            guard let tb = t.timeBlock, let s = HM.minutes(tb.start), let e = HM.minutes(tb.end) else { return }
            t.timeBlock?.end = HM.string(min(24 * 60 - 1, max(s + 15, e + delta)))
        }
    }
}
