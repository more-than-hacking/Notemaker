/* Notemaker — scheduler: task reminders (Notification API with in-app toast fallback), daily review prompt,
   midnight date change + rollover. Runs only while the app is open. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state;
    const FIRED_KEY = 'notemaker_fired';
    const REVIEW_KEY = 'notemaker_review_prompted';
    const GRACE_MIN = 15;         // fire a reminder up to 15 min late (e.g. app opened just after)
    const REVIEW_WINDOW_MIN = 180; // auto-prompt the review within 3 h after reviewTime

    NM.notify = function (title, body, tag) {
        if (NM.native) {
            NM.native.request('notify.show', { title, body }).catch(() => NM.toast(title + ' — ' + body, 'reminder', 10000));
            if (document.visibilityState === 'visible') NM.toast(title + ' — ' + body, 'reminder', 8000);
            return;
        }
        const perm = NM.notifyPermission();
        if (perm === 'granted') {
            const opts = { body, tag: tag || undefined, icon: 'web-icons/icon-192.png', badge: 'web-icons/icon-192.png' };
            try {
                const n = new Notification(title, opts);
                n.onclick = () => { window.focus(); n.close(); };
                if (document.visibilityState === 'visible') NM.toast(title + ' — ' + body, 'reminder', 8000);
                return;
            } catch (e) {
                // some mobile browsers only allow notifications through the service worker
                if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                    navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts)).catch(() => NM.toast(title + ' — ' + body, 'reminder', 10000));
                    return;
                }
            }
        }
        NM.toast(title + ' — ' + body, 'reminder', 10000);
    };

    function loadFired(today) {
        try { const f = JSON.parse(NM.ls.get(FIRED_KEY) || '{}'); return f.date === today ? f : { date: today, ids: [] }; } catch (e) { return { date: today, ids: [] }; }
    }
    function checkReminders() {
        const today = C.localToday();
        const now = C.timeToMin(C.localTimeHM());
        const fired = loadFired(today);
        let changed = false;
        for (const t of S.doc.tasks) {
            if (!t.reminder || !C.occursOn(t, today) || C.isDoneOn(t, today)) continue;
            const m = C.timeToMin(t.reminder);
            if (m > now || now - m > GRACE_MIN) continue;
            if (fired.ids.includes(t.id)) continue;
            fired.ids.push(t.id);
            changed = true;
            NM.notify('⏰ ' + t.title, 'Reminder for ' + t.reminder + (t.tags.length ? ' · #' + t.tags.join(' #') : ''), 'task-' + t.id);
        }
        if (changed) try { NM.ls.set(FIRED_KEY, JSON.stringify(fired)); } catch (e) { /* */ }
    }

    function checkReview() {
        const rt = S.doc.settings.reviewTime;
        if (!rt) return;
        const today = C.localToday();
        if (NM.ls.get(REVIEW_KEY) === today) return;
        const now = C.timeToMin(C.localTimeHM()), m = C.timeToMin(rt);
        if (now < m || now - m > REVIEW_WINDOW_MIN) return;
        if (NM.overlayOpen() || (NM.notes && NM.notes.isEditing())) return; // try again on the next tick
        try { NM.ls.set(REVIEW_KEY, today); } catch (e) { /* */ }
        NM.notify('✨ Daily review', 'Time to wrap up the day.', 'review');
        NM.openReview(today);
    }

    function checkDayChange() {
        const today = C.localToday();
        if (today === S.today) return;
        const wasOnToday = S.date === S.today;
        S.today = today;
        if (wasOnToday) { if (NM.beforeDateChange) NM.beforeDateChange(today); S.date = today; }
        const n = NM.runRollover();
        if (n) NM.toast(n + ' unfinished task(s) rolled over to today');
        NM.render();
        if (NM.syncNative) NM.syncNative(true);
    }

    function tick() {
        // desktop shell: reminders are scheduled natively via notify.sync (they fire even when the app is closed)
        try { checkDayChange(); if (!NM.native) checkReminders(); checkReview(); } catch (e) { console.error('Notemaker scheduler', e); }
    }
    NM.startScheduler = function () {
        tick();
        setInterval(tick, 15000);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
    };
})();
