import SwiftUI

struct HabitsView: View {
    @EnvironmentObject var store: AppStore
    @State private var editing: Habit?
    @State private var confirmDelete: Habit?

    var body: some View {
        let today = store.today
        VStack(spacing: 0) {
            HStack {
                Text("Habits").font(.title2.weight(.semibold))
                Spacer()
                Button { editing = Habit(name: "") } label: { Label("New Habit", systemImage: "plus") }
            }
            .padding(16)
            Divider()
            if store.data.habits.isEmpty {
                ContentUnavailableView {
                    Label("No habits yet", systemImage: "repeat.circle")
                } description: { Text("Track things you want to do regularly, like reading or exercise.") } actions: {
                    Button("Create a habit") { editing = Habit(name: "") }
                }
            } else {
                ScrollView {
                    VStack(spacing: 10) {
                        HStack {
                            Spacer()
                            ForEach(0..<7, id: \.self) { i in
                                let d = Day.add(today, days: i - 6)
                                Text(Day.weekdayShort[Day.weekday(d) - 1].prefix(2)).font(.caption2).foregroundStyle(.secondary).frame(width: 26)
                            }
                            Text("Streak").font(.caption2).foregroundStyle(.secondary).frame(width: 60)
                        }
                        .padding(.horizontal, 14)
                        ForEach(store.data.habits) { h in row(h, today: today) }
                    }
                    .padding(16)
                }
            }
        }
        .sheet(item: $editing) { h in HabitEditor(habit: h).environmentObject(store) }
        .confirmationDialog("Delete habit?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
                            presenting: confirmDelete) { h in
            Button("Delete “\(h.name)”", role: .destructive) { store.mutate("Delete Habit") { $0.habits.removeAll { $0.id == h.id } } }
        }
    }

    private func row(_ h: Habit, today: String) -> some View {
        let color = Color(hex: h.color)
        let scheduledToday = Streaks.habitScheduled(h, today)
        return HStack(spacing: 10) {
            Button { store.toggleHabit(h.id, on: today) } label: {
                Image(systemName: h.log[today] == true ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22)).foregroundStyle(color)
            }.buttonStyle(.plain).help("Check off today")
            VStack(alignment: .leading, spacing: 2) {
                Text(h.name).font(.body.weight(.medium))
                Text(daysLabel(h) + (scheduledToday ? "" : " · not scheduled today")).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            ForEach(0..<7, id: \.self) { i in
                let d = Day.add(today, days: i - 6)
                let on = h.log[d] == true
                let sched = Streaks.habitScheduled(h, d)
                Button { store.toggleHabit(h.id, on: d) } label: {
                    Circle()
                        .fill(on ? color : Color.clear)
                        .overlay(Circle().strokeBorder(sched ? color.opacity(0.7) : Color.secondary.opacity(0.25), lineWidth: 1.5))
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.plain).frame(width: 26).help(Day.longDate(d))
            }
            Label("\(Streaks.habit(h, today: today))", systemImage: "flame.fill")
                .font(.callout.monospacedDigit()).foregroundStyle(.orange).frame(width: 60)
            Menu {
                Button("Edit…") { editing = h }
                Button("Delete…", role: .destructive) { confirmDelete = h }
            } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize()
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(color.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(color.opacity(0.25)))
    }

    private func daysLabel(_ h: Habit) -> String {
        if h.days.isEmpty || h.days.count == 7 { return "Every day" }
        if h.days.sorted() == [1, 2, 3, 4, 5] { return "Weekdays" }
        return h.days.sorted().map { Day.weekdayShort[$0 - 1] }.joined(separator: ", ")
    }
}

struct HabitEditor: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State var habit: Habit

    var body: some View {
        let isNew = !store.data.habits.contains { $0.id == habit.id }
        VStack(alignment: .leading, spacing: 14) {
            Text(isNew ? "New Habit" : "Edit Habit").font(.title3.weight(.semibold))
            Form {
                TextField("Name", text: $habit.name)
                ColorPicker("Color", selection: Binding(get: { Color(hex: habit.color) }, set: { c in let h = c.hexString; if habit.color != h { habit.color = h } }), supportsOpacity: false)
                LabeledContent("Days") {
                    HStack(spacing: 4) {
                        ForEach(1...7, id: \.self) { w in
                            let on = habit.days.isEmpty || habit.days.contains(w)
                            Button(String(Day.weekdayShort[w - 1].prefix(2))) {
                                var s = Set(habit.days.isEmpty ? Array(1...7) : habit.days)
                                if on { s.remove(w) } else { s.insert(w) }
                                habit.days = s.count == 7 ? [] : s.sorted()
                            }
                            .buttonStyle(.borderless).frame(width: 28, height: 22)
                            .background(RoundedRectangle(cornerRadius: 5).fill(on ? Color(hex: habit.color) : Color.secondary.opacity(0.12)))
                            .foregroundStyle(on ? .white : .primary)
                        }
                    }
                }
                Text("No days selected or all days = every day.").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(isNew ? "Create" : "Save") {
                    let h = habit
                    store.mutate(isNew ? "Add Habit" : "Edit Habit") { d in
                        if let i = d.habits.firstIndex(where: { $0.id == h.id }) { d.habits[i] = h } else { d.habits.append(h) }
                    }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(habit.name.trimmingCharacters(in: .whitespaces).isEmpty || (habit.days.isEmpty && false))
            }
        }
        .padding(20).frame(width: 400)
    }
}
