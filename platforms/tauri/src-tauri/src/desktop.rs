//! Windows / Linux: native menu (same commands as the macOS app), tray icon (focus timer, show, quit).

use crate::{lock_or_recover, send, show_main};
use serde_json::json;
use std::sync::Mutex;
use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

pub const TRAY_ID: &str = "main";

/// (label, command, accelerator). Accelerators only where the web UI has no shortcut of its own, or where
/// the menu and the page do the same thing; never Ctrl+Z / C / V / X / A (native text editing keeps them).
pub const FILE: &[(&str, &str, Option<&str>)] = &[
    ("New Task", "newTask", Some("CmdOrCtrl+N")),
    ("-", "", None),
    ("Export…", "export", Some("CmdOrCtrl+Shift+E")),
    ("Import…", "import", Some("CmdOrCtrl+Shift+I")),
    ("-", "", None),
    ("Move to a New Device…", "transfer", None),
    ("Restore from Another Device…", "restore", None),
];
pub const EDIT: &[(&str, &str, Option<&str>)] =
    &[("Search…", "search", Some("CmdOrCtrl+F")), ("Command Palette…", "palette", Some("CmdOrCtrl+K"))];
pub const VIEWS: &[(&str, &str)] = &[
    ("Day", "day"),
    ("Calendar", "calendar"),
    ("Planner", "planner"),
    ("Board", "board"),
    ("Habits", "habits"),
    ("Insights", "insights"),
    ("Vault", "vault"),
    ("Settings", "settings"),
];
pub const GO: &[(&str, &str, Option<&str>)] = &[
    ("Today", "today", Some("CmdOrCtrl+T")),
    ("Previous Day", "prevDay", Some("CmdOrCtrl+[")),
    ("Next Day", "nextDay", Some("CmdOrCtrl+]")),
    ("-", "", None),
    ("Daily Review…", "review", Some("CmdOrCtrl+Shift+R")),
    ("Start / Stop Focus Timer", "focus.toggle", Some("CmdOrCtrl+Shift+P")),
    ("Lock Vault", "lockVault", Some("CmdOrCtrl+Shift+L")),
];

const CMD: &str = "cmd:";

fn items<R: Runtime>(app: &AppHandle<R>, list: &[(&str, &str, Option<&str>)]) -> tauri::Result<Vec<MenuItemKind<R>>> {
    let mut out = Vec::new();
    for (label, cmd, accel) in list {
        if *label == "-" {
            out.push(MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?));
        } else {
            out.push(MenuItemKind::MenuItem(MenuItem::with_id(app, format!("{CMD}{cmd}"), *label, true, *accel)?));
        }
    }
    Ok(out)
}

fn submenu<R: Runtime>(app: &AppHandle<R>, title: &str, kinds: Vec<MenuItemKind<R>>) -> tauri::Result<Submenu<R>> {
    let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = kinds.iter().map(|k| k as &dyn tauri::menu::IsMenuItem<R>).collect();
    Submenu::with_items(app, title, true, &refs)
}

pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let mut file = items(app, FILE)?;
    file.push(MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?));
    file.push(MenuItemKind::MenuItem(MenuItem::with_id(app, "win:close", "Close Window", true, Some("CmdOrCtrl+W"))?));
    file.push(MenuItemKind::MenuItem(MenuItem::with_id(app, "app:quit", "Quit Notemaker", true, Some("CmdOrCtrl+Q"))?));

    let mut view: Vec<MenuItemKind<R>> = Vec::new();
    for (i, (label, name)) in VIEWS.iter().enumerate() {
        let accel = format!("CmdOrCtrl+{}", i + 1);
        view.push(MenuItemKind::MenuItem(MenuItem::with_id(app, format!("{CMD}view:{name}"), *label, true, Some(accel.as_str()))?));
    }
    view.push(MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?));
    view.push(MenuItemKind::MenuItem(MenuItem::with_id(app, "zoom:reset", "Actual Size", true, Some("CmdOrCtrl+0"))?));
    view.push(MenuItemKind::MenuItem(MenuItem::with_id(app, "zoom:in", "Zoom In", true, Some("CmdOrCtrl+="))?));
    view.push(MenuItemKind::MenuItem(MenuItem::with_id(app, "zoom:out", "Zoom Out", true, Some("CmdOrCtrl+-"))?));

    let about = AboutMetadata {
        name: Some("Notemaker".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        license: Some("MIT".into()),
        website: Some("https://github.com/more-than-hacking/Notemaker".into()),
        comments: Some("Daily tasks, notes, habits and a hardware-protected vault.".into()),
        ..Default::default()
    };
    let help = vec![
        MenuItemKind::MenuItem(MenuItem::with_id(app, "help:github", "Notemaker on GitHub", true, None::<&str>)?),
        MenuItemKind::Predefined(PredefinedMenuItem::about(app, Some("About Notemaker"), Some(about))?),
    ];

    let menu = Menu::with_items(
        app,
        &[
            &submenu(app, "File", file)?,
            &submenu(app, "Edit", items(app, EDIT)?)?,
            &submenu(app, "View", view)?,
            &submenu(app, "Go", items(app, GO)?)?,
            &submenu(app, "Help", help)?,
        ],
    )?;
    let h = app.clone();
    app.on_menu_event(move |_app, e: MenuEvent| on_menu(&h, e.id().as_ref()));
    Ok(menu)
}

static ZOOM: Mutex<f64> = Mutex::new(1.0);

/// Menu / tray item handler (also used by the self-test to "click" an item by id).
pub fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(cmd) = id.strip_prefix(CMD) {
        if cmd == "focus.toggle" {
            show_main(app);
        }
        send(app, "menu", json!({ "command": cmd }));
        return;
    }
    match id {
        "app:quit" | "tray:quit" => crate::request_quit(app),
        "tray:show" => show_main(app),
        "win:close" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.close(); // → CloseRequested → hide to tray
            }
        }
        "help:github" => {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().open_url("https://github.com/more-than-hacking/Notemaker", None::<&str>);
        }
        "zoom:reset" | "zoom:in" | "zoom:out" => {
            let mut z = lock_or_recover(&ZOOM);
            *z = match id {
                "zoom:in" => (*z + 0.1).min(2.0),
                "zoom:out" => (*z - 0.1).max(0.6),
                _ => 1.0,
            };
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_zoom(*z);
            }
        }
        _ => {}
    }
}

/// Does the window menu have an item with this id? (self-test)
pub fn menu_has<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    fn search<R: Runtime>(items: Vec<MenuItemKind<R>>, id: &str) -> bool {
        items.into_iter().any(|k| match k {
            MenuItemKind::Submenu(s) => s.items().map(|i| search(i, id)).unwrap_or(false),
            other => other.id().as_ref() == id,
        })
    }
    app.get_webview_window("main")
        .and_then(|w| w.menu())
        .and_then(|m| m.items().ok())
        .map(|i| search(i, id))
        .unwrap_or(false)
}

pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "tray:show", "Show Notemaker", true, None::<&str>)?,
            &MenuItem::with_id(app, format!("{CMD}focus.toggle"), "Start / Stop Focus Timer", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "tray:quit", "Quit Notemaker", true, None::<&str>)?,
        ],
    )?;
    let mut b = TrayIconBuilder::with_id(TRAY_ID).tooltip("Notemaker").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    let h = app.clone();
    b.on_menu_event(move |_app, e| on_menu(&h, e.id().as_ref()))
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[derive(Default)]
struct FocusShown {
    label: Option<String>,
}
static FOCUS: Mutex<FocusShown> = Mutex::new(FocusShown { label: None });

/// `app.setFocusTimer`: tray tooltip (Windows) / tray label (Linux appindicator) while a timer runs.
pub fn set_focus_timer<R: Runtime>(app: &AppHandle<R>, label: Option<String>, phase: Option<String>) {
    let mut f = lock_or_recover(&FOCUS);
    if f.label == label {
        return; // the page calls this every second; avoid needless redraws
    }
    f.label = label.clone();
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    match label {
        Some(l) => {
            let what = if phase.as_deref() == Some("break") { "break" } else { "focus" };
            let _ = tray.set_tooltip(Some(format!("Notemaker — {what} {l}")));
            #[cfg(target_os = "linux")]
            let _ = tray.set_title(Some(l));
        }
        None => {
            let _ = tray.set_tooltip(Some("Notemaker"));
            #[cfg(target_os = "linux")]
            let _ = tray.set_title(None::<&str>);
        }
    }
}

/// Current tray tooltip as set by us (self-test).
pub fn focus_label() -> Option<String> {
    lock_or_recover(&FOCUS).label.clone()
}
