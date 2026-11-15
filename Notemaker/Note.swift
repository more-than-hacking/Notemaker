import Foundation

struct Note: Identifiable, Codable, Equatable {
    var id: UUID
    var content: String
    var date: Date
    var createdAt: Date
    
    init(id: UUID = UUID(), content: String, date: Date, createdAt: Date = Date()) {
        self.id = id
        self.content = content
        self.date = date
        self.createdAt = createdAt
    }
    
    static func == (lhs: Note, rhs: Note) -> Bool {
        lhs.id == rhs.id
    }
}

