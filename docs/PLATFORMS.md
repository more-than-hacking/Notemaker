# Notemaker on Windows, Linux and Android (Tauri 2) — contract v1

The same web UI runs everywhere. macOS keeps its native AppKit shell (`Notemaker/Shell`, Secure Enclave).
Windows, Linux and Android use one Tauri 2 project in `platforms/tauri/`. All shells implement
[`DESKTOP_BRIDGE.md`](DESKTOP_BRIDGE.md) (`window.NotemakerNative`), with `platform` = `"macos" | "windows" | "linux" | "android"`.
Everything is free/open source; builds run locally or on GitHub Actions (public repo).

## Bridge on Tauri
`NotemakerNative.request(method, params)` → `window.__TAURI__.core.invoke("bridge", { method, params })`
(one Rust command that dispatches by method name and validates params exactly like `Notemaker/Core/BridgeValidation.swift`).
Events → Tauri event `notemaker-native` re-dispatched as the DOM `CustomEvent("notemaker-native")`.
Method availability differs per platform; `app.capabilities` returns what this shell supports:
```jsonc
{ "platform": "windows", "storage": true, "blobs": true, "notifyWhenClosed": false, "badge": false,
  "tray": true, "fileOpen": true, "hardwareKey": "windows-hello" | "android-keystore" | "fido2" | "secure-enclave" | null }
```
The web UI hides features a shell doesn't support (e.g. Dock badge, notifications-when-closed on desktop Linux/Windows).

## Generic hardware keyslots: `hw.*`
New bridge methods (the macOS `se.*` methods stay; the web treats `se.*` as `hw.*` with kind `secure-enclave`):
| method | params | result |
|---|---|---|
| `hw.available` | – | `{ kind, available: bool, device: string, detail?: string }` |
| `hw.createSlot` | `{ slotId, label, vdk }` | Keyslot object (type below) — creates the hardware key (prompting the user) and wraps `vdk` |
| `hw.unwrapSlot` | `{ slot }` | `{ vdk }` — prompts (Windows Hello / biometric / touch the security key); errors `"cancelled"`, `"not-this-device"`, `"no-device"` (security key not plugged in), `"biometry-changed"` |
| `hw.deleteSlot` | `{ slotId }` | `{ ok: true }` |

The vault format (VAULT_FORMAT.md) gains three keyslot types. Common fields and AAD rule are unchanged:
`{ id, type, label, createdAt, iv, ct }` with `ct = AES-256-GCM(wrapKey, iv, VDK, AAD "notemaker/vault/v1/slot/<id>")`.

| type | platform | extra fields | wrapKey |
|---|---|---|---|
| `windows-hello` | Windows | `keyName` (KeyCredentialManager name), `challenge` b64(32), `device` | HKDF-SHA256(IKM = RSA PKCS#1 v1.5 signature of `challenge` by the Windows Hello key (deterministic), salt = `challenge`, info `"notemaker/vault/v1/windows-hello"`) |
| `android-keystore` | Android | `keyAlias`, `strongBox` bool, `device` | not HKDF: the VDK is encrypted directly by a non-exportable Android Keystore AES-256-GCM key (`setUserAuthenticationRequired(true)` with `BIOMETRIC_STRONG or DEVICE_CREDENTIAL`, StrongBox when available) using `iv` and the same AAD; `ct` is its output |
| `fido2-hmac` | Linux (any OS with a USB/NFC FIDO2 key) | `credentialId` b64url, `rpId` `"notemaker.local"`, `salt` b64(32), `hkdfSalt` b64(16), `device` | HKDF-SHA256(IKM = CTAP2 hmac-secret output for `salt`, salt = `hkdfSalt`, info `"notemaker/vault/v1/fido2-hmac"`) |

Windows Hello: `KeyCredentialManager.RequestCreateAsync(keyName, FailIfExists)` creates a TPM-backed RSA key gated by
Windows Hello (face, fingerprint or PIN); `RequestSignAsync(challenge)` returns the deterministic signature.
Linux FIDO2: CTAP2 over USB HID (pure-Rust crate, no system daemon), user presence (touch) + PIN if the key has one.
If no security key is available on Linux, the vault uses its recovery key (UI says plainly that it is not hardware-backed).

## Other bridge methods on Tauri
- `storage.*` → `notemaker-data.json` in the app data dir (`%APPDATA%\com.mth.notemaker`, `~/.local/share/com.mth.notemaker`,
  Android internal storage), atomic write + one `.backup.json`. `blobs.*` → `vault-blobs/` beside it.
- `notify.*` → tauri-plugin-notification. Android: scheduled notifications fire when the app is closed. Desktop: reminders fire
  while the app runs (it can live in the tray: closing the window hides it; "Quit" from the tray menu quits).
- `files.save` → save dialog (desktop) / Storage Access Framework (Android). `clipboard.write` → clipboard plugin (+ clear).
- `app.setFocusTimer` → tray tooltip/title (desktop), ongoing notification (Android). `app.setBadge` → no-op where unsupported.
- `openTransfer`: `.notemaker` file association (Windows registry via the installer, Linux `.desktop` MIME type, Android intent filter).
- Lock events: system suspend / session lock (Windows `WM_POWERBROADCAST`/`WTS_SESSION_LOCK`, Linux logind `PrepareForSleep`/`Lock`
  via D-Bus, Android `onPause` > N minutes / screen off).

## Packaging (free)
| platform | artifacts | notes |
|---|---|---|
| Windows | `.msi` + NSIS `.exe` (x64, arm64) | unsigned → SmartScreen "More info → Run anyway"; apply to SignPath Foundation (free OSS signing) later |
| Linux | AppImage, `.deb`, `.rpm` (x86_64, aarch64) | Flathub later |
| Android | universal `.apk` (+ `.aab`) signed with a project release key kept OUT of git (GitHub Actions secret) | F-Droid later; Play Store skipped ($25) |
| macOS | universal `.dmg` from `build_and_create_dmg.sh` | ad-hoc signed |

`.github/workflows/release.yml` builds all of the above on tag push (`v*`) and attaches them to a GitHub Release;
`ci.yml` runs web tests, macOS tests and Tauri builds on every push/PR.
