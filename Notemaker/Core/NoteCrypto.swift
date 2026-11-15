import Foundation
import CryptoKit
import CommonCrypto
import Security

/// Private-note encryption compatible with the web app's WebCrypto implementation:
/// PBKDF2-SHA256 → 32-byte key, AES-GCM-256 with a 12-byte IV, `ct` = ciphertext ‖ 16-byte tag.
enum NoteCrypto {
    static let defaultIterations = 210_000

    enum CryptoError: Error, LocalizedError {
        case badInput, kdfFailed, wrongPasscode
        var errorDescription: String? {
            switch self {
            case .badInput: return "The encrypted note is malformed."
            case .kdfFailed: return "Key derivation failed."
            case .wrongPasscode: return "Wrong passcode."
            }
        }
    }

    static func randomBytes(_ n: Int) -> Data {
        var d = Data(count: n)
        _ = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        return d
    }

    static func pbkdf2(_ passcode: String, salt: Data, iterations: Int, length: Int = 32) throws -> Data {
        let pw = Array(passcode.utf8)
        var out = Data(count: length)
        let status = out.withUnsafeMutableBytes { outPtr -> Int32 in
            salt.withUnsafeBytes { saltPtr -> Int32 in
                pw.withUnsafeBufferPointer { pwPtr -> Int32 in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                         pwPtr.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: Int8.self) },
                                         pw.count,
                                         saltPtr.bindMemory(to: UInt8.self).baseAddress, salt.count,
                                         CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations),
                                         outPtr.bindMemory(to: UInt8.self).baseAddress, length)
                }
            }
        }
        guard status == kCCSuccess else { throw CryptoError.kdfFailed }
        return out
    }

    static func encrypt(_ plaintext: String, passcode: String, iterations: Int = defaultIterations) throws -> Cipher {
        let salt = randomBytes(16)
        let key = try pbkdf2(passcode, salt: salt, iterations: iterations)
        return try encrypt(plaintext, key: key, salt: salt, iterations: iterations)
    }

    static func encrypt(_ plaintext: String, key: Data, salt: Data, iterations: Int) throws -> Cipher {
        let iv = randomBytes(12)
        let box = try AES.GCM.seal(Data(plaintext.utf8), using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: iv))
        return Cipher(iterations: iterations, salt: salt.base64EncodedString(), iv: iv.base64EncodedString(),
                      ct: (box.ciphertext + box.tag).base64EncodedString())
    }

    static func decrypt(_ c: Cipher, passcode: String) throws -> String {
        guard let salt = Data(base64Encoded: c.salt) else { throw CryptoError.badInput }
        let key = try pbkdf2(passcode, salt: salt, iterations: c.iterations)
        return try decrypt(c, key: key)
    }

    static func decrypt(_ c: Cipher, key: Data) throws -> String {
        guard let iv = Data(base64Encoded: c.iv), let all = Data(base64Encoded: c.ct), all.count >= 16 else { throw CryptoError.badInput }
        let ct = all.prefix(all.count - 16), tag = all.suffix(16)
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct, tag: tag)
            let plain = try AES.GCM.open(box, using: SymmetricKey(data: key))
            guard let s = String(data: plain, encoding: .utf8) else { throw CryptoError.badInput }
            return s
        } catch let e as CryptoError { throw e } catch { throw CryptoError.wrongPasscode }
    }

    static func makeLockHash(_ passcode: String, iterations: Int = defaultIterations) throws -> LockHash {
        let salt = randomBytes(16)
        let h = try pbkdf2(passcode, salt: salt, iterations: iterations)
        return LockHash(salt: salt.base64EncodedString(), iterations: iterations, hash: h.base64EncodedString())
    }

    static func verify(_ passcode: String, _ lh: LockHash) -> Bool {
        guard let salt = Data(base64Encoded: lh.salt), let h = try? pbkdf2(passcode, salt: salt, iterations: lh.iterations) else { return false }
        return h.base64EncodedString() == lh.hash
    }
}
