fn main() {
    // Only the `bridge` command exists, and only through the "allow-bridge" permission (capabilities/default.json).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["bridge"])),
    )
    .expect("failed to run tauri-build");
}
