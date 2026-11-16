//! `notify.*` — reminders.
//!   Android: scheduled with tauri-plugin-notification (AlarmManager) → they fire while the app is closed.
//!   Windows / Linux: a timer thread shows them while the app runs (the window can be closed to the tray).
//! Clicking a reminder sends `openDay {day}`.

use crate::lock_or_recover;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::{NotificationExt, PermissionState};

#[derive(Clone, Debug)]
pub struct Reminder {
    pub id: String,
    pub title: String,
    pub body: String,
    pub at_ms: i64,
    pub day: String,
}

/// Desktop scheduler state + notification id → day (for clicks).
#[derive(Default)]
pub struct Notifier {
    #[cfg_attr(mobile, allow(dead_code))]
    pending: Arc<(Mutex<Vec<Reminder>>, Condvar)>,
    days: Mutex<HashMap<i32, String>>,
    #[allow(dead_code)]
    focus: Mutex<FocusState>,
}

#[derive(Default)]
#[allow(dead_code)]
struct FocusState {
    label: Option<String>,
    last_post_ms: i64,
}

pub const FOCUS_NOTIFICATION_ID: i32 = 7_000_001;

/// Stable positive i32 id for a reminder id (FNV-1a), never the focus-timer id.
pub fn notification_id(s: &str) -> i32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    let id = (h & 0x3fff_ffff) as i32 + 1;
    if id == FOCUS_NOTIFICATION_ID { id + 1 } else { id }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let a = app.clone();
    let _ = app.notification().on_action(move |performed| {
        if performed.action_id() != "tap" {
            return;
        }
        let Some(n) = performed.notification() else { return };
        let day = n
            .extra()
            .get("day")
            .and_then(|d| d.as_str().map(str::to_string))
            .or_else(|| lock_or_recover(&a.state::<crate::Shell>().notify.days).get(&n.id()).cloned());
        if let Some(day) = day.filter(|d| crate::vaultcrypto::is_valid_day_string(d)) {
            let a2 = a.clone();
            let _ = a.run_on_main_thread(move || {
                crate::show_main(&a2);
                crate::send(&a2, "openDay", json!({ "day": day }));
            });
        }
    });
    #[cfg(desktop)]
    start_desktop_scheduler(app);
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_notification::{Channel, Importance};
        let n = app.notification();
        let _ = n.create_channel(Channel::builder("reminders", "Reminders").importance(Importance::High).build());
        let _ = n.create_channel(Channel::builder("focus", "Focus timer").importance(Importance::Low).build());
    }
}

fn status(s: PermissionState) -> &'static str {
    match s {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        _ => "default",
    }
}

/// `notify.permission` / `notify.request` (blocking on Android 13+, where the system asks the user).
pub fn permission<R: Runtime>(app: &AppHandle<R>, request: bool) -> &'static str {
    let n = app.notification();
    let r = if request { n.request_permission() } else { n.permission_state() };
    r.map(status).unwrap_or("default")
}

pub fn show<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) {
    let mut b = app.notification().builder().title(title).body(body);
    if cfg!(target_os = "android") {
        b = b.channel_id("reminders");
    }
    let _ = b.show();
}

fn remember_days(app_days: &Mutex<HashMap<i32, String>>, items: &[Reminder]) {
    let mut m = lock_or_recover(app_days);
    if m.len() > 500 {
        m.clear();
    }
    for r in items {
        m.insert(notification_id(&r.id), r.day.clone());
    }
}

/// `notify.sync`: replace ALL pending reminders with `items`. → number scheduled (future ones).
pub fn sync<R: Runtime>(app: &AppHandle<R>, items: Vec<Reminder>) -> usize {
    let now = now_ms();
    let future: Vec<Reminder> = items.into_iter().filter(|r| r.at_ms > now).collect();
    let shell = app.state::<crate::Shell>();
    remember_days(&shell.notify.days, &future);
    #[cfg(desktop)]
    {
        let (m, c) = &*shell.notify.pending;
        *lock_or_recover(m) = future.clone();
        c.notify_all();
        future.len()
    }
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_notification::Schedule;
        let n = app.notification();
        let _ = n.cancel_all(); // pending (scheduled) ones only — the ongoing focus notification stays
        let mut ok = 0;
        for r in &future {
            let Ok(date) = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(r.at_ms) * 1_000_000) else { continue };
            let res = n
                .builder()
                .id(notification_id(&r.id))
                .channel_id("reminders")
                .title(&r.title)
                .body(&r.body)
                .extra("day", &r.day)
                .auto_cancel()
                .schedule(Schedule::At { date, repeating: false, allow_while_idle: true })
                .show();
            if res.is_ok() {
                ok += 1;
            }
        }
        ok
    }
}

/// Desktop: fire due reminders while the app runs. Missed ones (e.g. the PC slept) are shown on wake if they are
/// less than an hour late.
#[cfg(desktop)]
fn start_desktop_scheduler<R: Runtime>(app: &AppHandle<R>) {
    let pending = app.state::<crate::Shell>().notify.pending.clone();
    let app = app.clone();
    std::thread::Builder::new()
        .name("notemaker-reminders".into())
        .spawn(move || {
            let (m, c) = &*pending;
            let mut g = lock_or_recover(m);
            loop {
                let now = now_ms();
                let (due, rest): (Vec<Reminder>, Vec<Reminder>) = g.drain(..).partition(|r| r.at_ms <= now);
                *g = rest;
                for r in due {
                    if now - r.at_ms < 3_600_000 {
                        let _ = app
                            .notification()
                            .builder()
                            .id(notification_id(&r.id))
                            .title(&r.title)
                            .body(&r.body)
                            .extra("day", &r.day)
                            .show();
                    }
                }
                let next = g.iter().map(|r| r.at_ms).min();
                // wake at least every 30 s so a clock change or system sleep doesn't delay reminders much
                let wait = next.map(|t| (t - now_ms()).clamp(50, 30_000)).unwrap_or(30_000);
                g = c.wait_timeout(g, std::time::Duration::from_millis(wait as u64)).map(|r| r.0).unwrap_or_else(|p| p.into_inner().0);
            }
        })
        .ok();
}

/// Android: `app.setFocusTimer` → an ongoing, silent notification (throttled to one update every 5 s).
#[cfg(target_os = "android")]
pub fn set_focus_timer<R: Runtime>(app: &AppHandle<R>, label: Option<String>, phase: Option<String>) {
    let shell = app.state::<crate::Shell>();
    let mut f = lock_or_recover(&shell.notify.focus);
    let n = app.notification();
    match label {
        None => {
            if f.label.take().is_some() {
                let _ = n.remove_active(vec![FOCUS_NOTIFICATION_ID]);
            }
        }
        Some(l) => {
            let now = now_ms();
            if f.label.as_deref() == Some(l.as_str()) || (f.label.is_some() && now - f.last_post_ms < 5_000) {
                return;
            }
            f.label = Some(l.clone());
            f.last_post_ms = now;
            let title = if phase.as_deref() == Some("break") { "Notemaker — break" } else { "Notemaker — focus" };
            let _ = n
                .builder()
                .id(FOCUS_NOTIFICATION_ID)
                .channel_id("focus")
                .title(title)
                .body(l)
                .ongoing()
                .silent()
                .show();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_stable_positive_and_not_focus() {
        let a = notification_id("task-1|2026-11-16");
        assert_eq!(a, notification_id("task-1|2026-11-16"));
        assert_ne!(a, notification_id("task-1|2026-11-17"));
        for i in 0..2000 {
            let id = notification_id(&format!("t{i}"));
            assert!(id > 0 && id != FOCUS_NOTIFICATION_ID);
        }
    }
}
