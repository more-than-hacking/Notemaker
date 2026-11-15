import SwiftUI
import AppKit

/// Gives the formatting toolbar access to the NSTextView's selection.
final class EditorController: ObservableObject {
    weak var textView: NSTextView?

    private func replace(_ range: NSRange, with s: String, select: NSRange? = nil) {
        guard let tv = textView, tv.shouldChangeText(in: range, replacementString: s) else { return }
        tv.textStorage?.replaceCharacters(in: range, with: s)
        tv.didChangeText()
        tv.setSelectedRange(select ?? NSRange(location: range.location + (s as NSString).length, length: 0))
        tv.window?.makeFirstResponder(tv)
    }

    /// Wrap the selection (or a placeholder) in `before`…`after`.
    func wrap(_ before: String, _ after: String, placeholder: String = "text") {
        guard let tv = textView else { return }
        let r = tv.selectedRange()
        let sel = (tv.string as NSString).substring(with: r)
        let inner = sel.isEmpty ? placeholder : sel
        let s = before + inner + after
        replace(r, with: s, select: NSRange(location: r.location + (before as NSString).length, length: (inner as NSString).length))
    }

    /// Toggle a line prefix on every selected line ("# ", "- ", "> ", "- [ ] ", "1. ").
    func prefixLines(_ prefix: String) {
        guard let tv = textView else { return }
        let ns = tv.string as NSString
        let lr = ns.lineRange(for: tv.selectedRange())
        let text = ns.substring(with: lr)
        var lines = text.components(separatedBy: "\n")
        let trailingNewline = text.hasSuffix("\n")
        if trailingNewline { lines.removeLast() }
        let allHave = lines.allSatisfy { $0.hasPrefix(prefix) }
        var n = 1
        lines = lines.map { l in
            if allHave { return String(l.dropFirst(prefix.count)) }
            var stripped = l
            for p in ["# ", "## ", "### ", "- [ ] ", "- [x] ", "- ", "> "] where stripped.hasPrefix(p) && prefix != p { stripped = String(stripped.dropFirst(p.count)); break }
            if let m = stripped.range(of: #"^\d+\. "#, options: .regularExpression) { stripped.removeSubrange(m) }
            defer { n += 1 }
            return (prefix == "1. " ? "\(n). " : prefix) + stripped
        }
        let out = lines.joined(separator: "\n") + (trailingNewline ? "\n" : "")
        replace(lr, with: out, select: NSRange(location: lr.location, length: (out as NSString).length - (trailingNewline ? 1 : 0)))
    }

    func insert(_ s: String) {
        guard let tv = textView else { return }
        replace(tv.selectedRange(), with: s)
    }

    func insertBlock(_ s: String) {
        guard let tv = textView else { return }
        let r = tv.selectedRange()
        let ns = tv.string as NSString
        let needsNL = r.location > 0 && ns.substring(with: NSRange(location: r.location - 1, length: 1)) != "\n"
        replace(r, with: (needsNL ? "\n" : "") + s)
    }

    func indent(_ outdent: Bool) {
        guard let tv = textView else { return }
        let ns = tv.string as NSString
        let lr = ns.lineRange(for: tv.selectedRange())
        let text = ns.substring(with: lr)
        var lines = text.components(separatedBy: "\n")
        let trailing = text.hasSuffix("\n")
        if trailing { lines.removeLast() }
        lines = lines.map { l in
            if outdent { return l.hasPrefix("  ") ? String(l.dropFirst(2)) : (l.hasPrefix("\t") ? String(l.dropFirst()) : l) }
            return "  " + l
        }
        let out = lines.joined(separator: "\n") + (trailing ? "\n" : "")
        replace(lr, with: out, select: NSRange(location: lr.location, length: (out as NSString).length - (trailing ? 1 : 0)))
    }
}

struct MarkdownTextView: NSViewRepresentable {
    @Binding var text: String
    let documentID: String          // resets the editor's undo stack when it changes (another day)
    let controller: EditorController

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        let tv = scroll.documentView as! NSTextView
        tv.delegate = context.coordinator
        tv.isRichText = false
        tv.allowsUndo = true
        tv.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        tv.textColor = .labelColor
        tv.backgroundColor = .textBackgroundColor
        tv.textContainerInset = NSSize(width: 10, height: 10)
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isAutomaticSpellingCorrectionEnabled = false
        tv.isContinuousSpellCheckingEnabled = true
        tv.string = text
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = true
        controller.textView = tv
        context.coordinator.docID = documentID
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? NSTextView else { return }
        context.coordinator.parent = self
        controller.textView = tv
        if context.coordinator.docID != documentID {
            context.coordinator.docID = documentID
            context.coordinator.undo.removeAllActions()
            tv.string = text
            tv.setSelectedRange(NSRange(location: 0, length: 0))
        } else if tv.string != text {
            let sel = tv.selectedRange()
            tv.string = text
            tv.setSelectedRange(NSRange(location: min(sel.location, (text as NSString).length), length: 0))
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MarkdownTextView
        var docID = ""
        let undo = UndoManager()
        init(_ p: MarkdownTextView) { parent = p }

        func undoManager(for view: NSTextView) -> UndoManager? { undo }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            if parent.text != tv.string { parent.text = tv.string }
        }

        /// Smart Return (continue lists/quotes/checkboxes) and Tab indentation in lists.
        func textView(_ tv: NSTextView, doCommandBy sel: Selector) -> Bool {
            let ns = tv.string as NSString
            let r = tv.selectedRange()
            let lineRange = ns.lineRange(for: NSRange(location: r.location, length: 0))
            let line = ns.substring(with: lineRange).trimmingCharacters(in: .newlines)
            if sel == #selector(NSResponder.insertNewline(_:)) {
                guard let m = line.range(of: #"^(\s*)(- \[[ xX]\] |[-*+] |\d+\. |> )"#, options: .regularExpression) else { return false }
                let marker = String(line[m])
                if line.trimmingCharacters(in: .whitespaces) == marker.trimmingCharacters(in: .whitespaces) {
                    // Empty item: end the list
                    let lr = NSRange(location: lineRange.location, length: (line as NSString).length)
                    if tv.shouldChangeText(in: lr, replacementString: "") {
                        tv.textStorage?.replaceCharacters(in: lr, with: ""); tv.didChangeText()
                    }
                    return true
                }
                var next = marker.replacingOccurrences(of: "[x]", with: "[ ]").replacingOccurrences(of: "[X]", with: "[ ]")
                if let nm = next.range(of: #"\d+"#, options: .regularExpression), let n = Int(next[nm]) {
                    next.replaceSubrange(nm, with: String(n + 1))
                }
                tv.insertText("\n" + next, replacementRange: r)
                return true
            }
            if sel == #selector(NSResponder.insertTab(_:)) || sel == #selector(NSResponder.insertBacktab(_:)) {
                guard line.range(of: #"^\s*([-*+] |\d+\. )"#, options: .regularExpression) != nil else { return false }
                let c = EditorController(); c.textView = tv
                c.indent(sel == #selector(NSResponder.insertBacktab(_:)))
                return true
            }
            return false
        }
    }
}

// MARK: - Preview

struct MarkdownPreview: View {
    let markdown: String
    var onToggleCheckbox: ((Int) -> Void)? = nil
    @EnvironmentObject var store: AppStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                let blocks = MarkdownParser.parse(markdown)
                if blocks.isEmpty {
                    Text("Nothing to preview yet.").foregroundStyle(.tertiary)
                }
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in block(b) }
            }
            .textSelection(.enabled)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .environment(\.openURL, OpenURLAction { url in
            if url.scheme == "notemaker", url.host == "day" {
                store.go(url.lastPathComponent)
                return .handled
            }
            return .systemAction
        })
    }

    @ViewBuilder private func block(_ b: MDBlock) -> some View {
        switch b {
        case .heading(let level, let text):
            inline(text)
                .font(level == 1 ? .title.bold() : level == 2 ? .title2.bold() : level == 3 ? .title3.bold() : .headline)
                .padding(.top, level <= 2 ? 6 : 2)
            if level <= 2 { Divider() }
        case .paragraph(let text):
            inline(text).fixedSize(horizontal: false, vertical: true)
        case .listItem(let indent, let marker, let checked, let text, let line):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let checked {
                    Button { onToggleCheckbox?(line) } label: {
                        Image(systemName: checked ? "checkmark.square.fill" : "square").foregroundStyle(checked ? .green : .secondary)
                    }.buttonStyle(.plain)
                } else {
                    Text(marker == "-" ? "•" : marker).foregroundStyle(.secondary).monospacedDigit()
                }
                inline(text).strikethrough(checked == true).foregroundStyle(checked == true ? .secondary : .primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, CGFloat(indent) * 18 + 4)
        case .quote(let text):
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5).fill(Color.accentColor.opacity(0.6)).frame(width: 3)
                inline(text).italic().foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text).font(.system(.callout, design: .monospaced)).padding(10)
            }
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.1)))
        case .table(let header, let rows):
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow { ForEach(Array(header.enumerated()), id: \.offset) { _, h in inline(h).bold() } }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, c in inline(c) } }
                }
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.secondary.opacity(0.25)))
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }

    private func inline(_ s: String) -> Text {
        let linked = WikiLinks.linkify(s)
        if var a = try? AttributedString(markdown: linked, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            for run in a.runs where run.link != nil { a[run.range].underlineStyle = .single }
            return Text(a)
        }
        return Text(s)
    }
}
