import SwiftUI

struct CalendarView: View {
    @EnvironmentObject var store: AppStore
    @State private var monthAnchor: String = Day.today()

    var body: some View {
        let p = Day.parts(monthAnchor) ?? (2026, 1, 1)
        let first = String(format: "%04d-%02d-01", p.y, p.m)
        let gridStart = Day.weekStart(of: first, weekStartsOn: store.data.settings.weekStartsOn)
        let count = Day.daysInMonth(year: p.y, month: p.m)
        let weeks = Int(ceil(Double(Day.between(gridStart, first) + count) / 7.0))
        VStack(spacing: 12) {
            HStack {
                Text(Day.monthTitle(year: p.y, month: p.m)).font(.title2.weight(.semibold))
                Spacer()
                Button { monthAnchor = Day.add(first, months: -1) } label: { Image(systemName: "chevron.left") }
                Button("This Month") { monthAnchor = store.today }
                Button { monthAnchor = Day.add(first, months: 1) } label: { Image(systemName: "chevron.right") }
            }
            HStack(spacing: 6) {
                ForEach(0..<7, id: \.self) { i in
                    let d = Day.add(gridStart, days: i)
                    Text(Day.weekdayShort[Day.weekday(d) - 1]).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            VStack(spacing: 6) {
                ForEach(0..<weeks, id: \.self) { w in
                    HStack(spacing: 6) {
                        ForEach(0..<7, id: \.self) { i in
                            let d = Day.add(gridStart, days: w * 7 + i)
                            DayCell(day: d, inMonth: d.hasPrefix(String(first.prefix(7))))
                        }
                    }
                }
            }
            HStack(spacing: 14) {
                legend(Color.gray.opacity(0.15), "Nothing done")
                legend(Color.heat.opacity(0.4), "Some done")
                legend(Color.heat.opacity(0.9), "All done")
                HStack(spacing: 4) { Circle().fill(Color.accentColor).frame(width: 6, height: 6); Text("Note").font(.caption) }
                Spacer()
            }.foregroundStyle(.secondary)
        }
        .padding(20)
        .onAppear { monthAnchor = store.selectedDay }
    }

    private func legend(_ c: Color, _ s: String) -> some View {
        HStack(spacing: 4) { RoundedRectangle(cornerRadius: 3).fill(c).frame(width: 12, height: 12); Text(s).font(.caption) }
    }
}

struct DayCell: View {
    @EnvironmentObject var store: AppStore
    let day: String
    let inMonth: Bool
    @State private var hover = false

    var body: some View {
        let s = Stats.day(store.data.tasks, day)
        let isToday = day == store.today
        let hasNote = (store.data.notes[day].map { $0.locked || !$0.markdown.isEmpty }) ?? false
        Button {
            store.go(day)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("\(Day.parts(day)?.d ?? 0)")
                        .font(.callout.weight(isToday ? .bold : .regular))
                        .foregroundStyle(isToday ? Color.white : (inMonth ? Color.primary : Color.secondary))
                        .frame(width: 24, height: 24)
                        .background(Circle().fill(isToday ? Color.accentColor : .clear))
                    Spacer()
                    if hasNote { Image(systemName: store.data.notes[day]?.locked == true ? "lock.fill" : "circle.fill").font(.system(size: 6)).foregroundStyle(Color.accentColor) }
                }
                Spacer(minLength: 0)
                if s.total > 0 {
                    Text("\(s.done)/\(s.total)").font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                }
            }
            .padding(6)
            .frame(maxWidth: .infinity, minHeight: 64, maxHeight: .infinity, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 8).fill(heatColor(s)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(day == store.selectedDay ? Color.accentColor : Color.secondary.opacity(hover ? 0.4 : 0.15),
                                                                   lineWidth: day == store.selectedDay ? 2 : 1))
            .opacity(inMonth ? 1 : 0.45)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help(s.total > 0 ? "\(s.done) of \(s.total) tasks done" : Day.longDate(day))
    }
}
