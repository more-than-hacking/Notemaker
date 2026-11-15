#!/bin/bash
# Build Notemaker.app for macOS.
#
#  • If full Xcode is installed, builds Notemaker.xcodeproj with xcodebuild.
#  • Otherwise compiles Notemaker/Core + Notemaker/Shell directly with swiftc from the Command Line Tools
#    (automatically working around the CLT "redefinition of module 'SwiftBridging'" bug).
#
# The app is a native AppKit + WKWebView shell around the web UI (docs/DESKTOP_BRIDGE.md); the web files
# (index.html, app.js, styles.css, js/, web-icons/, manifest.webmanifest) are copied to Contents/Resources/web.
#
# Output: build_output/Notemaker.app (ad-hoc signed)
#   ./build.sh            release build
#   ./build.sh --debug    unoptimised build (faster to compile)
#   ./build.sh --swiftc   force the swiftc path even if Xcode is installed
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"
APP_NAME="Notemaker"
OUT_DIR="$ROOT/build_output"
APP="$OUT_DIR/$APP_NAME.app"
VERSION="2.1.0"
BUILD_NUMBER="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"

OPT="-O"; FORCE_SWIFTC=0
for a in "$@"; do
  case "$a" in
    --debug) OPT="-Onone" ;;
    --swiftc) FORCE_SWIFTC=1 ;;
  esac
done

echo "Building $APP_NAME $VERSION…"
rm -rf "$APP"
mkdir -p "$OUT_DIR"

has_xcode() { xcodebuild -version >/dev/null 2>&1; }

if [ $FORCE_SWIFTC -eq 0 ] && has_xcode; then
  echo "→ Full Xcode found: using xcodebuild"
  xcodebuild -project "$APP_NAME.xcodeproj" -target "$APP_NAME" -configuration Release \
             SYMROOT="$ROOT/build/xcode" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="-" DEVELOPMENT_TEAM="" build
  cp -R "$ROOT/build/xcode/Release/$APP_NAME.app" "$APP"
  # The asset catalog provides the icon; also ship the .icns used by the swiftc build.
  cp "$ROOT/assets/Notemaker.icns" "$APP/Contents/Resources/Notemaker.icns"
else
  echo "→ Using swiftc (Command Line Tools)"
  source "$ROOT/tools/swiftc-env.sh"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  SOURCES=$(find "$ROOT/Notemaker/Core" "$ROOT/Notemaker/Shell" -name '*.swift' | sort)
  # shellcheck disable=SC2086
  nm_swiftc -parse-as-library $OPT -module-name "$APP_NAME" $SOURCES -o "$APP/Contents/MacOS/$APP_NAME"

  cp "$ROOT/assets/Notemaker.icns" "$APP/Contents/Resources/Notemaker.icns"
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>com.mth.notemaker</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>CFBundleIconFile</key><string>Notemaker</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSHumanReadableCopyright</key><string>Copyright © 2025–2026 Notemaker. All rights reserved.</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.mth.notemaker.day</string>
      <key>CFBundleURLSchemes</key><array><string>notemaker</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST
  printf 'APPL????' > "$APP/Contents/PkgInfo"
fi

echo "→ Bundling web UI"
RES="$APP/Contents/Resources"
rm -rf "$RES/web" "$RES/selftest"
mkdir -p "$RES/web" "$RES/selftest"
for f in index.html app.js styles.css manifest.webmanifest; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$RES/web/"
done
for d in js web-icons; do
  [ -d "$ROOT/$d" ] && cp -R "$ROOT/$d" "$RES/web/"
done
[ -f "$RES/web/index.html" ] || { echo "❌ index.html missing"; exit 1; }
cp "$ROOT/Notemaker/Shell/selftest/selftest.html" "$RES/selftest/"
cp "$ROOT/assets/Notemaker.icns" "$RES/Notemaker.icns"

echo "→ Ad-hoc signing"
codesign --force --deep -s - "$APP"
codesign --verify --deep "$APP" && echo "✅ Built $APP"
