import Foundation
import CryptoKit
import Security

// Vault format v1 — see docs/VAULT_FORMAT.md. Pure logic, no UI imports.

// MARK: - Stored model (top-level "vault" field)

struct VaultCipherBox: Codable, Equatable {
    var iv: String
    var ct: String
}

struct Keyslot: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var type: String               // "secure-enclave" | "passkey-prf" | "recovery" | unknown (kept)
    var label: String
    var createdAt: String
    var iv: String
    var ct: String
    // type-specific
    var salt: String? = nil
    var ephemeralPublicKey: String? = nil
    var publicKey: String? = nil
    var device: String? = nil
    var credentialId: String? = nil
    var rpId: String? = nil
    var prfSalt: String? = nil
    var extra: [String: JSONValue] = [:]

    static let known: Set<String> = ["id", "type", "label", "createdAt", "iv", "ct", "salt", "ephemeralPublicKey",
                                     "publicKey", "device", "credentialId", "rpId", "prfSalt"]

    init(id: String, type: String, label: String, createdAt: String = ISO.string(), iv: String, ct: String) {
        self.id = id; self.type = type; self.label = label; self.createdAt = createdAt; self.iv = iv; self.ct = ct
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = c.str("id") ?? UUID().uuidString
        type = c.str("type") ?? ""
        label = c.str("label") ?? ""
        createdAt = c.str("createdAt") ?? ISO.string()
        iv = c.str("iv") ?? ""; ct = c.str("ct") ?? ""
        salt = c.str("salt"); ephemeralPublicKey = c.str("ephemeralPublicKey"); publicKey = c.str("publicKey")
        device = c.str("device"); credentialId = c.str("credentialId"); rpId = c.str("rpId"); prfSalt = c.str("prfSalt")
        extra = c.extras(known: Self.known)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("id", id); try c.put("type", type); try c.put("label", label); try c.put("createdAt", createdAt)
        try c.put("iv", iv); try c.put("ct", ct)
        for (k, v) in [("salt", salt), ("ephemeralPublicKey", ephemeralPublicKey), ("publicKey", publicKey), ("device", device),
                       ("credentialId", credentialId), ("rpId", rpId), ("prfSalt", prfSalt)] {
            if let v { try c.put(k, v) }
        }
    }
}

struct VaultItemRecord: Codable, Equatable, Identifiable {
    var id: String
    var iv: String
    var ct: String
    var createdAt: String
    var updatedAt: String
    var extra: [String: JSONValue] = [:]

    init(id: String, iv: String, ct: String, createdAt: String, updatedAt: String) {
        self.id = id; self.iv = iv; self.ct = ct; self.createdAt = createdAt; self.updatedAt = updatedAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = c.str("id") ?? UUID().uuidString
        iv = c.str("iv") ?? ""; ct = c.str("ct") ?? ""
        createdAt = c.str("createdAt") ?? ISO.string(); updatedAt = c.str("updatedAt") ?? createdAt
        extra = c.extras(known: ["id", "iv", "ct", "createdAt", "updatedAt"])
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("id", id); try c.put("iv", iv); try c.put("ct", ct)
        try c.put("createdAt", createdAt); try c.put("updatedAt", updatedAt)
    }
}

enum VaultMode: String, Codable, CaseIterable, Identifiable {
    case hardwareOnly = "hardware-only"
    case hardwareRecovery = "hardware+recovery"
    var id: String { rawValue }
}

struct VaultData: Codable, Equatable {
    var version: Int = 1
    var createdAt: String = ISO.string()
    var mode: String = VaultMode.hardwareRecovery.rawValue
    var verifier: VaultCipherBox
    var keyslots: [Keyslot] = []
    var items: [VaultItemRecord] = []
    /// Only present inside exported backups; locally blobs live in vault-blobs/<id>.bin.
    var blobs: [String: VaultCipherBox]? = nil
    var extra: [String: JSONValue] = [:]

    init(mode: VaultMode, verifier: VaultCipherBox) { self.mode = mode.rawValue; self.verifier = verifier }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        version = c.int("version") ?? 1
        createdAt = c.str("createdAt") ?? ISO.string()
        mode = c.str("mode") ?? VaultMode.hardwareRecovery.rawValue
        verifier = c.val("verifier", VaultCipherBox.self) ?? VaultCipherBox(iv: "", ct: "")
        keyslots = c.val("keyslots", [Keyslot].self) ?? []
        items = c.val("items", [VaultItemRecord].self) ?? []
        blobs = c.val("blobs", [String: VaultCipherBox].self)
        extra = c.extras(known: ["version", "createdAt", "mode", "verifier", "keyslots", "items", "blobs"])
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("version", version); try c.put("createdAt", createdAt); try c.put("mode", mode)
        try c.put("verifier", verifier); try c.put("keyslots", keyslots); try c.put("items", items)
        if let blobs, !blobs.isEmpty { try c.put("blobs", blobs) }
    }
}

// MARK: - Decrypted item payload

enum VaultItemType: String, CaseIterable, Identifiable {
    case note, login, card, file
    var id: String { rawValue }
    var label: String { switch self { case .note: return "Secure note"; case .login: return "Login"; case .card: return "Card / ID"; case .file: return "File" } }
    var icon: String { switch self { case .note: return "note.text"; case .login: return "key.fill"; case .card: return "creditcard.fill"; case .file: return "doc.fill" } }
}

struct VaultField: Codable, Equatable, Identifiable {
    var id = UUID()                 // local only
    var label: String
    var value: String
    var secret: Bool
    enum CodingKeys: String, CodingKey { case label, value, secret }
    init(label: String, value: String, secret: Bool) { self.label = label; self.value = value; self.secret = secret }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = (try? c.decode(String.self, forKey: .label)) ?? ""
        value = (try? c.decode(String.self, forKey: .value)) ?? ""
        secret = (try? c.decode(Bool.self, forKey: .secret)) ?? false
    }
    static func == (a: VaultField, b: VaultField) -> Bool { a.label == b.label && a.value == b.value && a.secret == b.secret }
}

struct VaultPayload: Codable, Equatable {
    var type: String = "note"
    var title: String = ""
    var favorite: Bool = false
    var notes: String = ""
    var tags: [String] = []
    // note
    var markdown: String = ""
    // login
    var username: String = ""
    var password: String = ""
    var url: String = ""
    var totpSecret: String = ""
    // card
    var kind: String = "card"
    var holder: String = ""
    var number: String = ""
    var expiry: String = ""
    var cvv: String = ""
    var issuer: String = ""
    var fields: [VaultField] = []
    // file
    var fileName: String = ""
    var mime: String = ""
    var size: Int = 0
    var blobId: String = ""
    var sha256: String = ""
    var extra: [String: JSONValue] = [:]

    var itemType: VaultItemType { VaultItemType(rawValue: type) ?? .note }

    static let common: Set<String> = ["type", "title", "favorite", "notes", "tags"]
    static let byType: [String: [String]] = [
        "note": ["markdown"],
        "login": ["username", "password", "url", "totpSecret"],
        "card": ["kind", "holder", "number", "expiry", "cvv", "issuer", "fields"],
        "file": ["fileName", "mime", "size", "blobId", "sha256"],
    ]

    init(type: VaultItemType, title: String = "") { self.type = type.rawValue; self.title = title }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        type = c.str("type") ?? "note"; title = c.str("title") ?? ""; favorite = c.bool("favorite") ?? false
        notes = c.str("notes") ?? ""; tags = c.val("tags", [String].self) ?? []
        markdown = c.str("markdown") ?? ""
        username = c.str("username") ?? ""; password = c.str("password") ?? ""; url = c.str("url") ?? ""
        totpSecret = c.str("totpSecret") ?? ""
        kind = c.str("kind") ?? "card"; holder = c.str("holder") ?? ""; number = c.str("number") ?? ""
        expiry = c.str("expiry") ?? ""; cvv = c.str("cvv") ?? ""; issuer = c.str("issuer") ?? ""
        fields = c.val("fields", [VaultField].self) ?? []
        fileName = c.str("fileName") ?? ""; mime = c.str("mime") ?? ""; size = c.int("size") ?? 0
        blobId = c.str("blobId") ?? ""; sha256 = c.str("sha256") ?? ""
        // keep fields of other types too, if present, as extras (lossless)
        let mine = Self.common.union(Self.byType[type] ?? [])
        extra = c.extras(known: mine)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.putExtras(extra)
        try c.put("type", type); try c.put("title", title); try c.put("favorite", favorite)
        try c.put("notes", notes); try c.put("tags", tags)
        switch type {
        case "note": try c.put("markdown", markdown)
        case "login":
            try c.put("username", username); try c.put("password", password); try c.put("url", url); try c.put("totpSecret", totpSecret)
        case "card":
            try c.put("kind", kind); try c.put("holder", holder); try c.put("number", number); try c.put("expiry", expiry)
            try c.put("cvv", cvv); try c.put("issuer", issuer); try c.put("fields", fields)
        case "file":
            try c.put("fileName", fileName); try c.put("mime", mime); try c.put("size", size)
            try c.put("blobId", blobId); try c.put("sha256", sha256)
        default: break
        }
    }

    /// Text matched by the vault's local search (never by global search).
    var searchText: String {
        [title, notes, tags.joined(separator: " "), username, url, issuer, holder, fileName, markdown].joined(separator: " ").lowercased()
    }
}

struct VaultItem: Identifiable, Equatable {
    var id: String
    var createdAt: String
    var updatedAt: String
    var payload: VaultPayload
}

// MARK: - Crypto

enum VaultCrypto {
    enum VaultError: Error, LocalizedError {
        case malformed, wrongKey, verifierMismatch, tooLarge, noUsableSlot
        var errorDescription: String? {
            switch self {
            case .malformed: return "The vault data is malformed."
            case .wrongKey: return "The key could not decrypt the vault."
            case .verifierMismatch: return "The vault key failed verification."
            case .tooLarge: return "Files can be at most 25 MB."
            case .noUsableSlot: return "No keyslot on this device can open the vault."
            }
        }
    }

    static let maxBlobBytes = 25 * 1024 * 1024
    static let verifierPlain = "notemaker-vault-ok"
    static let verifierAAD = "notemaker/vault/v1/verifier"
    static func slotAAD(_ id: String) -> String { "notemaker/vault/v1/slot/" + id }
    static let infoRecovery = "notemaker/vault/v1/recovery"
    static let infoSE = "notemaker/vault/v1/secure-enclave"
    static let infoPasskey = "notemaker/vault/v1/passkey-prf"

    static func randomBytes(_ n: Int) -> Data {
        var d = Data(count: n)
        let ok = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        precondition(ok == errSecSuccess, "SecRandomCopyBytes failed")
        return d
    }

    static func hkdf(ikm: Data, salt: Data, info: String) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: Data(info.utf8), outputByteCount: 32)
    }

    static func seal(_ plain: Data, key: SymmetricKey, aad: String, iv: Data? = nil) throws -> (iv: Data, ct: Data) {
        let nonceData = iv ?? randomBytes(12)
        let box = try AES.GCM.seal(plain, using: key, nonce: AES.GCM.Nonce(data: nonceData), authenticating: Data(aad.utf8))
        return (nonceData, box.ciphertext + box.tag)
    }

    static func open(iv: Data, ct: Data, key: SymmetricKey, aad: String) throws -> Data {
        guard iv.count == 12, ct.count >= 16 else { throw VaultError.malformed }
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct.prefix(ct.count - 16), tag: ct.suffix(16))
            return try AES.GCM.open(box, using: key, authenticating: Data(aad.utf8))
        } catch { throw VaultError.wrongKey }
    }

    static func open(b64iv: String, b64ct: String, key: SymmetricKey, aad: String) throws -> Data {
        guard let iv = Data(base64Encoded: b64iv), let ct = Data(base64Encoded: b64ct) else { throw VaultError.malformed }
        return try open(iv: iv, ct: ct, key: key, aad: aad)
    }

    // Verifier
    static func makeVerifier(vdk: Data) throws -> VaultCipherBox {
        let r = try seal(Data(verifierPlain.utf8), key: SymmetricKey(data: vdk), aad: verifierAAD)
        return VaultCipherBox(iv: r.iv.base64EncodedString(), ct: r.ct.base64EncodedString())
    }
    static func checkVerifier(_ v: VaultCipherBox, vdk: Data) -> Bool {
        guard let p = try? open(b64iv: v.iv, b64ct: v.ct, key: SymmetricKey(data: vdk), aad: verifierAAD) else { return false }
        return p == Data(verifierPlain.utf8)
    }

    // Slot wrapping
    private static func wrap(_ vdk: Data, key: SymmetricKey, slotId: String) throws -> (String, String) {
        let r = try seal(vdk, key: key, aad: slotAAD(slotId))
        return (r.iv.base64EncodedString(), r.ct.base64EncodedString())
    }
    private static func unwrap(_ slot: Keyslot, key: SymmetricKey) throws -> Data {
        let vdk = try open(b64iv: slot.iv, b64ct: slot.ct, key: key, aad: slotAAD(slot.id))
        guard vdk.count == 32 else { throw VaultError.malformed }
        return vdk
    }

    static func wrapRecovery(vdk: Data, recoveryBytes: Data, slotId: String = UUID().uuidString.lowercased()) throws -> Keyslot {
        let salt = randomBytes(16)
        let (iv, ct) = try wrap(vdk, key: hkdf(ikm: recoveryBytes, salt: salt, info: infoRecovery), slotId: slotId)
        var s = Keyslot(id: slotId, type: "recovery", label: "Recovery key", iv: iv, ct: ct)
        s.salt = salt.base64EncodedString()
        return s
    }

    static func unwrapRecovery(_ slot: Keyslot, recoveryBytes: Data) throws -> Data {
        guard let salt = slot.salt.flatMap({ Data(base64Encoded: $0) }) else { throw VaultError.malformed }
        return try unwrap(slot, key: hkdf(ikm: recoveryBytes, salt: salt, info: infoRecovery))
    }

    /// Wrap the VDK to a (Secure Enclave) P-256 public key with an ephemeral software key — no Touch ID needed.
    static func wrapForSecureEnclave(vdk: Data, sePublicKey: P256.KeyAgreement.PublicKey, slotId: String,
                                     label: String, device: String) throws -> Keyslot {
        let eph = P256.KeyAgreement.PrivateKey()
        let shared = try eph.sharedSecretFromKeyAgreement(with: sePublicKey)
        let ephPub = eph.publicKey.x963Representation
        let ikm = shared.withUnsafeBytes { Data($0) }
        let (iv, ct) = try wrap(vdk, key: hkdf(ikm: ikm, salt: ephPub, info: infoSE), slotId: slotId)
        var s = Keyslot(id: slotId, type: "secure-enclave", label: label, iv: iv, ct: ct)
        s.ephemeralPublicKey = ephPub.base64EncodedString()
        s.publicKey = sePublicKey.x963Representation.base64EncodedString()
        s.device = device
        return s
    }

    /// `agree` performs ECDH with the slot's ephemeral public key — the Secure Enclave key in the app
    /// (prompts Touch ID), or a software key in tests.
    static func unwrapSecureEnclave(_ slot: Keyslot, agree: (P256.KeyAgreement.PublicKey) throws -> SharedSecret) throws -> Data {
        guard let eb = slot.ephemeralPublicKey.flatMap({ Data(base64Encoded: $0) }) else { throw VaultError.malformed }
        let eph = try P256.KeyAgreement.PublicKey(x963Representation: eb)
        let ikm = try agree(eph).withUnsafeBytes { Data($0) }
        return try unwrap(slot, key: hkdf(ikm: ikm, salt: eb, info: infoSE))
    }

    /// Passkey slots are created by the web app; macOS can only open them given the PRF output.
    static func unwrapPasskey(_ slot: Keyslot, prfOutput: Data) throws -> Data {
        guard let salt = slot.salt.flatMap({ Data(base64Encoded: $0) }) else { throw VaultError.malformed }
        return try unwrap(slot, key: hkdf(ikm: prfOutput, salt: salt, info: infoPasskey))
    }

    // Items
    static func encryptItem(_ p: VaultPayload, id: String, vdk: Data, createdAt: String, updatedAt: String = ISO.string()) throws -> VaultItemRecord {
        let json = try JSONEncoder().encode(p)
        let r = try seal(json, key: SymmetricKey(data: vdk), aad: id)
        return VaultItemRecord(id: id, iv: r.iv.base64EncodedString(), ct: r.ct.base64EncodedString(), createdAt: createdAt, updatedAt: updatedAt)
    }

    static func decryptItemJSON(_ r: VaultItemRecord, vdk: Data) throws -> Data {
        try open(b64iv: r.iv, b64ct: r.ct, key: SymmetricKey(data: vdk), aad: r.id)
    }

    static func decryptItem(_ r: VaultItemRecord, vdk: Data) throws -> VaultItem {
        let p = try JSONDecoder().decode(VaultPayload.self, from: try decryptItemJSON(r, vdk: vdk))
        return VaultItem(id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt, payload: p)
    }

    // Blobs: stored on disk as iv ‖ ct
    static func encryptBlob(_ bytes: Data, blobId: String, vdk: Data) throws -> Data {
        guard bytes.count <= maxBlobBytes else { throw VaultError.tooLarge }
        let r = try seal(bytes, key: SymmetricKey(data: vdk), aad: "blob:" + blobId)
        return r.iv + r.ct
    }

    static func decryptBlob(_ stored: Data, blobId: String, vdk: Data) throws -> Data {
        guard stored.count >= 28 else { throw VaultError.malformed }
        return try open(iv: stored.prefix(12), ct: stored.dropFirst(12), key: SymmetricKey(data: vdk), aad: "blob:" + blobId)
    }

    static func sha256Hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

    /// Create a new vault around `vdk`; returns the vault and the recovery key bytes (if any).
    static func newVault(vdk: Data, mode: VaultMode) throws -> (VaultData, Data?) {
        var v = VaultData(mode: mode, verifier: try makeVerifier(vdk: vdk))
        var recovery: Data? = nil
        if mode == .hardwareRecovery {
            let r = randomBytes(32)
            v.keyslots.append(try wrapRecovery(vdk: vdk, recoveryBytes: r))
            recovery = r
        }
        return (v, recovery)
    }
}

// MARK: - Recovery key (Crockford Base32 + 2-byte SHA-256 checksum)

enum RecoveryKey {
    static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    enum RKError: Error, LocalizedError {
        case badCharacter(Character), badLength, badChecksum
        var errorDescription: String? {
            switch self {
            case .badCharacter(let c): return "“\(c)” is not a valid recovery-key character."
            case .badLength: return "A recovery key has 55 characters (11 groups of 5)."
            case .badChecksum: return "The recovery key has a typo (checksum mismatch)."
            }
        }
    }

    static func encode(_ bytes: Data) -> String {
        precondition(bytes.count == 32)
        let all = bytes + SHA256.hash(data: bytes).prefix(2)
        var out = ""
        var buffer = 0, bits = 0
        for b in all {
            buffer = (buffer << 8) | Int(b); bits += 8
            while bits >= 5 { out.append(alphabet[(buffer >> (bits - 5)) & 31]); bits -= 5 }
            buffer &= (1 << bits) - 1
        }
        if bits > 0 { out.append(alphabet[(buffer << (5 - bits)) & 31]) }
        return stride(from: 0, to: out.count, by: 5).map { i in
            String(out[out.index(out.startIndex, offsetBy: i)..<out.index(out.startIndex, offsetBy: min(i + 5, out.count))])
        }.joined(separator: "-")
    }

    static func decode(_ s: String) throws -> Data {
        var chars: [Int] = []
        for ch in s.uppercased() where ch != "-" && !ch.isWhitespace {
            let c: Character = ch == "O" ? "0" : (ch == "I" || ch == "L") ? "1" : ch
            guard let i = alphabet.firstIndex(of: c) else { throw RKError.badCharacter(ch) }
            chars.append(i)
        }
        guard chars.count == 55 else { throw RKError.badLength }
        var out = Data()
        var buffer = 0, bits = 0
        for v in chars {
            buffer = (buffer << 5) | v; bits += 5
            if bits >= 8 { out.append(UInt8((buffer >> (bits - 8)) & 0xFF)); bits -= 8; buffer &= (1 << bits) - 1 }
        }
        guard out.count == 34 else { throw RKError.badLength }
        let key = out.prefix(32)
        guard Data(SHA256.hash(data: key).prefix(2)) == out.suffix(2) else { throw RKError.badChecksum }
        return Data(key)
    }
}

// MARK: - Password generator

enum PasswordGenerator {
    struct Options: Equatable {
        var length = 20
        var upper = true, lower = true, digits = true, symbols = true
        var avoidLookAlikes = true
    }

    static let lookAlikes = Set("Il1O0o|`'\"")
    static let symbolSet = "!@#$%^&*()-_=+[]{};:,.<>/?~"

    static func charset(_ o: Options) -> [[Character]] {
        var sets: [String] = []
        if o.upper { sets.append("ABCDEFGHIJKLMNOPQRSTUVWXYZ") }
        if o.lower { sets.append("abcdefghijklmnopqrstuvwxyz") }
        if o.digits { sets.append("0123456789") }
        if o.symbols { sets.append(symbolSet) }
        if sets.isEmpty { sets = ["abcdefghijklmnopqrstuvwxyz"] }
        return sets.map { Array($0.filter { !o.avoidLookAlikes || !lookAlikes.contains($0) }) }
    }

    private static func uniform(_ n: Int) -> Int {
        // rejection sampling over random UInt32s
        let limit = UInt32.max - UInt32.max % UInt32(n)
        while true {
            let r = VaultCrypto.randomBytes(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
            if r < limit { return Int(r % UInt32(n)) }
        }
    }

    /// Guarantees at least one character from each enabled set.
    static func generate(_ o: Options) -> String {
        let len = max(8, min(64, o.length))
        let sets = charset(o)
        let all = sets.flatMap { $0 }
        var chars = sets.map { $0[uniform($0.count)] }
        while chars.count < len { chars.append(all[uniform(all.count)]) }
        for i in stride(from: chars.count - 1, to: 0, by: -1) { chars.swapAt(i, uniform(i + 1)) }
        return String(chars.prefix(len))
    }

    /// Rough entropy estimate in bits from length and the character classes used.
    static func entropyBits(_ pw: String) -> Double {
        guard !pw.isEmpty else { return 0 }
        var pool = 0
        if pw.contains(where: { $0.isUppercase }) { pool += 26 }
        if pw.contains(where: { $0.isLowercase }) { pool += 26 }
        if pw.contains(where: { $0.isNumber }) { pool += 10 }
        if pw.contains(where: { !$0.isLetter && !$0.isNumber }) { pool += 32 }
        let unique = Set(pw).count
        let effectiveLen = Double(pw.count) * min(1, Double(unique) / max(1, Double(pw.count)) + 0.3)
        return effectiveLen * log2(Double(max(pool, 2)))
    }

    /// 0 very weak … 4 very strong
    static func strength(_ pw: String) -> Int {
        switch entropyBits(pw) {
        case ..<28: return 0
        case ..<45: return 1
        case ..<60: return 2
        case ..<90: return 3
        default: return 4
        }
    }
}
