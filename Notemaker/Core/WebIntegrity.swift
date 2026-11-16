import Foundation
import CryptoKit

/// Build-time integrity check of the bundled web UI (a free, ad-hoc-signing-friendly substitute for notarization).
///
/// Build: `tools/bundle-web.sh` writes `Contents/Resources/web-manifest.json`
///   `{ "version": 1, "algorithm": "sha256", "files": { "<path relative to web/>": "<hex sha256>", … } }`
/// and compiles the SHA-256 of that manifest file into the binary (`BuildIntegrity.manifestSHA256`).
/// Launch: the manifest's hash must match the compiled constant, and every file under `web/` must match
/// the manifest exactly — no tampered, missing or extra files.
enum WebIntegrity {
    struct Report: Equatable {
        var manifestOK = true
        var tampered: [String] = []
        var missing: [String] = []
        var extra: [String] = []
        var error: String? = nil
        var ok: Bool { manifestOK && tampered.isEmpty && missing.isEmpty && extra.isEmpty && error == nil }
        var summary: String {
            if ok { return "ok" }
            var parts: [String] = []
            if let error { parts.append(error) }
            if !manifestOK { parts.append("manifest hash mismatch") }
            if !tampered.isEmpty { parts.append("changed: " + tampered.joined(separator: ", ")) }
            if !missing.isEmpty { parts.append("missing: " + missing.joined(separator: ", ")) }
            if !extra.isEmpty { parts.append("unexpected: " + extra.joined(separator: ", ")) }
            return parts.joined(separator: "; ")
        }
    }

    /// Finder may drop these into any folder it shows; they are never loaded by the page.
    static let ignoredNames: Set<String> = [".DS_Store"]

    static func sha256Hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

    /// Every entry under `dir` (relative paths, "/"-separated). Symlinks and other non-regular files are
    /// returned in `odd` so they count as unexpected.
    static func listFiles(_ dir: URL) -> (files: [String], odd: [String]) {
        let fm = FileManager.default
        guard let e = fm.enumerator(atPath: dir.path) else { return ([], []) }
        var files: [String] = [], odd: [String] = []
        while let rel = e.nextObject() as? String {
            if ignoredNames.contains((rel as NSString).lastPathComponent) { continue }
            let type = (try? fm.attributesOfItem(atPath: dir.appendingPathComponent(rel).path))?[.type] as? FileAttributeType
            switch type {
            case .typeDirectory?: continue
            case .typeRegular?: files.append(rel)
            default: odd.append(rel)          // symlink, socket, unreadable…
            }
        }
        return (files.sorted(), odd.sorted())
    }

    /// The manifest JSON for a directory (same shape tools/bundle-web.sh writes).
    static func makeManifest(for dir: URL) throws -> Data {
        var files: [String: String] = [:]
        for f in listFiles(dir).files { files[f] = sha256Hex(try Data(contentsOf: dir.appendingPathComponent(f))) }
        let obj: [String: Any] = ["version": 1, "algorithm": "sha256", "files": files]
        return try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .prettyPrinted])
    }

    static func verify(webDir: URL, manifestURL: URL, expectedManifestSHA256: String) -> Report {
        var r = Report()
        guard let manifestData = try? Data(contentsOf: manifestURL) else { r.error = "web-manifest.json is missing"; return r }
        guard !expectedManifestSHA256.isEmpty, sha256Hex(manifestData) == expectedManifestSHA256.lowercased() else {
            r.manifestOK = false; return r
        }
        guard let obj = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
              obj["algorithm"] as? String == "sha256", let expected = obj["files"] as? [String: String] else {
            r.error = "web-manifest.json is malformed"; return r
        }
        let (actual, odd) = listFiles(webDir)
        let actualSet = Set(actual)
        r.missing = expected.keys.filter { !actualSet.contains($0) }.sorted()
        r.extra = (actual.filter { expected[$0] == nil } + odd).sorted()
        for f in actual {
            guard let want = expected[f] else { continue }
            guard let d = try? Data(contentsOf: webDir.appendingPathComponent(f), options: .mappedIfSafe) else { r.missing.append(f); continue }
            if sha256Hex(d) != want.lowercased() { r.tampered.append(f) }
        }
        return r
    }
}
