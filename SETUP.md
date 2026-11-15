# Quick Setup Guide

## Option 1: Open in Xcode (Recommended)

1. **Open the project:**
   ```bash
   open Notemaker.xcodeproj
   ```
   
   Or double-click `Notemaker.xcodeproj` in Finder.

2. **Select your Mac as the build target:**
   - In Xcode, click on "Notemaker" in the top toolbar
   - Select "My Mac" as the destination

3. **Build and Run:**
   - Press `⌘R` (Command + R) or click the Play button
   - The app will build and launch automatically

4. **Create an Installable App:**
   - Go to **Product → Archive**
   - Once archived, click **"Distribute App"**
   - Choose **"Copy App"** to create an installable .app bundle
   - Drag the app to your Applications folder

## Option 2: Build from Command Line

1. **Run the build script:**
   ```bash
   ./build.sh
   ```

2. **Install the app:**
   ```bash
   cp -R ./build/Build/Products/Release/Notemaker.app /Applications/
   ```

## Troubleshooting

### If Xcode shows project errors:

1. Close Xcode
2. Delete the `Notemaker.xcodeproj` folder
3. Open Xcode
4. Go to **File → New → Project**
5. Select **macOS → App**
6. Name it "Notemaker"
7. Choose a location (you can use the same folder)
8. Copy all the Swift files from the `Notemaker/` folder into the new project
9. Build and run

### Requirements

- macOS 13.0 or later
- Xcode 14.0 or later (available from the App Store)

## First Launch

When you first launch the app:
- It will open with today's date selected
- You can immediately start adding tasks and notes
- All data is automatically saved and persists between sessions

