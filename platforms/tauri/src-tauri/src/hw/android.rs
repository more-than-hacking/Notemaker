//! Android native helpers: the `android-keystore` keyslot type plus the few things that need Kotlin
//! (Storage Access Framework saves, opened `.notemaker` files, sensitive clipboard, logcat).
//! Implemented by `gen/android/app/src/main/java/com/mth/notemaker/NotemakerPlugin.kt`.

use crate::validate::{BResult, BridgeError};
use crate::vaultcrypto;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

pub struct Native<R: Runtime>(pub PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("notemaker-native")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.mth.notemaker", "NotemakerPlugin")?;
            app.manage(Native(handle));
            Ok(())
        })
        .build()
}

/// Run a Kotlin command (blocks until it resolves — call from a blocking thread, never the main thread).
pub fn call<R: Runtime, T: DeserializeOwned>(app: &AppHandle<R>, cmd: &str, payload: Value) -> BResult<T> {
    let native = app.try_state::<Native<R>>().ok_or_else(|| BridgeError::new("native plugin missing"))?;
    native.0.run_mobile_plugin::<T>(cmd, payload).map_err(|e| {
        // Kotlin rejects with the bridge's error codes ("cancelled", "not-this-device", "biometry-changed", …)
        let s = match &e {
            tauri::plugin::mobile::PluginInvokeError::InvokeRejected(r) => r.message.clone().unwrap_or_else(|| e.to_string()),
            _ => e.to_string(),
        };
        BridgeError::new(s)
    })
}

pub fn key_alias(slot_id: &str) -> String {
    format!("notemaker-vault-{}", slot_id.to_ascii_lowercase())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Available {
    available: bool,
    strong_box: bool,
    device: String,
    detail: Option<String>,
}

pub fn device_name<R: Runtime>(app: &AppHandle<R>) -> String {
    #[derive(Deserialize)]
    struct D {
        device: String,
    }
    call::<R, D>(app, "deviceName", json!({})).map(|d| d.device).unwrap_or_else(|_| "Android device".into())
}

pub fn available<R: Runtime>(app: &AppHandle<R>) -> Value {
    match call::<R, Available>(app, "available", json!({})) {
        Ok(a) => {
            let mut v = json!({ "kind": "android-keystore", "available": a.available, "device": a.device, "strongBox": a.strong_box });
            if let Some(d) = a.detail {
                v["detail"] = json!(d);
            }
            v
        }
        Err(e) => json!({ "kind": "android-keystore", "available": false, "device": "", "detail": e.0 }),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sealed {
    iv: String,
    ct: String,
    strong_box: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateArgs<'a> {
    alias: &'a str,
    aad: &'a str,
    vdk: &'a str,
    title: &'a str,
}

/// `hw.createSlot`: new user-auth-bound Keystore AES-256-GCM key; BiometricPrompt (CryptoObject) encrypts the VDK.
pub fn create_slot<R: Runtime>(app: &AppHandle<R>, slot_id: &str, label: &str, vdk: &[u8]) -> BResult<Value> {
    let alias = key_alias(slot_id);
    let aad = vaultcrypto::slot_aad(slot_id);
    let vdk_b64 = vaultcrypto::b64_encode(vdk);
    let sealed: Sealed = call(
        app,
        "createKey",
        serde_json::to_value(CreateArgs { alias: &alias, aad: &aad, vdk: &vdk_b64, title: "Protect your Notemaker vault" })
            .map_err(|e| BridgeError::new(e.to_string()))?,
    )?;
    let iv = vaultcrypto::b64_decode(&sealed.iv).filter(|v| v.len() == 12);
    let ct = vaultcrypto::b64_decode(&sealed.ct).filter(|v| v.len() == 48);
    match (iv, ct) {
        (Some(iv), Some(ct)) => Ok(vaultcrypto::android_keystore_slot(
            slot_id,
            label,
            &device_name(app),
            &alias,
            sealed.strong_box,
            &iv,
            &ct,
        )),
        _ => {
            let _ = call::<R, Value>(app, "deleteKey", json!({ "alias": alias }));
            Err(BridgeError::new("The Keystore returned an unexpected result"))
        }
    }
}

/// `hw.unwrapSlot`: BiometricPrompt (or device credential) unlocks the Keystore key, which decrypts `ct`.
pub fn unwrap_slot<R: Runtime>(app: &AppHandle<R>, slot: &Map<String, Value>) -> BResult<Vec<u8>> {
    let id = slot.get("id").and_then(Value::as_str).unwrap_or_default();
    let alias = slot.get("keyAlias").and_then(Value::as_str).unwrap_or_default();
    if alias != key_alias(id) {
        return Err(BridgeError::new("slot.keyAlias does not belong to this slot"));
    }
    let iv = vaultcrypto::b64_field(slot, "iv").filter(|v| v.len() == 12).ok_or_else(|| BridgeError::new("slot.iv must be 12 bytes"))?;
    let ct = vaultcrypto::b64_field(slot, "ct").filter(|v| v.len() == 48).ok_or_else(|| BridgeError::new("slot.ct must be 48 bytes"))?;
    #[derive(Deserialize)]
    struct Out {
        vdk: String,
    }
    let out: Out = call(
        app,
        "decrypt",
        json!({ "alias": alias, "aad": vaultcrypto::slot_aad(id), "iv": vaultcrypto::b64_encode(&iv),
                "ct": vaultcrypto::b64_encode(&ct), "title": "Unlock your Notemaker vault" }),
    )?;
    let vdk = vaultcrypto::b64_decode(&out.vdk).filter(|v| v.len() == 32).ok_or_else(|| BridgeError::new("decryption failed"))?;
    Ok(vdk)
}

pub fn delete_slot<R: Runtime>(app: &AppHandle<R>, slot_id: &str) {
    let _ = call::<R, Value>(app, "deleteKey", json!({ "alias": key_alias(slot_id) }));
}

/// Storage Access Framework "create document". The bytes are first written to the app cache (`path`).
pub fn save_file<R: Runtime>(app: &AppHandle<R>, name: &str, mime: &str, path: &std::path::Path) -> BResult<Option<String>> {
    #[derive(Deserialize)]
    struct Saved {
        saved: bool,
        uri: Option<String>,
    }
    let r: Saved = call(app, "saveFile", json!({ "name": name, "mime": mime, "path": path.to_string_lossy() }))?;
    Ok(if r.saved { Some(r.uri.unwrap_or_default()) } else { None })
}

/// A `.notemaker` file the app was opened with (VIEW / SEND intent), copied into the cache by Kotlin.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PendingFile {
    pub path: Option<String>,
    pub error: Option<String>,
}

pub fn take_pending_file<R: Runtime>(app: &AppHandle<R>) -> PendingFile {
    call(app, "takePendingFile", json!({})).unwrap_or_default()
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LaunchInfo {
    pub selftest: bool,
    #[serde(default)]
    pub hw: bool,
}

pub fn launch_info<R: Runtime>(app: &AppHandle<R>) -> LaunchInfo {
    call(app, "launchInfo", json!({})).unwrap_or_default()
}

/// Milliseconds since the epoch of the last screen-off while the app was in the background (0 = none). Consumes it.
pub fn take_screen_off<R: Runtime>(app: &AppHandle<R>) -> i64 {
    #[derive(Deserialize)]
    struct S {
        since: i64,
    }
    call::<R, S>(app, "takeScreenOff", json!({})).map(|s| s.since).unwrap_or(0)
}

pub fn clipboard_write<R: Runtime>(app: &AppHandle<R>, text: &str, sensitive: bool) -> BResult<()> {
    call::<R, Value>(app, "clipboardWrite", json!({ "text": text, "sensitive": sensitive })).map(|_| ())
}

/// Clear the clipboard only if it still holds `text`.
pub fn clipboard_clear_if<R: Runtime>(app: &AppHandle<R>, text: &str) {
    let _ = call::<R, Value>(app, "clipboardClearIf", json!({ "text": text }));
}

pub fn clipboard_read<R: Runtime>(app: &AppHandle<R>) -> String {
    #[derive(Deserialize)]
    struct T {
        text: String,
    }
    call::<R, T>(app, "clipboardRead", json!({})).map(|t| t.text).unwrap_or_default()
}

pub fn log<R: Runtime>(app: &AppHandle<R>, message: &str) {
    let _ = call::<R, Value>(app, "log", json!({ "message": message }));
}
