import Foundation
import CryptoKit
import Security
import LocalAuthentication

/// Secure Enclave keys behind `se.*` bridge methods (docs/VAULT_FORMAT.md, docs/DESKTOP_BRIDGE.md).
///
/// The SE key's `dataRepresentation` is an opaque handle only this Mac's Secure Enclave can use. It is stored in
/// the Keychain (generic password, service `com.mth.notemaker.vault`, account = slot id). If the Keychain refuses
/// (e.g. for an ad-hoc signed build), it falls back to a 0600 file in Application Support/Notemaker/vault-keys/.
enum SecureEnclaveKeys {
    static let service = "com.mth.notemaker.vault"

    enum SEError: Error, LocalizedError {
        case unavailable, accessControl, notThisDevice, cancelled, biometryUnavailable, biometryChanged, biometryLockout, failed(String)
        /// Error strings are part of the bridge contract ("cancelled", "not-this-device").
        var errorDescription: String? {
            switch self {
            case .unavailable: return "secure-enclave-unavailable"
            case .accessControl: return "Could not create the Secure Enclave access control."
            case .notThisDevice: return "not-this-device"
            case .cancelled: return "cancelled"
            case .biometryUnavailable: return "biometry-unavailable"
            case .biometryChanged: return "biometry-changed"
            case .biometryLockout: return "biometry-lockout"
            case .failed(let s): return s
            }
        }
    }

    enum Location: String { case keychain, file }

    static var isAvailable: Bool { SecureEnclave.isAvailable }
    static var deviceName: String { Host.current().localizedName ?? "This Mac" }
    static var keysDir: URL { DataFile.root.appendingPathComponent("vault-keys", isDirectory: true) }

    static let policyPresence = "user-presence"
    static let policyBiometry = "biometry-current-set"

    // MARK: Bridge operations

    /// `se.capabilities`: Touch ID hardware present, and fingers enrolled (i.e. biometry usable now).
    static func capabilities() -> (touchID: Bool, enrolled: Bool) {
        let ctx = LAContext()
        var err: NSError?
        let usable = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
        // biometryType is filled in by canEvaluatePolicy even when nothing is enrolled.
        let hasTouchID = ctx.biometryType == .touchID || (err.map { $0.code == LAError.biometryNotEnrolled.rawValue } ?? false)
        return (hasTouchID, usable)
    }

    /// Opaque hash of the currently enrolled fingerprints (nil if biometry isn't usable).
    static func biometryDomainState() -> Data? {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else { return nil }
        return ctx.evaluatedPolicyDomainState
    }
    private static func domainKey(_ slotId: String) -> String { "seBiometryDomainState.\(slotId)" }

    /// `se.createSlot`: new SE key (no prompt at creation), store its handle, wrap the VDK to its public key.
    /// `biometryOnly`: Touch ID only (`.biometryCurrentSet`) — the key stops working if fingerprints change.
    static func createSlot(slotId: String, label: String, vdk: Data, biometryOnly: Bool = false) throws -> (Keyslot, Location) {
        guard isAvailable else { throw SEError.unavailable }
        if biometryOnly && !capabilities().enrolled { throw SEError.biometryUnavailable }
        var err: Unmanaged<CFError>?
        let flags: SecAccessControlCreateFlags = biometryOnly ? [.privateKeyUsage, .biometryCurrentSet] : [.privateKeyUsage, .userPresence]
        guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &err)
        else { throw SEError.accessControl }
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: ac)
        let loc = try save(handle: key.dataRepresentation, slotId: slotId)
        do {
            var slot = try VaultCrypto.wrapForSecureEnclave(vdk: vdk, sePublicKey: key.publicKey, slotId: slotId,
                                                            label: label, device: deviceName)
            slot.policy = biometryOnly ? policyBiometry : policyPresence
            if biometryOnly, let state = biometryDomainState() {
                UserDefaults.standard.set(state, forKey: domainKey(slotId))   // not secret: lets us detect enrollment changes
            }
            return (slot, loc)
        } catch {
            delete(slotId: slotId)
            throw error
        }
    }

    /// `se.unwrapSlot`: prompts Touch ID / the Mac password. Blocking — call off the main thread.
    static func unwrapSlot(_ slot: Keyslot, reason: String = "unlock your Notemaker vault") throws -> Data {
        guard isAvailable else { throw SEError.unavailable }
        guard slot.type == "secure-enclave", let handle = load(slotId: slot.id) else { throw SEError.notThisDevice }
        let biometryOnly = slot.policy == policyBiometry
        if biometryOnly && !capabilities().enrolled {
            // No Touch ID sensor reachable (e.g. lid closed) or no fingers enrolled.
            throw SEError.biometryUnavailable
        }
        if biometryOnly, let saved = UserDefaults.standard.data(forKey: domainKey(slot.id)),
           let now = biometryDomainState(), saved != now {
            throw SEError.biometryChanged     // fingerprints were added/removed: the key is permanently invalid
        }
        let ctx = LAContext()
        ctx.localizedReason = reason
        let key: SecureEnclave.P256.KeyAgreement.PrivateKey
        do { key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: handle, authenticationContext: ctx) }
        catch { throw biometryOnly ? SEError.biometryChanged : SEError.notThisDevice }
        if let pk = slot.publicKey, let pkData = Data(base64Encoded: pk), pkData != key.publicKey.x963Representation {
            throw SEError.notThisDevice   // a handle exists for this id but belongs to another key
        }
        do {
            return try VaultCrypto.unwrapSecureEnclave(slot) { eph in try key.sharedSecretFromKeyAgreement(with: eph) }
        } catch let e as VaultCrypto.VaultError {
            throw SEError.failed(e.localizedDescription)
        } catch {
            if isCancellation(error) { throw SEError.cancelled }
            if hasLACode(error, LAError.biometryLockout.rawValue) { throw SEError.biometryLockout }
            // A .biometryCurrentSet key is invalidated for good when fingerprints are added or removed.
            if biometryOnly { throw SEError.biometryChanged }
            throw SEError.failed("Secure Enclave error: \(error.localizedDescription)")
        }
    }

    static func hasLACode(_ error: Error, _ code: Int) -> Bool {
        var e: NSError? = error as NSError
        while let n = e {
            if n.domain == LAError.errorDomain && n.code == code { return true }
            e = n.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return false
    }

    /// LocalAuthentication cancellations surface through CryptoKit/Security as NSErrors.
    static func isCancellation(_ error: Error) -> Bool {
        var e: NSError? = error as NSError
        while let n = e {
            if n.domain == LAError.errorDomain,
               [LAError.userCancel.rawValue, LAError.appCancel.rawValue, LAError.systemCancel.rawValue,
                LAError.userFallback.rawValue, LAError.notInteractive.rawValue].contains(n.code) { return true }
            if n.domain == NSOSStatusErrorDomain && (n.code == Int(errSecUserCanceled) || n.code == Int(errSecAuthFailed)) { return true }
            e = n.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return "\(error)".localizedCaseInsensitiveContains("cancel")
    }

    // MARK: Handle storage

    @discardableResult
    static func save(handle: Data, slotId: String) throws -> Location {
        delete(slotId: slotId)
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: slotId,
            kSecAttrLabel as String: "Notemaker vault key",
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: handle,
        ]
        if SecItemAdd(q as CFDictionary, nil) == errSecSuccess, loadFromKeychain(slotId) == handle { return .keychain }
        // Fallback: a private file (the handle is useless without this Mac's Secure Enclave).
        try FileManager.default.createDirectory(at: keysDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = keysDir.appendingPathComponent("\(slotId).key")
        try handle.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return .file
    }

    static func load(slotId: String) -> Data? {
        loadFromKeychain(slotId) ?? (try? Data(contentsOf: keysDir.appendingPathComponent("\(slotId).key")))
    }

    static func delete(slotId: String) {
        UserDefaults.standard.removeObject(forKey: domainKey(slotId))
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service, kSecAttrAccount as String: slotId]
        SecItemDelete(q as CFDictionary)
        try? FileManager.default.removeItem(at: keysDir.appendingPathComponent("\(slotId).key"))
    }

    private static func loadFromKeychain(_ slotId: String) -> Data? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service, kSecAttrAccount as String: slotId,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }
}
