//! `hw.*` bridge methods: one hardware keyslot type per platform (docs/PLATFORMS.md).
//!   Windows → `windows-hello`, Linux → `fido2-hmac` (kind "fido2"), Android → `android-keystore`.
//! All functions block (they prompt the user) — the bridge runs them on a blocking thread.

#[cfg(target_os = "android")]
pub mod android;
#[cfg(target_os = "linux")]
pub mod fido2;
#[cfg(windows)]
pub mod windows_hello;

use crate::validate::{BResult, BridgeError};
#[allow(unused_imports)]
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Runtime};

/// `app.capabilities().hardwareKey`
pub fn kind() -> Option<&'static str> {
    if cfg!(windows) {
        Some("windows-hello")
    } else if cfg!(target_os = "android") {
        Some("android-keystore")
    } else if cfg!(target_os = "linux") {
        Some("fido2")
    } else {
        None
    }
}

/// The keyslot `type` this platform creates.
pub fn slot_type() -> Option<&'static str> {
    if cfg!(target_os = "linux") { Some("fido2-hmac") } else { kind() }
}

pub fn device_name<R: Runtime>(_app: &AppHandle<R>) -> String {
    #[cfg(windows)]
    return windows_hello::device_name();
    #[cfg(target_os = "android")]
    return android::device_name(_app);
    #[cfg(not(any(windows, target_os = "android")))]
    return std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "This computer".into());
}

pub fn available<R: Runtime>(_app: &AppHandle<R>) -> Value {
    #[cfg(windows)]
    return windows_hello::available();
    #[cfg(target_os = "android")]
    return android::available(_app);
    #[cfg(target_os = "linux")]
    return fido2::available();
    #[cfg(not(any(windows, target_os = "android", target_os = "linux")))]
    return json!({ "kind": Value::Null, "available": false, "device": "" });
}

pub fn create_slot<R: Runtime>(_app: &AppHandle<R>, slot_id: &str, label: &str, vdk: &[u8], _pin: Option<&str>) -> BResult<Value> {
    #[cfg(windows)]
    return windows_hello::create_slot(slot_id, label, vdk);
    #[cfg(target_os = "android")]
    return android::create_slot(_app, slot_id, label, vdk);
    #[cfg(target_os = "linux")]
    return fido2::create_slot(slot_id, label, vdk, _pin);
    #[cfg(not(any(windows, target_os = "android", target_os = "linux")))]
    {
        let _ = (slot_id, label, vdk);
        Err(BridgeError::new("no-device"))
    }
}

/// Checks the slot type and id, then unwraps on this platform.
pub fn unwrap_slot<R: Runtime>(_app: &AppHandle<R>, slot: &Map<String, Value>, _pin: Option<&str>) -> BResult<Vec<u8>> {
    let ty = slot.get("type").and_then(Value::as_str).unwrap_or_default();
    match slot_type() {
        Some(t) if t == ty => {}
        Some(t) => return Err(BridgeError::new(format!("slot.type must be {t}"))),
        None => return Err(BridgeError::new("no-device")),
    }
    #[cfg(windows)]
    return windows_hello::unwrap_slot(slot);
    #[cfg(target_os = "android")]
    return android::unwrap_slot(_app, slot);
    #[cfg(target_os = "linux")]
    return fido2::unwrap_slot(slot, _pin);
    #[cfg(not(any(windows, target_os = "android", target_os = "linux")))]
    Err(BridgeError::new("no-device"))
}

pub fn delete_slot<R: Runtime>(_app: &AppHandle<R>, _slot_id: &str) {
    #[cfg(windows)]
    windows_hello::delete_slot(_slot_id);
    #[cfg(target_os = "android")]
    android::delete_slot(_app, _slot_id);
    // fido2-hmac: the credential is non-resident (nothing is stored on the key), so there is nothing to delete.
}
