import SwiftUI

@main
struct NotemakerApp: App {
    @StateObject private var taskManager = TaskManager()
    @StateObject private var noteManager = NoteManager()
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(taskManager)
                .environmentObject(noteManager)
        }
        .windowStyle(.automatic)
        .defaultSize(width: 1000, height: 700)
    }
}

