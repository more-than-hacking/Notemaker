import SwiftUI
import AppKit

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        let v = UInt64(s, radix: 16) ?? 0x4F8EF7
        self.init(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    var hexString: String {
        let ns = NSColor(self).usingColorSpace(.sRGB) ?? .systemBlue
        return String(format: "#%02X%02X%02X", Int(round(ns.redComponent * 255)), Int(round(ns.greenComponent * 255)), Int(round(ns.blueComponent * 255)))
    }

    static func tag(_ name: String) -> Color { Color(hue: Tags.hue(name), saturation: 0.55, brightness: 0.78) }

    static func priority(_ p: Priority) -> Color {
        switch p {
        case .high: return .red
        case .medium: return .orange
        case .low: return .blue
        case .none: return .secondary
        }
    }

    static let heat = Color.green
}

struct TagChip: View {
    let tag: String
    var body: some View {
        Text("#\(tag)")
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Capsule().fill(Color.tag(tag).opacity(0.18)))
            .foregroundStyle(Color.tag(tag))
    }
}

struct PriorityBadge: View {
    let priority: Priority
    var body: some View {
        if priority != .none {
            Text(priority.label.uppercased())
                .font(.system(size: 9, weight: .bold))
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color.priority(priority).opacity(0.18)))
                .foregroundStyle(Color.priority(priority))
        }
    }
}

struct Badge: View {
    let text: String
    var color: Color = .secondary
    var systemImage: String? = nil
    var body: some View {
        HStack(spacing: 2) {
            if let i = systemImage { Image(systemName: i) }
            Text(text)
        }
        .font(.caption2)
        .padding(.horizontal, 5).padding(.vertical, 2)
        .background(Capsule().fill(color.opacity(0.14)))
        .foregroundStyle(color)
    }
}

func heatColor(_ s: DayStats) -> Color {
    guard s.total > 0 else { return .clear }
    if s.done == 0 { return Color.gray.opacity(0.15) }
    return Color.heat.opacity(0.25 + 0.65 * s.ratio)
}

func applyAppearance(_ t: ThemeSetting) {
    // Only touch NSApp.appearance when it really changes: every assignment makes AppKit
    // re-render all windows, which (via picker bindings) could start an update loop.
    let wanted: NSAppearance.Name? = {
        switch t {
        case .light: return .aqua
        case .dark: return .darkAqua
        case .system: return nil
        }
    }()
    guard NSApp.appearance?.name != wanted else { return }
    NSApp.appearance = wanted.flatMap { NSAppearance(named: $0) }
}
