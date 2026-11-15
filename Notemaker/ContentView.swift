import SwiftUI

struct ContentView: View {
    @EnvironmentObject var taskManager: TaskManager
    @EnvironmentObject var noteManager: NoteManager
    
    @State private var selectedDate = Date()
    @State private var taskFilter: TaskFilter = .all
    @State private var newTaskTitle = ""
    @State private var showingForwardConfirmation = false
    
    var body: some View {
        HSplitView {
            // Left Sidebar - Date Selection & Filters
            VStack(alignment: .leading, spacing: 20) {
                Text("Notemaker")
                    .font(.largeTitle)
                    .fontWeight(.bold)
                    .padding(.top)
                
                Divider()
                
                // Date Picker
                VStack(alignment: .leading, spacing: 8) {
                    Text("Select Date")
                        .font(.headline)
                    
                    DatePicker("", selection: $selectedDate, displayedComponents: .date)
                        .datePickerStyle(.compact)
                        .labelsHidden()
                }
                
                Divider()
                
                // Quick Date Navigation
                VStack(alignment: .leading, spacing: 8) {
                    Text("Quick Navigation")
                        .font(.headline)
                    
                    HStack {
                        Button(action: { moveDate(by: -1) }) {
                            Label("Previous", systemImage: "chevron.left")
                        }
                        .buttonStyle(.bordered)
                        
                        Button(action: { selectedDate = Date() }) {
                            Label("Today", systemImage: "calendar")
                        }
                        .buttonStyle(.bordered)
                        
                        Button(action: { moveDate(by: 1) }) {
                            Label("Next", systemImage: "chevron.right")
                        }
                        .buttonStyle(.bordered)
                    }
                }
                
                Divider()
                
                // Task Filter
                VStack(alignment: .leading, spacing: 8) {
                    Text("Filter Tasks")
                        .font(.headline)
                    
                    Picker("Filter", selection: $taskFilter) {
                        ForEach(TaskFilter.allCases, id: \.self) { filter in
                            Text(filter.rawValue).tag(filter)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                
                Divider()
                
                // Forward Tasks Button
                if hasIncompleteTasks {
                    Button(action: { showingForwardConfirmation = true }) {
                        Label("Forward Incomplete Tasks to Tomorrow", systemImage: "arrow.right.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
                
                Spacer()
                
                // Stats
                VStack(alignment: .leading, spacing: 4) {
                    Text("Today's Stats")
                        .font(.headline)
                    Text("Total: \(filteredTasks.count)")
                    Text("Completed: \(completedCount)")
                    Text("Remaining: \(incompleteCount)")
                }
                .font(.caption)
                .foregroundColor(.secondary)
                
                Spacer()
            }
            .padding()
            .frame(minWidth: 250, maxWidth: 300)
            .background(Color(NSColor.controlBackgroundColor))
            
            // Main Content Area
            VStack(spacing: 0) {
                // Header with Date
                HStack {
                    Text(selectedDate.formatted(date: .long, time: .omitted))
                        .font(.title2)
                        .fontWeight(.semibold)
                    
                    Spacer()
                }
                .padding()
                .background(Color(NSColor.windowBackgroundColor))
                
                Divider()
                
                // Content Tabs
                TabView {
                    // Tasks Tab
                    TasksView(
                        selectedDate: selectedDate,
                        taskFilter: taskFilter,
                        newTaskTitle: $newTaskTitle
                    )
                    .tabItem {
                        Label("Tasks", systemImage: "checklist")
                    }
                    
                    // Notes Tab
                    NotesView(selectedDate: selectedDate)
                        .tabItem {
                            Label("Notes", systemImage: "note.text")
                        }
                }
            }
        }
        .alert("Forward Incomplete Tasks?", isPresented: $showingForwardConfirmation) {
            Button("Cancel", role: .cancel) { }
            Button("Forward") {
                forwardIncompleteTasks()
            }
        } message: {
            Text("This will move all incomplete tasks from \(selectedDate.formatted(date: .abbreviated, time: .omitted)) to tomorrow.")
        }
    }
    
    // MARK: - Computed Properties
    
    private var filteredTasks: [Task] {
        taskManager.filteredTasks(for: selectedDate, filter: taskFilter)
    }
    
    private var completedCount: Int {
        taskManager.tasksForDate(selectedDate).filter { $0.isCompleted }.count
    }
    
    private var incompleteCount: Int {
        taskManager.tasksForDate(selectedDate).filter { !$0.isCompleted }.count
    }
    
    private var hasIncompleteTasks: Bool {
        incompleteCount > 0
    }
    
    // MARK: - Helper Methods
    
    private func moveDate(by days: Int) {
        if let newDate = Calendar.current.date(byAdding: .day, value: days, to: selectedDate) {
            selectedDate = newDate
        }
    }
    
    private func forwardIncompleteTasks() {
        guard let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: selectedDate) else { return }
        taskManager.forwardIncompleteTasks(from: selectedDate, to: tomorrow)
    }
}

// MARK: - Tasks View

struct TasksView: View {
    @EnvironmentObject var taskManager: TaskManager
    let selectedDate: Date
    let taskFilter: TaskFilter
    @Binding var newTaskTitle: String
    
    var body: some View {
        VStack(spacing: 0) {
            // Add Task Section
            HStack {
                TextField("Add new task...", text: $newTaskTitle)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        addTask()
                    }
                
                Button(action: addTask) {
                    Label("Add", systemImage: "plus.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(newTaskTitle.isEmpty)
            }
            .padding()
            
            Divider()
            
            // Tasks List
            if filteredTasks.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: taskFilter == .all ? "checklist" : "checkmark.circle")
                        .font(.system(size: 48))
                        .foregroundColor(.secondary)
                    Text(taskFilter == .all ? "No tasks for this date" : "No \(taskFilter.rawValue.lowercased()) tasks")
                        .font(.headline)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(filteredTasks) { task in
                        TaskRowView(task: task)
                    }
                    .onDelete { indexSet in
                        deleteTasks(at: indexSet)
                    }
                }
                .listStyle(.inset)
            }
        }
    }
    
    private var filteredTasks: [Task] {
        taskManager.filteredTasks(for: selectedDate, filter: taskFilter)
    }
    
    private func addTask() {
        guard !newTaskTitle.isEmpty else { return }
        let task = Task(title: newTaskTitle, date: selectedDate)
        taskManager.addTask(task)
        newTaskTitle = ""
    }
    
    private func deleteTasks(at indexSet: IndexSet) {
        for index in indexSet {
            taskManager.deleteTask(filteredTasks[index])
        }
    }
}

// MARK: - Task Row View

struct TaskRowView: View {
    @EnvironmentObject var taskManager: TaskManager
    let task: Task
    
    var body: some View {
        HStack {
            Button(action: {
                taskManager.toggleTask(task)
            }) {
                Image(systemName: task.isCompleted ? "checkmark.circle.fill" : "circle")
                    .foregroundColor(task.isCompleted ? .green : .secondary)
                    .font(.title3)
            }
            .buttonStyle(.plain)
            
            if task.isCompleted {
                Text(task.title)
                    .strikethrough()
                    .foregroundColor(.secondary)
            } else {
                Text(task.title)
            }
            
            Spacer()
        }
        .contentShape(Rectangle())
        .padding(.vertical, 4)
    }
}

// MARK: - Notes View

struct NotesView: View {
    @EnvironmentObject var noteManager: NoteManager
    let selectedDate: Date
    
    @State private var noteContent: String = ""
    @State private var currentNote: Note?
    
    var body: some View {
        VStack(spacing: 0) {
            // Notes Editor
            TextEditor(text: $noteContent)
                .font(.body)
                .padding()
                .onChange(of: selectedDate) { _ in
                    loadNoteForDate()
                }
                .onChange(of: noteContent) { _ in
                    saveNote()
                }
        }
        .onAppear {
            loadNoteForDate()
        }
    }
    
    private func loadNoteForDate() {
        let note = noteManager.getOrCreateNoteForDate(selectedDate)
        currentNote = note
        noteContent = note.content
    }
    
    private func saveNote() {
        guard var note = currentNote else { return }
        note.content = noteContent
        noteManager.updateNote(note)
    }
}

// MARK: - Preview

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
            .environmentObject(TaskManager())
            .environmentObject(NoteManager())
    }
}

