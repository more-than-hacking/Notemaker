//! `storage.*` and `blobs.*`: the v2 document and vault blobs in the app data directory
//! (`%APPDATA%\com.mth.notemaker`, `~/.local/share/com.mth.notemaker`, Android internal storage).
//!
//! Layout (same as js/storage-core.js folder storage):
//!   notemaker-data.json          the document (atomic write)
//!   notemaker-data.backup.json   the previous version (rotated on every successful write)
//!   vault-blobs/<uuid>.bin       iv (12 bytes) ‖ ciphertext

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const DATA: &str = "notemaker-data.json";
pub const BACKUP: &str = "notemaker-data.backup.json";
pub const BLOBS: &str = "vault-blobs";

#[derive(Clone, Debug)]
pub struct Storage {
    pub root: PathBuf,
}

impl Storage {
    pub fn new(root: PathBuf) -> Self {
        Storage { root }
    }

    pub fn data_path(&self) -> PathBuf {
        self.root.join(DATA)
    }

    pub fn backup_path(&self) -> PathBuf {
        self.root.join(BACKUP)
    }

    pub fn blobs_dir(&self) -> PathBuf {
        self.root.join(BLOBS)
    }

    fn ensure_dir(dir: &Path) -> std::io::Result<()> {
        fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
        Ok(())
    }

    /// `storage.load`: the document, or None when there is none yet.
    pub fn load(&self) -> std::io::Result<Option<String>> {
        match fs::read(self.data_path()) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "notemaker-data.json is not UTF-8")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// `storage.save`: keep the current file as the backup, then atomically replace it.
    pub fn save(&self, json: &str) -> std::io::Result<()> {
        Self::ensure_dir(&self.root)?;
        let data = self.data_path();
        if data.exists() {
            // copy (not rename) so a crash between the two steps never leaves no data file
            let tmp_backup = self.root.join(format!("{BACKUP}.tmp"));
            fs::copy(&data, &tmp_backup)?;
            fs::rename(&tmp_backup, self.backup_path())?;
        }
        atomic_write(&data, json.as_bytes())
    }

    fn blob_path(&self, id: &str) -> PathBuf {
        // `id` is validated as a UUID by the bridge; lower-case it so lookups are case-insensitive everywhere
        self.blobs_dir().join(format!("{}.bin", id.to_ascii_lowercase()))
    }

    pub fn put_blob(&self, id: &str, iv: &[u8], ct: &[u8]) -> std::io::Result<()> {
        Self::ensure_dir(&self.blobs_dir())?;
        let mut data = Vec::with_capacity(iv.len() + ct.len());
        data.extend_from_slice(iv);
        data.extend_from_slice(ct);
        atomic_write(&self.blob_path(id), &data)
    }

    /// → (iv, ct), or None when missing / too short.
    pub fn get_blob(&self, id: &str) -> Option<(Vec<u8>, Vec<u8>)> {
        let d = fs::read(self.blob_path(id)).ok()?;
        if d.len() < 28 {
            return None;
        }
        Some((d[..12].to_vec(), d[12..].to_vec()))
    }

    pub fn delete_blob(&self, id: &str) {
        let _ = fs::remove_file(self.blob_path(id));
    }
}

/// Write to a temporary file in the same directory, fsync, then rename over the target (0600 on Unix).
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let rnd = crate::vaultcrypto::random::<6>().map(|b| crate::vaultcrypto::b64url_encode(&b)).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{rnd}.tmp"));
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        if let Err(e) = f.write_all(bytes).and_then(|_| f.sync_all()) {
            drop(f);
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("notemaker-storage-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn save_load_backup_rotation() {
        let s = Storage::new(temp_root("doc"));
        assert_eq!(s.load().unwrap(), None);
        s.save(r#"{"v":1,"m":"ü✓"}"#).unwrap();
        assert_eq!(s.load().unwrap().unwrap(), r#"{"v":1,"m":"ü✓"}"#);
        assert!(!s.backup_path().exists());
        s.save(r#"{"v":2}"#).unwrap();
        assert_eq!(fs::read_to_string(s.backup_path()).unwrap(), r#"{"v":1,"m":"ü✓"}"#);
        s.save(r#"{"v":3}"#).unwrap();
        assert_eq!(fs::read_to_string(s.backup_path()).unwrap(), r#"{"v":2}"#);
        assert_eq!(s.load().unwrap().unwrap(), r#"{"v":3}"#);
        let leftovers: Vec<_> = fs::read_dir(&s.root).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
        assert_eq!(leftovers.len(), 2, "{leftovers:?}");
        let _ = fs::remove_dir_all(&s.root);
    }

    #[test]
    fn blobs() {
        let s = Storage::new(temp_root("blobs"));
        let id = "AAAAAAAA-0000-4000-8000-000000000001";
        s.put_blob(id, &[1u8; 12], &[2u8; 20]).unwrap();
        let (iv, ct) = s.get_blob(&id.to_lowercase()).unwrap();
        assert_eq!(iv, vec![1u8; 12]);
        assert_eq!(ct, vec![2u8; 20]);
        s.delete_blob(id);
        assert!(s.get_blob(id).is_none());
        let _ = fs::remove_dir_all(&s.root);
    }
}
