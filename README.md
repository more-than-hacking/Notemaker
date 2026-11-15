# Notemaker - Web App

A beautiful, user-friendly web app for managing your daily notes and tasks with automatic date organization.

## Features

- ✅ **Daily Task Management**: Add, complete, and manage tasks for any date
- 📝 **Daily Notes**: Take notes for each day with automatic organization
- 🔄 **One-Click Forward**: Forward incomplete tasks to the next day with a single click
- 📅 **Date-Based Organization**: Automatically organize tasks and notes by date
- 🔍 **Task Filtering**: Filter tasks by All, Completed, or Incomplete
- 📊 **Daily Stats**: View task completion statistics for each day
- 💾 **Auto-Save**: All data is automatically saved in your browser (localStorage)
- 📤 **Export Data**: Export all your tasks and notes as a JSON backup file
- 📥 **Import Data**: Import your backup file to restore data on any device
- 📱 **Responsive**: Works on desktop, tablet, and mobile devices

## How to Use

### Option 1: Open Directly in Browser

1. Simply open `index.html` in your web browser
   - Double-click the file, or
   - Right-click → Open With → Your Browser

2. Start using it immediately!

### Option 2: Use a Local Server (Recommended)

For better performance and to avoid CORS issues:

```bash
# Using Python 3
python3 -m http.server 8000

# Using Python 2
python -m SimpleHTTPServer 8000

# Using Node.js (if you have http-server installed)
npx http-server
```

Then open: `http://localhost:8000`

## Usage Guide

### Managing Tasks

1. **Select a Date**: Use the date picker or quick navigation buttons
2. **Add Tasks**: Type in the task field and press Enter or click "Add Task"
3. **Complete Tasks**: Click on a task to mark it complete/incomplete
4. **Delete Tasks**: Hover over a task and click "Delete"
5. **Filter Tasks**: Use the filter dropdown to show All, Completed, or Incomplete tasks

### Forwarding Tasks

1. When you have incomplete tasks, a "Forward Incomplete Tasks to Tomorrow" button appears
2. Click it to move all incomplete tasks to the next day
3. Confirm the action in the dialog

### Taking Notes

1. Switch to the "Notes" tab
2. Start typing - notes are automatically saved
3. Each date has its own note that persists

### Navigation

- **Previous/Next**: Navigate between days
- **Today**: Jump to today's date
- **Date Picker**: Select any specific date

### Export & Import Data

**Export Data:**
1. Click "📤 Export Data" button in the sidebar
2. A JSON file will be downloaded with all your tasks and notes
3. File name: `notemaker_backup_[date].json`

**Import Data:**
1. Click "📥 Import Data" button in the sidebar
2. Select your backup JSON file
3. Review the import preview (shows current data, imported data, and how many new items will be added)
4. Confirm to merge the imported data with your existing data

**Merge Behavior:**
- **Tasks**: New tasks are added, existing tasks with the same ID are kept (no duplicates)
- **Notes**: Notes for the same date are merged together with a separator, new dates are added
- **No Data Loss**: Your existing data is always preserved, only new items are added

**Use Case:**
- Export your data from one device
- Transfer the JSON file to another device (via email, cloud storage, USB, etc.)
- Import the file on the new device to restore all your tasks and notes

## Data Storage

All data is stored locally in your browser using localStorage. Your tasks and notes are:
- ✅ Private and never leave your device
- ✅ Automatically saved as you type
- ✅ Persisted between browser sessions

## Browser Compatibility

Works on all modern browsers:
- Chrome/Edge (recommended)
- Firefox
- Safari
- Opera

## No Installation Required!

This is a pure web app - no installation, no Xcode, no build process needed. Just open and use!
