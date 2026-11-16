//! Lock the vault on system suspend / session lock (`lock {reason: "sleep" | "screen-lock" | "idle-system"}`).
//!   Linux:   logind `PrepareForSleep(true)` and session `Lock` (system bus), plus the freedesktop / GNOME
//!            screensaver `ActiveChanged(true)` (session bus) — D-Bus via zbus.
//!   Windows: a hidden window receiving `WM_POWERBROADCAST/PBT_APMSUSPEND` and `WM_WTSSESSION_CHANGE/WTS_SESSION_LOCK`,
//!            and system idle time (`GetLastInputInfo`) while the vault is unlocked (`app.vaultState`).
//!   Android: handled on resume in lib.rs (background longer than the auto-lock time, or screen turned off).

use tauri::{AppHandle, Runtime};

#[allow(unused_variables)]
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "linux")]
    linux::start(app);
    #[cfg(windows)]
    windows_lock::start(app);
}

#[cfg(target_os = "linux")]
mod linux {
    use tauri::{AppHandle, Runtime};
    use zbus::blocking::{Connection, MessageIterator};
    use zbus::message::Type;
    use zbus::MatchRule;

    fn watch<R: Runtime>(
        app: AppHandle<R>,
        system: bool,
        interface: &'static str,
        member: &'static str,
        reason: &'static str,
        needs_true: bool,
    ) {
        let _ = std::thread::Builder::new().name(format!("notemaker-dbus-{member}")).spawn(move || {
            let conn = if system { Connection::system() } else { Connection::session() };
            let Ok(conn) = conn else { return };
            let Ok(rule) = MatchRule::builder().msg_type(Type::Signal).interface(interface).and_then(|b| b.member(member)).map(|b| b.build())
            else {
                return;
            };
            let Ok(iter) = MessageIterator::for_match_rule(rule, &conn, Some(64)) else { return };
            for msg in iter.flatten() {
                let fire = if needs_true { msg.body().deserialize::<bool>().unwrap_or(false) } else { true };
                if fire {
                    crate::lock_vault(&app, reason);
                }
            }
        });
    }

    pub fn start<R: Runtime>(app: &AppHandle<R>) {
        watch(app.clone(), true, "org.freedesktop.login1.Manager", "PrepareForSleep", "sleep", true);
        // Lock is sent to every session object; a lock of another user's session is harmless (we only lock).
        watch(app.clone(), true, "org.freedesktop.login1.Session", "Lock", "screen-lock", false);
        watch(app.clone(), false, "org.freedesktop.ScreenSaver", "ActiveChanged", "screen-lock", true);
        watch(app.clone(), false, "org.gnome.ScreenSaver", "ActiveChanged", "screen-lock", true);
    }
}

#[cfg(windows)]
mod windows_lock {
    use crate::{lock_or_recover, Shell};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Manager, Runtime};
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage, MSG,
        PBT_APMSUSPEND, WINDOW_EX_STYLE, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WNDCLASSW, WS_POPUP, WTS_SESSION_LOCK,
    };

    static FIRE: OnceLock<Box<dyn Fn(&'static str) + Send + Sync>> = OnceLock::new();

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match msg {
            WM_WTSSESSION_CHANGE if wparam.0 as u32 == WTS_SESSION_LOCK => {
                if let Some(f) = FIRE.get() {
                    f("screen-lock");
                }
            }
            WM_POWERBROADCAST if wparam.0 as u32 == PBT_APMSUSPEND => {
                if let Some(f) = FIRE.get() {
                    f("sleep");
                }
            }
            _ => {}
        }
        // SAFETY: forwarding the message we were given to the default window procedure.
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    pub fn start<R: Runtime>(app: &AppHandle<R>) {
        let a = app.clone();
        let _ = FIRE.set(Box::new(move |reason| crate::lock_vault(&a, reason)));
        let _ = std::thread::Builder::new().name("notemaker-power".into()).spawn(|| {
            // SAFETY: standard Win32 window-class registration and message loop on this thread; the window is never shown.
            unsafe {
                let Ok(hinstance) = GetModuleHandleW(None) else { return };
                let class = w!("NotemakerPowerWatcher");
                let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: hinstance.into(), lpszClassName: class, ..Default::default() };
                if RegisterClassW(&wc) == 0 {
                    return;
                }
                // A hidden top-level window (message-only windows don't get WM_POWERBROADCAST).
                let Ok(hwnd) = CreateWindowExW(WINDOW_EX_STYLE(0), class, w!(""), WS_POPUP, 0, 0, 0, 0, None, None, Some(hinstance.into()), None)
                else {
                    return;
                };
                let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        });

        // System-wide idle lock while the vault is unlocked (checked every 30 s), like the macOS shell.
        let app = app.clone();
        let _ = std::thread::Builder::new().name("notemaker-idle".into()).spawn(move || {
            let mut sent = false;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(30));
                let (unlocked, minutes) = {
                    let shell = app.state::<Shell>();
                    let v = lock_or_recover(&shell.vault);
                    (v.unlocked, v.auto_lock_minutes)
                };
                if !unlocked {
                    sent = false;
                    continue;
                }
                let idle = idle_seconds().unwrap_or(0);
                if idle >= (minutes as u64) * 60 {
                    if !sent {
                        sent = true;
                        crate::lock_vault(&app, "idle-system");
                    }
                } else {
                    sent = false;
                }
            }
        });
    }

    fn idle_seconds() -> Option<u64> {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: `info` is a properly sized LASTINPUTINFO.
        let ok = unsafe { GetLastInputInfo(&mut info) }.as_bool();
        if !ok {
            return None;
        }
        // SAFETY: GetTickCount has no preconditions.
        let now = unsafe { windows::Win32::System::SystemInformation::GetTickCount() };
        Some(u64::from(now.wrapping_sub(info.dwTime)) / 1000)
    }
}
