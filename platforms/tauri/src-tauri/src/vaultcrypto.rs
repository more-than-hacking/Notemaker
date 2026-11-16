//! Vault keyslot crypto shared by every hardware-key backend (docs/VAULT_FORMAT.md, docs/PLATFORMS.md).
//!
//! Pure Rust, no platform code: HKDF-SHA256, AES-256-GCM with the slot AAD, base64 helpers and the keyslot
//! JSON for the `windows-hello`, `fido2-hmac` and `android-keystore` types. Unit tests run it against
//! `docs/vault-test-vector.json` (recovery, passkey-prf, secure-enclave-with-software-key) and
//! `docs/hw-slot-test-vector.json` (the three new slot types with software stand-ins).

// Every platform uses a subset (Windows: windows-hello, Linux: fido2, Android: android-keystore).
#![allow(dead_code)]

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use serde_json::{json, Map, Value};
use sha2::Sha256;

pub const INFO_WINDOWS_HELLO: &str = "notemaker/vault/v1/windows-hello";
pub const INFO_FIDO2: &str = "notemaker/vault/v1/fido2-hmac";
pub const FIDO2_RP_ID: &str = "notemaker.local";

#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    BadKey,
    Decrypt,
    Encrypt,
    Random,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            CryptoError::BadKey => "key must be 32 bytes",
            CryptoError::Decrypt => "decryption failed (wrong key or tampered data)",
            CryptoError::Encrypt => "encryption failed",
            CryptoError::Random => "no secure random numbers available",
        })
    }
}

pub fn slot_aad(slot_id: &str) -> String {
    format!("notemaker/vault/v1/slot/{slot_id}")
}

/// HKDF-SHA256 → 32 bytes.
pub fn hkdf32(ikm: &[u8], salt: &[u8], info: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut out = [0u8; 32];
    hk.expand(info.as_bytes(), &mut out).expect("32 bytes is a valid HKDF-SHA256 length");
    out
}

pub fn gcm_seal(key: &[u8], iv: &[u8; 12], plain: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::BadKey)?;
    let nonce = Nonce::try_from(&iv[..]).map_err(|_| CryptoError::Encrypt)?;
    cipher
        .encrypt(&nonce, Payload { msg: plain, aad })
        .map_err(|_| CryptoError::Encrypt)
}

pub fn gcm_open(key: &[u8], iv: &[u8], ct: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if iv.len() != 12 {
        return Err(CryptoError::Decrypt);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::BadKey)?;
    let nonce = Nonce::try_from(iv).map_err(|_| CryptoError::Decrypt)?;
    cipher
        .decrypt(&nonce, Payload { msg: ct, aad })
        .map_err(|_| CryptoError::Decrypt)
}

pub fn random<const N: usize>() -> Result<[u8; N], CryptoError> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|_| CryptoError::Random)?;
    Ok(b)
}

/// Wrap the VDK for slot `slot_id` with `wrap_key` and a fresh random IV → (iv, ct).
pub fn wrap_vdk(wrap_key: &[u8; 32], vdk: &[u8], slot_id: &str) -> Result<([u8; 12], Vec<u8>), CryptoError> {
    let iv = random::<12>()?;
    let ct = gcm_seal(wrap_key, &iv, vdk, slot_aad(slot_id).as_bytes())?;
    Ok((iv, ct))
}

/// Unwrap a keyslot's `iv`/`ct` with `wrap_key` (AAD = slot id). Returns the 32-byte VDK.
pub fn unwrap_vdk(wrap_key: &[u8], slot: &Map<String, Value>) -> Result<Vec<u8>, CryptoError> {
    let id = slot.get("id").and_then(Value::as_str).ok_or(CryptoError::Decrypt)?;
    let iv = b64_field(slot, "iv").ok_or(CryptoError::Decrypt)?;
    let ct = b64_field(slot, "ct").ok_or(CryptoError::Decrypt)?;
    let vdk = gcm_open(wrap_key, &iv, &ct, slot_aad(id).as_bytes())?;
    if vdk.len() != 32 {
        return Err(CryptoError::Decrypt);
    }
    Ok(vdk)
}

pub fn b64_field(slot: &Map<String, Value>, name: &str) -> Option<Vec<u8>> {
    slot.get(name).and_then(Value::as_str).and_then(b64_decode)
}

// ---------------------------------------------------------------- slot-type specific key derivation

/// windows-hello: IKM = the (deterministic RSASSA-PKCS1-v1_5) signature of `challenge`, salt = `challenge`.
pub fn windows_hello_wrap_key(signature: &[u8], challenge: &[u8]) -> [u8; 32] {
    hkdf32(signature, challenge, INFO_WINDOWS_HELLO)
}

/// fido2-hmac: IKM = CTAP2 hmac-secret output for `salt`, salt = `hkdfSalt`.
pub fn fido2_wrap_key(hmac_secret_output: &[u8], hkdf_salt: &[u8]) -> [u8; 32] {
    hkdf32(hmac_secret_output, hkdf_salt, INFO_FIDO2)
}

/// Common keyslot fields.
pub fn slot_base(slot_id: &str, slot_type: &str, label: &str, device: &str, iv: &[u8], ct: &[u8]) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("id".into(), json!(slot_id));
    m.insert("type".into(), json!(slot_type));
    m.insert("label".into(), json!(label));
    m.insert("createdAt".into(), json!(iso_now()));
    m.insert("device".into(), json!(device));
    m.insert("iv".into(), json!(b64_encode(iv)));
    m.insert("ct".into(), json!(b64_encode(ct)));
    m
}

/// Build a windows-hello keyslot from the signature the Windows Hello key produced over `challenge`.
pub fn windows_hello_slot(
    slot_id: &str,
    label: &str,
    device: &str,
    key_name: &str,
    challenge: &[u8; 32],
    signature: &[u8],
    vdk: &[u8],
) -> Result<Value, CryptoError> {
    let wrap = windows_hello_wrap_key(signature, challenge);
    let (iv, ct) = wrap_vdk(&wrap, vdk, slot_id)?;
    let mut m = slot_base(slot_id, "windows-hello", label, device, &iv, &ct);
    m.insert("keyName".into(), json!(key_name));
    m.insert("challenge".into(), json!(b64_encode(challenge)));
    Ok(Value::Object(m))
}

/// Build a fido2-hmac keyslot from the hmac-secret output for `salt`.
#[allow(clippy::too_many_arguments)]
pub fn fido2_slot(
    slot_id: &str,
    label: &str,
    device: &str,
    credential_id: &[u8],
    salt: &[u8; 32],
    hkdf_salt: &[u8; 16],
    hmac_secret_output: &[u8],
    vdk: &[u8],
) -> Result<Value, CryptoError> {
    let wrap = fido2_wrap_key(hmac_secret_output, hkdf_salt);
    let (iv, ct) = wrap_vdk(&wrap, vdk, slot_id)?;
    let mut m = slot_base(slot_id, "fido2-hmac", label, device, &iv, &ct);
    m.insert("credentialId".into(), json!(b64url_encode(credential_id)));
    m.insert("rpId".into(), json!(FIDO2_RP_ID));
    m.insert("salt".into(), json!(b64_encode(salt)));
    m.insert("hkdfSalt".into(), json!(b64_encode(hkdf_salt)));
    Ok(Value::Object(m))
}

/// Build an android-keystore keyslot from the Keystore cipher's output (`iv`, `ct`).
pub fn android_keystore_slot(
    slot_id: &str,
    label: &str,
    device: &str,
    key_alias: &str,
    strong_box: bool,
    iv: &[u8],
    ct: &[u8],
) -> Value {
    let mut m = slot_base(slot_id, "android-keystore", label, device, iv, ct);
    m.insert("keyAlias".into(), json!(key_alias));
    m.insert("strongBox".into(), json!(strong_box));
    Value::Object(m)
}

// ---------------------------------------------------------------- base64 (strict, RFC 4648)

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn encode_with(data: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let chars = chunk.len() + 1;
        for i in 0..4 {
            if i < chars {
                out.push(alphabet[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

pub fn b64_encode(data: &[u8]) -> String {
    encode_with(data, B64, true)
}

pub fn b64url_encode(data: &[u8]) -> String {
    encode_with(data, B64URL, false)
}

fn decode_sym(c: u8, url: bool) -> Option<u32> {
    Some(match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' if !url => 62,
        b'/' if !url => 63,
        b'-' if url => 62,
        b'_' if url => 63,
        _ => return None,
    } as u32)
}

fn decode_with(s: &str, url: bool) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    let trimmed: &[u8] = {
        let mut end = bytes.len();
        let mut pads = 0;
        while end > 0 && bytes[end - 1] == b'=' && pads < 2 {
            end -= 1;
            pads += 1;
        }
        if pads > 0 && !bytes.len().is_multiple_of(4) {
            return None;
        }
        if !url && pads == 0 && !bytes.len().is_multiple_of(4) {
            return None; // standard base64 must be padded (like Foundation's Data(base64Encoded:))
        }
        &bytes[..end]
    };
    if trimmed.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(trimmed.len() * 3 / 4);
    for chunk in trimmed.chunks(4) {
        let mut n: u32 = 0;
        for (i, &c) in chunk.iter().enumerate() {
            n |= decode_sym(c, url)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
        // reject non-canonical trailing bits
        let used_bits = chunk.len() * 6;
        let kept_bits = (chunk.len() - 1) * 8;
        if used_bits > kept_bits {
            let mask = (1u32 << (used_bits - kept_bits)) - 1;
            if (n >> (24 - used_bits)) & mask != 0 {
                return None;
            }
        }
    }
    Some(out)
}

/// Standard base64 with padding (what `btoa` and Foundation produce). Rejects anything else.
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    decode_with(s, false)
}

/// base64url, padding optional.
pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    decode_with(s, true)
}

// ---------------------------------------------------------------- time

/// Current UTC time as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso_now() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    iso_from_millis(now.as_millis() as i64)
}

pub fn iso_from_millis(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z", sod / 3600, (sod / 60) % 60, sod % 60)
}

/// Days since 1970-01-01 → (year, month, day) (Howard Hinnant's algorithm).
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Parse an ISO-8601 timestamp as produced by `Date.toISOString()` (also accepts no fraction and ±HH:MM offsets)
/// → milliseconds since the epoch.
pub fn parse_iso_millis(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b.len() > 40 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = s.get(r)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    if b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b't') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    if !is_valid_day(y, mo as u32, d as u32) {
        return None;
    }
    let mut i = 19;
    let mut millis = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start || i - start > 9 {
            return None;
        }
        let frac = &s[start..i.min(start + 3)];
        millis = frac.parse::<i64>().ok()? * 10i64.pow(3 - frac.len() as u32);
    }
    let offset_min = match b.get(i) {
        Some(b'Z') | Some(b'z') if i + 1 == b.len() => 0,
        Some(&c) if (c == b'+' || c == b'-') && i + 6 == b.len() && b[i + 3] == b':' => {
            let oh = num(i + 1..i + 3)?;
            let om = num(i + 4..i + 6)?;
            if oh > 23 || om > 59 {
                return None;
            }
            let v = oh * 60 + om;
            if c == b'+' { v } else { -v }
        }
        _ => return None,
    };
    let days = days_from_civil(y, mo as u32, d as u32);
    Some(((days * 86_400 + h * 3600 + mi * 60 + se) - offset_min * 60) * 1000 + millis)
}

pub fn is_valid_day(y: i64, m: u32, d: u32) -> bool {
    if !(1..=12).contains(&m) || d == 0 {
        return false;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(m - 1) as usize];
    d <= dim
}

/// `YYYY-MM-DD` with a real calendar date.
pub fn is_valid_day_string(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && digits(5..7) && digits(8..10)) {
        return false;
    }
    let y: i64 = s[0..4].parse().unwrap_or(0);
    let m: u32 = s[5..7].parse().unwrap_or(0);
    let d: u32 = s[8..10].parse().unwrap_or(0);
    is_valid_day(y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VAULT_VECTOR: &str = include_str!("../../../../docs/vault-test-vector.json");
    const HW_VECTOR: &str = include_str!("../../../../docs/hw-slot-test-vector.json");

    fn vec_json(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }
    fn slot_of(v: &Value, ty: &str) -> Map<String, Value> {
        let slots = v.pointer("/vault/keyslots").or_else(|| v.get("keyslots")).unwrap().as_array().unwrap();
        slots.iter().find(|s| s["type"] == ty).unwrap().as_object().unwrap().clone()
    }
    fn b(v: &Value) -> Vec<u8> {
        b64_decode(v.as_str().unwrap()).unwrap()
    }
    fn check_verifier(v: &Value, vdk: &[u8]) {
        let ver = v.pointer("/vault/verifier").or_else(|| v.get("verifier")).unwrap();
        let pt = gcm_open(vdk, &b(&ver["iv"]), &b(&ver["ct"]), b"notemaker/vault/v1/verifier").unwrap();
        assert_eq!(pt, b"notemaker-vault-ok");
    }

    #[test]
    fn recovery_slot_vector() {
        let v = vec_json(VAULT_VECTOR);
        let slot = slot_of(&v, "recovery");
        let wrap = hkdf32(&b(&v["recoveryBytes"]), &b(&slot["salt"]), "notemaker/vault/v1/recovery");
        let vdk = unwrap_vdk(&wrap, &slot).unwrap();
        assert_eq!(b64_encode(&vdk), v["vdk"].as_str().unwrap());
        check_verifier(&v, &vdk);
    }

    #[test]
    fn passkey_prf_slot_vector() {
        let v = vec_json(VAULT_VECTOR);
        let slot = slot_of(&v, "passkey-prf");
        let wrap = hkdf32(&b(&v["prfOutput"]), &b(&slot["salt"]), "notemaker/vault/v1/passkey-prf");
        let vdk = unwrap_vdk(&wrap, &slot).unwrap();
        assert_eq!(b64_encode(&vdk), v["vdk"].as_str().unwrap());
    }

    #[test]
    fn secure_enclave_software_key_vector() {
        let v = vec_json(VAULT_VECTOR);
        let slot = slot_of(&v, "secure-enclave");
        let d = b64url_decode(v["seSoftwarePrivateJwk"]["d"].as_str().unwrap()).unwrap();
        let sk = p256::SecretKey::from_slice(&d).unwrap();
        // the slot's publicKey is the SE (here: software) key
        assert_eq!(sk.public_key().to_sec1_bytes().as_ref(), b(&slot["publicKey"]).as_slice());
        let eph_raw = b(&slot["ephemeralPublicKey"]);
        let eph = p256::PublicKey::from_sec1_bytes(&eph_raw).unwrap();
        let shared = p256::ecdh::diffie_hellman(sk.to_nonzero_scalar(), eph.as_affine());
        let wrap = hkdf32(shared.raw_secret_bytes().as_slice(), &eph_raw, "notemaker/vault/v1/secure-enclave");
        let vdk = unwrap_vdk(&wrap, &slot).unwrap();
        assert_eq!(b64_encode(&vdk), v["vdk"].as_str().unwrap());
    }

    #[test]
    fn items_and_blob_decrypt_with_vector_vdk() {
        let v = vec_json(VAULT_VECTOR);
        let vdk = b(&v["vdk"]);
        for item in v.pointer("/vault/items").unwrap().as_array().unwrap() {
            let id = item["id"].as_str().unwrap();
            let pt = gcm_open(&vdk, &b(&item["iv"]), &b(&item["ct"]), id.as_bytes()).unwrap();
            let got: Value = serde_json::from_slice(&pt).unwrap();
            assert_eq!(got, v["expectedPayloads"][id]);
        }
        let (blob_id, blob) = v.pointer("/vault/blobs").unwrap().as_object().unwrap().iter().next().unwrap();
        let pt = gcm_open(&vdk, &b(&blob["iv"]), &b(&blob["ct"]), format!("blob:{blob_id}").as_bytes()).unwrap();
        assert_eq!(pt, b(&v["fileBytes"]));
    }

    #[test]
    fn windows_hello_vector() {
        let v = vec_json(HW_VECTOR);
        let slot = slot_of(&v, "windows-hello");
        let wrap = windows_hello_wrap_key(&b(&v["windowsHelloSignature"]), &b(&slot["challenge"]));
        assert_eq!(b64_encode(&wrap), v["windowsHelloWrapKey"].as_str().unwrap());
        let vdk = unwrap_vdk(&wrap, &slot).unwrap();
        assert_eq!(b64_encode(&vdk), v["vdk"].as_str().unwrap());
        check_verifier(&v, &vdk);
        assert_eq!(slot["keyName"], json!(format!("notemaker-vault-{}", slot["id"].as_str().unwrap())));
    }

    #[test]
    fn fido2_hmac_vector() {
        let v = vec_json(HW_VECTOR);
        let slot = slot_of(&v, "fido2-hmac");
        assert_eq!(slot["rpId"], json!(FIDO2_RP_ID));
        assert_eq!(b(&slot["salt"]).len(), 32);
        assert!(b64url_decode(slot["credentialId"].as_str().unwrap()).is_some());
        let wrap = fido2_wrap_key(&b(&v["fido2HmacSecretOutput"]), &b(&slot["hkdfSalt"]));
        assert_eq!(b64_encode(&wrap), v["fido2WrapKey"].as_str().unwrap());
        let vdk = unwrap_vdk(&wrap, &slot).unwrap();
        assert_eq!(b64_encode(&vdk), v["vdk"].as_str().unwrap());
    }

    #[test]
    fn android_keystore_vector() {
        let v = vec_json(HW_VECTOR);
        let slot = slot_of(&v, "android-keystore");
        // the Keystore key encrypts the VDK directly (no HKDF), same IV/AAD rules
        let vdk = unwrap_vdk(&b(&v["androidKeystoreSoftwareKey"]), &slot).unwrap();
        assert_eq!(b64_encode(&vdk), v["vdk"].as_str().unwrap());
        check_verifier(&v, &vdk);
    }

    #[test]
    fn wrong_key_and_tampering_fail() {
        let v = vec_json(HW_VECTOR);
        let mut slot = slot_of(&v, "fido2-hmac");
        let wrap = fido2_wrap_key(&[0u8; 32], &b(&slot["hkdfSalt"]));
        assert_eq!(unwrap_vdk(&wrap, &slot), Err(CryptoError::Decrypt));
        // a slot moved to another id fails (AAD binds the id)
        let good = fido2_wrap_key(&b(&v["fido2HmacSecretOutput"]), &b(&slot["hkdfSalt"]));
        slot.insert("id".into(), json!("55555555-5555-4555-8555-555555555556"));
        assert_eq!(unwrap_vdk(&good, &slot), Err(CryptoError::Decrypt));
    }

    #[test]
    fn new_slots_round_trip() {
        let vdk = [7u8; 32];
        let id = "77777777-7777-4777-8777-777777777777";
        let challenge = [1u8; 32];
        let sig = [9u8; 256];
        let s = windows_hello_slot(id, "PC", "PC", "notemaker-vault-x", &challenge, &sig, &vdk).unwrap();
        let m = s.as_object().unwrap();
        assert_eq!(b(&m["iv"]).len(), 12);
        assert_eq!(b(&m["ct"]).len(), 48);
        assert_eq!(unwrap_vdk(&windows_hello_wrap_key(&sig, &challenge), m).unwrap(), vdk);

        let hmac = [3u8; 32];
        let s = fido2_slot(id, "Key", "Key", b"cred", &[4u8; 32], &[5u8; 16], &hmac, &vdk).unwrap();
        let m = s.as_object().unwrap();
        assert_eq!(m["credentialId"], json!("Y3JlZA"));
        assert_eq!(unwrap_vdk(&fido2_wrap_key(&hmac, &[5u8; 16]), m).unwrap(), vdk);

        let s = android_keystore_slot(id, "Phone", "Phone", "alias", true, &[0u8; 12], &[1u8; 48]);
        assert_eq!(s["strongBox"], json!(true));
        assert_eq!(s["type"], json!("android-keystore"));
        assert!(parse_iso_millis(s["createdAt"].as_str().unwrap()).is_some());
    }

    #[test]
    fn base64_strict() {
        for n in 0..40 {
            let data: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(b64_decode(&b64_encode(&data)).unwrap(), data);
            assert_eq!(b64url_decode(&b64url_encode(&data)).unwrap(), data);
        }
        assert_eq!(b64_decode("").unwrap(), Vec::<u8>::new());
        assert!(b64_decode("%%%not base64%%%").is_none());
        assert!(b64_decode("QUJD\n").is_none());
        assert!(b64_decode("QUI").is_none()); // unpadded standard base64
        assert!(b64_decode("QUJ=").is_none()); // non-canonical trailing bits
        assert!(b64_decode("Q===").is_none());
        assert!(b64_decode("a-b_").is_none());
        assert_eq!(b64url_decode("dGVzdC1jcmVkZW50aWFs").unwrap(), b"test-credential");
    }

    #[test]
    fn iso_parsing() {
        assert_eq!(parse_iso_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_millis("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(parse_iso_millis("2026-11-16T09:30:00.000Z"), Some(1_794_821_400_000));
        assert_eq!(parse_iso_millis("2026-11-16T10:30:00+01:00"), Some(1_794_821_400_000));
        assert_eq!(iso_from_millis(1_794_821_400_000), "2026-11-16T09:30:00.000Z");
        for bad in ["not-a-date", "2026-02-30T00:00:00Z", "2026-11-16 09:30:00Z", "2026-11-16T25:00:00Z", "2026-11-16T09:30:00"] {
            assert_eq!(parse_iso_millis(bad), None, "{bad}");
        }
        assert!(is_valid_day_string("2024-02-29"));
        assert!(!is_valid_day_string("2026-02-29"));
        assert!(!is_valid_day_string("2026-1-01"));
    }
}
