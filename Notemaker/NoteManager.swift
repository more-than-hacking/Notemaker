import Foundation
import SwiftUI

class NoteManager: ObservableObject {
    @Published var notes: [Note] = []
    
    private let notesKey = "saved_notes"
    
    init() {
        loadNotes()
    }
    
    // MARK: - Note Management
    
    func addNote(_ note: Note) {
        notes.append(note)
        saveNotes()
    }
    
    func deleteNote(_ note: Note) {
        notes.removeAll { $0.id == note.id }
        saveNotes()
    }
    
    func updateNote(_ note: Note) {
        if let index = notes.firstIndex(where: { $0.id == note.id }) {
            notes[index] = note
            saveNotes()
        }
    }
    
    // MARK: - Date-based Operations
    
    func noteForDate(_ date: Date) -> Note? {
        let calendar = Calendar.current
        return notes.first { note in
            calendar.isDate(note.date, inSameDayAs: date)
        }
    }
    
    func getOrCreateNoteForDate(_ date: Date) -> Note {
        if let existingNote = noteForDate(date) {
            return existingNote
        }
        let newNote = Note(content: "", date: date)
        addNote(newNote)
        return newNote
    }
    
    // MARK: - Persistence
    
    private func saveNotes() {
        if let encoded = try? JSONEncoder().encode(notes) {
            UserDefaults.standard.set(encoded, forKey: notesKey)
        }
    }
    
    private func loadNotes() {
        if let data = UserDefaults.standard.data(forKey: notesKey),
           let decoded = try? JSONDecoder().decode([Note].self, from: data) {
            notes = decoded
        }
    }
}

