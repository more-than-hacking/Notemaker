#!/bin/bash
# Build Notemaker.app (via build.sh — works with full Xcode or just the Command Line Tools)
# and package it into Notemaker.dmg with an Applications shortcut.
set -e
cd "$(dirname "$0")"
APP_NAME="Notemaker"
APP_PATH="build_output/${APP_NAME}.app"
DMG_NAME="${APP_NAME}.dmg"
STAGE="build/dmg"

./build.sh "$@"
[ -d "$APP_PATH" ] || { echo "❌ Build failed: $APP_PATH not found"; exit 1; }

echo "📦 Creating ${DMG_NAME}…"
rm -rf "$STAGE" "$DMG_NAME"
mkdir -p "$STAGE"
cp -R "$APP_PATH" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/README.txt" <<TXT
Welcome to ${APP_NAME} 2!

Install: drag ${APP_NAME}.app onto the Applications folder, then open it.

The app is ad-hoc signed (not notarized). On first launch macOS may block it:
right-click the app → Open → Open, or allow it in System Settings → Privacy & Security.

Your data lives in ~/Library/Application Support/Notemaker/data.json.
TXT
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG_NAME"
rm -rf "$STAGE"
echo "✅ DMG created: $(pwd)/$DMG_NAME"
