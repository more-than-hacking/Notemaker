import Foundation
import SwiftUI

class TaskManager: ObservableObject {
    @Published var tasks: [Task] = []
    
    private let tasksKey = "saved_tasks"
    
    init() {
        loadTasks()
    }
    
    // MARK: - Task Management
    
    func addTask(_ task: Task) {
        tasks.append(task)
        saveTasks()
    }
    
    func deleteTask(_ task: Task) {
        tasks.removeAll { $0.id == task.id }
        saveTasks()
    }
    
    func toggleTask(_ task: Task) {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index].isCompleted.toggle()
            saveTasks()
        }
    }
    
    func updateTask(_ task: Task) {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task
            saveTasks()
        }
    }
    
    // MARK: - Date-based Operations
    
    func tasksForDate(_ date: Date) -> [Task] {
        let calendar = Calendar.current
        return tasks.filter { task in
            calendar.isDate(task.date, inSameDayAs: date)
        }
    }
    
    func incompleteTasksForDate(_ date: Date) -> [Task] {
        return tasksForDate(date).filter { !$0.isCompleted }
    }
    
    func forwardIncompleteTasks(from fromDate: Date, to toDate: Date) {
        let incompleteTasks = incompleteTasksForDate(fromDate)
        
        for task in incompleteTasks {
            var updatedTask = task
            updatedTask.date = toDate
            updatedTask.isCompleted = false
            updateTask(updatedTask)
        }
    }
    
    // MARK: - Filtering
    
    func filteredTasks(for date: Date, filter: TaskFilter) -> [Task] {
        let dateTasks = tasksForDate(date)
        
        switch filter {
        case .all:
            return dateTasks
        case .completed:
            return dateTasks.filter { $0.isCompleted }
        case .incomplete:
            return dateTasks.filter { !$0.isCompleted }
        }
    }
    
    // MARK: - Persistence
    
    private func saveTasks() {
        if let encoded = try? JSONEncoder().encode(tasks) {
            UserDefaults.standard.set(encoded, forKey: tasksKey)
        }
    }
    
    private func loadTasks() {
        if let data = UserDefaults.standard.data(forKey: tasksKey),
           let decoded = try? JSONDecoder().decode([Task].self, from: data) {
            tasks = decoded
        }
    }
}

enum TaskFilter: String, CaseIterable {
    case all = "All"
    case completed = "Completed"
    case incomplete = "Incomplete"
}

