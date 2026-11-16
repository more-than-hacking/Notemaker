//! Notemaker shell for Windows, Linux and Android (Tauri 2).
//!
//! It hosts the same bundled web UI as the macOS app and the browser version and exposes
//! `window.NotemakerNative` (docs/DESKTOP_BRIDGE.md, docs/PLATFORMS.md) through ONE command, `bridge`.
//! Nothing is loaded from the network.

mod bridge;
#[cfg(desktop)]
mod desktop;
mod hw;
mod lock;
mod notify;
mod selftest;
mod storage;
mod validate;
mod vaultcrypto;

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const PLATFORM: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "android") {
    "android"
} else if cfg!(target_os = "linux") {
    "linux"
} else {
    "unknown"
};
pub const MAX_TRANSFER_BYTES: u64 = 1 << 30; // docs/TRANSFER_FORMAT.md
const BRIDGE_JS: &str = include_str!("../bridge.js");
pub(crate) use selftest::{done as selftest_done, trigger as selftest_trigger};

pub(crate) fn lock_or_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub struct VaultState {
    pub unlocked: bool,
    pub auto_lock_minutes: i64,
}

#[derive(Default)]
struct Hidden {
    reason: Option<String>,
    since: Option<Instant>,
    inactive_generation: u64,
}

/// Shared shell state (managed by Tauri).
pub struct Shell {
    /// `--bridge-selftest` (desktop): start on the self-test page, print its results and exit 0/1.
    pub selftest_flag: bool,
    pub log_calls: bool,
    pub storage: storage::Storage,
    /// The self-test page always gets a temporary data folder.
    pub selftest_storage: storage::Storage,
    page_ready: AtomicBool,
    queued: Mutex<Vec<Value>>,
    pending_transfer: Mutex<Option<(String, String)>>,
    saves: (Mutex<u64>, Condvar),
    pub vault: Mutex<VaultState>,
    hidden: Mutex<Hidden>,
    #[cfg_attr(mobile, allow(dead_code))]
    quitting: AtomicBool,
    pub notify: notify::Notifier,
}

impl Shell {
    fn new(data_dir: PathBuf, selftest_flag: bool, log_calls: bool) -> Self {
        let selftest_root = std::env::temp_dir().join(format!("notemaker-selftest-{}", std::process::id()));
        Shell {
            selftest_flag,
            log_calls,
            storage: storage::Storage::new(data_dir),
            selftest_storage: storage::Storage::new(selftest_root),
            page_ready: AtomicBool::new(false),
            queued: Mutex::new(Vec::new()),
            pending_transfer: Mutex::new(None),
            saves: (Mutex::new(0), Condvar::new()),
            vault: Mutex::new(VaultState { unlocked: false, auto_lock_minutes: 5 }),
            hidden: Mutex::new(Hidden::default()),
            quitting: AtomicBool::new(false),
            notify: notify::Notifier::default(),
        }
    }

    pub fn log(&self, m: &str) {
        if self.log_calls {
            println!("{m}");
        }
    }

    pub fn note_saved(&self) {
        let (m, c) = &self.saves;
        *lock_or_recover(m) += 1;
        c.notify_all();
    }

    /// Wait until a `storage.save` arrives after `since`, or the timeout passes.
    #[cfg(desktop)]
    fn wait_for_save(&self, since: u64, timeout: Duration) -> bool {
        let (m, c) = &self.saves;
        let g = lock_or_recover(m);
        let (g, _) = c.wait_timeout_while(g, timeout, |n| *n == since).unwrap_or_else(|p| p.into_inner());
        *g != since
    }

    #[cfg(desktop)]
    fn save_count(&self) -> u64 {
        *lock_or_recover(&self.saves.0)
    }

    pub fn take_transfer(&self) -> Option<(String, String)> {
        lock_or_recover(&self.pending_transfer).take()
    }
}

/// Send a `notemaker-native` event to the page (queued until the page reports it is ready).
pub fn send<R: Runtime>(app: &AppHandle<R>, ty: &str, data: Value) {
    let shell = app.state::<Shell>();
    let mut detail = match data {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    detail.insert("type".into(), json!(ty));
    let detail = Value::Object(detail);
    if !shell.page_ready.load(Ordering::SeqCst) {
        shell.log(&format!("bridge → event {ty} (queued until the page is ready)"));
        lock_or_recover(&shell.queued).push(detail);
        return;
    }
    shell.log(&format!("bridge → event {ty}"));
    dispatch(app, &detail);
}

fn dispatch<R: Runtime>(app: &AppHandle<R>, detail: &Value) {
    if let Some(w) = app.get_webview_window("main") {
        // serde_json output is a valid JS expression; the page-side function is non-writable (bridge.js)
        let _ = w.eval(format!("window.__notemakerNativeEvent && window.__notemakerNativeEvent({detail});"));
    }
}

pub fn page_ready<R: Runtime>(app: &AppHandle<R>) {
    let shell = app.state::<Shell>();
    shell.page_ready.store(true, Ordering::SeqCst);
    let queued: Vec<Value> = std::mem::take(&mut *lock_or_recover(&shell.queued));
    for d in queued {
        dispatch(app, &d);
    }
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(desktop)]
        {
            let _ = w.unminimize();
            let _ = w.show();
        }
        let _ = w.set_focus();
    }
    mark_shown(app);
}

// ---------------------------------------------------------------- windowHidden / windowShown

pub fn mark_hidden<R: Runtime>(app: &AppHandle<R>, reason: &str) {
    let shell = app.state::<Shell>();
    {
        let mut h = lock_or_recover(&shell.hidden);
        if h.reason.is_some() {
            return;
        }
        h.reason = Some(reason.to_string());
        h.since = Some(Instant::now());
    }
    send(app, "windowHidden", json!({ "reason": reason }));
}

/// → how long the window was hidden (None if it wasn't).
pub fn mark_shown<R: Runtime>(app: &AppHandle<R>) -> Option<Duration> {
    let shell = app.state::<Shell>();
    let elapsed = {
        let mut h = lock_or_recover(&shell.hidden);
        h.inactive_generation += 1;
        h.reason.as_ref()?;
        h.reason = None;
        h.since.take().map(|s| s.elapsed())
    };
    send(app, "windowShown", json!({}));
    elapsed
}

/// The vault must lock now (`lock {reason}`).
pub fn lock_vault<R: Runtime>(app: &AppHandle<R>, reason: &str) {
    send(app, "lock", json!({ "reason": reason }));
}

// ---------------------------------------------------------------- transfer files

/// A `.notemaker` file argument (plain path or file:// URL)?
fn transfer_arg(arg: &str) -> Option<PathBuf> {
    if arg.starts_with('-') {
        return None;
    }
    let p = match arg.strip_prefix("file://") {
        Some(rest) => PathBuf::from(percent_decode(rest)),
        None => PathBuf::from(arg),
    };
    let ext = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    (ext.as_deref() == Some("notemaker")).then_some(p)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Handle command-line arguments (first launch, or forwarded by the single-instance plugin).
pub fn handle_args<R: Runtime>(app: &AppHandle<R>, args: &[String]) {
    for a in args.iter().skip(1) {
        if let Some(p) = transfer_arg(a) {
            open_transfer_file(app, p, None);
        }
    }
}

pub type DoneFn = Box<dyn FnOnce(bool) + Send>;

/// Read a .notemaker file off the main thread and send `openTransfer` (queued until the page is ready).
/// The page receives a `__transfer` notice and fetches the bytes with `shell.takeTransfer` (IPC, not eval).
pub fn open_transfer_file<R: Runtime>(app: &AppHandle<R>, path: PathBuf, done: Option<DoneFn>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("transfer.notemaker").to_string();
        let result = read_transfer(&path, &name);
        let ok = result.is_ok();
        match result {
            Ok(b64) => {
                *lock_or_recover(&app.state::<Shell>().pending_transfer) = Some((name, b64));
                send(&app, "__transfer", json!({}));
                let a2 = app.clone();
                let _ = app.run_on_main_thread(move || show_main(&a2));
            }
            Err((title, text)) => alert(&app, &title, &text),
        }
        if let Some(d) = done {
            d(ok);
        }
    });
}

fn read_transfer(path: &Path, name: &str) -> Result<String, (String, String)> {
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if ext.as_deref() != Some("notemaker") {
        return Err((
            format!("“{name}” isn’t a Notemaker transfer file."),
            "Transfer files end in .notemaker. To restore an older JSON backup, use File → Import…".into(),
        ));
    }
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size > MAX_TRANSFER_BYTES {
        return Err((format!("“{name}” is too large."), "Transfer files can be at most 1 GB.".into()));
    }
    std::fs::read(path)
        .map(|b| vaultcrypto::b64_encode(&b))
        .map_err(|e| (format!("Couldn’t open “{name}”."), e.to_string()))
}

pub fn alert<R: Runtime>(app: &AppHandle<R>, title: &str, text: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    app.dialog().message(text).title(title).kind(MessageDialogKind::Warning).show(|_| {});
}

// ---------------------------------------------------------------- quit (desktop)

/// Quit: tell the page (lock + beforeQuit), wait up to 1 s for its final `storage.save`, then exit.
#[cfg(desktop)]
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let shell = app.state::<Shell>();
    if shell.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    if !shell.page_ready.load(Ordering::SeqCst) || shell.selftest_flag {
        app.exit(0);
        return;
    }
    let before = shell.save_count();
    lock_vault(app, "quit");
    send(app, "beforeQuit", json!({}));
    let app = app.clone();
    std::thread::spawn(move || {
        let saved = app.state::<Shell>().wait_for_save(before, Duration::from_millis(1000));
        app.state::<Shell>().log(&format!("quit: {}", if saved { "saved" } else { "no save within 1 s" }));
        app.exit(0);
    });
}

// ---------------------------------------------------------------- main window

fn init_script(selftest: bool) -> String {
    BRIDGE_JS
        .replace("__NM_PLATFORM__", PLATFORM)
        .replace("__NM_VERSION__", env!("CARGO_PKG_VERSION"))
        .replace("__NM_SELFTEST__", if selftest { "true" } else { "false" })
}

/// The bundled app origin: tauri://localhost (Linux) or https://tauri.localhost (Windows / Android).
pub fn is_app_url(u: &tauri::Url) -> bool {
    match u.scheme() {
        "tauri" => u.host_str() == Some("localhost"),
        "http" | "https" => u.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

fn create_main_window<R: Runtime>(app: &AppHandle<R>, url: &str) -> tauri::Result<()> {
    let shell = app.state::<Shell>();
    let nav_app = app.clone();
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.into()))
        .initialization_script(init_script(shell.selftest_flag))
        .use_https_scheme(true)
        .on_navigation(move |u| {
            if is_app_url(u) {
                return true;
            }
            // links never open inside the shell: http(s)/mailto go to the default browser / mail app
            if matches!(u.scheme(), "http" | "https" | "mailto") {
                use tauri_plugin_opener::OpenerExt;
                let _ = nav_app.opener().open_url(u.as_str(), None::<&str>);
                return false;
            }
            matches!(u.scheme(), "about" | "blob" | "data")
        })
        .on_page_load(|w, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                w.app_handle().state::<Shell>().page_ready.store(false, Ordering::SeqCst);
            }
        });
    #[cfg(desktop)]
    let builder = {
        let menu = desktop::build_menu(app)?;
        builder
            .title("Notemaker")
            .inner_size(1200.0, 800.0)
            .min_inner_size(380.0, 520.0)
            .menu(menu)
            .disable_drag_drop_handler()
    };
    builder.build()?;
    Ok(())
}

// ---------------------------------------------------------------- entry point

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let selftest_flag = cfg!(desktop) && args.iter().any(|a| a == "--bridge-selftest");
    let log_calls = args.iter().any(|a| a == "--bridge-log") || selftest_flag;

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        show_main(app);
        handle_args(app, &argv);
    }));
    #[cfg(target_os = "android")]
    let builder = builder.plugin(hw::android::init());

    let app = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![bridge::bridge])
        .setup(move |app| {
            let handle = app.handle().clone();
            let data_dir = handle.path().app_data_dir()?;
            app.manage(Shell::new(data_dir, selftest_flag, log_calls));
            let start = if selftest_flag { "selftest/index.html" } else { "index.html" };
            create_main_window(&handle, start)?;
            notify::setup(&handle);
            lock::start(&handle);
            #[cfg(desktop)]
            {
                desktop::setup_tray(&handle)?;
                handle_args(&handle, &args);
            }
            #[cfg(target_os = "android")]
            {
                let h = handle.clone();
                std::thread::spawn(move || android_after_launch(&h));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Notemaker");

    app.run(|app, event| match event {
        #[cfg(desktop)]
        RunEvent::ExitRequested { api, code, .. } => {
            // A quit that didn't come from request_quit (e.g. the session ending): flush first.
            if code.is_none() && !app.state::<Shell>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_quit(app);
            }
        }
        RunEvent::WindowEvent { label, event, .. } if label == "main" => on_window_event(app, &event),
        _ => {}
    });
}

fn on_window_event<R: Runtime>(app: &AppHandle<R>, event: &WindowEvent) {
    match event {
        #[cfg(desktop)]
        WindowEvent::CloseRequested { api, .. } => {
            // Closing the window hides it (the app stays in the tray); Quit (tray / File menu) quits.
            let shell = app.state::<Shell>();
            if !shell.quitting.load(Ordering::SeqCst) && !shell.selftest_flag {
                api.prevent_close();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                mark_hidden(app, "closed");
            }
        }
        #[cfg(desktop)]
        WindowEvent::Focused(false) => {
            let shell = app.state::<Shell>();
            let generation = {
                let mut h = lock_or_recover(&shell.hidden);
                h.inactive_generation += 1;
                h.inactive_generation
            };
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(30));
                let still = lock_or_recover(&app.state::<Shell>().hidden).inactive_generation == generation;
                if still {
                    mark_hidden(&app, "inactive");
                }
            });
        }
        #[cfg(desktop)]
        WindowEvent::Focused(true) => {
            mark_shown(app);
        }
        #[cfg(mobile)]
        WindowEvent::Suspended => mark_hidden(app, "background"),
        #[cfg(mobile)]
        WindowEvent::Resumed => {
            #[cfg(target_os = "android")]
            {
                let app = app.clone();
                std::thread::spawn(move || android_resumed(&app));
            }
        }
        _ => {}
    }
}

#[cfg(target_os = "android")]
fn android_after_launch<R: Runtime>(app: &AppHandle<R>) {
    // Self-test page: debug builds only (`adb shell am start … --ez notemaker.selftest true`).
    let info = hw::android::launch_info(app);
    if cfg!(debug_assertions) && info.selftest {
        // navigate only after the initial page has loaded, or that first load would replace the self-test page
        for _ in 0..100 {
            if app.state::<Shell>().page_ready.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        if let (Some(w), Ok(u)) = (app.get_webview_window("main"), tauri::Url::parse(if info.hw { "https://tauri.localhost/selftest/index.html?hw=1" } else { "https://tauri.localhost/selftest/index.html" })) {
            let _ = w.navigate(u);
        }
        return;
    }
    android_check_intent(app);
}

/// A `.notemaker` file the app was opened with: Kotlin copied the content:// stream into the cache.
#[cfg(target_os = "android")]
fn android_check_intent<R: Runtime>(app: &AppHandle<R>) {
    let f = hw::android::take_pending_file(app);
    if let Some(err) = f.error {
        alert(app, "Couldn’t open the file.", &err);
    } else if let Some(p) = f.path {
        let cleanup = PathBuf::from(&p);
        open_transfer_file(app, PathBuf::from(p), Some(Box::new(move |_| {
            let _ = std::fs::remove_file(&cleanup);
        })));
    }
}

#[cfg(target_os = "android")]
fn android_resumed<R: Runtime>(app: &AppHandle<R>) {
    let away = mark_shown(app);
    let (unlocked, minutes) = {
        let shell = app.state::<Shell>();
        let v = lock_or_recover(&shell.vault);
        (v.unlocked, v.auto_lock_minutes)
    };
    let screen_off = hw::android::take_screen_off(app) > 0;
    let too_long = away.map(|d| d.as_secs() as i64 >= minutes * 60).unwrap_or(false);
    if unlocked && (screen_off || too_long) {
        lock_vault(app, "screen-lock");
    }
    android_check_intent(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_args() {
        assert_eq!(transfer_arg("/home/u/Notemaker transfer.notemaker"), Some(PathBuf::from("/home/u/Notemaker transfer.notemaker")));
        assert_eq!(transfer_arg("C:\\Users\\u\\x.NOTEMAKER"), Some(PathBuf::from("C:\\Users\\u\\x.NOTEMAKER")));
        assert_eq!(transfer_arg("file:///home/u/a%20b.notemaker"), Some(PathBuf::from("/home/u/a b.notemaker")));
        assert_eq!(transfer_arg("--bridge-selftest"), None);
        assert_eq!(transfer_arg("/home/u/backup.json"), None);
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    #[test]
    fn app_urls() {
        assert!(is_app_url(&tauri::Url::parse("tauri://localhost/index.html").unwrap()));
        assert!(is_app_url(&tauri::Url::parse("https://tauri.localhost/index.html").unwrap()));
        assert!(!is_app_url(&tauri::Url::parse("https://tauri.localhost.evil.com/").unwrap()));
        assert!(!is_app_url(&tauri::Url::parse("https://example.com/").unwrap()));
    }

    #[test]
    fn init_script_placeholders() {
        let s = init_script(false);
        assert!(!s.contains("__NM_"));
        assert!(s.contains(&format!("\"{PLATFORM}\"")));
    }
}
