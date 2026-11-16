//! The one Tauri command: `bridge(method, params)` → docs/DESKTOP_BRIDGE.md + docs/PLATFORMS.md.
//! Every parameter is validated like `Notemaker/Core/BridgeValidation.swift`; errors reject the page's promise
//! with a plain message (hardware-key errors use the contract's codes: "cancelled", "not-this-device", …).

use crate::validate::{self as v, BResult, BridgeError};
use crate::{hw, lock_or_recover, notify, storage::Storage, vaultcrypto, Shell, PLATFORM};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, Runtime, Webview};

pub const MAX_BLOB: usize = 25 * 1024 * 1024; // docs/VAULT_FORMAT.md
pub const MAX_DOCUMENT: usize = 200 * 1024 * 1024;
pub const MAX_SAVE_BYTES: usize = 1 << 30; // files.save (transfer files up to 1 GB)

#[tauri::command]
pub async fn bridge<R: Runtime>(app: AppHandle<R>, webview: Webview<R>, method: String, params: Option<Value>) -> Result<Value, String> {
    // Only the main window's bundled page may use the bridge (Tauri already refuses IPC from remote origins).
    let url = webview.url().map_err(|e| e.to_string())?;
    if webview.label() != "main" || !crate::is_app_url(&url) {
        return Err("bridge: untrusted origin".into());
    }
    let selftest_page = url.path().starts_with("/selftest/") && (app.state::<Shell>().selftest_flag || cfg!(debug_assertions));
    let params = match params {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m,
        Some(_) => return Err("params must be an object".into()),
    };
    let shell = app.state::<Shell>();
    if method != "shell.log" {
        shell.log(&format!("bridge ← {method}"));
    }
    let r = handle(&app, &method, &params, selftest_page).await;
    if let Err(e) = &r {
        shell.log(&format!("bridge → error ({method}): {e}"));
    }
    r.map_err(|e| e.0)
}

/// Run blocking work (dialogs, hardware keys, big files) off the async runtime's core threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> BResult<T> + Send + 'static) -> BResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| BridgeError::new(e.to_string()))?
}

fn ok() -> Value {
    json!({ "ok": true })
}

pub fn capabilities() -> Value {
    let desktop = cfg!(any(windows, target_os = "linux")) && !cfg!(target_os = "android");
    json!({
        "platform": PLATFORM,
        "shellVersion": env!("CARGO_PKG_VERSION"),
        "storage": true,
        "blobs": true,
        "notify": true,
        "notifyWhenClosed": cfg!(target_os = "android"),
        "badge": false,
        "tray": desktop,
        "menu": desktop,
        "fileOpen": true,
        "fileSave": true,
        "clipboardClear": true,
        "lockEvents": true,
        "idleLock": cfg!(windows),
        "hardwareKey": hw::kind(),
        "hardwareSlotType": hw::slot_type(),
        "hardwarePin": cfg!(target_os = "linux") && !cfg!(target_os = "android"),
    })
}

async fn handle<R: Runtime>(app: &AppHandle<R>, method: &str, p: &Map<String, Value>, selftest_page: bool) -> BResult<Value> {
    let shell = app.state::<Shell>();
    let store: Storage = if selftest_page { shell.selftest_storage.clone() } else { shell.storage.clone() };
    match method {
        // ------------------------------------------------ storage
        "storage.load" => {
            let s = blocking(move || store.load().map_err(BridgeError::from)).await?;
            Ok(json!({ "json": s }))
        }
        "storage.save" => {
            let json = v::string(p.get("json"), "json", MAX_DOCUMENT)?;
            match serde_json::from_str::<Value>(&json) {
                Ok(Value::Object(_)) => {}
                _ => return Err(BridgeError::new("json must be a JSON object")),
            }
            blocking(move || store.save(&json).map_err(BridgeError::from)).await?;
            shell.note_saved();
            Ok(ok())
        }

        // ------------------------------------------------ blobs
        "blobs.put" => {
            let id = v::uuid(p.get("id"), "id")?;
            let iv = v::base64(p.get("iv"), "iv", 12)?;
            if iv.len() != 12 {
                return Err(BridgeError::new("iv must be 12 bytes"));
            }
            let ct = v::base64(p.get("ct"), "ct", MAX_BLOB + 16)?;
            if ct.len() < 16 {
                return Err(BridgeError::new("ct is too short"));
            }
            blocking(move || store.put_blob(&id, &iv, &ct).map_err(BridgeError::from)).await?;
            Ok(ok())
        }
        "blobs.get" => {
            let id = v::uuid(p.get("id"), "id")?;
            Ok(match store.get_blob(&id) {
                Some((iv, ct)) => json!({ "iv": vaultcrypto::b64_encode(&iv), "ct": vaultcrypto::b64_encode(&ct) }),
                None => Value::Null,
            })
        }
        "blobs.delete" => {
            store.delete_blob(&v::uuid(p.get("id"), "id")?);
            Ok(ok())
        }

        // ------------------------------------------------ hardware keyslots
        "hw.available" => {
            let a = app.clone();
            blocking(move || Ok(hw::available(&a))).await
        }
        "hw.createSlot" => {
            let slot_id = v::uuid(p.get("slotId"), "slotId")?;
            let label = v::string(p.get("label"), "label", 200)?;
            let vdk = v::base64_exact(p.get("vdk"), "vdk", 32)?;
            let pin = pin_param(p)?;
            let a = app.clone();
            blocking(move || hw::create_slot(&a, &slot_id, &label, &vdk, pin.as_deref())).await
        }
        "hw.unwrapSlot" => {
            let slot = v::dict(p.get("slot"), "slot")?.clone();
            v::uuid(slot.get("id"), "slot.id")?;
            v::string(slot.get("type"), "slot.type", 40)?;
            let pin = pin_param(p)?;
            let a = app.clone();
            let vdk = blocking(move || hw::unwrap_slot(&a, &slot, pin.as_deref())).await?;
            Ok(json!({ "vdk": vaultcrypto::b64_encode(&vdk) }))
        }
        "hw.deleteSlot" => {
            let slot_id = v::uuid(p.get("slotId"), "slotId")?;
            let a = app.clone();
            blocking(move || {
                hw::delete_slot(&a, &slot_id);
                Ok(ok())
            })
            .await
        }
        // The web UI treats se.* as hw.* with kind "secure-enclave": there is no Secure Enclave here,
        // but se.available's device name is used by the transfer screen.
        "se.available" => Ok(json!({ "available": false, "device": hw::device_name(app) })),

        // ------------------------------------------------ notifications
        "notify.permission" => {
            let a = app.clone();
            blocking(move || Ok(json!({ "status": notify::permission(&a, false) }))).await
        }
        "notify.request" => {
            let a = app.clone();
            blocking(move || Ok(json!({ "status": notify::permission(&a, true) }))).await
        }
        "notify.sync" => {
            let items = match p.get("items") {
                Some(Value::Array(a)) => a,
                _ => return Err(BridgeError::new("items must be an array")),
            };
            if items.len() > 64 {
                return Err(BridgeError::new("at most 64 notifications"));
            }
            let mut parsed = Vec::with_capacity(items.len());
            for i in items {
                let i = i.as_object().ok_or_else(|| BridgeError::new("items[] must be objects"))?;
                let id = v::string(i.get("id"), "items[].id", 200)?;
                let title = v::string(i.get("title"), "items[].title", 500)?;
                let body = v::opt_string(i.get("body"), "items[].body", 2000)?.unwrap_or_default();
                let at = v::string(i.get("at"), "items[].at", 40)?;
                let at_ms = vaultcrypto::parse_iso_millis(&at).ok_or_else(|| BridgeError::new("items[].at must be an ISO timestamp"))?;
                let day = v::string(i.get("day"), "items[].day", 10)?;
                if !vaultcrypto::is_valid_day_string(&day) {
                    return Err(BridgeError::new("items[].day must be YYYY-MM-DD"));
                }
                parsed.push(notify::Reminder { id, title, body, at_ms, day });
            }
            let a = app.clone();
            let n = blocking(move || Ok(notify::sync(&a, parsed))).await?;
            Ok(json!({ "scheduled": n }))
        }
        "notify.show" => {
            let title = v::string(p.get("title"), "title", 500)?;
            let body = v::opt_string(p.get("body"), "body", 2000)?.unwrap_or_default();
            notify::show(app, &title, &body);
            Ok(ok())
        }

        // ------------------------------------------------ files / clipboard / app
        "files.save" => {
            let name = v::file_name(&v::string(p.get("suggestedName"), "suggestedName", 255)?);
            let mime = v::opt_string(p.get("mime"), "mime", 200)?.unwrap_or_else(|| "application/octet-stream".into());
            // Transfer files can be hundreds of MB: only check the size here; decode + write happen off the main thread.
            let b64 = v::string(p.get("base64"), "base64", (MAX_SAVE_BYTES / 3 + 2) * 4)?;
            let a = app.clone();
            let saved = blocking(move || save_file(&a, &name, &mime, &b64)).await?;
            Ok(match saved {
                Some(path) => json!({ "saved": true, "path": path }),
                None => json!({ "saved": false }),
            })
        }
        "clipboard.write" => {
            let text = v::string(p.get("text"), "text", 1_000_000)?;
            let clear = v::opt_int(p.get("clearAfterSeconds"), "clearAfterSeconds", 1..=3600)?;
            let concealed = v::opt_bool(p.get("concealed"), "concealed", false)?;
            clipboard_write(app, text, clear.map(|c| c as u64), concealed)?;
            Ok(ok())
        }
        "app.setBadge" => {
            v::int(p.get("count"), "count", 0..=999_999)?; // no badge on Windows / Linux / Android (capabilities.badge = false)
            Ok(ok())
        }
        "app.setFocusTimer" => {
            let label = v::opt_string(p.get("label"), "label", 40)?;
            let phase = v::opt_string(p.get("phase"), "phase", 10)?;
            if !matches!(phase.as_deref(), None | Some("focus") | Some("break")) {
                return Err(BridgeError::new("phase must be focus or break"));
            }
            set_focus_timer(app, label, phase);
            Ok(ok())
        }
        "app.vaultState" => {
            let unlocked = v::boolean(p.get("unlocked"), "unlocked")?;
            let minutes = v::opt_int(p.get("autoLockMinutes"), "autoLockMinutes", 1..=1440)?;
            let mut st = lock_or_recover(&shell.vault);
            st.unlocked = unlocked;
            if let Some(m) = minutes {
                st.auto_lock_minutes = m;
            }
            Ok(ok())
        }
        "app.openExternal" => {
            let url = v::external_url(&v::string(p.get("url"), "url", 4000)?)?;
            use tauri_plugin_opener::OpenerExt;
            app.opener().open_url(url, None::<&str>).map_err(|e| BridgeError::new(e.to_string()))?;
            Ok(ok())
        }
        "app.capabilities" => Ok(capabilities()),

        // ------------------------------------------------ shell-internal
        "shell.ready" => {
            crate::page_ready(app);
            Ok(ok())
        }
        "shell.log" => {
            if let Some(m) = p.get("message").and_then(Value::as_str) {
                shell.log(&format!("page: {}", m.chars().take(500).collect::<String>()));
            }
            Ok(ok())
        }
        "shell.takeTransfer" => Ok(match shell.take_transfer() {
            Some((name, b64)) => json!({ "fileName": name, "base64": b64 }),
            None => Value::Null,
        }),
        "selftest.trigger" if selftest_page => {
            let action = v::string(p.get("action"), "action", 40)?;
            let arg = v::opt_string(p.get("arg"), "arg", 100_000)?.unwrap_or_default();
            crate::selftest_trigger(app, &action, &arg).await
        }
        "selftest.done" if selftest_page => {
            crate::selftest_done(app, p);
            Ok(ok())
        }
        _ => Err(BridgeError::new(format!("unknown method: {method}"))),
    }
}

/// Optional security-key PIN (FIDO2: 4–63 bytes UTF-8). Never logged or stored.
fn pin_param(p: &Map<String, Value>) -> BResult<Option<String>> {
    let pin = v::opt_string(p.get("pin"), "pin", 63)?;
    if let Some(s) = &pin {
        if s.chars().count() < 4 {
            return Err(BridgeError::new("pin must be at least 4 characters"));
        }
    }
    Ok(pin)
}

fn decode_save(b64: &str) -> BResult<Vec<u8>> {
    vaultcrypto::b64_decode(b64).ok_or_else(|| BridgeError::new("base64 is not valid"))
}

/// files.save: native save dialog (desktop) / Storage Access Framework (Android). Blocking.
#[allow(unused_variables)]
fn save_file<R: Runtime>(app: &AppHandle<R>, name: &str, mime: &str, b64: &str) -> BResult<Option<String>> {
    let bytes = decode_save(b64)?;
    #[cfg(desktop)]
    {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app.dialog().file().set_file_name(name);
        if let Some(w) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&w);
        }
        let Some(path) = dialog.blocking_save_file() else { return Ok(None) };
        let path = path.into_path().map_err(|e| BridgeError::new(e.to_string()))?;
        crate::storage::atomic_write(&path, &bytes)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }
    #[cfg(target_os = "android")]
    {
        let cache = app.path().app_cache_dir().map_err(|e| BridgeError::new(e.to_string()))?.join("outgoing");
        std::fs::create_dir_all(&cache)?;
        let tmp = cache.join(format!("save-{}.bin", vaultcrypto::b64url_encode(&vaultcrypto::random::<8>().unwrap_or_default())));
        std::fs::write(&tmp, &bytes)?;
        let r = hw::android::save_file(app, name, mime, &tmp);
        let _ = std::fs::remove_file(&tmp);
        r
    }
}

fn clipboard_write<R: Runtime>(app: &AppHandle<R>, text: String, clear_after: Option<u64>, concealed: bool) -> BResult<()> {
    #[cfg(desktop)]
    {
        let _ = concealed; // no clipboard-manager exclusion through the plugin (see report: honest gaps)
        use tauri_plugin_clipboard_manager::ClipboardExt;
        app.clipboard().write_text(text.clone()).map_err(|e| BridgeError::new(e.to_string()))?;
        if let Some(secs) = clear_after {
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(secs));
                // clear only if nobody copied something else meanwhile
                if app.clipboard().read_text().ok().as_deref() == Some(text.as_str()) {
                    let _ = app.clipboard().clear();
                }
            });
        }
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        let sensitive = concealed || clear_after.is_some();
        let a = app.clone();
        let t = text.clone();
        std::thread::spawn(move || {
            let _ = hw::android::clipboard_write(&a, &t, sensitive);
            if let Some(secs) = clear_after {
                std::thread::sleep(std::time::Duration::from_secs(secs));
                hw::android::clipboard_clear_if(&a, &t);
            }
        });
        Ok(())
    }
}

fn set_focus_timer<R: Runtime>(app: &AppHandle<R>, label: Option<String>, phase: Option<String>) {
    #[cfg(desktop)]
    crate::desktop::set_focus_timer(app, label, phase);
    #[cfg(target_os = "android")]
    notify::set_focus_timer(app, label, phase);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_shape() {
        let c = capabilities();
        assert_eq!(c["platform"], json!(PLATFORM));
        assert_eq!(c["storage"], json!(true));
        assert!(c.get("hardwareKey").is_some());
        assert_eq!(c["badge"], json!(false));
    }

    #[test]
    fn pins() {
        let mut m = Map::new();
        assert_eq!(pin_param(&m).unwrap(), None);
        m.insert("pin".into(), json!("123"));
        assert!(pin_param(&m).is_err());
        m.insert("pin".into(), json!("1234"));
        assert_eq!(pin_param(&m).unwrap().as_deref(), Some("1234"));
        m.insert("pin".into(), json!("x".repeat(64)));
        assert!(pin_param(&m).is_err());
    }
}
