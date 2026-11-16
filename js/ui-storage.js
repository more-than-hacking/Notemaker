/* Notemaker — storage location (browser only; hidden in the desktop shell, which already stores data in a file).
   Folder storage via the File System Access API (the folder is the source of truth, browser storage a cache mirror),
   persistent-storage request, install hint and backup reminders. Logic: js/storage-core.js. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h, St = window.NotemakerStorage, V = window.NotemakerVault;
    const MODE = 'notemaker_storage', BACKUP_PREF = 'notemaker_backup', HINT = 'notemaker_install_hint', TIP = 'notemaker_folder_tip';
    const ua = navigator.userAgent;
    let folder = null;                 // FolderStore while the folder is the active, permitted storage
    let state = 'off';                 // off | ok | permission | unavailable
    let persistAsked = false, persisted = null, conflictOpen = false;

    /* Test hook for headless runs (the OS folder picker can't be automated). Honoured only on a local file:// page
       opened with ?nm-test — never on a served site or in the desktop shell. */
    const testPicker = () => (location.protocol === 'file:' && !NM.native && new URLSearchParams(location.search).has('nm-test')
        && typeof window.__notemakerPickFolder === 'function') ? window.__notemakerPickFolder : null;
    const env = () => ({ native: !!NM.native, hasPicker: typeof window.showDirectoryPicker === 'function' || !!testPicker(),
        secure: window.isSecureContext !== false, mobile: /Android|iPhone|iPad|iPod/.test(ua) });
    const supported = () => St.folderSupported(env());
    const mode = () => (NM.native ? 'native' : NM.ls.get(MODE) === 'folder' ? 'folder' : 'browser');
    const hasData = () => !window.NotemakerTransfer.isEmptyDoc(S.doc);
    const rerender = () => { if (NM.started) { NM.applyTheme(); NM.render(); } };
    function prefs() { try { return Object.assign({ intervalDays: 14 }, JSON.parse(NM.ls.get(BACKUP_PREF) || '{}')); } catch (e) { return { intervalDays: 14 }; } }
    function setPrefs(p) { try { NM.ls.set(BACKUP_PREF, JSON.stringify(Object.assign(prefs(), p))); } catch (e) { /* */ } }

    // ---------------- handle persistence (IndexedDB; handles can't go in localStorage) ----------------
    function idb(modeRW, fn) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('notemaker-storage', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('handles');
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
                const t = req.result.transaction('handles', modeRW);
                const r = fn(t.objectStore('handles'));
                t.oncomplete = () => resolve(r && r.result);
                t.onerror = () => reject(t.error);
            };
        });
    }
    const saveHandle = (hd) => idb('readwrite', (s) => s.put(hd, 'folder'));
    const loadHandle = () => idb('readonly', (s) => s.get('folder')).catch(() => null);
    const dropHandle = () => idb('readwrite', (s) => s.delete('folder')).catch(() => null);

    function makeStore(handle) {
        return St.createFolderStore({
            handle,
            onConflict: (theirs) => showConflict(theirs),
            onError: (e) => {
                if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) { state = 'permission'; gate(); return; }
                if (e && e.name === 'NotFoundError') { state = 'unavailable'; gate(); return; }
                NM.toast('Couldn’t save to your data folder: ' + e.message, 'error', 8000);
            }
        });
    }
    function mirror() { try { NM.persist.save(S.doc); } catch (e) { /* cache only */ } }
    async function pickFolder() {
        const hook = testPicker();
        if (hook) return hook();
        return window.showDirectoryPicker({ id: 'notemaker', mode: 'readwrite', startIn: 'documents' });
    }

    // ---------------- gate: permission needed / folder unavailable ----------------
    let gateEl = null, gateResolve = null;
    function gate() {
        if (gateEl) gateEl.remove();
        document.body.classList.add('gated');
        const name = folder ? folder.name : (gate.handle && gate.handle.name) || 'your data folder';
        const col = h('div', { class: 'v-center flow-screen' });
        col.appendChild(h('span', { class: 'v-tile big', 'aria-hidden': 'true' }, NM.icon(state === 'permission' ? 'lock' : 'info')));
        if (state === 'permission') {
            col.appendChild(h('h2', { class: 'v-title' }, 'Notemaker needs permission to open your data folder'));
            col.appendChild(h('p', { class: 'v-lead' }, 'Your data lives in “' + name + '” on this computer. Your browser asks again after a restart.'));
            const btn = h('button', { class: 'btn primary v-cta', type: 'button', onclick: async () => {
                btn.disabled = true;
                const st = makeStore(gate.handle);
                let p = 'denied';
                try { p = await st.permission(true); } catch (e) { p = 'denied'; }
                if (p === 'granted') { await openWith(st); closeGate(); } else { btn.disabled = false; msg.textContent = 'Permission wasn’t given. Notemaker can’t open your data without it.'; }
            } }, 'Allow access to “' + name + '”');
            const msg = h('p', { class: 'v-note warn', role: 'status' });
            col.appendChild(btn); col.appendChild(msg);
            setTimeout(() => btn.focus(), 30);
        } else {
            col.appendChild(h('h2', { class: 'v-title' }, 'Your data folder can’t be found'));
            col.appendChild(h('p', { class: 'v-lead' }, '“' + name + '” was moved, renamed or deleted, or the drive isn’t connected. Choose it again to continue.'));
            const btn = h('button', { class: 'btn primary v-cta', type: 'button', onclick: async () => {
                try { const hd = await pickFolder(); const st = makeStore(hd); if ((await st.permission()) !== 'granted' && (await st.permission(true)) !== 'granted') return; await saveHandle(hd); await openWith(st); closeGate(); } catch (e) { if (e.name !== 'AbortError') NM.toast(e.message, 'error'); }
            } }, 'Choose the folder again');
            col.appendChild(btn);
            setTimeout(() => btn.focus(), 30);
        }
        col.appendChild(h('button', { class: 'link-btn muted', type: 'button', onclick: async () => {
            const ok = await NM.confirm('Use the copy saved in this browser from your last session? Changes made elsewhere since then won’t be included, and Notemaker will stop using the folder.', 'Use browser storage');
            if (!ok) return;
            await switchToBrowser(true);
            closeGate();
        } }, 'Use browser storage instead'));
        gateEl = h('div', { class: 'flow-backdrop gate', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Data folder' }, h('div', { class: 'flow' }, h('div', { class: 'flow-body' }, col)));
        document.body.appendChild(gateEl);
        return new Promise((resolve) => { gateResolve = resolve; });
    }
    function closeGate() {
        if (gateEl) gateEl.remove();
        gateEl = null;
        document.body.classList.remove('gated');
        rerender();
        if (gateResolve) { const r = gateResolve; gateResolve = null; r(); }
    }
    async function openWith(store) {
        const r = await store.read();
        if (!r.doc) {
            // the folder lost its data file: write the cached copy so nothing diverges silently
            await store.writeNow(S.doc, true);
        } else { S.doc = r.doc; mirror(); }
        folder = store; state = 'ok';
        if (NM.vault && NM.started) NM.vault.lock('silent');
    }

    /** Boot: called from NM.load after the browser cache was loaded. Waits for permission when needed. */
    async function boot() {
        try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (e) { persisted = null; }
        if (!prefs().firstSeenAt) setPrefs({ firstSeenAt: Date.now() });
        if (mode() !== 'folder') return;
        if (!supported()) { NM.ls.set(MODE, 'browser'); return; }
        const handle = await loadHandle();
        gate.handle = handle;
        if (!handle) { state = 'unavailable'; await gate(); return; }
        const store = makeStore(handle);
        let perm = 'prompt';
        try { perm = await store.permission(); } catch (e) { perm = 'prompt'; }
        if (perm !== 'granted') { state = 'permission'; await gate(); return; }
        try { await openWith(store); } catch (e) {
            if (e.code === 'unreadable') { NM.toast(e.message + ' Using the copy in this browser; nothing was overwritten.', 'error', 12000); folder = null; state = 'unavailable'; await gate(); return; }
            state = 'unavailable'; await gate();
        }
    }

    // ---------------- saves, external changes, conflicts ----------------
    function onSave(doc) {
        if (mode() === 'folder' && folder && state === 'ok') folder.save(doc);
        if (St.shouldRequestPersist({ supported: !!(navigator.storage && navigator.storage.persist), hasData: hasData(), asked: persistAsked, persisted, folder: mode() === 'folder', native: !!NM.native })) {
            persistAsked = true;
            navigator.storage.persist().then((p) => { persisted = p; }).catch(() => { /* */ });
        }
    }
    function applyTheirs(theirs, silent) {
        const oldVault = JSON.stringify(S.doc.vault);
        folder.adopt(theirs.meta);
        S.doc = theirs.doc;
        mirror();
        if (NM.vault) NM.vault.onDocChanged(oldVault);
        NM.applyTheme(); NM.render();
        if (NM.syncNative) NM.syncNative(true);
        if (silent) NM.toast('Updated with changes made on another device.', '', 4000);
    }
    function showConflict(theirs) {
        if (conflictOpen || !folder) return;
        conflictOpen = true;
        const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown');
        const c = theirs.doc ? St.countsOf(theirs.doc) : null, mine = St.countsOf(S.doc);
        const fmt = (k) => k.tasks + ' tasks · ' + k.notes + ' notes';
        const body = h('div', { class: 'form' },
            h('p', { class: 'modal-text' }, 'The data in “' + folder.name + '” was changed outside this window — on another device, by a sync app or by the Mac app — while you had unsaved changes here.'),
            h('div', { class: 'tf-rows' },
                h('div', { class: 'tf-row' }, h('span', { class: 'tf-label' }, 'Newer version (folder)'), h('span', { class: 'tf-value' }, (c ? fmt(c) + ' · ' : 'can’t be read · ') + when(theirs.meta.lastModified))),
                h('div', { class: 'tf-row' }, h('span', { class: 'tf-label' }, 'This window'), h('span', { class: 'tf-value' }, fmt(mine) + ' · now'))));
        NM.chooseWithBody('Your data changed on another device', body, [
            { label: 'Keep this version', value: 'keep' },
            theirs.doc ? { label: 'Merge', value: 'merge' } : null,
            theirs.doc ? { label: 'Load the newer version', value: 'load', kind: 'primary' } : null
        ].filter(Boolean)).then(async (choice) => {
            conflictOpen = false;
            if (!folder) return;
            if (choice === 'load') applyTheirs(theirs, false);
            else if (choice === 'merge') {
                const merged = C.normalizeDoc(C.mergeDocs(theirs.doc, S.doc).doc);
                folder.adopt(theirs.meta);
                S.doc = merged; mirror(); NM.render();
                await folder.writeNow(S.doc);
                NM.toast('Merged both versions.', 'ok');
            } else if (choice === 'keep') {
                await folder.writeNow(S.doc, true);
                NM.toast('Kept this version. The other one is in notemaker-data.backup.json.', '', 6000);
            }
            // closing without a choice keeps the conflict pending; it's asked again on the next save/focus
        });
    }
    async function checkExternal() {
        if (!folder || state !== 'ok' || conflictOpen) return;
        let ext;
        try { ext = await folder.checkExternal(); } catch (e) {
            if (e && e.name === 'NotAllowedError') { state = 'permission'; gate(); }
            return;
        }
        const editing = !!(NM.notes && NM.notes.isEditing());
        const act = St.externalChangeAction(ext, folder.hasPending() || editing);
        if (act === 'reload') applyTheirs(ext.theirs, true);
        else if (act === 'conflict') showConflict(ext.theirs);
        else if (act === 'missing') { state = 'unavailable'; gate(); }
    }
    window.addEventListener('focus', checkExternal);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkExternal(); else if (folder) folder.flush(); });
    window.addEventListener('beforeunload', () => { if (folder) folder.flush(); });

    // ---------------- choose / move / switch ----------------
    async function blobsFromBrowser() {
        const out = {};
        try {
            const all = await NM.vaultBlobs.all({ browserOnly: true });
            for (const id of Object.keys(all || {})) out[id] = { iv: V.unb64(all[id].iv), ct: V.unb64(all[id].ct) };
        } catch (e) { /* none */ }
        return out;
    }
    async function moveTo(store, handle) {
        const blobs = await blobsFromBrowser();
        await store.importAndVerify(S.doc, blobs);
        await saveHandle(handle);
        NM.ls.set(MODE, 'folder');
        folder = store; state = 'ok';
        NM.render();
        NM.toast('Your data now lives in “' + store.name + '”. This browser keeps a copy.', 'ok', 6000);
    }
    async function openFolderData(store, handle) {
        await saveHandle(handle);
        NM.ls.set(MODE, 'folder');
        await openWith(store);
        rerender();
        NM.toast('Opened the data in “' + store.name + '”.', 'ok', 5000);
    }
    /** Pick a folder and either move this browser's data into it or open what's already there. */
    async function chooseFolder() {
        let handle;
        try { handle = await pickFolder(); } catch (e) { if (e.name !== 'AbortError') NM.toast('Couldn’t open that folder: ' + e.message, 'error'); return false; }
        const store = makeStore(handle);
        if ((await store.permission()) !== 'granted' && (await store.permission(true)) !== 'granted') { NM.toast('Notemaker needs permission to use that folder.', 'error'); return false; }
        const info = await store.inspect();
        const mine = St.countsOf(S.doc);
        const line = (k) => k.tasks + ' tasks · ' + k.notes + ' notes · ' + k.habits + ' habits' + (k.vaultItems ? ' · ' + k.vaultItems + ' vault items' : '');
        if (info.exists) {
            const latest = Math.max(0, ...Object.values(S.doc.notes).map((n) => Date.parse(n.updatedAt) || 0), ...S.doc.tasks.map((t) => Date.parse(t.createdAt) || 0));
            const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
            const choice = await NM.chooseWithBody('This folder already has Notemaker data', h('div', { class: 'form' },
                h('p', { class: 'modal-text' }, 'Which data should Notemaker use from now on?'),
                h('div', { class: 'tf-rows' },
                    h('div', { class: 'tf-row' }, h('span', { class: 'tf-label' }, 'In “' + store.name + '”'), h('span', { class: 'tf-value' }, info.readable ? line(info.counts) + ' · changed ' + when(info.modified) : 'can’t be read')),
                    h('div', { class: 'tf-row' }, h('span', { class: 'tf-label' }, 'In this browser'), h('span', { class: 'tf-value' }, line(mine) + (latest ? ' · changed ' + when(latest) : ''))))),
            [{ label: 'Cancel', value: null }, { label: 'Replace it with this browser’s data', value: 'replace' },
                info.readable ? { label: 'Open the data in this folder', value: 'open', kind: 'primary' } : null].filter(Boolean));
            if (!choice) return false;
            try {
                if (choice === 'open') await openFolderData(store, handle);
                else await moveTo(store, handle);
            } catch (e) { NM.toast('That didn’t work: ' + e.message + ' Nothing was switched.', 'error', 8000); return false; }
            return true;
        }
        const ok = await NM.chooseWithBody('Move your data to “' + store.name + '”?', h('div', { class: 'form' },
            h('p', { class: 'modal-text' }, 'Notemaker will keep everything in this folder as notemaker-data.json (and vault files in vault-blobs). It works with folders in iCloud Drive, Dropbox, Google Drive or OneDrive too. This browser keeps a copy.'),
            h('div', { class: 'tf-rows' }, h('div', { class: 'tf-row' }, h('span', { class: 'tf-label' }, 'Moving'), h('span', { class: 'tf-value' }, line(mine))))),
        [{ label: 'Cancel', value: null }, { label: 'Move data to this folder', value: 'move', kind: 'primary' }]);
        if (!ok) return false;
        try { await moveTo(store, handle); } catch (e) { NM.toast('The data couldn’t be verified in that folder (' + e.message + '). Nothing was switched.', 'error', 9000); return false; }
        return true;
    }
    async function switchToBrowser(silent) {
        if (folder) {
            try {
                for (const id of await folder.blobList()) { const r = await folder.blobGet(id); if (r) await NM.vaultBlobs.put(id, r.iv, r.ct, { browserOnly: true }); }
            } catch (e) { /* blobs may be unavailable if the folder is gone */ }
            await folder.flush();
        }
        mirror();
        folder = null; state = 'off';
        NM.ls.set(MODE, 'browser');
        await dropHandle();
        NM.render();
        if (!silent) NM.toast('Notemaker now keeps your data in this browser. The folder was left as it is.', '', 6000);
    }

    // ---------------- backups, install hint ----------------
    function noteBackup() { setPrefs({ lastBackupAt: Date.now() }); }
    function backupInfo() {
        const p = prefs();
        return St.backupReminder({ intervalDays: p.intervalDays, lastBackupAt: p.lastBackupAt || null, firstSeenAt: p.firstSeenAt, lastNagDay: p.lastNagDay,
            hasData: hasData(), folderActive: mode() === 'folder', folderAvailable: state === 'ok', native: !!NM.native, now: Date.now(), today: C.localToday() });
    }
    function maybeRemind() {
        const r = backupInfo();
        if (!r.due || NM.overlayOpen()) return;
        setPrefs({ lastNagDay: C.localToday() });
        const text = r.never ? 'You haven’t saved a backup yet — save one now?' : 'Last backup ' + r.days + ' days ago — save one now?';
        NM.toast(text, 'backup', 20000, { label: 'Save a backup', fn: () => NM.transfer.start({ backup: true }) });
    }
    function installHint() {
        const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
        return St.installHint(ua, standalone, !!NM.native);
    }
    const hintShown = () => St.hintVisible(Number(NM.ls.get(HINT)) || 0, Date.now());
    function dismissHint() { try { NM.ls.set(HINT, String(Date.now())); } catch (e) { /* */ } renderSidebarHint(); NM.render(); }
    function renderSidebarHint() {
        let el = document.getElementById('installHintSide');
        const hint = mode() === 'browser' && !supported() ? installHint() : null;
        if (!hint || !hintShown()) { if (el) el.remove(); return; }
        if (el) return;
        el = h('button', { id: 'installHintSide', class: 'side-hint', type: 'button', onclick: () => { NM.setView('settings'); setTimeout(() => { const s = document.getElementById('dataSection'); if (s) s.scrollIntoView({ behavior: 'smooth' }); }, 50); } },
            NM.icon('download'), h('span', null, 'Install Notemaker to keep your data safe'));
        const sb = document.querySelector('.side-actions');
        if (sb) sb.after(el);
    }

    // ---------------- Settings rows ----------------
    function settingsRows(row) {
        if (NM.native) return [];
        const out = [];
        const sup = supported();
        if (sup) {
            const where = mode() === 'folder' ? (state === 'ok' ? 'The folder “' + folder.name + '” on this computer. This browser keeps a copy.' : 'A folder on this computer — not reachable right now.')
                : 'This browser. Choose a folder to keep your data as a file you can back up or sync (iCloud Drive, Dropbox, OneDrive…).';
            out.push(row('Storage location', where, h('div', { class: 'inline' },
                h('button', { class: 'btn small' + (mode() === 'folder' ? '' : ' primary'), type: 'button', onclick: chooseFolder }, NM.icon('upload'), mode() === 'folder' ? ' Choose a different folder…' : ' Choose folder…'),
                mode() === 'folder' ? h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { if (await NM.confirm('Keep your data in this browser instead of “' + (folder ? folder.name : 'the folder') + '”? The folder stays as it is.', 'Switch')) switchToBrowser(); } }, 'Switch back to browser storage') : null)));
        } else {
            const k = St.browserKind(ua);
            const name = { safari: 'Safari', firefox: 'Firefox', ios: 'This browser', android: 'This browser' }[k] || 'This browser';
            out.push(row('Storage location', 'This browser. ' + name + ' can’t keep data in a folder, so Notemaker protects browser storage instead.', null));
        }
        if (mode() !== 'folder') {
            const estimateEl = h('span', { class: 'muted small' });
            if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then((e) => { estimateEl.textContent = ' Using ' + fmtBytes(e.usage || 0) + (e.quota ? ' of ' + fmtBytes(e.quota) : '') + '.'; }).catch(() => { /* */ });
            const canPersist = !!(navigator.storage && navigator.storage.persist);
            out.push(row('Protected from cleanup', h('span', null, persisted ? 'Yes — the browser won’t clear Notemaker’s data on its own.' : canPersist ? 'Not yet — browsers may clear data from sites you haven’t used in a while.' : 'This browser doesn’t support protecting storage.', estimateEl),
                !persisted && canPersist ? h('button', { class: 'btn small', type: 'button', onclick: async () => {
                    persistAsked = true;
                    try { persisted = await navigator.storage.persist(); } catch (e) { persisted = false; }
                    NM.toast(persisted ? 'Protected.' : 'The browser didn’t allow it yet — installing Notemaker usually helps.', persisted ? 'ok' : '', 6000);
                    NM.render();
                } }, 'Protect') : null));
            const hint = installHint();
            if (hint && hintShown()) {
                out.push(h('div', { class: 'hint-card' }, h('span', { class: 'v-tile', 'aria-hidden': 'true' }, NM.icon('download')),
                    h('div', { class: 'hint-text' }, h('div', { class: 'set-label' }, 'Install Notemaker'), h('div', { class: 'muted small' }, hint.text)),
                    h('button', { class: 'btn ghost small', type: 'button', onclick: dismissHint }, 'Not now')));
            }
        }
        const p = prefs();
        const last = p.lastBackupAt ? Math.floor((Date.now() - p.lastBackupAt) / 86400000) : null;
        const desc = (mode() === 'folder' && state === 'ok' ? 'Your data is a file in “' + folder.name + '”, so it’s included in your regular backups. ' : '') +
            (last == null ? 'No backup saved yet.' : last === 0 ? 'Last backup: today.' : 'Last backup: ' + last + (last === 1 ? ' day' : ' days') + ' ago.');
        out.push(row('Backup reminders', desc, h('div', { class: 'inline' },
            h('select', { class: 'select', 'aria-label': 'Backup reminder interval', onchange: (e) => { setPrefs({ intervalDays: +e.target.value }); NM.render(); } },
                [[7, 'Every week'], [14, 'Every 2 weeks'], [30, 'Every month'], [0, 'Off']].map(([v, l]) => h('option', { value: v, selected: p.intervalDays === v }, l))),
            h('button', { class: 'btn small', type: 'button', onclick: () => NM.transfer.start({ backup: true }) }, 'Save a backup'))));
        return out;
    }
    function fmtBytes(n) { return n < 1048576 ? Math.round(n / 1024) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(1) + ' GB'; }

    NM.storage = {
        boot, onSave, supported, mode, chooseFolder, switchToBrowser, settingsRows, noteBackup, maybeRemind, renderSidebarHint, checkExternal,
        folderActive: () => mode() === 'folder' && !!folder && state === 'ok',
        folder: () => folder, state: () => state,
        /** Welcome screen: extra choice where folders are supported. */
        welcomeOption(onDone) {
            if (!supported()) return null;
            return h('button', { class: 'link-btn', type: 'button', onclick: async () => { if (await chooseFolder()) onDone(); } }, 'Keep my data in a folder on this computer');
        },
        afterStartFresh() {
            if (!supported() || mode() === 'folder' || NM.ls.get(TIP)) return;
            try { NM.ls.set(TIP, '1'); } catch (e) { /* */ }
            setTimeout(() => NM.toast('Tip: you can keep your data in a folder on this computer, so it’s safe even if the browser is reset.', '', 14000, { label: 'Choose folder', fn: chooseFolder }), 600);
        }
    };
})();
