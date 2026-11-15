import SwiftUI
import Charts

struct InsightsView: View {
    @EnvironmentObject var store: AppStore

    private struct Bar: Identifiable { let id: String; let label: String; let done: Int; let total: Int }

    var body: some View {
        let today = store.today
        let tasks = store.data.tasks
        let days = Streaks.completionDays(tasks)
        let last30 = (0..<30).map { Stats.day(tasks, Day.add(today, days: -$0)) }
        let total30 = last30.reduce(0) { $0 + $1.total }, done30 = last30.reduce(0) { $0 + $1.done }
        let bars = (0..<7).reversed().map { i -> Bar in
            let d = Day.add(today, days: -i); let s = Stats.day(tasks, d)
            return Bar(id: d, label: Day.weekdayShort[Day.weekday(d) - 1], done: s.done, total: s.total)
        }
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 12) {
                    tile("Current streak", "\(Streaks.current(days, today: today))", "days", "flame.fill", .orange)
                    tile("Best streak", "\(Streaks.best(days))", "days", "trophy.fill", .yellow)
                    tile("Focus this week", "\(Stats.focusMinutes(store.data.focusSessions, weekOf: today, weekStartsOn: store.data.settings.weekStartsOn))", "minutes", "timer", .red)
                    tile("Completion rate", total30 == 0 ? "–" : "\(Int((Double(done30) / Double(total30) * 100).rounded()))%", "last 30 days", "chart.pie.fill", .green)
                }
                card("Last 365 days") { Heatmap(today: today) }
                HStack(alignment: .top, spacing: 12) {
                    card("Last 7 days") {
                        Chart(bars) { b in
                            BarMark(x: .value("Day", b.label), y: .value("Tasks", b.total))
                                .foregroundStyle(Color.secondary.opacity(0.25))
                            BarMark(x: .value("Day", b.label), y: .value("Done", b.done))
                                .foregroundStyle(Color.green.gradient)
                                .annotation(position: .top) { if b.total > 0 { Text("\(b.done)/\(b.total)").font(.caption2).foregroundStyle(.secondary) } }
                        }
                        .chartYAxis { AxisMarks(position: .leading) }
                        .frame(height: 180)
                    }
                    card("Top tags") {
                        let tags = Stats.topTags(tasks)
                        if tags.isEmpty {
                            Text("No tags yet — add #tags to tasks.").foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 180)
                        } else {
                            let maxC = tags.map(\.1).max() ?? 1
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(tags, id: \.0) { t, c in
                                    HStack {
                                        TagChip(tag: t).frame(width: 90, alignment: .leading)
                                        GeometryReader { g in
                                            RoundedRectangle(cornerRadius: 3).fill(Color.tag(t).opacity(0.7))
                                                .frame(width: max(4, g.size.width * CGFloat(c) / CGFloat(maxC)))
                                        }.frame(height: 10)
                                        Text("\(c)").font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 30, alignment: .trailing)
                                    }
                                }
                            }
                            .frame(minHeight: 180, alignment: .top)
                        }
                    }
                }
            }
            .padding(20)
        }
    }

    private func tile(_ title: String, _ value: String, _ unit: String, _ icon: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(title, systemImage: icon).font(.caption.weight(.medium)).foregroundStyle(color)
            Text(value).font(.system(size: 28, weight: .semibold, design: .rounded)).monospacedDigit()
            Text(unit).font(.caption).foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.secondary.opacity(0.15)))
    }

    private func card<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.secondary.opacity(0.15)))
    }
}

/// GitHub-style 365-day completion heatmap; click a day to open it.
struct Heatmap: View {
    @EnvironmentObject var store: AppStore
    let today: String

    var body: some View {
        let start = Day.weekStart(of: Day.add(today, days: -364), weekStartsOn: store.data.settings.weekStartsOn)
        let weeks = Day.between(start, today) / 7 + 1
        let stats = Stats.range(store.data.tasks, from: start, to: today)
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 3) {
                ForEach(0..<weeks, id: \.self) { w in
                    VStack(spacing: 3) {
                        ForEach(0..<7, id: \.self) { i in
                            let d = Day.add(start, days: w * 7 + i)
                            let s = stats[d] ?? DayStats()
                            RoundedRectangle(cornerRadius: 2)
                                .fill(d > today ? Color.clear : (s.total == 0 ? Color.secondary.opacity(0.1) : heatColor(s)))
                                .frame(width: 11, height: 11)
                                .help("\(d): \(s.done)/\(s.total)")
                                .onTapGesture { if d <= today { store.go(d) } }
                        }
                    }
                }
            }
        }
        .defaultScrollAnchor(.trailing)
    }
}
