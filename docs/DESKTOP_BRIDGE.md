# Notemaker desktop shell ↔ web UI bridge (v1)

The macOS app is a native shell (AppKit + WKWebView) that runs the **same web UI** as the browser
version, loaded from the app bundle (`Contents/Resources/web/index.html` via `loadFileURL`, read access
to the `web/` folder). Native capabilities are exposed through one bridge. The web code must keep
working unchanged in a normal browser when the bridge is absent.

## Detection
The shell injects (WKUserScript, at document start, main frame only):
```js
window.NotemakerNative = {
  isDesktop: true, platform: "macos", shellVersion: "x.y.z",
  request(method, params) { /* returns a Promise */ }
};
```
Web code checks `window.NotemakerNative?.isDesktop`.

## Transport
- JS → native: `window.webkit.messageHandlers.notemaker.postMessage({ id, method, params })`
  (`request()` assigns an increasing `id` and keeps the promise).
- native → JS reply: `window.__notemakerNativeReply(id, result, errorMessage)` via `evaluateJavaScript`
  (exactly one of result / errorMessage; errors reject the promise with `new Error(errorMessage)`).
- native → JS events: `window.dispatchEvent(new CustomEvent("notemaker-native", { detail: { type, ...data } }))`.
- All binary data crosses the bridge as base64 strings. Params/results are plain JSON.
- The shell only accepts messages from the main frame of its own bundled `file://` page.

## Methods
| method | params | result | notes |
|---|---|---|---|
| `storage.load` | – | `{ json: string \| null }` | contents of `~/Library/Application Support/Notemaker/data.json` (v2 document, also the file the previous SwiftUI app wrote) |
| `storage.save` | `{ json }` | `{ ok: true }` | atomic write; the web side debounces (~500 ms) and also saves on `beforeunload` |
| `blobs.put` | `{ id, iv, ct }` | `{ ok: true }` | vault file blobs → `…/Notemaker/vault-blobs/<id>.bin` (iv ‖ ct), id must be a UUID |
| `blobs.get` | `{ id }` | `{ iv, ct } \| null` | |
| `blobs.delete` | `{ id }` | `{ ok: true }` | |
| `se.available` | – | `{ available: bool, device: string }` | Secure Enclave present (Apple Silicon / T2) |
| `se.createSlot` | `{ slotId, label, vdk }` | Keyslot object (`type: "secure-enclave"`, per VAULT_FORMAT.md) | creates an SE P-256 KeyAgreement key with `[.privateKeyUsage, .userPresence]`, stores its handle (Keychain, or 0600 file fallback), wraps `vdk` per spec |
| `se.unwrapSlot` | `{ slot }` | `{ vdk }` | triggers Touch ID / Mac password; rejects with `"cancelled"` if the user cancels, `"not-this-device"` if the handle isn't on this Mac |
| `se.deleteSlot` | `{ slotId }` | `{ ok: true }` | deletes the stored handle |
| `notify.permission` | – | `{ status: "granted" \| "denied" \| "default" }` | |
| `notify.request` | – | `{ status }` | asks for permission |
| `notify.sync` | `{ items: [{ id, title, body, at: ISO, day: "YYYY-MM-DD" }] }` | `{ scheduled: n }` | replaces ALL pending Notemaker notifications with these (web computes reminders for the next 14 days, max 60). Fire even when the app is closed. Clicking one sends event `openDay {day}` |
| `notify.show` | `{ title, body }` | `{ ok: true }` | immediate (focus timer end, etc.) |
| `files.save` | `{ suggestedName, mime, base64 }` | `{ saved: bool, path? }` | NSSavePanel |
| `clipboard.write` | `{ text, clearAfterSeconds? }` | `{ ok: true }` | NSPasteboard; if `clearAfterSeconds`, clear only if `changeCount` is unchanged |
| `app.setBadge` | `{ count }` | `{ ok: true }` | Dock badge (0 = none) |
| `app.setFocusTimer` | `{ label: string \| null, phase?: "focus" \| "break" }` | `{ ok: true }` | menu-bar status item while a focus timer runs; null hides it. Clicking the item activates the window and sends event `menu {command: "focus.toggle"}` |
| `app.openExternal` | `{ url }` | `{ ok: true }` | http(s)/mailto only, opens default browser |

`<input type="file">` works natively (the shell implements the WKUIDelegate open panel, multiple selection).
Plain links to http(s) URLs open in the default browser, never inside the shell.

## Events (native → web)
| type | data | when |
|---|---|---|
| `lock` | `{ reason: "sleep" \| "screen-lock" \| "quit" }` | the vault must lock immediately |
| `openDay` | `{ day }` | a reminder notification was clicked |
| `menu` | `{ command }` | native menu / shortcut: `newTask`, `palette`, `search`, `today`, `prevDay`, `nextDay`, `view:<name>` (`day`, `calendar`, `planner`, `board`, `habits`, `insights`, `vault`, `settings`), `export`, `import`, `transfer` (File → Move to a New Mac…), `restore` (File → Restore from Another Device…), `review`, `focus.toggle`, `lockVault`, `undo`, `redo` |
| `beforeQuit` | – | flush pending saves (the shell waits up to 1 s for a `storage.save`) |
| `openTransfer` | `{ fileName, base64 }` | the user double-clicked / opened a `.notemaker` transfer file (or dropped it on the Dock icon); the web UI starts the Restore flow with it (max 1 GB) |

## Web-side behaviour in the shell
- Storage uses `storage.load/save` instead of localStorage (first launch: if `storage.load` returns null
  but localStorage has data, migrate it). Vault blobs use `blobs.*` instead of IndexedDB.
- Vault hardware slots use `se.*` (type `secure-enclave`) instead of passkeys; recovery keys work the same.
  A vault created in the browser (passkey slot) opens in the shell via its recovery key, then
  "Add this Mac" creates an SE slot — and vice versa.
- Reminders use `notify.sync` (so they fire when the app is closed) instead of the in-page checker.
- Exports/downloads use `files.save`; copying secrets uses `clipboard.write` with `clearAfterSeconds: 30`.
- The service worker is not registered (file://). No external network access is needed.

## Transfer files (v1.1 of this bridge)
The app registers the `.notemaker` document type (UTI `com.mth.notemaker.transfer`, conforms to `public.json`,
MIME `application/vnd.notemaker.transfer+json`, role Viewer, icon = app icon). Opening one sends `openTransfer`
(queued until the page is ready). `files.save` is used to write transfer files (suggested name
`Notemaker transfer YYYY-MM-DD.notemaker`).

## v1.2 additions (macOS)
| method | params | result | notes |
|---|---|---|---|
| `se.capabilities` | – | `{ touchID: bool, enrolled: bool }` | `enrolled` = Touch ID usable right now (lid closed / no fingers → false) |
| `se.createSlot` | + `biometryOnly?: bool` (default false) | Keyslot + `policy` | `policy`: `"user-presence"` (Touch ID or Mac password) or `"biometry-current-set"` (Touch ID only) |
| `clipboard.write` | + `concealed?: bool` | `{ ok: true }` | current-host-only (no Universal Clipboard) + `org.nspasteboard.ConcealedType`/`TransientType` markers |
| `app.vaultState` | `{ unlocked: bool, autoLockMinutes?: 1…1440 }` | `{ ok: true }` | starts/stops the native system-idle check; call on unlock, lock and auto-lock setting changes |

Events: `windowHidden { reason: "minimized" | "app-hidden" | "inactive" | "closed" }` (`inactive` = app in background > 30 s),
`windowShown`, `lock { reason: "idle-system" }` (system idle ≥ autoLockMinutes while unlocked). The page decides whether
`windowHidden` locks the vault (setting `vaultLockOnHide`).

Error codes for `se.*`: `biometry-unavailable` (no Touch ID / nothing enrolled), `biometry-changed` (fingers added/removed →
key permanently invalid → use the recovery key, then create a new slot), `biometry-lockout`, plus `cancelled`, `not-this-device`.
Switching an existing vault's policy: `se.createSlot({ biometryOnly })` then `se.deleteSlot(old)`.

Integrity: at launch the shell verifies `Resources/web-manifest.json` (SHA-256 of every bundled web file, itself pinned by a
hash compiled into the binary) and refuses to load a modified UI (`--skip-integrity` for development only).
