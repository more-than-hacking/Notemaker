#!/bin/bash

# Build script for Notemaker Mac App
# This script helps build the app from the command line

echo "Building Notemaker Mac App..."
echo ""

# Check if Xcode is installed
if ! command -v xcodebuild &> /dev/null; then
    echo "Error: xcodebuild not found. Please install Xcode from the App Store."
    exit 1
fi

# Build the project
xcodebuild -project Notemaker.xcodeproj \
           -scheme Notemaker \
           -configuration Release \
           -derivedDataPath ./build \
           clean build

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Build successful!"
    echo "The app is located at: ./build/Build/Products/Release/Notemaker.app"
    echo ""
    echo "To install:"
    echo "  cp -R ./build/Build/Products/Release/Notemaker.app /Applications/"
else
    echo ""
    echo "❌ Build failed. Please check the errors above."
    exit 1
fi

