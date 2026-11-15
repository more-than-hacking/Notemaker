import Foundation

/// A small block-level Markdown parser; inline formatting is rendered by the UI layer.
enum MDBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case listItem(indent: Int, marker: String, checked: Bool?, text: String, line: Int)
    case quote(String)
    case code(lang: String, text: String)
    case table(header: [String], rows: [[String]])
    case rule
}

enum MarkdownParser {
    static func parse(_ md: String) -> [MDBlock] {
        let lines = md.components(separatedBy: "\n")
        var out: [MDBlock] = []
        var para: [String] = []
        var i = 0
        func flush() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))); para = [] }
        }
        func cells(_ l: String) -> [String] {
            var t = l.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("|") { t.removeFirst() }
            if t.hasSuffix("|") { t.removeLast() }
            return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
        }
        func isSeparator(_ l: String) -> Bool {
            let t = l.trimmingCharacters(in: .whitespaces)
            return t.contains("-") && t.contains("|") && t.allSatisfy { "|-: ".contains($0) }
        }
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flush()
                let lang = String(trimmed.dropFirst(3))
                var body: [String] = []
                i += 1
                while i < lines.count && !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { body.append(lines[i]); i += 1 }
                out.append(.code(lang: lang, text: body.joined(separator: "\n")))
                i += 1; continue
            }
            if trimmed.isEmpty { flush(); i += 1; continue }
            if let m = trimmed.range(of: #"^#{1,6}\s+"#, options: .regularExpression) {
                flush()
                let level = trimmed[m].filter { $0 == "#" }.count
                out.append(.heading(level: level, text: String(trimmed[m.upperBound...])))
                i += 1; continue
            }
            if trimmed.range(of: #"^(-{3,}|\*{3,}|_{3,})$"#, options: .regularExpression) != nil {
                flush(); out.append(.rule); i += 1; continue
            }
            if trimmed.hasPrefix(">") {
                flush()
                var q: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    var t = lines[i].trimmingCharacters(in: .whitespaces); t.removeFirst()
                    q.append(t.trimmingCharacters(in: .whitespaces)); i += 1
                }
                out.append(.quote(q.joined(separator: "\n"))); continue
            }
            if trimmed.hasPrefix("|"), i + 1 < lines.count, isSeparator(lines[i + 1]) {
                flush()
                let header = cells(line)
                var rows: [[String]] = []
                i += 2
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") { rows.append(cells(lines[i])); i += 1 }
                out.append(.table(header: header, rows: rows)); continue
            }
            let lead = line.prefix(while: { $0 == " " || $0 == "\t" }).reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
            if let m = trimmed.range(of: #"^([-*+]|\d+[.)])\s+"#, options: .regularExpression) {
                flush()
                var marker = trimmed[m].trimmingCharacters(in: .whitespaces)
                var rest = String(trimmed[m.upperBound...])
                var checked: Bool? = nil
                if let cm = rest.range(of: #"^\[( |x|X)\]\s?"#, options: .regularExpression) {
                    checked = rest[cm].lowercased().contains("x")
                    rest = String(rest[cm.upperBound...])
                }
                if marker == "*" || marker == "+" { marker = "-" }
                out.append(.listItem(indent: lead / 2, marker: marker, checked: checked, text: rest, line: i))
                i += 1; continue
            }
            para.append(trimmed)
            i += 1
        }
        flush()
        return out
    }

    /// Toggle the checkbox on a given line of markdown.
    static func toggleCheckbox(_ md: String, line: Int) -> String {
        var lines = md.components(separatedBy: "\n")
        guard line < lines.count else { return md }
        let l = lines[line]
        if let r = l.range(of: "[ ]") { lines[line] = l.replacingCharacters(in: r, with: "[x]") }
        else if let r = l.range(of: "[x]") ?? l.range(of: "[X]") { lines[line] = l.replacingCharacters(in: r, with: "[ ]") }
        return lines.joined(separator: "\n")
    }
}
