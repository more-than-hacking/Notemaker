import Foundation

/// A loss-less representation of arbitrary JSON, used to carry fields this app
/// does not know about (e.g. added by the web app) through a decode → encode cycle.
enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n):
            if n.rounded() == n && abs(n) < 1e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

/// A CodingKey that accepts any string, so containers can enumerate unknown keys.
struct AnyKey: CodingKey, Hashable {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { self.stringValue = String(intValue) }
}

extension KeyedDecodingContainer where K == AnyKey {
    func val<T: Decodable>(_ key: String, _ type: T.Type) -> T? {
        guard contains(AnyKey(key)) else { return nil }
        if (try? decodeNil(forKey: AnyKey(key))) == true { return nil }
        return try? decode(T.self, forKey: AnyKey(key))
    }
    func str(_ key: String) -> String? { val(key, String.self) }
    func bool(_ key: String) -> Bool? { val(key, Bool.self) }
    func int(_ key: String) -> Int? {
        if let i = val(key, Int.self) { return i }
        if let d = val(key, Double.self) { return Int(d) }
        if let s = val(key, String.self) { return Int(s) }
        return nil
    }
    func double(_ key: String) -> Double? {
        if let d = val(key, Double.self) { return d }
        if let s = val(key, String.self) { return Double(s) }
        return nil
    }
    /// Accepts both `{ "2026-01-01": true }` and `["2026-01-01"]`.
    func dateSet(_ key: String) -> [String: Bool] {
        if let d = val(key, [String: Bool].self) { return d.filter { $0.value } }
        if let a = val(key, [String].self) { return Dictionary(a.map { ($0, true) }, uniquingKeysWith: { a, _ in a }) }
        return [:]
    }
    func extras(known: Set<String>) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for k in allKeys where !known.contains(k.stringValue) {
            if let v = try? decode(JSONValue.self, forKey: k) { out[k.stringValue] = v }
        }
        return out
    }
}

extension KeyedEncodingContainer where K == AnyKey {
    mutating func put<T: Encodable>(_ key: String, _ value: T) throws {
        try encode(value, forKey: AnyKey(key))
    }
    mutating func putOpt<T: Encodable>(_ key: String, _ value: T?) throws {
        if let v = value { try encode(v, forKey: AnyKey(key)) } else { try encodeNil(forKey: AnyKey(key)) }
    }
    mutating func putExtras(_ extras: [String: JSONValue]) throws {
        for (k, v) in extras { try encode(v, forKey: AnyKey(k)) }
    }
}
