<p align="center"><img src="assets/icon-1024.png" width="112" alt="Notemaker icon"></p>

<h1 align="center">Notemaker</h1>

<p align="center">Daily tasks, notes, habits and a hardware-protected vault —<br>
one app that runs in your browser and as a native Mac app.</p>

<p align="center">
  <img src="docs/screenshots/detail-login-dark-1280.png" width="760" alt="Notemaker vault with a saved login">
</p>

## Features

**Plan your day**
- Tasks with subtasks, priorities (`!high`), colored `#tags`, notes and drag-to-reorder
- **Quick add** in plain language: `Call Raj tomorrow 3pm #work !high`, `Gym every mon ~2`, `Pay rent every month`
- Recurring tasks (daily, weekdays, weekly, monthly, every N), reminders, smart rollover of unfinished tasks, snooze
- Views: **Day**, **Calendar** (completion heatmap), **Planner** (drag tasks onto an hourly timeline),
  **Board** (To do / Doing / Done), **Habits** (streaks), **Insights** (365-day heatmap, streaks, focus time, top tags)
- **Focus timer** (Pomodoro) per task, **Daily review**, **⌘K command palette**, global search, keyboard shortcuts

**Write**
- Markdown notes per day with toolbar, live preview, tables, `[[YYYY-MM-DD]]` links with backlinks, templates
- Private notes with a passcode (AES-256-GCM)
- Export a day or week as Markdown; full JSON backup / import (the web and Mac apps share one format)

**Vault**: passwords, cards & IDs, secure notes and files, encrypted with a key held in **hardware**
- Mac: the **Secure Enclave**, unlocked with Touch ID · Browser: a **passkey** (Touch ID or a security key)
- Optional printable **recovery key** to move the vault between devices or recover it
- Password generator, strength meter, copy with clipboard auto-clear, auto-lock

| Setup | Recovery key | Locked | Phone width |
|---|---|---|---|
| <img src="docs/screenshots/setup-dark-1280.png" width="220"> | <img src="docs/screenshots/recovery-key-light-1280.png" width="220"> | <img src="docs/screenshots/unlock-dark-1280.png" width="220"> | <img src="docs/screenshots/list-light-390.png" width="110"> |

---

## Install

### Option A: macOS app (recommended on a Mac)

Requires **macOS 14 (Sonoma) or later** and Apple's **Command Line Tools** (full Xcode is *not* needed).

```bash
# 1. Command Line Tools (skip if `xcode-select -p` already prints a path)
xcode-select --install

# 2. Get the code
git clone https://github.com/more-than-hacking/Notemaker.git
cd Notemaker

# 3. Build the app (first build takes a few minutes; later builds ~30 s)
./build.sh

# 4. Install
cp -R build_output/Notemaker.app /Applications/
open /Applications/Notemaker.app
```

Prefer a disk image? `./build_and_create_dmg.sh` creates `Notemaker.dmg`. Open it and drag **Notemaker** to **Applications**.

**First launch**
1. The app is self-signed (not notarized). If macOS says it can't be opened: right-click **Notemaker** → **Open** → **Open**
   (or System Settings → Privacy & Security → **Open Anyway**). Only needed once.
2. Allow **notifications** when asked (Settings → Reminders & notifications) so reminders arrive even when the app is closed.
3. The first time you unlock the vault after installing or rebuilding, macOS may ask to use the keychain.
   Click **Always Allow**.

The app builds for your Mac's architecture (Apple Silicon or Intel). Vault hardware keys need a Mac with a
Secure Enclave (Apple Silicon or a T2 chip); other Macs can still use the vault with a recovery key.

### Option B: in the browser

**Quick look**: open `index.html` directly (double-click). Everything works except the vault's passkeys,
which browsers only allow on a real web address.

**Full version (vault + installable app)**: serve the folder locally:

```bash
cd Notemaker
python3 -m http.server 8000
```

Open **http://localhost:8000** in **Safari 18+** or **Chrome 116+**. To install it as an app:
Chrome → address bar **Install** icon · Safari → **File → Add to Dock**.

The vault's passkey must support the PRF extension: iCloud Keychain passkeys (Touch ID), Google Password Manager,
or a FIDO2 security key. If yours doesn't, the app tells you, and you can still open a vault with its recovery key.

---

## Where your data lives

| | Location |
|---|---|
| Mac app | `~/Library/Application Support/Notemaker/data.json` (+ `vault-blobs/` for encrypted vault files) |
| Vault hardware key (Mac) | Inside the Secure Enclave; only an encrypted handle is kept in your login Keychain |
| Browser | The browser's local storage for this site (+ IndexedDB for encrypted vault files) |

Nothing is sent to any server. **Back up** with **Export backup** (⇧⌘E on Mac, Settings → Data in the browser);
the file opens in either app. Data from Notemaker v1 (web or Mac) is migrated automatically on first launch.

## The vault and your security, honestly

- Items, titles and files are encrypted with AES-256-GCM. The key that unlocks them is wrapped by a hardware key
  (Secure Enclave or passkey) and, if you chose it, by your recovery key. **No key is stored in any file, backup or
  server**, so a copied `data.json`, Time Machine backup or export is useless on its own.
- On a Mac, the Secure Enclave key opens with **Touch ID or your Mac login password**, so use a strong Mac password.
- **Store the recovery key offline** (printed, or in another password manager), not as a file next to the vault.
  If you choose *hardware only* and lose the device, the vault cannot be recovered.
- The vault auto-locks after 5 minutes idle (configurable), on sleep and on screen lock. While it is unlocked,
  malware running on your Mac could read it, as with any password manager.
- This is a personal project **without an independent security audit**. The cryptography is tested against shared
  test vectors (`docs/`), but for very high-value secrets prefer an audited password manager.

Formats are documented in [`docs/DATA_FORMAT.md`](docs/DATA_FORMAT.md), [`docs/VAULT_FORMAT.md`](docs/VAULT_FORMAT.md)
and [`docs/DESKTOP_BRIDGE.md`](docs/DESKTOP_BRIDGE.md).

## Keyboard shortcuts

| | Mac app | Browser |
|---|---|---|
| New task | ⌘N | `n` |
| Command palette | ⌘K | Ctrl/⌘ K |
| Search | ⌘F | `/` |
| Today / previous / next day | ⌘T · ⌘[ · ⌘] | `t` · ← · → |
| Switch view | ⌘1 … ⌘8 | `1` … `8` |
| Lock vault | ⇧⌘L | palette → *Lock vault* |
| All shortcuts | Help menu | `?` |

## Troubleshooting

| Problem | Fix |
|---|---|
| `redefinition of module 'SwiftBridging'` while building | Known Command Line Tools issue. `build.sh` detects it and rebuilds with a workaround automatically. |
| *"Notemaker can't be opened"* | Right-click → **Open** (self-signed app), once. |
| Reminders don't appear | Allow notifications for Notemaker in System Settings → Notifications. |
| Vault says passkeys aren't available (browser) | Use `http://localhost:8000` (not `file://`) in Safari 18+ / Chrome 116+. |
| Vault: "This vault was created on another device" | Unlock with the recovery key, then choose **Add this Mac / this browser**. |
| Start over (Mac) | Quit Notemaker and move `~/Library/Application Support/Notemaker/data.json` away. |

## Development

```bash
node --test tests-web/                    # web tests (Node 20+)
./Tests-mac/run.sh                        # macOS core + crypto tests (no Xcode needed)
./build.sh && build_output/Notemaker.app/Contents/MacOS/Notemaker --bridge-selftest   # native bridge self-test
```

The UI is plain HTML/CSS/JS (`index.html`, `styles.css`, `app.js`, `js/`) with no build step and no dependencies.
The Mac app (`Notemaker/Shell/`) is an AppKit window with a WKWebView that loads the same files and adds native
features through a small bridge. See [`SETUP.md`](SETUP.md) for the source layout and debugging flags, and
[`INSTALL_INSTRUCTIONS.md`](INSTALL_INSTRUCTIONS.md) for more install details.

## License

[MIT](LICENSE) © 2026 More-Than-Hacking (MTH). The app icon is original artwork included under the same license.
