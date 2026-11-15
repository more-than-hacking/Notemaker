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
        case unavailable, accessControl, notThisDevice, cancelled, failed(String)
        /// Error strings are part of the bridge contract ("cancelled", "not-this-device").
        var errorDescription: String? {
            switch self {
            case .unavailable: return "secure-enclave-unavailable"
            case .accessControl: return "Could not create the Secure Enclave access control."
            case .notThisDevice: return "not-this-device"
            case .cancelled: return "cancelled"
            case .failed(let s): return s
            }
        }
    }

    enum Location: String { case keychain, file }

    static var isAvailable: Bool { SecureEnclave.isAvailable }
    static var deviceName: String { Host.current().localizedName ?? "This Mac" }
    static var keysDir: URL { DataFile.root.appendingPathComponent("vault-keys", isDirectory: true) }

    // MARK: Bridge operations

    /// `se.createSlot`: new SE key (no prompt at creation), store its handle, wrap the VDK to its public key.
    static func createSlot(slotId: String, label: String, vdk: Data) throws -> (Keyslot, Location) {
        guard isAvailable else { throw SEError.unavailable }
        var err: Unmanaged<CFError>?
        guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                       [.privateKeyUsage, .userPresence], &err) else { throw SEError.accessControl }
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: ac)
        let loc = try save(handle: key.dataRepresentation, slotId: slotId)
        do {
            let slot = try VaultCrypto.wrapForSecureEnclave(vdk: vdk, sePublicKey: key.publicKey, slotId: slotId,
                                                            label: label, device: deviceName)
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
        let ctx = LAContext()
        ctx.localizedReason = reason
        let key: SecureEnclave.P256.KeyAgreement.PrivateKey
        do { key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: handle, authenticationContext: ctx) }
        catch { throw SEError.notThisDevice }
        if let pk = slot.publicKey, let pkData = Data(base64Encoded: pk), pkData != key.publicKey.x963Representation {
            throw SEError.notThisDevice   // a handle exists for this id but belongs to another key
        }
        do {
            return try VaultCrypto.unwrapSecureEnclave(slot) { eph in try key.sharedSecretFromKeyAgreement(with: eph) }
        } catch let e as VaultCrypto.VaultError {
            throw SEError.failed(e.localizedDescription)
        } catch {
            throw isCancellation(error) ? SEError.cancelled : SEError.failed("Secure Enclave error: \(error.localizedDescription)")
        }
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
