# Notemaker for macOS — developer setup

## Layout

```
Notemaker/
  Core/        pure logic, Foundation + CryptoKit/CommonCrypto only (no SwiftUI/AppKit) — unit tested
    Models.swift          v2 data model with explicit Codable (exact JSON field names, unknown keys preserved)
    DayMath.swift         "YYYY-MM-DD" / ISO / "HH:MM" helpers
    Logic.swift           occurrence rule, rollover/snooze, streaks, stats, search, wiki links, templates, Markdown export
    QuickAdd.swift        quick-add grammar parser
    NoteCrypto.swift      PBKDF2-SHA256 + AES-GCM-256 (WebCrypto compatible), lockHash
    Migration.swift       macOS/web v1 → v2, import parsing/merge, data.json load/save
    MarkdownBlocks.swift  block-level Markdown parser for the preview
  App/         AppStore (state, undo, persistence), Reminders (UserNotifications), FocusTimer, Theme
  Views/       SwiftUI views (Day, Calendar, Planner, Board, Habits, Insights, Search, palette, sheets, Settings)
  NotemakerApp.swift      @main, menus/shortcuts, Settings scene, menu bar timer
Tests-mac/     main.swift + run.sh — CLI test runner for Core (no XCTest needed)
tools/         swiftc-env.sh — shared swiftc setup (SDK, module cache, SwiftBridging workaround)
```

## Build

```bash
./build.sh            # release → build_output/Notemaker.app (ad-hoc signed)
./build.sh --debug    # faster, unoptimised
```

`build.sh` uses `xcodebuild` when full Xcode is installed, otherwise `swiftc` from the Command Line Tools.
`Notemaker.xcodeproj` uses a file-system-synchronized group (Xcode 16+), so new files under `Notemaker/`
are picked up automatically.

## Tests

```bash
Tests-mac/run.sh                          # all Core tests
Tests-mac/run.sh --import path/to.json    # print entity counts of any v2 (or web v1) backup
Tests-mac/run.sh --migrate-v1-defaults    # dry run of the macOS v1 migration (read-only, counts only)
```

The tests cover the quick-add vectors from `docs/DATA_FORMAT.md`, the occurrence rule, rollover, streaks,
v1 migration, decryption of `docs/crypto-test-vector.json`, v2 round trips, and (when present) the web
app's `tests-web/fixtures/*.json`.
