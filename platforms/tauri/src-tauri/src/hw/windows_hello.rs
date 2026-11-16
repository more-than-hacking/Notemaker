//! `windows-hello` keyslots (docs/PLATFORMS.md): a TPM-backed RSA key created with
//! `KeyCredentialManager.RequestCreateAsync` (Windows Hello face / fingerprint / PIN on every use) signs the slot's
//! random 32-byte challenge; the deterministic RSASSA-PKCS1-v1_5 signature is the HKDF input of the wrap key.
//! All calls block on WinRT async operations, so they run on a blocking thread, never the UI thread.

use crate::validate::{BResult, BridgeError};
use crate::vaultcrypto::{self, CryptoError};
use serde_json::{json, Map, Value};
use windows::core::{Array, HSTRING};
use windows::Security::Credentials::{
    KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
};
use windows::Security::Cryptography::CryptographicBuffer;

pub fn key_name(slot_id: &str) -> String {
    format!("notemaker-vault-{}", slot_id.to_ascii_lowercase())
}

fn err(e: windows::core::Error) -> BridgeError {
    BridgeError::new(format!("Windows Hello error: {}", e.message()))
}

fn status_error(s: KeyCredentialStatus) -> BridgeError {
    BridgeError::new(match s {
        KeyCredentialStatus::UserCanceled | KeyCredentialStatus::UserPrefersPassword => "cancelled",
        KeyCredentialStatus::NotFound => "not-this-device",
        KeyCredentialStatus::SecurityDeviceLocked => "locked",
        KeyCredentialStatus::CredentialAlreadyExists => "Windows Hello key already exists",
        _ => "Windows Hello is not available",
    })
}

pub fn is_supported() -> bool {
    KeyCredentialManager::IsSupportedAsync().and_then(|op| op.join()).unwrap_or(false)
}

pub fn device_name() -> String {
    std::env::var("COMPUTERNAME").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "This PC".into())
}

pub fn available() -> Value {
    let ok = is_supported();
    let mut v = json!({ "kind": "windows-hello", "available": ok, "device": device_name() });
    if !ok {
        v["detail"] = json!("Windows Hello is not set up on this PC (Settings → Accounts → Sign-in options).");
    }
    v
}

fn sign(cred: &KeyCredential, challenge: &[u8]) -> BResult<Vec<u8>> {
    let buf = CryptographicBuffer::CreateFromByteArray(challenge).map_err(err)?;
    focus_hello_dialog();
    let res = cred.RequestSignAsync(&buf).and_then(|op| op.join()).map_err(err)?;
    let status = res.Status().map_err(err)?;
    if status != KeyCredentialStatus::Success {
        return Err(status_error(status));
    }
    let out = res.Result().map_err(err)?;
    let mut arr = Array::<u8>::new();
    CryptographicBuffer::CopyToByteArray(&out, &mut arr).map_err(err)?;
    if arr.len() < 128 {
        return Err(BridgeError::new("Windows Hello returned an unexpected signature"));
    }
    Ok(arr.to_vec())
}

/// `hw.createSlot`: creates the Windows Hello key (prompts), signs a fresh challenge, wraps the VDK.
pub fn create_slot(slot_id: &str, label: &str, vdk: &[u8]) -> BResult<Value> {
    if !is_supported() {
        return Err(BridgeError::new("no-device"));
    }
    let name = key_name(slot_id);
    focus_hello_dialog();
    let res = KeyCredentialManager::RequestCreateAsync(&HSTRING::from(&name), KeyCredentialCreationOption::FailIfExists)
        .and_then(|op| op.join())
        .map_err(err)?;
    let status = res.Status().map_err(err)?;
    if status != KeyCredentialStatus::Success {
        return Err(status_error(status));
    }
    let cred = res.Credential().map_err(err)?;
    let challenge = vaultcrypto::random::<32>().map_err(|e: CryptoError| BridgeError::new(e.to_string()))?;
    let signature = match sign(&cred, &challenge) {
        Ok(s) => s,
        Err(e) => {
            delete_key(&name);
            return Err(e);
        }
    };
    vaultcrypto::windows_hello_slot(slot_id, label, &device_name(), &name, &challenge, &signature, vdk)
        .map_err(|e| BridgeError::new(e.to_string()))
}

/// `hw.unwrapSlot`: opens the key named in the slot (prompts) and re-derives the wrap key.
pub fn unwrap_slot(slot: &Map<String, Value>) -> BResult<Vec<u8>> {
    let id = slot.get("id").and_then(Value::as_str).unwrap_or_default();
    let name = slot.get("keyName").and_then(Value::as_str).unwrap_or_default();
    // only ever use Notemaker's own key for this slot
    if name != key_name(id) {
        return Err(BridgeError::new("slot.keyName does not belong to this slot"));
    }
    let challenge = vaultcrypto::b64_field(slot, "challenge")
        .filter(|c| c.len() == 32)
        .ok_or_else(|| BridgeError::new("slot.challenge must be 32 bytes"))?;
    if !is_supported() {
        return Err(BridgeError::new("no-device"));
    }
    let res = KeyCredentialManager::OpenAsync(&HSTRING::from(name)).and_then(|op| op.join()).map_err(err)?;
    let status = res.Status().map_err(err)?;
    if status != KeyCredentialStatus::Success {
        return Err(status_error(status));
    }
    let cred = res.Credential().map_err(err)?;
    let signature = sign(&cred, &challenge)?;
    let wrap = vaultcrypto::windows_hello_wrap_key(&signature, &challenge);
    // A different key (e.g. Windows Hello was reset and the key recreated) gives a different signature → GCM fails.
    vaultcrypto::unwrap_vdk(&wrap, slot).map_err(|_| BridgeError::new("biometry-changed"))
}

fn delete_key(name: &str) {
    let _ = KeyCredentialManager::DeleteAsync(&HSTRING::from(name)).and_then(|op| op.join());
}

pub fn delete_slot(slot_id: &str) {
    delete_key(&key_name(slot_id));
}

/// The Windows Hello dialog of an unpackaged desktop app often opens *behind* the app window. Bring it to the
/// front when it appears (it is a top-level window of class "Credential Dialog Xaml Host").
fn focus_hello_dialog() {
    std::thread::spawn(|| {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow};
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            // SAFETY: plain Win32 calls with a constant class name; a null result is handled.
            unsafe {
                if let Ok(hwnd) = FindWindowW(w!("Credential Dialog Xaml Host"), None) {
                    if !hwnd.is_invalid() {
                        let _ = SetForegroundWindow(hwnd);
                        return;
                    }
                }
            }
        }
    });
}
