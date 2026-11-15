# Installing Notemaker for macOS

Requires macOS 14 (Sonoma) or later. **Full Xcode is not required** — the Command Line Tools are enough
(`xcode-select --install`).

## Build and install

```bash
./build_and_create_dmg.sh      # builds build_output/Notemaker.app and Notemaker.dmg
```

Then open `Notemaker.dmg` and drag **Notemaker.app** onto **Applications**.
Or skip the DMG: `./build.sh && cp -R build_output/Notemaker.app /Applications/`.

The app is ad-hoc signed, not notarized. If macOS refuses to open it the first time, right-click the
app → **Open** → **Open** (or allow it under System Settings → Privacy & Security).

## Your data

- Stored in `~/Library/Application Support/Notemaker/data.json` (Notemaker data format v2, see `docs/DATA_FORMAT.md`).
- On first launch, data from Notemaker v1 for macOS (UserDefaults domain `com.notemaker.app`) is migrated
  automatically. The v1 data is left in place as a backup.
- **File → Export Backup** writes a v2 JSON file that the web app can import, and **File → Import Backup**
  accepts v2 backups and web v1 backups (merge or replace; undoable).
- Reminders and the focus timer use macOS notifications: allow them when asked, or in Settings → General.

## Troubleshooting

- *"redefinition of module 'SwiftBridging'"* — a known Command Line Tools issue. `build.sh` detects it and
  retries with a VFS overlay automatically; nothing to do.
- First build takes a few minutes (system modules are compiled into `build/module-cache`); later builds are fast.
- To start over: quit the app and move `~/Library/Application Support/Notemaker/data.json` away.
