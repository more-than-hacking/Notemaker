# Notemaker for macOS — developer setup

The macOS app is a **native AppKit shell around the web UI**: an `NSWindow` with a `WKWebView` that loads the
bundled `index.html` (from `Contents/Resources/web/`). Native capabilities (file storage, Secure Enclave vault
keys, notifications, Dock badge, menu-bar timer, save panels, clipboard) are exposed to the page through the
bridge described in `docs/DESKTOP_BRIDGE.md`. The UI itself is the web app — change it in `index.html`,
`app.js`, `styles.css` and `js/`, then rebuild.

## Layout

```
Notemaker/
  Shell/       the native shell
    AppDelegate.swift       @main, window, WKWebView, menus, lifecycle, lock events, quit flush, --bridge-selftest
    WebBridge.swift         WKScriptMessageHandler: origin check, dispatch of every bridge method, events
    BridgeScript.swift      JS injected at document start (window.NotemakerNative, reply/event plumbing)
    NativeServices.swift    blobs, UserNotifications, NSSavePanel, clipboard auto-clear, Dock badge, status item
    SecureEnclaveKeys.swift Secure Enclave P-256 keys + Keychain handle storage (0600-file fallback)
    selftest/selftest.html  page used by --bridge-selftest
  Core/        Foundation/CryptoKit only — shared model + crypto, unit tested
    Vault.swift             vault format v1: keyslots, items, blobs, recovery key, password generator
    BridgeValidation.swift  bridge parameter validation
    Models.swift, Logic.swift, QuickAdd.swift, NoteCrypto.swift, Migration.swift, …  (data format v2)
Tests-mac/     main.swift + run.sh — CLI test runner for Core (no XCTest needed)
tools/         swiftc-env.sh — shared swiftc setup (SDK, module cache, SwiftBridging workaround)
```

## Build & run

```bash
./build.sh                       # → build_output/Notemaker.app, universal (arm64 + x86_64), ad-hoc signed
./build.sh --native-only         # only this Mac's architecture (fast dev build)
./build.sh --debug               # unoptimised
build_output/Notemaker.app/Contents/MacOS/Notemaker --bridge-log       # print bridge calls + page JS errors
build_output/Notemaker.app/Contents/MacOS/Notemaker --bridge-selftest  # automated bridge test (temp data folder), exits 0/1
arch -x86_64 build_output/Notemaker.app/Contents/MacOS/Notemaker --bridge-selftest   # same, Intel slice under Rosetta
build_output/Notemaker.app/Contents/MacOS/Notemaker --skip-integrity   # dev only: skip the web-file integrity check
defaults write com.mth.notemaker NotemakerWebInspector -bool YES      # enable Safari Web Inspector for the page
```

`build.sh` uses `xcodebuild` when full Xcode is installed (the project has a "Bundle web UI" script phase),
otherwise `swiftc` from the Command Line Tools.

## Integrity check (free substitute for notarization)

`tools/bundle-web.sh` copies the web UI into `Contents/Resources/web/`, writes `Resources/web-manifest.json`
(SHA-256 of every file) and generates `BuildIntegrity.swift`, which compiles the manifest's own SHA-256 into the
binary. At launch, before the page loads, the app checks that every file matches and that none are missing or
extra (`Notemaker/Core/WebIntegrity.swift`, ~20 ms). If anything differs it refuses to open. Any edit to the web
files therefore needs a rebuild (`./build.sh`).

## Tests

```bash
Tests-mac/run.sh                          # Core tests incl. docs/vault-test-vector.json and docs/crypto-test-vector.json
Tests-mac/run.sh --import path/to.json    # print entity counts of any v2 (or web v1) backup
Tests-mac/run.sh --migrate-v1-defaults    # dry run of the macOS v1 migration (read-only, counts only)
```

## Data

- `~/Library/Application Support/Notemaker/data.json` — the v2 document (`storage.load/save`).
- `…/Notemaker/vault-blobs/<id>.bin` — encrypted vault files (iv ‖ ct), 0600.
- Keychain, service `com.mth.notemaker.vault` — Secure Enclave key handles, one per keyslot
  (fallback `…/Notemaker/vault-keys/<slot>.key`, 0600, only if the Keychain refuses).
