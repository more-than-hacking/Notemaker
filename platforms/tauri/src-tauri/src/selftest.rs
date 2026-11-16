//! Bridge self-test (`--bridge-selftest` on desktop; on Android debug builds:
//! `adb shell am start -n com.mth.notemaker/.MainActivity --ez notemaker.selftest true`).
//! The page (`selftest/index.html`) calls every non-interactive bridge method; these hooks let it exercise
//! paths that normally need the OS (menu clicks, opening a .notemaker file, lock events, the clipboard).

use crate::validate::{BResult, BridgeError};
use crate::Shell;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, Runtime};

pub async fn trigger<R: Runtime>(app: &AppHandle<R>, action: &str, arg: &str) -> BResult<Value> {
    match action {
        // Fire the real menu item for a command (proves it exists in the native menu and is wired up).
        "menu" => {
            #[cfg(desktop)]
            {
                let id = format!("cmd:{arg}");
                if !crate::desktop::menu_has(app, &id) {
                    return Ok(json!({ "ok": false, "error": "no such menu item" }));
                }
                crate::desktop::on_menu(app, &id);
                Ok(json!({ "ok": true }))
            }
            #[cfg(mobile)]
            {
                let _ = arg;
                Ok(json!({ "ok": false, "skipped": "no menu on mobile" }))
            }
        }
        // Write a temporary .notemaker file and open it through the same path as a double-click / intent.
        "openTransfer" => {
            let dir = std::env::temp_dir().join(format!("notemaker-selftest-transfer-{}", std::process::id()));
            std::fs::create_dir_all(&dir)?;
            let path = dir.join("Selftest transfer.notemaker");
            std::fs::write(&path, arg.as_bytes())?;
            let (tx, rx) = std::sync::mpsc::channel();
            let cleanup = dir.clone();
            crate::open_transfer_file(
                app,
                path,
                Some(Box::new(move |ok| {
                    let _ = std::fs::remove_dir_all(&cleanup);
                    let _ = tx.send(ok);
                })),
            );
            let ok = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or(false))
                .await
                .unwrap_or(false);
            Ok(json!({ "ok": ok }))
        }
        // The same code path the OS listeners use (logind / WTS / power / Android resume).
        "lock" => {
            crate::lock_vault(app, if arg.is_empty() { "screen-lock" } else { "sleep" });
            Ok(json!({ "ok": true }))
        }
        "clipboardRead" => {
            #[cfg(desktop)]
            {
                use tauri_plugin_clipboard_manager::ClipboardExt;
                Ok(json!({ "ok": true, "text": app.clipboard().read_text().unwrap_or_default() }))
            }
            #[cfg(target_os = "android")]
            {
                let a = app.clone();
                let text = tauri::async_runtime::spawn_blocking(move || crate::hw::android::clipboard_read(&a)).await.unwrap_or_default();
                Ok(json!({ "ok": true, "text": text }))
            }
        }
        "storageFiles" => {
            let root = &app.state::<Shell>().selftest_storage.root;
            let mut names: Vec<String> = std::fs::read_dir(root)
                .map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
                .unwrap_or_default();
            names.sort();
            Ok(json!({ "ok": true, "files": names, "root": root.to_string_lossy() }))
        }
        "tray" => {
            #[cfg(desktop)]
            {
                Ok(json!({ "ok": app.tray_by_id(crate::desktop::TRAY_ID).is_some(), "focusLabel": crate::desktop::focus_label() }))
            }
            #[cfg(mobile)]
            Ok(json!({ "ok": true, "skipped": "no tray on mobile" }))
        }
        "vaultState" => {
            let shell = app.state::<Shell>();
            let (unlocked, minutes) = {
                let v = crate::lock_or_recover(&shell.vault);
                (v.unlocked, v.auto_lock_minutes)
            };
            Ok(json!({ "ok": true, "unlocked": unlocked, "autoLockMinutes": minutes }))
        }
        _ => Err(BridgeError::new("unknown self-test action")),
    }
}

/// Print the results, then exit 0 (all passed) / 1 (desktop). Android: logcat tag "NotemakerSelftest".
pub fn done<R: Runtime>(app: &AppHandle<R>, p: &Map<String, Value>) {
    let passed = p.get("passed").and_then(Value::as_i64).unwrap_or(0);
    let failed = p.get("failed").and_then(Value::as_i64).unwrap_or(1);
    let lines: Vec<String> = p
        .get("lines")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|l| l.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let summary = format!("SELFTEST: {passed} passed, {failed} failed — {}", if failed == 0 { "PASS" } else { "FAIL" });
    let _ = std::fs::remove_dir_all(&app.state::<Shell>().selftest_storage.root);
    #[cfg(target_os = "android")]
    {
        let a = app.clone();
        std::thread::spawn(move || {
            for l in &lines {
                crate::hw::android::log(&a, l);
            }
            crate::hw::android::log(&a, &summary);
        });
    }
    #[cfg(desktop)]
    {
        for l in &lines {
            println!("{l}");
        }
        println!("{summary}");
        // CI (Windows GUI apps have no console): also write the report to $NOTEMAKER_SELFTEST_OUT
        if let Ok(path) = std::env::var("NOTEMAKER_SELFTEST_OUT") {
            let _ = std::fs::write(path, format!("{}\n{summary}\n", lines.join("\n")));
        }
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            // with --bridge-selftest, exit with the result (the self-test page is also reachable in debug builds)
            if app.state::<Shell>().selftest_flag {
                std::process::exit(if failed == 0 { 0 } else { 1 });
            }
        });
    }
}
