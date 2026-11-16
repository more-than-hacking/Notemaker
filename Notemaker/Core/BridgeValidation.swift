import Foundation

/// Bridge error and parameter validation (docs/DESKTOP_BRIDGE.md). Foundation only, so Tests-mac covers it.
struct BridgeError: Error { let message: String; init(_ m: String) { message = m } }

/// Parameter validation helpers.
enum Validate {
    private static let uuidRE = try! NSRegularExpression(pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    static func uuid(_ v: Any?, _ name: String) throws -> String {
        guard let s = v as? String, uuidRE.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
        else { throw BridgeError("\(name) must be a UUID") }
        return s
    }
    static func string(_ v: Any?, _ name: String, max: Int = 10_000) throws -> String {
        guard let s = v as? String else { throw BridgeError("\(name) must be a string") }
        guard s.utf8.count <= max else { throw BridgeError("\(name) is too long") }
        return s
    }
    static func optString(_ v: Any?, _ name: String, max: Int = 10_000) throws -> String? {
        if v == nil || v is NSNull { return nil }
        return try string(v, name, max: max)
    }
    static func base64(_ v: Any?, _ name: String, maxBytes: Int) throws -> Data {
        guard let s = v as? String else { throw BridgeError("\(name) must be a base64 string") }
        guard s.utf8.count <= (maxBytes / 3 + 2) * 4 else { throw BridgeError("\(name) is too large") }
        guard let d = Data(base64Encoded: s) else { throw BridgeError("\(name) is not valid base64") }
        guard d.count <= maxBytes else { throw BridgeError("\(name) is too large") }
        return d
    }
    static func int(_ v: Any?, _ name: String, range: ClosedRange<Int>) throws -> Int {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { throw BridgeError("\(name) must be a number") }
        let i = n.intValue
        guard Double(i) == n.doubleValue, range.contains(i) else { throw BridgeError("\(name) is out of range") }
        return i
    }
    static func bool(_ v: Any?, _ name: String) throws -> Bool {
        guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw BridgeError("\(name) must be true or false") }
        return n.boolValue
    }
    /// Absent / null → `default`.
    static func optBool(_ v: Any?, _ name: String, default d: Bool = false) throws -> Bool {
        if v == nil || v is NSNull { return d }
        return try bool(v, name)
    }
    static func dict(_ v: Any?, _ name: String) throws -> [String: Any] {
        guard let d = v as? [String: Any] else { throw BridgeError("\(name) must be an object") }
        return d
    }
}
