# Notemaker for Windows, Linux and Android (Tauri 2)

One Tauri 2 shell runs the **same web UI** as the browser and macOS versions (the files at the repo root are
copied into `dist/` at build time and embedded in the binary — nothing is ever loaded from the network).
The contract is [`docs/PLATFORMS.md`](../../docs/PLATFORMS.md) + [`docs/DESKTOP_BRIDGE.md`](../../docs/DESKTOP_BRIDGE.md).

```
platforms/tauri/
  package.json, package-lock.json   pinned Tauri CLI (npx tauri …)
  scripts/prepare-web.mjs           copies the web UI + selftest/ into dist/ (runs before every build)
  selftest/                         bridge self-test page (--bridge-selftest)
  docker/                           Linux build + headless self-test + screenshot in Docker
  src-tauri/
    tauri.conf.json                 CSP, bundle targets, .notemaker file association
    capabilities/default.json       the page may call exactly one command: `bridge`
    bridge.js                       window.NotemakerNative (injected at document start)
    src/bridge.rs                   dispatch + validation (mirrors Notemaker/Core/BridgeValidation.swift)
    src/vaultcrypto.rs              HKDF / AES-GCM / keyslot JSON + unit tests against docs/*-test-vector.json
    src/hw/                         windows_hello.rs · fido2.rs (Linux) · android.rs
    src/storage.rs, notify.rs, lock.rs, desktop.rs (menu + tray), selftest.rs
    gen/android/                    Android Studio project (+ NotemakerPlugin.kt: Keystore, SAF, intents)
```

## What each platform supports

| | Windows | Linux | Android |
|---|---|---|---|
| storage / vault blobs | `%APPDATA%\com.mth.notemaker` | `~/.local/share/com.mth.notemaker` | app-internal storage |
| hardware vault key (`hw.*`) | `windows-hello` (TPM, face / fingerprint / PIN) | `fido2-hmac` (USB FIDO2 key with hmac-secret; touch + PIN) | `android-keystore` (StrongBox if present; fingerprint / face / screen lock) |
| reminders | while running (closing the window keeps it in the tray) | while running (tray) | **also when the app is closed** (AlarmManager) |
| click a reminder → open that day | ✓ (while running) | ✓ (while running) | ✓ |
| focus timer outside the window | tray tooltip | tray label (AppIndicator) | ongoing notification |
| native menu (File / Edit / View / Go / Help) | ✓ | ✓ | – |
| open `.notemaker` files | double-click / Open with (installer registers it) | double-click / Open with (`.desktop` + MIME type in .deb/.rpm) | Open with / Share |
| `files.save` | save dialog | save dialog | Storage Access Framework |
| clipboard auto-clear (30 s) | ✓ | ✓ | ✓ (+ "sensitive" flag on Android 13+) |
| vault lock on | sleep, session lock, system idle | sleep, session lock (logind), screensaver | screen off, background > auto-lock time |
| Dock-style badge | – | – | – |

`app.capabilities` returns this per platform (see `src/bridge.rs`).

## Build locally

Common: Node 18+, Rust 1.97.1 (`rustup`), then `npm ci` in this folder.

| | command | output |
|---|---|---|
| Windows | `npx tauri build` (x64) · `npx tauri build --target aarch64-pc-windows-msvc --bundles nsis` (arm64) | `src-tauri/target/**/bundle/{msi,nsis}` |
| Linux | `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libudev-dev rpm` then `npx tauri build --bundles deb,rpm,appimage` | `src-tauri/target/release/bundle/` |
| Linux via Docker (any OS) | `docker/run-linux.sh arm64` (or `amd64`) | `out/linux-<arch>/` (+ self-test result + screenshot) |
| Android | JDK 17, Android SDK + NDK (`ANDROID_HOME`, `NDK_HOME`), `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`, then `npx tauri android build --apk --aab` (release) or `--debug --apk` | `src-tauri/gen/android/app/build/outputs/` |

Tests: `cd src-tauri && node ../scripts/prepare-web.mjs && cargo test && cargo clippy --all-targets -- -D warnings`.

### Bridge self-test
* Desktop: `notemaker --bridge-selftest` opens `selftest/index.html`, calls every non-interactive bridge method with a
  temporary data folder, prints ✓/✗ lines and exits 0/1 (set `NOTEMAKER_SELFTEST_OUT=<file>` to also write the report —
  Windows release builds have no console). Headless Linux: `dbus-run-session -- xvfb-run -a notemaker --bridge-selftest`.
* Android (debug builds only): `adb shell am start -n com.mth.notemaker/.MainActivity --ez notemaker.selftest true`,
  then `adb logcat -s NotemakerSelftest`.

## Android release key (free, never in git)

A release keystore was created **outside the repo** at `~/.notemaker-android/release.jks` (alias `notemaker`,
RSA 4096, valid ~27 years); its passwords are in `~/.notemaker-android/keystore.properties` (mode 0600).
Back both up somewhere safe (e.g. a password manager): **if the key is lost, installed apps can't be updated.**

Local signed release build:
```bash
cp ~/.notemaker-android/keystore.properties src-tauri/gen/android/keystore.properties   # git-ignored
npx tauri android build --apk --aab
```

GitHub Actions (`.github/workflows/release.yml`) needs four repository secrets
(Settings → Secrets and variables → Actions), e.g. with the GitHub CLI:
```bash
base64 -i ~/.notemaker-android/release.jks | gh secret set NOTEMAKER_ANDROID_KEYSTORE_BASE64
grep storePassword ~/.notemaker-android/keystore.properties | cut -d= -f2- | gh secret set NOTEMAKER_ANDROID_KEYSTORE_PASSWORD
echo -n notemaker | gh secret set NOTEMAKER_ANDROID_KEY_ALIAS
grep keyPassword ~/.notemaker-android/keystore.properties | cut -d= -f2- | gh secret set NOTEMAKER_ANDROID_KEY_PASSWORD
```
Debug builds always use the Android debug key. Without the secrets the release job stops instead of
publishing unsigned APKs.

## Unsigned desktop builds
Windows installers are unsigned (free): SmartScreen shows "Windows protected your PC" → **More info → Run anyway**.
Free code signing for open source: [SignPath Foundation](https://signpath.org/) (apply later).

## Hardware-key error codes (`hw.createSlot` / `hw.unwrapSlot` rejections)
`cancelled`, `not-this-device`, `no-device` (no security key / Windows Hello / screen lock), `biometry-changed`,
`biometry-lockout`, `locked` (Windows Hello locked), and FIDO2 only: `pin-required` (retry with `params.pin`),
`pin-invalid`, `pin-blocked`, `multiple-devices`, `no-permission` (udev rules), `timeout`, `unsupported`
(no hmac-secret). The PIN is passed to the security key only — never logged or stored.
