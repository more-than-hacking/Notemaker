/*
 * Notemaker — desktop-shell bridge client (docs/DESKTOP_BRIDGE.md) + environment-neutral helpers.
 * In a normal browser window.NotemakerNative is absent: createBridge() returns null and every caller
 * falls back to the browser behaviour. Pure parts (persistence, reminder schedule, SE vault slots)
 * run in Node for tests (module.exports) and attach to window.NotemakerNativeClient in the browser.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NotemakerNativeClient = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const KEY_V2 = 'notemaker_v2', V1_TASKS = 'notemaker_tasks', V1_NOTES = 'notemaker_notes', V1_THEME = 'notemaker_theme';

    /** Wrap window.NotemakerNative → { request(method, params) → Promise, on(type, fn) } or null in a browser. */
    function createBridge(win) {
        const nat = win && win.NotemakerNative;
        if (!nat || !nat.isDesktop || typeof nat.request !== 'function') return null;
        const listeners = {};
        win.addEventListener('notemaker-native', (e) => {
            const d = (e && e.detail) || {};
            (listeners[d.type] || []).slice().forEach((fn) => { try { fn(d); } catch (err) { if (win.console) win.console.error('native event handler', err); } });
        });
        return {
            isDesktop: true, platform: nat.platform || 'macos', shellVersion: nat.shellVersion || '',
            request(method, params) {
                try { return Promise.resolve(nat.request(method, params || {})); } catch (e) { return Promise.reject(e); }
            },
            on(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); return () => { listeners[type] = listeners[type].filter((f) => f !== fn); }; }
        };
    }

    /**
     * Document persistence. Browser: localStorage `notemaker_v2` (synchronous writes).
     * Desktop: storage.load / storage.save (debounced; flush() on beforeunload / beforeQuit).
     * opts: { bridge, storage (localStorage-like), core, delay = 500, setTimer, clearTimer }
     */
    function createPersistence(opts) {
        const bridge = opts.bridge, ls = opts.storage, C = opts.core;
        const delay = opts.delay == null ? 500 : opts.delay;
        const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
        const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
        const lsGet = (k) => { try { return ls ? ls.getItem(k) : null; } catch (e) { return null; } };
        let pending = null, timer = null, blocked = false, inflight = Promise.resolve();

        function fromLocal() {
            const raw = lsGet(KEY_V2);
            if (raw) return { doc: C.normalizeDoc(JSON.parse(raw)), source: 'local-v2' };
            const t = lsGet(V1_TASKS), n = lsGet(V1_NOTES);
            if (t || n) return { doc: C.migrateV1(JSON.parse(t || '[]'), JSON.parse(n || '[]'), { theme: lsGet(V1_THEME) }), source: 'local-v1' };
            return null;
        }

        /** → { doc, source: 'native'|'local-v2'|'local-v1'|'new', migrated: bool, error?: string } */
        async function load() {
            if (!bridge) {
                let r = null, error = null;
                try { r = fromLocal(); } catch (e) {
                    const raw = lsGet(KEY_V2);
                    try { if (raw) ls.setItem(KEY_V2 + '_corrupt_' + Date.now(), raw); } catch (_) { /* quota */ }
                    error = 'Saved data could not be read; a copy was kept and a fresh notebook started.';
                    try { if (raw) ls.removeItem(KEY_V2); r = fromLocal(); } catch (_) { r = null; }
                }
                if (!r) r = { doc: C.emptyDoc(), source: 'new' };
                return { doc: r.doc, source: r.source, migrated: r.source === 'local-v1', error };
            }
            const res = await bridge.request('storage.load');
            const json = res && typeof res.json === 'string' ? res.json : null;
            if (json) {
                try { return { doc: C.normalizeDoc(JSON.parse(json)), source: 'native', migrated: false }; } catch (e) {
                    // never overwrite an unreadable data.json
                    blocked = true;
                    return { doc: C.emptyDoc(), source: 'new', migrated: false, error: 'data.json could not be read (' + e.message + '). Nothing will be saved this session so the file stays untouched — import a backup or fix the file.' };
                }
            }
            let r = null;
            try { r = fromLocal(); } catch (e) { r = null; }
            if (!r) r = { doc: C.emptyDoc(), source: 'new' };
            // first launch in the shell: write the migrated/new document right away (localStorage is left untouched as a backup)
            await bridge.request('storage.save', { json: JSON.stringify(r.doc) });
            return { doc: r.doc, source: r.source, migrated: r.source !== 'new' };
        }

        function save(doc) {
            if (blocked) return;
            if (!bridge) { ls.setItem(KEY_V2, JSON.stringify(doc)); return; }
            pending = doc;
            if (timer) clearTimer(timer);
            timer = setTimer(() => { timer = null; flush(); }, delay);
        }
        function flush() {
            if (!bridge || blocked) return Promise.resolve();
            if (timer) { clearTimer(timer); timer = null; }
            if (!pending) return inflight;
            const json = JSON.stringify(pending);
            pending = null;
            inflight = inflight.then(() => bridge.request('storage.save', { json })).catch((e) => { if (opts.onError) opts.onError(e); });
            return inflight;
        }
        return { load, save, flush, isBlocked: () => blocked, hasPending: () => !!pending };
    }

    /**
     * Reminder notifications for notify.sync: every (non-done) task occurrence with a reminder in the next
     * `days` days (default 14, starting today) whose time is still in the future; at most `max` (60), soonest first.
     * now: Date (local time).
     */
    function reminderSchedule(doc, now, C, opts) {
        opts = opts || {};
        const days = opts.days || 14, max = opts.max || 60;
        const today = C.localToday(now);
        const withReminder = doc.tasks.filter((t) => t.reminder);
        const out = [];
        for (let i = 0; i < days; i++) {
            const day = C.addDays(today, i);
            const [y, m, d] = day.split('-').map(Number);
            for (const t of withReminder) {
                if (!C.occursOn(t, day) || C.isDoneOn(t, day)) continue;
                const [hh, mm] = t.reminder.split(':').map(Number);
                const at = new Date(y, m - 1, d, hh, mm, 0, 0);
                if (at <= now) continue;
                out.push({
                    id: t.id + '|' + day, title: '⏰ ' + t.title,
                    body: 'Reminder for ' + t.reminder + (t.tags.length ? ' · #' + t.tags.join(' #') : ''),
                    at: at.toISOString(), day
                });
            }
        }
        out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id.localeCompare(b.id)));
        return out.slice(0, max);
    }

    /** Remaining (not done) task occurrences on a day — Dock badge. */
    function remainingCount(doc, day, C) {
        let n = 0;
        for (const t of doc.tasks) if (C.occursOn(t, day) && !C.isDoneOn(t, day)) n++;
        return n;
    }

    // ---------------- Secure Enclave vault slots (desktop shell) ----------------
    const SE_CODES = ['cancelled', 'not-this-device', 'biometry-changed', 'biometry-unavailable', 'biometry-lockout'];
    function errCode(e) {
        const m = String((e && e.message) || e || '');
        const exact = SE_CODES.find((c) => m === c || m.indexOf(c) >= 0);
        if (exact) return exact;
        return /cancel/i.test(m) ? 'cancelled' : 'error';
    }
    /**
     * What the unlock screen shows for a Secure Enclave error.
     * policy: the slot's policy ("user-presence" default, or "biometry-current-set" = Touch ID only).
     * → { reason, title, text, hardware (offer Touch ID again), recovery (offer the recovery key), replaceSlot }
     */
    function seErrorScreen(code, policy) {
        const touchOnly = policy === 'biometry-current-set';
        switch (code) {
            case 'biometry-changed': return { reason: code, title: 'Your fingerprints changed',
                text: 'Your fingerprints changed, so this Mac’s Touch ID key no longer works. Unlock with your recovery key, then set up Touch ID again.',
                hardware: false, recovery: true, replaceSlot: true };
            case 'biometry-unavailable': return { reason: code, title: 'Touch ID isn’t available',
                text: touchOnly ? 'Touch ID isn’t available right now (lid closed or no fingerprints). This vault only accepts Touch ID, so use your recovery key.'
                    : 'Touch ID isn’t available right now (lid closed or no fingerprints). Use your Mac password or recovery key.',
                hardware: !touchOnly, recovery: true, replaceSlot: false };
            case 'biometry-lockout': return { reason: code, title: 'Touch ID is locked',
                text: 'Too many attempts. Unlock your Mac with your password, then try again.', hardware: true, recovery: true, replaceSlot: false };
            case 'cancelled': return { reason: code, title: '', text: 'Touch ID was cancelled — try again when you’re ready.', hardware: true, recovery: true, replaceSlot: false, quiet: true };
            case 'not-this-device': return { reason: code, title: '', text: '', hardware: false, recovery: true, replaceSlot: false };
            default: return { reason: 'error', title: '', text: 'Touch ID couldn’t open the vault. Try again or use your recovery key.', hardware: true, recovery: true, replaceSlot: false };
        }
    }
    /** Lock on windowHidden (any reason: minimized, app-hidden, inactive, closed) when the setting is on. */
    function shouldLockOnHide(settings) { return !!(settings && settings.vaultLockOnHide); }
    /** app.vaultState payload (autoLockMinutes 1…1440). */
    function vaultStatePayload(unlocked, settings) {
        const m = Math.max(1, Math.min(1440, Math.floor(Number(settings && settings.vaultAutoLockMinutes) || 5)));
        return { unlocked: !!unlocked, autoLockMinutes: m };
    }
    /** clipboard.write params for a secret in the shell: concealed (current host only, not synced) + clears after 30 s. */
    function secretClipboardParams(text) { return { text: String(text), clearAfterSeconds: 30, concealed: true }; }
    const seVault = {
        async available(bridge) {
            try { const r = await bridge.request('se.available'); return { available: !!(r && r.available), device: (r && r.device) || 'this Mac' }; } catch (e) { return { available: false, device: '' }; }
        },
        /** raw: 32-byte VDK (Uint8Array). Returns a validated keyslot. */
        async capabilities(bridge) {
            try { const r = await bridge.request('se.capabilities'); return { touchID: !!(r && r.touchID), enrolled: !!(r && r.enrolled) }; } catch (e) { return { touchID: false, enrolled: false }; }
        },
        async createSlot(bridge, V, raw, label, biometryOnly) {
            const slotId = V.uuid();
            let slot;
            try { slot = await bridge.request('se.createSlot', { slotId, label: label || 'This Mac', vdk: V.b64(raw), biometryOnly: !!biometryOnly }); } catch (e) {
                const code = errCode(e);
                const msg = code === 'cancelled' ? 'Cancelled.' : code === 'biometry-unavailable' ? 'Touch ID isn’t set up on this Mac. Add a fingerprint in System Settings › Touch ID & Password first.'
                    : 'Could not create the Touch ID key: ' + e.message;
                const err = new Error(msg); err.code = code; throw err;
            }
            const clean = V.normalizeVault({ verifier: { iv: 'AAAAAAAAAAAAAAAA', ct: 'AA==' }, keyslots: [slot] });
            if (!clean || clean.keyslots[0].type !== 'secure-enclave') throw new Error('The shell returned an invalid keyslot.');
            return clean.keyslots[0];
        },
        /** Try the vault's secure-enclave slots on this Mac. → { raw (verified, caller zeroes), slot } */
        async unlock(bridge, V, vault) {
            const slots = vault.keyslots.filter((s) => s.type === 'secure-enclave');
            if (!slots.length) { const e = new Error('This vault has no Mac (Secure Enclave) key.'); e.code = 'no-slot'; throw e; }
            let notHere = 0;
            for (const slot of slots) {
                let res;
                try { res = await bridge.request('se.unwrapSlot', { slot }); } catch (e) {
                    const code = errCode(e);
                    if (code === 'not-this-device') { notHere++; continue; }
                    const screen = seErrorScreen(code, slot.policy);
                    const err = new Error(screen.text || 'Unlock failed: ' + e.message); err.code = code; err.slotId = slot.id; err.screen = screen; throw err;
                }
                const raw = V.unb64(res && res.vdk);
                if (raw.length !== 32) continue;
                const key = await V.importVdk(raw, false);
                if (await V.checkVerifier(key, vault.verifier)) return { raw, slot };
                raw.fill(0);
            }
            const e = new Error(notHere === slots.length ? 'None of this vault’s Mac keys are on this Mac. Use the recovery key, then “Add this Mac”.' : 'The Secure Enclave key did not open this vault.');
            e.code = notHere === slots.length ? 'not-this-device' : 'wrong-key';
            throw e;
        },
        /**
         * Switch this Mac's key to a new policy (Touch ID only on/off): create the new slot first, then delete the old
         * handles. If creating fails nothing changes. → { keyslots (new array), slot (new), deleteFailed: [ids] }
         * The old slots are removed from the vault even if deleting their handle fails, so the old key can't open it.
         */
        async switchPolicy(bridge, V, vault, raw, opts) {
            const slot = await seVault.createSlot(bridge, V, raw, opts.label, opts.biometryOnly);
            const old = new Set(opts.oldSlotIds || []);
            const deleteFailed = [];
            for (const id of old) { try { await bridge.request('se.deleteSlot', { slotId: id }); } catch (e) { deleteFailed.push(id); } }
            return { keyslots: vault.keyslots.filter((s) => !old.has(s.id)).concat([slot]), slot, deleteFailed };
        }
    };

    return { createBridge, createPersistence, reminderSchedule, remainingCount, seVault, seErrorScreen, shouldLockOnHide, vaultStatePayload, secretClipboardParams, KEY_V2 };
});
