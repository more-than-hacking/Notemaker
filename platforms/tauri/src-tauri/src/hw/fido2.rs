//! `fido2-hmac` keyslots (docs/PLATFORMS.md) for Linux: CTAP2 over USB HID with the `hmac-secret` extension
//! (pure user-space, no daemon). Creation makes a non-resident credential for rpId `notemaker.local` and then
//! asks for the hmac-secret output for a random 32-byte `salt` (two touches). Unwrapping asks for it again.
//!
//! PIN: if the key has a PIN, every operation needs it. Without `params.pin` the call fails with `pin-required`
//! so the web UI can ask and retry. The PIN is only passed to the authenticator — never logged or stored.
//! A key with a PIN always uses it (user verification), a key without one uses touch only, so the hmac-secret
//! output (which CTAP 2.1 keys derive differently with / without UV) is the same at creation and unlock.

use crate::validate::{BResult, BridgeError};
use crate::vaultcrypto::{self, FIDO2_RP_ID};
use ctap_hid_fido2::fidokey::get_info::InfoOption;
use ctap_hid_fido2::fidokey::{AssertionExtension as Gext, CredentialExtension as Mext, GetAssertionArgsBuilder, MakeCredentialArgsBuilder};
use ctap_hid_fido2::{FidoKeyHid, FidoKeyHidFactory, LibCfg};
use serde_json::{json, Map, Value};

fn cfg() -> LibCfg {
    let mut c = LibCfg::init();
    c.enable_log = false;
    c.enable_keep_alive_msg = false; // the library would print "touch the sensor" to stdout
    c.keep_alive_msg = String::new();
    c
}

/// Map a CTAP / HID error to the bridge's error codes. Never includes the PIN (it is not part of these messages).
fn map_err<E: std::fmt::Display>(e: E) -> BridgeError {
    let m = format!("{e:#}");
    let code = if m.contains("CTAP2_ERR_PIN_INVALID") {
        "pin-invalid"
    } else if m.contains("CTAP2_ERR_PIN_BLOCKED") || m.contains("CTAP2_ERR_PIN_AUTH_BLOCKED") {
        "pin-blocked"
    } else if m.contains("CTAP2_ERR_PIN_REQUIRED") || m.contains("CTAP2_ERR_PUAT_REQUIRED") {
        "pin-required"
    } else if m.contains("CTAP2_ERR_NO_CREDENTIALS") || m.contains("CTAP2_ERR_INVALID_CREDENTIAL") {
        "not-this-device"
    } else if m.contains("CTAP2_ERR_OPERATION_DENIED") || m.contains("CTAP2_ERR_KEEPALIVE_CANCEL") {
        "cancelled"
    } else if m.contains("TIMEOUT") {
        "timeout"
    } else if m.contains("FIDO device not found") {
        "no-device"
    } else if m.contains("Multiple FIDO devices") {
        "multiple-devices"
    } else {
        return BridgeError::new(format!("Security key error: {}", m.lines().next().unwrap_or("unknown")));
    };
    BridgeError::new(code)
}

struct Key {
    dev: FidoKeyHid,
    product: String,
    pin_set: bool,
    hmac_secret: bool,
}

fn open() -> BResult<Key> {
    let devs = ctap_hid_fido2::get_fidokey_devices();
    if devs.is_empty() {
        return Err(BridgeError::new("no-device"));
    }
    if devs.len() > 1 {
        return Err(BridgeError::new("multiple-devices"));
    }
    let product = devs[0].product_string.clone();
    let dev = FidoKeyHidFactory::create(&cfg()).map_err(|e| {
        let m = format!("{e:#}");
        if m.to_ascii_lowercase().contains("permission") {
            BridgeError::new("no-permission")
        } else {
            map_err(e)
        }
    })?;
    let info = dev.get_info().map_err(map_err)?;
    let pin_set = dev.enable_info_option(&InfoOption::ClientPin).map_err(map_err)? == Some(true);
    let hmac_secret = info.extensions.iter().any(|x| x == "hmac-secret");
    Ok(Key { dev, product, pin_set, hmac_secret })
}

fn device_label(product: &str) -> String {
    let p = product.trim();
    if p.is_empty() { "Security key".into() } else { p.chars().take(80).collect() }
}

pub fn available() -> Value {
    match open() {
        Ok(k) => {
            let mut v = json!({ "kind": "fido2", "available": k.hmac_secret, "device": device_label(&k.product), "pinSet": k.pin_set });
            if !k.hmac_secret {
                v["detail"] = json!("This security key does not support the hmac-secret extension.");
            }
            v
        }
        Err(e) => {
            let detail = match e.0.as_str() {
                "no-device" => "Plug in a FIDO2 security key (YubiKey, SoloKey, Nitrokey, …).".to_string(),
                "multiple-devices" => "More than one security key is plugged in — keep only one.".to_string(),
                "no-permission" => "No permission to use the security key. Install your distribution's FIDO udev rules \
                                    (package libfido2-1 / libu2f-udev) and plug it in again."
                    .to_string(),
                other => other.to_string(),
            };
            json!({ "kind": "fido2", "available": false, "device": "", "detail": detail, "error": e.0 })
        }
    }
}

fn check_pin(k: &Key, pin: Option<&str>) -> BResult<()> {
    if k.pin_set && pin.is_none() {
        return Err(BridgeError::new("pin-required"));
    }
    Ok(())
}

fn hmac_output(k: &Key, pin: Option<&str>, credential_id: &[u8], salt: &[u8; 32]) -> BResult<[u8; 32]> {
    let challenge = vaultcrypto::random::<32>().map_err(|e| BridgeError::new(e.to_string()))?;
    let ext = [Gext::HmacSecret(Some(*salt))];
    let mut b = GetAssertionArgsBuilder::new(FIDO2_RP_ID, &challenge).credential_id(credential_id).extensions(&ext);
    b = match (k.pin_set, pin) {
        (true, Some(p)) => b.pin(p),
        _ => b.without_pin_and_uv(),
    };
    let assertions = k.dev.get_assertion_with_args(&b.build()).map_err(map_err)?;
    for a in assertions {
        for e in a.extensions {
            if let Gext::HmacSecret(Some(out)) = e {
                return Ok(out);
            }
        }
    }
    Err(BridgeError::new("The security key did not return an hmac-secret"))
}

/// `hw.createSlot` (touch twice: create the credential, then read the hmac-secret).
pub fn create_slot(slot_id: &str, label: &str, vdk: &[u8], pin: Option<&str>) -> BResult<Value> {
    let k = open()?;
    if !k.hmac_secret {
        return Err(BridgeError::new("unsupported"));
    }
    check_pin(&k, pin)?;
    let challenge = vaultcrypto::random::<32>().map_err(|e| BridgeError::new(e.to_string()))?;
    let ext = [Mext::HmacSecret(Some(true))];
    let mut b = MakeCredentialArgsBuilder::new(FIDO2_RP_ID, &challenge).extensions(&ext);
    b = match (k.pin_set, pin) {
        (true, Some(p)) => b.pin(p),
        _ => b.without_pin_and_uv(),
    };
    let att = k.dev.make_credential_with_args(&b.build()).map_err(map_err)?;
    let credential_id = att.credential_descriptor.id.clone();
    if credential_id.is_empty() {
        return Err(BridgeError::new("The security key returned no credential"));
    }
    let salt = vaultcrypto::random::<32>().map_err(|e| BridgeError::new(e.to_string()))?;
    let hkdf_salt = vaultcrypto::random::<16>().map_err(|e| BridgeError::new(e.to_string()))?;
    let out = hmac_output(&k, pin, &credential_id, &salt)?;
    vaultcrypto::fido2_slot(slot_id, label, &device_label(&k.product), &credential_id, &salt, &hkdf_salt, &out, vdk)
        .map_err(|e| BridgeError::new(e.to_string()))
}

/// `hw.unwrapSlot` (one touch, + PIN if the key has one).
pub fn unwrap_slot(slot: &Map<String, Value>, pin: Option<&str>) -> BResult<Vec<u8>> {
    if slot.get("rpId").and_then(Value::as_str) != Some(FIDO2_RP_ID) {
        return Err(BridgeError::new("slot.rpId must be notemaker.local"));
    }
    let credential_id = slot
        .get("credentialId")
        .and_then(Value::as_str)
        .and_then(vaultcrypto::b64url_decode)
        .filter(|c| !c.is_empty() && c.len() <= 1024)
        .ok_or_else(|| BridgeError::new("slot.credentialId must be base64url"))?;
    let salt: [u8; 32] = vaultcrypto::b64_field(slot, "salt")
        .and_then(|s| s.try_into().ok())
        .ok_or_else(|| BridgeError::new("slot.salt must be 32 bytes"))?;
    let hkdf_salt = vaultcrypto::b64_field(slot, "hkdfSalt")
        .filter(|s| s.len() == 16)
        .ok_or_else(|| BridgeError::new("slot.hkdfSalt must be 16 bytes"))?;
    let k = open()?;
    check_pin(&k, pin)?;
    let out = hmac_output(&k, pin, &credential_id, &salt)?;
    let wrap = vaultcrypto::fido2_wrap_key(&out, &hkdf_salt);
    // Wrong key (another authenticator happened to accept the credential id) or PIN state changed since creation.
    vaultcrypto::unwrap_vdk(&wrap, slot).map_err(|_| BridgeError::new("not-this-device"))
}
