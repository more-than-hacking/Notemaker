# Notemaker transfer file (`.notemaker`) — format v1

Moves *everything* from one device to another (Mac ↔ Mac, Mac ↔ browser, browser ↔ browser):
tasks, notes (incl. private notes), habits, templates, focus history, settings, UI preferences,
and the vault (encrypted items **and files**). The file is encrypted end-to-end with a one-time
**transfer code** that is shown on the old device and never stored in the file or anywhere else.
`docs/transfer-test-vector.json` (from `docs/gen-transfer-vector.js`, WebCrypto) must decrypt in both apps.

## Transfer code
20 random bytes → append the first 2 bytes of SHA-256(those 20 bytes) → 22 bytes → Crockford Base32
(same alphabet/rules as the vault recovery key) → 36 characters, shown as **6 groups of 6** joined with `-`
(e.g. `K3F9QZ-…`). Parsing: uppercase, drop spaces/dashes, `O→0`, `I/L→1`, verify checksum.
160 bits of entropy, so no slow KDF is needed.

## File (UTF-8 JSON, extension `.notemaker`, MIME `application/vnd.notemaker.transfer+json`)
```jsonc
{
  "format": "notemaker-transfer",
  "version": 1,
  "createdAt": ISO,
  "source": { "app": "web" | "macos", "appVersion": "2.x.y", "device": string },   // shown before decrypting
  "summary": { "tasks": n, "notes": n, "vaultItems": n, "vaultFiles": n, "bytes": n }, // counts only, no content
  "salt": b64(16), "iv": b64(12),
  "ct": b64       // AES-256-GCM(key, iv, gzip(payload JSON), AAD = UTF-8 "notemaker/transfer/v1")
}
```
`key` = HKDF-SHA256(IKM = 20 code bytes, salt = `salt`, info = `"notemaker/transfer/v1"`, 32 bytes).
Compression: gzip (`CompressionStream("gzip")` in browsers/WKWebView, `zlib` in Node).

## Payload (inside `ct`, after gunzip)
```jsonc
{
  "manifest": {
    "tasks": n, "notes": n, "lockedNotes": n, "habits": n, "templates": n, "focusSessions": n,
    "vaultItems": n, "vaultFiles": n, "vaultFileBytes": n,
    "docSha256": hex   // SHA-256 of the UTF-8 bytes of JSON.stringify(doc) exactly as stored in this payload
  },
  "doc": { ...v2 document incl. settings and vault, with vault.blobs filled for EVERY file... },
  "prefs": { ...UI preferences (accent color, editor mode, last view, sidebar state) }
}
```

## Rules
- **Export** requires: all vault files present (unlock the vault so blobs can be read; if a blob is missing the
  export stops and names the item). If the vault is `hardware-only` and has no recovery slot, the user must
  either create a recovery key now (vault becomes `hardware+recovery`) or explicitly choose "Move without the
  vault" (vault omitted; manifest counts reflect that). Private notes stay encrypted as they are.
- **Import**: parse envelope → show `source` + `summary` → ask for the code → decrypt (wrong code / tampering →
  AES-GCM failure → "That code doesn't match this file") → gunzip → verify `docSha256` and that the manifest
  counts match the doc → restore:
  - target empty: replace. Target has data: offer "Replace this device's data" (default for a move) or
    "Merge" (existing merge rules) — both undoable for the session.
  - settings and prefs replaced (Replace) or kept (Merge); vault blobs written to local blob storage;
    reminders rescheduled; the vault starts locked.
- **After import**: re-count and show a check screen (✓ per category, comparing with the manifest).
  If the vault has no hardware slot usable on this device, prompt "Finish moving your vault": unlock with the
  recovery key (or a synced passkey, browser), then immediately offer "Add this Mac / this browser".
- The transfer code is never written to disk, logs, the file, clipboard history (copy uses the concealed /
  auto-clear clipboard path), or analytics. Size limit: 1 GB per file (warn above 200 MB).
- Old unencrypted JSON backups (`notemaker_backup_*.json`) remain importable; their export stays available as
  "Unencrypted backup (JSON)" with a warning.
