# Installation Instructions

## Quick Install (Once Xcode is Installed)

### Step 1: Install Xcode (Required)

You need Xcode to build the app. It's free from the App Store:

1. Open **App Store** on your Mac
2. Search for **"Xcode"**
3. Click **"Get"** or **"Install"** (it's free but large ~15GB)
4. Wait for installation to complete
5. Open Xcode once and accept the license agreement

### Step 2: Build and Create DMG

Once Xcode is installed, run:

```bash
./build_and_create_dmg.sh
```

This will:
- Build the app
- Create a DMG installer file (`Notemaker.dmg`)

### Step 3: Install the App

1. Double-click `Notemaker.dmg` to open it
2. Drag `Notemaker.app` to the Applications folder
3. Open Applications folder
4. Double-click `Notemaker.app` to launch

## Alternative: Build in Xcode

If you prefer to build manually:

1. Open the project:
   ```bash
   open Notemaker.xcodeproj
   ```

2. In Xcode:
   - Select **"My Mac"** as the build target
   - Press **⌘R** (Command + R) to build and run

3. To create an installable app:
   - Go to **Product → Archive**
   - Click **"Distribute App"**
   - Choose **"Copy App"**
   - Drag the `.app` to Applications

## Troubleshooting

### "Xcode is required" Error

- Make sure Xcode is fully installed from the App Store
- Open Xcode once and accept the license
- Run: `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`

### Build Errors

If you see build errors:
1. Close Xcode
2. Delete `Notemaker.xcodeproj` folder
3. Create a new Xcode project (macOS → App)
4. Copy all Swift files from `Notemaker/` folder into the new project
5. Build again

## System Requirements

- macOS 13.0 (Ventura) or later
- Xcode 14.0 or later
- At least 2GB free disk space

