#!/bin/bash

# Build Notemaker Mac App and Create DMG Installer
# This script builds the app and creates a DMG file for easy installation

set -e

APP_NAME="Notemaker"
BUILD_DIR="./build"
DMG_NAME="${APP_NAME}.dmg"
APP_PATH="${BUILD_DIR}/Build/Products/Release/${APP_NAME}.app"
DMG_DIR="${BUILD_DIR}/DMG"
VOLUME_NAME="${APP_NAME}"

echo "🚀 Building ${APP_NAME} Mac App..."
echo ""

# Check if Xcode is installed
if ! command -v xcodebuild &> /dev/null || ! xcodebuild -version &> /dev/null; then
    echo "❌ Error: Xcode is required to build this app."
    echo ""
    echo "Please install Xcode from the App Store:"
    echo "  1. Open App Store"
    echo "  2. Search for 'Xcode'"
    echo "  3. Install it (it's free but large ~15GB)"
    echo "  4. Run this script again"
    exit 1
fi

# Clean previous builds
echo "🧹 Cleaning previous builds..."
rm -rf "${BUILD_DIR}"
rm -f "${DMG_NAME}"

# Build the app
echo "🔨 Building app..."
xcodebuild -project "${APP_NAME}.xcodeproj" \
           -scheme "${APP_NAME}" \
           -configuration Release \
           -derivedDataPath "${BUILD_DIR}" \
           clean build \
           CODE_SIGN_IDENTITY="" \
           CODE_SIGNING_REQUIRED=NO \
           CODE_SIGNING_ALLOWED=NO

if [ ! -d "${APP_PATH}" ]; then
    echo "❌ Build failed: App not found at ${APP_PATH}"
    exit 1
fi

echo "✅ Build successful!"
echo ""

# Create DMG
echo "📦 Creating DMG installer..."

# Create DMG directory
mkdir -p "${DMG_DIR}"

# Copy app to DMG directory
cp -R "${APP_PATH}" "${DMG_DIR}/"

# Create Applications symlink
ln -s /Applications "${DMG_DIR}/Applications"

# Create README
cat > "${DMG_DIR}/README.txt" << EOF
Welcome to ${APP_NAME}!

To install:
1. Drag ${APP_NAME}.app to the Applications folder
2. Open Applications folder
3. Double-click ${APP_NAME}.app to launch

Enjoy your daily notes and tasks management!
EOF

# Remove existing DMG if it exists
rm -f "${DMG_NAME}"

# Create DMG
hdiutil create -volname "${VOLUME_NAME}" \
               -srcfolder "${DMG_DIR}" \
               -ov \
               -format UDZO \
               "${DMG_NAME}"

# Clean up DMG directory
rm -rf "${DMG_DIR}"

echo ""
echo "✅ DMG created successfully!"
echo ""
echo "📦 Installer: ${DMG_NAME}"
echo "📱 App location: ${APP_PATH}"
echo ""
echo "To install:"
echo "  1. Double-click ${DMG_NAME}"
echo "  2. Drag ${APP_NAME}.app to Applications folder"
echo "  3. Open Applications and launch ${APP_NAME}"
echo ""

