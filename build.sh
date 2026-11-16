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
#   ./build.sh            release build, universal (arm64 + x86_64)
#   ./build.sh --native-only   only this Mac's architecture (faster dev builds)
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

OPT="-O"; FORCE_SWIFTC=1; ARCHS="arm64 x86_64"
for a in "$@"; do
  case "$a" in
    --debug) OPT="-Onone" ;;
    --swiftc) FORCE_SWIFTC=1 ;;
    --xcode) FORCE_SWIFTC=0 ;;
    --native-only) ARCHS="$(uname -m)" ;;
  esac
done

echo "Building $APP_NAME $VERSION ($ARCHS)…"
rm -rf "$APP"
mkdir -p "$OUT_DIR"
RES="$APP/Contents/Resources"

has_xcode() { xcodebuild -version >/dev/null 2>&1; }

if [ $FORCE_SWIFTC -eq 0 ] && has_xcode; then
  echo "→ Full Xcode found: using xcodebuild"
  # The project's script phases bundle the web UI and generate BuildIntegrity.swift (tools/bundle-web.sh).
  xcodebuild -project "$APP_NAME.xcodeproj" -target "$APP_NAME" -configuration Release ARCHS="$ARCHS" ONLY_ACTIVE_ARCH=NO \
             SYMROOT="$ROOT/build/xcode" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="-" DEVELOPMENT_TEAM="" build
  cp -R "$ROOT/build/xcode/Release/$APP_NAME.app" "$APP"
else
  echo "→ Using swiftc (Command Line Tools)"
  source "$ROOT/tools/swiftc-env.sh"
  mkdir -p "$APP/Contents/MacOS" "$RES"

  # 1. Web UI + integrity manifest first: its hash is compiled into the binary.
  GEN="$ROOT/build/generated/BuildIntegrity.swift"
  "$ROOT/tools/bundle-web.sh" "$RES" "$GEN"

  # 2. Compile each architecture, then merge into a universal binary.
  SOURCES=$(find "$ROOT/Notemaker/Core" "$ROOT/Notemaker/Shell" -name '*.swift' | sort)
  SLICES=()
  for arch in $ARCHS; do
    echo "→ Compiling $arch"
    mkdir -p "$ROOT/build/arch/$arch"
    # shellcheck disable=SC2086
    NM_TARGET="$arch-apple-macos14" nm_swiftc -parse-as-library $OPT -module-name "$APP_NAME" $SOURCES "$GEN" \
      -o "$ROOT/build/arch/$arch/$APP_NAME"
    SLICES+=("$ROOT/build/arch/$arch/$APP_NAME")
  done
  if [ ${#SLICES[@]} -gt 1 ]; then
    lipo -create "${SLICES[@]}" -output "$APP/Contents/MacOS/$APP_NAME"
  else
    cp "${SLICES[0]}" "$APP/Contents/MacOS/$APP_NAME"
  fi
  echo "→ $(lipo -info "$APP/Contents/MacOS/$APP_NAME" | sed 's/.*: //')"

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
</dict>
</plist>
PLIST
  # URL scheme + .notemaker document type / UTI come from Notemaker/Info.plist (also used by Xcode).
  /usr/libexec/PlistBuddy -c "Merge $ROOT/Notemaker/Info.plist" "$APP/Contents/Info.plist" >/dev/null
  plutil -lint "$APP/Contents/Info.plist" >/dev/null
  # URL scheme + .notemaker document type / UTI come from Notemaker/Info.plist (also used by Xcode).
  /usr/libexec/PlistBuddy -c "Merge $ROOT/Notemaker/Info.plist" "$APP/Contents/Info.plist" >/dev/null
  plutil -lint "$APP/Contents/Info.plist" >/dev/null
  printf 'APPL????' > "$APP/Contents/PkgInfo"
fi

# Outside web/ (not covered by the manifest): the self-test page and the icon.
mkdir -p "$RES/selftest"
cp "$ROOT/Notemaker/Shell/selftest/selftest.html" "$RES/selftest/"
cp "$ROOT/assets/Notemaker.icns" "$RES/Notemaker.icns"

echo "→ Ad-hoc signing"
codesign --force --deep -s - "$APP"
codesign --verify --deep "$APP" && echo "✅ Built $APP"
