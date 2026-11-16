//! Bridge parameter validation — the same rules and messages as `Notemaker/Core/BridgeValidation.swift`.

use crate::vaultcrypto::b64_decode;
use serde_json::{Map, Value};
use std::ops::RangeInclusive;

/// A bridge error: its message becomes the rejected promise's `Error.message` in the page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeError(pub String);

impl BridgeError {
    pub fn new(m: impl Into<String>) -> Self {
        BridgeError(m.into())
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<std::io::Error> for BridgeError {
    fn from(e: std::io::Error) -> Self {
        BridgeError(e.to_string())
    }
}

pub type BResult<T> = Result<T, BridgeError>;

fn is_null(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

pub fn uuid(v: Option<&Value>, name: &str) -> BResult<String> {
    match v.and_then(Value::as_str) {
        Some(s) if is_uuid(s) => Ok(s.to_string()),
        _ => Err(BridgeError::new(format!("{name} must be a UUID"))),
    }
}

pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

pub fn string(v: Option<&Value>, name: &str, max: usize) -> BResult<String> {
    let s = v.and_then(Value::as_str).ok_or_else(|| BridgeError::new(format!("{name} must be a string")))?;
    if s.len() > max {
        return Err(BridgeError::new(format!("{name} is too long")));
    }
    Ok(s.to_string())
}

pub fn opt_string(v: Option<&Value>, name: &str, max: usize) -> BResult<Option<String>> {
    if is_null(v) {
        return Ok(None);
    }
    string(v, name, max).map(Some)
}

pub fn base64(v: Option<&Value>, name: &str, max_bytes: usize) -> BResult<Vec<u8>> {
    let s = v.and_then(Value::as_str).ok_or_else(|| BridgeError::new(format!("{name} must be a base64 string")))?;
    if s.len() > (max_bytes / 3 + 2) * 4 {
        return Err(BridgeError::new(format!("{name} is too large")));
    }
    let d = b64_decode(s).ok_or_else(|| BridgeError::new(format!("{name} is not valid base64")))?;
    if d.len() > max_bytes {
        return Err(BridgeError::new(format!("{name} is too large")));
    }
    Ok(d)
}

/// Exactly `len` bytes of base64.
pub fn base64_exact(v: Option<&Value>, name: &str, len: usize) -> BResult<Vec<u8>> {
    let d = base64(v, name, len)?;
    if d.len() != len {
        return Err(BridgeError::new(format!("{name} must be {len} bytes")));
    }
    Ok(d)
}

pub fn int(v: Option<&Value>, name: &str, range: RangeInclusive<i64>) -> BResult<i64> {
    let n = match v {
        Some(Value::Number(n)) => n,
        _ => return Err(BridgeError::new(format!("{name} must be a number"))),
    };
    let i = if let Some(i) = n.as_i64() {
        i
    } else {
        let f = n.as_f64().unwrap_or(f64::NAN);
        if f.fract() != 0.0 || !f.is_finite() || f.abs() > 9.0e15 {
            return Err(BridgeError::new(format!("{name} is out of range")));
        }
        f as i64
    };
    if !range.contains(&i) {
        return Err(BridgeError::new(format!("{name} is out of range")));
    }
    Ok(i)
}

pub fn opt_int(v: Option<&Value>, name: &str, range: RangeInclusive<i64>) -> BResult<Option<i64>> {
    if is_null(v) {
        return Ok(None);
    }
    int(v, name, range).map(Some)
}

pub fn boolean(v: Option<&Value>, name: &str) -> BResult<bool> {
    v.and_then(Value::as_bool).ok_or_else(|| BridgeError::new(format!("{name} must be true or false")))
}

/// Absent / null → `default`.
pub fn opt_bool(v: Option<&Value>, name: &str, default: bool) -> BResult<bool> {
    if is_null(v) {
        return Ok(default);
    }
    boolean(v, name)
}

pub fn dict<'a>(v: Option<&'a Value>, name: &str) -> BResult<&'a Map<String, Value>> {
    v.and_then(Value::as_object).ok_or_else(|| BridgeError::new(format!("{name} must be an object")))
}

/// http(s) / mailto only, no control characters or whitespace.
pub fn external_url(s: &str) -> BResult<String> {
    let lower = s.to_ascii_lowercase();
    let ok_scheme = lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:");
    let clean = !s.chars().any(|c| c.is_control() || c.is_whitespace());
    let has_rest = s.split_once(':').map(|(_, r)| !r.trim_start_matches('/').is_empty()).unwrap_or(false);
    if !(ok_scheme && clean && has_rest) {
        return Err(BridgeError::new("only http(s) and mailto URLs"));
    }
    Ok(s.to_string())
}

/// A safe file name for a suggested save name (no directories).
pub fn file_name(s: &str) -> String {
    let base = s.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() { "Notemaker export".to_string() } else { trimmed }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn uuids() {
        assert!(uuid(Some(&json!("11111111-1111-4111-8111-111111111111")), "id").is_ok());
        assert_eq!(uuid(Some(&json!("../../etc/passwd")), "id").unwrap_err().0, "id must be a UUID");
        assert!(uuid(Some(&json!(5)), "id").is_err());
        assert!(uuid(None, "id").is_err());
        assert!(!is_uuid("11111111-1111-4111-8111-11111111111g"));
    }

    #[test]
    fn strings_and_base64() {
        assert_eq!(string(Some(&json!("ü")), "s", 2).unwrap(), "ü");
        assert_eq!(string(Some(&json!("üx")), "s", 2).unwrap_err().0, "s is too long");
        assert_eq!(string(Some(&json!(1)), "s", 2).unwrap_err().0, "s must be a string");
        assert_eq!(opt_string(Some(&Value::Null), "s", 2).unwrap(), None);
        assert_eq!(base64(Some(&json!("%%%not base64%%%")), "ct", 100).unwrap_err().0, "ct is not valid base64");
        assert_eq!(base64(Some(&json!("AAAAAAAAAAAAAAAA")), "iv", 8).unwrap_err().0, "iv is too large");
        assert_eq!(base64_exact(Some(&json!("AAAAAAAAAAA=")), "iv", 12).unwrap_err().0, "iv must be 12 bytes");
        assert_eq!(base64_exact(Some(&json!("AAAAAAAAAAAAAAAA")), "iv", 12).unwrap().len(), 12);
    }

    #[test]
    fn numbers_and_bools() {
        assert_eq!(int(Some(&json!(30)), "n", 1..=3600).unwrap(), 30);
        assert_eq!(int(Some(&json!(30.0)), "n", 1..=3600).unwrap(), 30);
        assert_eq!(int(Some(&json!(0)), "n", 1..=3600).unwrap_err().0, "n is out of range");
        assert_eq!(int(Some(&json!(1.5)), "n", 1..=3600).unwrap_err().0, "n is out of range");
        assert_eq!(int(Some(&json!(true)), "n", 0..=1).unwrap_err().0, "n must be a number");
        assert_eq!(boolean(Some(&json!(1)), "b").unwrap_err().0, "b must be true or false");
        assert!(opt_bool(None, "b", true).unwrap());
    }

    #[test]
    fn urls_and_names() {
        assert!(external_url("https://example.com/x").is_ok());
        assert!(external_url("mailto:a@b.c").is_ok());
        assert!(external_url("file:///etc/passwd").is_err());
        assert!(external_url("javascript:alert(1)").is_err());
        assert!(external_url("https://exa mple.com").is_err());
        assert!(external_url("https://").is_err());
        assert_eq!(file_name("../../x/Notemaker transfer 2026-11-16.notemaker"), "Notemaker transfer 2026-11-16.notemaker");
        assert_eq!(file_name("a\\b:c"), "b_c");
        assert_eq!(file_name(".."), "Notemaker export");
    }
}
