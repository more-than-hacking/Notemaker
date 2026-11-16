/* Notemaker — "Move to a new device" (export), "Restore from another device" (import), first-run welcome.
   Format: docs/TRANSFER_FORMAT.md (js/transfer-core.js). The transfer code lives only in this module's memory
   while its screen is open; it is never written to storage, the file, logs or the regular clipboard path. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h, T = window.NotemakerTransfer, V = window.NotemakerVault;
    NM.VERSION = '2.2.0';
    const WELCOMED = 'notemaker_welcomed';
    const kit = () => NM.vault.kit;
    const isNative = () => !!NM.native;
    const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

    // ======================= sheet (full-screen flow container) =======================
    function sheet(opts) {
        const body = h('div', { class: 'flow-body' });
        let guard = opts.guard || null;
        const closeBtn = opts.closable === false ? null : NM.iconBtn('x', 'Close', () => tryClose());
        const panel = h('div', { class: 'flow', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.label }, h('div', { class: 'flow-top' }, closeBtn), body);
        const backdrop = h('div', { class: 'flow-backdrop' }, panel);
        document.body.appendChild(backdrop);
        const close = NM.pushOverlay(backdrop, opts.onClose);
        async function tryClose() { if (!guard || (await guard())) close(); }
        backdrop.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || NM.isTyping(e) && e.target.value) return;
            e.preventDefault(); e.stopPropagation();
            if (opts.closable === false) { if (opts.onEscape) opts.onEscape(); return; }
            tryClose();
        });
        return {
            close, tryClose, setGuard(g) { guard = g; },
            show(node, focusSel) {
                NM.clear(body).appendChild(node);
                panel.scrollTop = 0;
                setTimeout(() => {
                    const f = (focusSel && body.querySelector(focusSel)) || body.querySelector('[data-autofocus]') || body.querySelector('.btn.primary:not([disabled])') || body.querySelector('button, input');
                    if (f) f.focus();
                }, 30);
            }
        };
    }
    const tile = (icon, cls) => h('span', { class: 'v-tile big ' + (cls || ''), 'aria-hidden': 'true' }, NM.icon(icon));
    const screen = (...kids) => h('div', { class: 'v-center flow-screen' }, ...kids);
    const title = (t) => h('h2', { class: 'v-title' }, t);
    const lead = (t) => h('p', { class: 'v-lead' }, t);
    const note = (t, kind) => h('p', { class: 'v-note ' + (kind || 'muted'), role: kind === 'warn' ? 'alert' : 'status' }, t);
    const link = (label, fn, cls) => h('button', { class: 'link-btn ' + (cls || ''), type: 'button', onclick: fn }, label);
    const primary = (label, fn, extra) => h('button', Object.assign({ class: 'btn primary v-cta', type: 'button', onclick: fn }, extra || {}), label);
    function rows(list) {
        return h('div', { class: 'tf-rows' }, list.filter(Boolean).map((r) => h('div', { class: 'tf-row' + (r.status ? ' ' + r.status : '') },
            r.status ? h('span', { class: 'tf-status', 'aria-label': r.status === 'ok' ? 'OK' : 'Problem' }, NM.icon(r.status === 'ok' ? 'check' : 'x')) : null,
            h('span', { class: 'tf-label' }, r.label),
            h('span', { class: 'tf-value' }, r.value),
            r.detail ? h('span', { class: 'tf-detail' }, r.detail) : null)));
    }
    /** Transfer-code input: auto-uppercase, auto-dash, live checksum mark. */
    function codeInput(onState) {
        const input = h('input', { class: 'input rk-input tf-code-input', placeholder: 'XXXXXX-XXXXXX-…', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', 'aria-label': 'Transfer code', 'data-autofocus': 'true' });
        const mark = h('span', { class: 'rk-mark', 'aria-live': 'polite' });
        let seq = 0;
        input.addEventListener('input', async () => {
            const n = T.normalizeCodeInput(input.value);
            input.value = n.display;
            mark.className = 'rk-mark'; mark.textContent = '';
            const my = ++seq;
            if (!n.complete) { onState(false); return; }
            try { const b = await T.parseCode(n.raw); b.fill(0); if (my !== seq) return; mark.className = 'rk-mark ok'; mark.textContent = '✓'; onState(true); } catch (e) {
                if (my !== seq) return; mark.className = 'rk-mark bad'; mark.textContent = 'Check for typos'; onState(false);
            }
        });
        return { input, el: h('div', { class: 'rk-field' }, input, mark) };
    }
    async function deviceName() {
        if (isNative()) { try { const r = await NM.native.request('se.available'); if (r && r.device) return r.device; } catch (e) { /* */ } return 'Mac'; }
        const ua = navigator.userAgent;
        const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
        const p = /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
        return b + (p ? ' on ' + p : '');
    }
    function prefsNow() {
        return T.sanitizePrefs({ accent: NM.ls.get('notemaker_accent') || 'violet', lastView: S.view, dayTab: S.dayTab, sort: S.sort,
            syncScroll: (document.getElementById('syncScroll') || {}).checked !== false });
    }
    function applyPrefs(p) {
        if (!p) return;
        try { if (p.accent) NM.ls.set('notemaker_accent', p.accent); } catch (e) { /* */ }
        if (p.lastView && NM.views[p.lastView]) S.view = p.lastView;
        if (p.dayTab) S.dayTab = p.dayTab;
        if (p.sort) S.sort = p.sort;
        const sync = document.getElementById('syncScroll');
        if (sync && typeof p.syncScroll === 'boolean' && sync.checked !== p.syncScroll) { sync.checked = p.syncScroll; sync.dispatchEvent(new Event('change')); }
        NM.saveUi();
    }
    /** Save a file: shell → save panel (resolves false if cancelled); browser → download. */
    async function saveFile(name, text, mime) {
        if (isNative()) {
            const r = await NM.native.request('files.save', { suggestedName: name, mime, base64: V.b64(new TextEncoder().encode(text)) });
            return !!(r && r.saved);
        }
        NM.download(name, text, mime);
        return true;
    }

    // ======================= move to a new device (export) =======================
    NM.transfer = NM.transfer || {};
    NM.transfer.start = function () {
        while (NM.closeTopOverlay()) { /* clear the stage */ }
        if (NM.beforeDateChange) NM.beforeDateChange();
        const st = { omitVault: false, code: null, fileText: null, fileName: T.fileName(C.localToday()) };
        const sh = sheet({ label: 'Move to a new device', onClose: () => { st.code = null; st.fileText = null; } });

        function summaryScreen() {
            const d = S.doc, v = d.vault;
            const notes = Object.values(d.notes), locked = notes.filter((n) => n.locked).length;
            const files = kit().fileItems();
            const fileBytes = files.reduce((s, f) => s + (f.size || 0), 0);
            const vaultValue = !v ? null : NM.vault.isUnlocked()
                ? plural(v.items.length, 'item') + (files.length ? ', ' + plural(files.length, 'file') + ' (' + T.formatBytes(fileBytes) + ')' : '')
                : plural(v.items.length, 'item') + ' · files are counted after you unlock it';
            sh.show(screen(
                tile('upload'),
                title('Move to a new device'),
                lead('Everything on this ' + (isNative() ? 'Mac' : 'browser') + ' goes into one encrypted file. You’ll open it on your new device with a one-time code.'),
                rows([
                    { label: 'Tasks', value: String(d.tasks.length) },
                    { label: 'Notes', value: notes.length + (locked ? ' (' + locked + ' private)' : '') },
                    { label: 'Habits', value: String(d.habits.length) },
                    { label: 'Templates', value: String(d.templates.length) },
                    { label: 'Focus sessions', value: String(d.focusSessions.length) },
                    v ? { label: 'Vault', value: vaultValue } : null,
                    { label: 'Settings & preferences', value: 'Included' }
                ]),
                primary(needsVaultStep() ? 'Continue' : 'Create transfer file', () => (needsVaultStep() ? vaultScreen() : build())),
                link('Cancel', () => sh.close(), 'muted')));
        }
        const hardwareOnly = () => !!S.doc.vault && !S.doc.vault.keyslots.some((s) => s.type === 'recovery');
        const needsVaultStep = () => !st.omitVault && !!S.doc.vault && (hardwareOnly() || (!NM.vault.isUnlocked() && S.doc.vault.items.length > 0));

        async function vaultScreen() {
            await kit().ensureSupport();
            if (hardwareOnly()) return hardwareOnlyScreen();
            unlockScreen({
                heading: 'Unlock your vault to include it',
                text: 'Your vault’s items and files go into the transfer file still encrypted.',
                after: () => build()
            });
        }
        function hardwareOnlyScreen(msg) {
            sh.show(screen(
                tile('lock'),
                title('Your vault is tied to this ' + (isNative() ? 'Mac' : 'browser')),
                lead('Right now only ' + (isNative() ? 'Touch ID on this Mac' : 'your passkey') + ' can open it. To take it with you, create a recovery key — you’ll type it once on the new device.'),
                msg ? note(msg.text, msg.kind) : null,
                primary('Create a recovery key and move it', async (e) => {
                    const btn = e.currentTarget;
                    btn.disabled = true; btn.textContent = 'Waiting for ' + (isNative() ? 'Touch ID' : 'your passkey') + '…';
                    let raw = null;
                    try {
                        if (NM.vault.isUnlocked()) raw = await kit().obtainRawVdk('Creating a recovery key');
                        else raw = (await kit().hwUnlock()).raw;
                        if (!raw) { hardwareOnlyScreen(); return; }
                        const text = await kit().addRecoverySlotText(raw);
                        if (!NM.vault.isUnlocked()) { await kit().openSession(raw); raw = null; }
                        recoveryKeyScreen(text);
                    } catch (err) {
                        hardwareOnlyScreen({ text: err.code === 'cancelled' ? 'That was cancelled — try again when you’re ready.' : err.message, kind: err.code === 'cancelled' ? 'muted' : 'warn' });
                    } finally { if (raw) raw.fill(0); }
                }),
                link('Move without the vault', async () => {
                    const ok = await NM.confirm('Your vault (' + plural(S.doc.vault.items.length, 'item') + ') won’t be on the new device. It stays here on this ' + (isNative() ? 'Mac' : 'browser') + '.', 'Move without it');
                    if (ok) { st.omitVault = true; build(); }
                })));
        }
        function recoveryKeyScreen(text) {
            let saved = false;
            const next = primary('Continue', () => build(), { disabled: true });
            sh.setGuard(async () => saved || NM.confirm('Your new recovery key won’t be shown again. Close anyway?', 'Close'));
            sh.show(screen(
                tile('key'),
                title('Save your recovery key'),
                lead('You’ll type it once on the new device to open your vault. We can’t show it again.'),
                kit().recoveryGrid(text),
                kit().recoveryActions(text),
                h('label', { class: 'check-line v-check' }, h('input', { type: 'checkbox', onchange: (e) => { saved = e.target.checked; next.disabled = !saved; if (saved) next.focus(); } }),
                    h('span', null, 'I’ve saved my recovery key somewhere safe')),
                next), 'input[type=checkbox]');
        }
        /** Unlock inline (Touch ID / passkey, or recovery key). */
        function unlockScreen(o, msg, showRecovery) {
            const canHw = kit().usableHere();
            const hasRec = kit().hasRecovery();
            const parts = [tile('lock'), title(o.heading), lead(o.text)];
            if (canHw && !showRecovery) {
                parts.push(primary(isNative() ? 'Unlock with Touch ID' : 'Unlock with passkey', async (e) => {
                    const btn = e.currentTarget;
                    btn.disabled = true; btn.textContent = 'Waiting for ' + (isNative() ? 'Touch ID' : 'your passkey') + '…';
                    try { const r = await kit().hwUnlock(); await kit().openSession(r.raw); o.after(); } catch (err) {
                        unlockScreen(o, { text: err.code === 'cancelled' ? 'That was cancelled — try again when you’re ready.' : err.message, kind: err.code === 'cancelled' ? 'muted' : 'warn' }, err.code === 'not-this-device');
                    }
                }));
                if (msg) parts.push(note(msg.text, msg.kind));
                if (hasRec) parts.push(link('Use recovery key instead', () => unlockScreen(o, null, true)));
            } else if (hasRec) {
                const go = primary('Unlock', async () => {
                    go.disabled = true; go.textContent = 'Unlocking…';
                    try { const r = await kit().unlockRecovery(rk.input.value); await kit().openSession(r.raw); o.after(); } catch (err) { unlockScreen(o, { text: err.message, kind: 'warn' }, true); }
                }, { disabled: true });
                const rk = kit().recoveryInput((ok) => { go.disabled = !ok; });
                rk.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); });
                parts.push(h('label', { class: 'field v-field' }, h('span', { class: 'field-label' }, 'Recovery key'), rk.el), go);
                if (msg) parts.push(note(msg.text, msg.kind));
                if (canHw) parts.push(link('Use ' + (isNative() ? 'Touch ID' : 'your passkey') + ' instead', () => unlockScreen(o, null, false)));
            } else {
                parts.push(note('This vault can only be opened on the device that created it.', 'warn'));
            }
            if (o.skip) parts.push(link(o.skip.label, o.skip.run, 'muted'));
            sh.show(screen(...parts), showRecovery ? 'input' : null);
        }

        async function build() {
            sh.setGuard(null);
            sh.show(screen(tile('upload'), title('Creating your transfer file…'), lead('This takes a moment for large vaults.'), h('div', { class: 'tf-spinner', 'aria-hidden': 'true' })));
            try {
                let blobs = {};
                const v = S.doc.vault;
                if (v && !st.omitVault) {
                    for (const f of kit().fileItems()) {
                        let rec = null;
                        try { rec = await NM.vaultBlobs.get(f.blobId); } catch (e) { rec = null; }
                        if (!rec) {
                            sh.show(screen(tile('x', 'warn'), title('A vault file is missing'),
                                lead('“' + f.title + '” has no file on this device, so the transfer was stopped. Open the vault and re-add or delete that item, then try again.'),
                                primary('Open the vault', () => { sh.close(); NM.setView('vault'); }), link('Close', () => sh.close(), 'muted')));
                            return;
                        }
                        blobs[f.blobId] = { iv: V.b64(rec.iv), ct: V.b64(rec.ct) };
                    }
                }
                const doc = T.prepareExportDoc(S.doc, { blobs, omitVault: st.omitVault });
                const estimate = Object.values(blobs).reduce((s, b) => s + b.ct.length, 0) + JSON.stringify(S.doc).length;
                if (estimate > T.MAX_BYTES) throw Object.assign(new Error('Your data is over 1 GB, which is too large for one transfer file. Remove some large vault files and try again.'), { code: 'too-large' });
                if (estimate > T.WARN_BYTES && !(await NM.confirm('This transfer file will be about ' + T.formatBytes(estimate) + '. Copying it can take a while. Continue?', 'Continue'))) { summaryScreen(); return; }
                const built = await T.buildTransferFile({ doc, prefs: prefsNow(), source: { app: isNative() ? 'macos' : 'web', appVersion: NM.VERSION, device: await deviceName() } });
                st.fileText = built.fileText;
                st.code = built.code.text;
                built.code.bytes.fill(0);
                st.summary = built.file.summary;
                const saved = await saveFile(st.fileName, st.fileText, T.MIME);
                if (!saved) { st.code = null; st.fileText = null; summaryScreen(); NM.toast('Not saved — nothing was created.'); return; }
                codeScreen();
            } catch (err) {
                sh.show(screen(tile('x', 'warn'), title('The transfer file couldn’t be created'), lead(err.message), primary('Try again', () => summaryScreen()), link('Close', () => sh.close(), 'muted')));
            }
        }
        function codeScreen() {
            let done = false;
            const finish = primary('Done', () => { done = true; st.code = null; st.fileText = null; sh.close(); NM.toast('Transfer file ready. Open it on your new device.', 'ok', 5000); }, { disabled: true });
            sh.setGuard(async () => done || NM.confirm('Close without keeping the code? It can’t be shown again — you’d need to create a new transfer file.', 'Close', true));
            const groups = st.code.split('-');
            sh.show(screen(
                tile('key'),
                title('Your transfer code'),
                lead('You’ll type this on your new device. It’s shown only once.'),
                h('div', { class: 'rk-grid tf-code', 'aria-label': 'Transfer code' }, groups.map((g) => h('span', null, g))),
                h('div', { class: 'btn-group' },
                    h('button', { class: 'btn', type: 'button', onclick: () => kit().copySecret(st.code) }, NM.icon('copy'), ' Copy'),
                    h('button', { class: 'btn', type: 'button', onclick: () => kit().printSecret('Notemaker transfer code', 'Type this on your new device to open “' + st.fileName + '”. It only works with that file.', st.code) }, NM.icon('note'), ' Print')),
                h('ol', { class: 'tf-steps' },
                    h('li', null, 'Copy ', h('b', null, st.fileName), ' to your new device (AirDrop, USB or cloud).'),
                    h('li', null, 'Open Notemaker there and choose ', h('b', null, 'Restore from another device'), '.'),
                    h('li', null, 'Type this code.')),
                link('Save the file again', () => saveFile(st.fileName, st.fileText, T.MIME), 'muted'),
                h('label', { class: 'check-line v-check' }, h('input', { type: 'checkbox', onchange: (e) => { finish.disabled = !e.target.checked; if (e.target.checked) finish.focus(); } }),
                    h('span', null, 'I’ve written down the code')),
                finish), 'input[type=checkbox]');
        }
        summaryScreen();
    };

    // ======================= restore from another device (import) =======================
    let undoState = null;
    /** opts: { file (File) | text + name + size, fromWelcome } */
    NM.transfer.restore = function (opts) {
        opts = opts || {};
        while (NM.closeTopOverlay()) { /* */ }
        const st = { envelope: null, payload: null, verify: null, name: '', before: null };
        const sh = sheet({ label: 'Restore from another device', onClose: () => { st.payload = null; if (opts.fromWelcome && !NM.ls.get(WELCOMED)) setTimeout(NM.transfer.welcome, 0); } });

        async function loadFile(file) {
            if (!file) return;
            if (file.size > T.MAX_BYTES) { pickScreen({ text: 'This file is larger than 1 GB, which Notemaker can’t restore in one go.', kind: 'warn' }); return; }
            if (file.size > T.WARN_BYTES && !(await NM.confirm('This file is ' + T.formatBytes(file.size) + '. Opening it can take a while and needs plenty of memory. Continue?', 'Continue'))) return;
            let text;
            try { text = await file.text(); } catch (e) { pickScreen({ text: 'That file couldn’t be read.', kind: 'warn' }); return; }
            useText(text, file.name, file.size);
        }
        function useText(text, name, size) {
            try { st.envelope = T.parseEnvelope(text, size); st.name = name || 'Transfer file'; codeScreen(); } catch (e) { pickScreen({ text: e.message, kind: 'warn' }); }
        }
        function pickScreen(msg) {
            const input = h('input', { type: 'file', accept: '.notemaker,application/json,' + T.MIME, hidden: true, onchange: (e) => { loadFile(e.target.files[0]); e.target.value = ''; } });
            const drop = h('div', { class: 'drop-zone tf-drop', tabindex: 0, role: 'button', 'aria-label': 'Choose a transfer file', onclick: () => input.click(),
                onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
            h('div', { class: 'drop-empty' }, NM.icon('upload'), h('span', null, 'Drop the .notemaker file here'), h('span', { class: 'muted small' }, 'or use the button below')));
            drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drop'); });
            drop.addEventListener('dragleave', () => drop.classList.remove('drop'));
            drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drop'); loadFile(e.dataTransfer.files[0]); });
            sh.show(screen(
                tile('download'),
                title('Restore from another device'),
                lead('Choose the transfer file you created on your old device.'),
                drop, input,
                msg ? note(msg.text, msg.kind) : null,
                primary('Choose file', () => input.click()),
                link('Cancel', () => sh.close(), 'muted')));
        }
        function sourceLine() {
            const e = st.envelope;
            const when = e.createdAt ? new Date(e.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown date';
            return (e.source.device || (e.source.app === 'macos' ? 'a Mac' : 'a browser')) + ' · ' + when;
        }
        function summaryText() {
            const s = st.envelope.summary;
            return [plural(s.tasks, 'task'), plural(s.notes, 'note'), s.vaultItems ? plural(s.vaultItems, 'vault item') + (s.vaultFiles ? ' incl. ' + plural(s.vaultFiles, 'file') : '') : null, T.formatBytes(s.bytes)].filter(Boolean).join(' · ');
        }
        function codeScreen(msg, keep) {
            const go = primary('Open file', open, { disabled: true });
            const ci = codeInput((ok) => { go.disabled = !ok; });
            if (keep) setTimeout(() => { ci.input.value = keep; ci.input.dispatchEvent(new Event('input')); ci.input.select(); }, 0);
            ci.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) open(); });
            async function open() {
                go.disabled = true; go.textContent = 'Opening…';
                try {
                    st.payload = await T.openTransferFile(st.envelope, ci.input.value);
                    ci.input.value = '';
                    st.verify = await T.verifyPayload(st.payload);
                    if (!st.verify.ok) return damagedScreen();
                    if (T.isEmptyDoc(S.doc)) apply('replace'); else choiceScreen();
                } catch (e) {
                    codeScreen({ text: e.code === 'wrong-code' ? 'That code doesn’t match this file.' : e.message, kind: 'warn' }, ci.input.value);
                }
            }
            sh.show(screen(
                tile('download'),
                title('Enter the transfer code'),
                h('div', { class: 'tf-source' }, h('div', { class: 'tf-source-name' }, st.name), h('div', { class: 'muted small' }, 'From ' + sourceLine()), h('div', { class: 'muted small' }, summaryText())),
                h('label', { class: 'field v-field' }, h('span', { class: 'field-label' }, 'Transfer code'), ci.el),
                go,
                msg ? note(msg.text, msg.kind) : null,
                link('Choose a different file', () => pickScreen(), 'muted')), '.tf-code-input');
        }
        function damagedScreen() {
            const names = { docSha256: 'Contents checksum', tasks: 'Tasks', notes: 'Notes', lockedNotes: 'Private notes', habits: 'Habits', templates: 'Templates', focusSessions: 'Focus sessions', vaultItems: 'Vault items', vaultFiles: 'Vault files', vaultFileBytes: 'Vault file sizes' };
            sh.show(screen(tile('x', 'warn'), title('This file is damaged'),
                lead('Nothing was changed on this device. Create a new transfer file on your old device and try again.'),
                rows(st.verify.problems.map((p) => ({ label: names[p.key] || p.key, value: p.key === 'docSha256' ? 'doesn’t match' : 'expected ' + p.expected + ', found ' + p.actual, status: 'bad' }))),
                primary('Close', () => sh.close())));
        }
        function choiceScreen() {
            let mode = 'replace';
            const card = (m, t, d) => h('label', { class: 'mode-card' + (mode === m ? ' active' : '') },
                h('input', { type: 'radio', name: 'tf-mode', value: m, checked: mode === m, onchange: () => { mode = m; [...document.querySelectorAll('.tf-choice .mode-card')].forEach((c) => c.classList.toggle('active', c.querySelector('input').checked)); } }),
                h('span', { class: 'mode-title' }, t), h('span', { class: 'mode-desc muted small' }, d));
            sh.show(screen(
                tile('download'),
                title('This device already has data'),
                lead('Choose what happens to what’s here now. You can undo this until you close Notemaker.'),
                h('div', { class: 'mode-cards tf-choice' },
                    card('replace', 'Replace this device’s data', 'Use exactly what’s in the file. Best when you’re moving to this device.'),
                    card('merge', 'Merge', 'Keep what’s here and add what’s new. Your settings here stay as they are.')),
                primary('Restore', () => apply(mode)),
                link('Cancel', () => sh.close(), 'muted')), 'input[value=replace]');
        }
        async function apply(mode) {
            sh.show(screen(tile('download'), title('Restoring…'), h('div', { class: 'tf-spinner', 'aria-hidden': 'true' })));
            st.before = { doc: JSON.stringify(S.doc), prefs: prefsNow() };
            const plan = T.planRestore(S.doc, st.payload, mode);
            NM.vault.lock('import');
            kit().markRestored();
            NM.update(() => { S.doc = plan.doc; S.unlocked = {}; S.passcode = null; });
            if (plan.prefs) applyPrefs(plan.prefs);
            const stored = await NM.vault.importBlobs(plan.blobs);
            NM.applyTheme();
            S.today = C.localToday(); S.date = S.today;
            NM.render();
            if (NM.syncNative) NM.syncNative(true);
            try { NM.ls.set(WELCOMED, '1'); } catch (e) { /* */ }
            undoState = st.before;
            st.mode = mode; st.plan = plan; st.storedBlobs = stored;
            await checkScreen();
        }
        async function checkScreen() {
            const inc = st.payload.doc, m = st.payload.manifest, d = S.doc;
            const has = (list, ids) => ids.filter((id) => list.has(id)).length;
            const taskIds = new Set(d.tasks.map((t) => t.id)), habitIds = new Set(d.habits.map((x) => x.id)), sessIds = new Set(d.focusSessions.map((x) => x.id));
            const tplKeys = new Set(d.templates.map((t) => t.id).concat(d.templates.map((t) => t.name.toLowerCase())));
            const noteDays = Object.keys(inc.notes || {});
            const vaultMoved = inc.vault && d.vault && d.vault.verifier.ct === inc.vault.verifier.ct;
            const vaultItemIds = new Set(vaultMoved ? d.vault.items.map((x) => x.id) : []);
            let filesHere = 0;
            for (const id of Object.keys((inc.vault && inc.vault.blobs) || {})) { try { if (await NM.vaultBlobs.get(id)) filesHere++; } catch (e) { /* */ } }
            const row = (label, expected, actual, why) => ({ label, value: actual === expected ? String(expected) : actual + ' of ' + expected, status: actual === expected ? 'ok' : 'bad', detail: actual === expected ? null : why });
            const list = [
                row('Tasks', m.tasks, has(taskIds, (inc.tasks || []).map((t) => t.id)), 'Some tasks matched ones already here and were kept once.'),
                row('Notes', m.notes, noteDays.filter((k) => d.notes[k]).length, 'Some notes couldn’t be restored.'),
                m.lockedNotes ? row('Private notes', m.lockedNotes, noteDays.filter((k) => inc.notes[k].locked && d.notes[k] && d.notes[k].locked).length, 'A private note here already used that day, so it was kept as it was.') : null,
                row('Habits', m.habits, has(habitIds, (inc.habits || []).map((x) => x.id)), 'Some habits couldn’t be restored.'),
                row('Templates', m.templates, (inc.templates || []).filter((t) => tplKeys.has(t.id) || tplKeys.has(String(t.name).toLowerCase())).length, 'Some templates couldn’t be restored.'),
                row('Focus sessions', m.focusSessions, has(sessIds, (inc.focusSessions || []).map((x) => x.id)), 'Some focus sessions couldn’t be restored.'),
                m.vaultItems || inc.vault ? row('Vault items', m.vaultItems, has(vaultItemIds, ((inc.vault && inc.vault.items) || []).map((x) => x.id)),
                    vaultMoved ? 'Some vault items are missing.' : 'This device already has its own vault, so the moved one wasn’t merged. Restore again with “Replace” to use it.') : null,
                m.vaultFiles ? row('Vault files', m.vaultFiles, vaultMoved ? filesHere : 0, vaultMoved ? 'Some files couldn’t be stored on this device (storage full?).' : 'Kept with the vault that wasn’t merged.') : null
            ].filter(Boolean);
            const allOk = list.every((r) => r.status === 'ok');
            await kit().ensureSupport();
            const needsVault = !!(d.vault && vaultMoved && !kit().usableHere());
            sh.setGuard(null);
            sh.show(screen(
                tile(allOk ? 'check' : 'info', allOk ? 'ok' : ''),
                title(allOk ? 'Everything’s here' : 'Restored, with a few gaps'),
                lead(st.mode === 'merge' ? 'Your data from ' + (st.envelope.source.device || 'the other device') + ' was added to this device.' : 'This device now has everything from ' + (st.envelope.source.device || 'the other device') + '.'),
                rows(list),
                needsVault ? primary('Finish moving your vault', () => finishVaultScreen()) : primary('Done', () => done()),
                needsVault ? link('Do it later', () => done(), 'muted') : null,
                link('Undo this restore', () => { sh.close(); undo(); }, 'muted')));
        }
        function done() {
            sh.close();
            st.payload = null;
            NM.toast('Restore complete', 'ok', 6000, { label: 'Undo', fn: undo });
        }
        function finishVaultScreen(msg, showRecovery) {
            const native = isNative();
            const parts = [tile('lock'), title('Finish moving your vault'),
                lead('Unlock it once with your recovery key. Then you can use ' + (native ? 'Touch ID on this Mac' : 'a passkey in this browser') + ' instead.')];
            const hasPasskeyHere = !native && kit().usableHere();
            const afterUnlock = async (rawCopy) => {
                const sup = await kit().ensureSupport();
                if (!sup.ok) { if (rawCopy) rawCopy.fill(0); return finishedVault(false); }
                addDeviceScreen(rawCopy);
            };
            if (hasPasskeyHere && !showRecovery) {
                parts.push(primary('Unlock with passkey', async (e) => {
                    e.currentTarget.disabled = true;
                    try { const r = await kit().hwUnlock(); await kit().openSession(r.raw); finishedVault(false); } catch (err) { finishVaultScreen({ text: err.message, kind: err.code === 'cancelled' ? 'muted' : 'warn' }); }
                }));
                parts.push(link('Use recovery key instead', () => finishVaultScreen(null, true)));
            } else if (kit().hasRecovery()) {
                const go = primary('Unlock', async () => {
                    go.disabled = true; go.textContent = 'Unlocking…';
                    try {
                        const r = await kit().unlockRecovery(rk.input.value);
                        const copy = r.raw.slice();
                        await kit().openSession(r.raw);
                        afterUnlock(copy);
                    } catch (err) { finishVaultScreen({ text: err.message, kind: 'warn' }, true); }
                }, { disabled: true });
                const rk = kit().recoveryInput((ok) => { go.disabled = !ok; });
                rk.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); });
                parts.push(h('label', { class: 'field v-field' }, h('span', { class: 'field-label' }, 'Recovery key'), rk.el), go);
            } else parts.push(note('This vault has no recovery key, so it can’t be opened here.', 'warn'));
            if (msg) parts.push(note(msg.text, msg.kind));
            parts.push(link('Do it later', () => done(), 'muted'));
            sh.show(screen(...parts), 'input');
        }
        function addDeviceScreen(raw) {
            let consumed = false;
            sh.setGuard(async () => { if (!consumed && raw) raw.fill(0); return true; });
            const add = primary(isNative() ? 'Add this Mac' : 'Add this browser', async () => {
                add.disabled = true; add.textContent = 'Waiting for ' + (isNative() ? 'Touch ID' : 'your passkey') + '…';
                try { await kit().addHardwareSlot(raw); consumed = true; raw.fill(0); finishedVault(true); } catch (err) {
                    add.disabled = false; add.textContent = isNative() ? 'Add this Mac' : 'Add this browser';
                    NM.toast(err.code === 'cancelled' ? 'That was cancelled — try again when you’re ready.' : err.message, err.code === 'cancelled' ? '' : 'error', 6000);
                }
            });
            sh.show(screen(tile('key'), title(isNative() ? 'Use Touch ID next time?' : 'Use a passkey next time?'),
                lead('Your vault is open. Add ' + (isNative() ? 'this Mac' : 'this browser') + ' so you won’t need the recovery key again.'),
                add, link('Not now', () => { raw.fill(0); consumed = true; finishedVault(false); }, 'muted')));
        }
        function finishedVault(added) {
            sh.setGuard(null);
            sh.close();
            st.payload = null;
            NM.setView('vault');
            NM.toast(added ? 'Your vault is ready on ' + (isNative() ? 'this Mac' : 'this browser') + '.' : 'Your vault is open.', 'ok', 5000, { label: 'Undo restore', fn: undo });
        }

        if (opts.file) loadFile(opts.file);
        else if (opts.text != null) useText(opts.text, opts.name, opts.size);
        else pickScreen();
    };
    function undo() {
        if (!undoState) { NM.toast('Nothing to undo'); return; }
        const b = undoState;
        undoState = null;
        NM.vault.lock('import');
        NM.update(() => { S.doc = C.normalizeDoc(JSON.parse(b.doc)); S.unlocked = {}; S.passcode = null; });
        applyPrefs(b.prefs);
        NM.applyTheme();
        NM.render();
        if (NM.syncNative) NM.syncNative(true);
        NM.toast('Restore undone — this device is back to how it was.');
    }
    NM.transfer.undo = undo;

    // ======================= first-run welcome =======================
    NM.transfer.welcome = function () {
        const fresh = () => { try { NM.ls.set(WELCOMED, '1'); } catch (e) { /* */ } sh.close(); NM.focusQuickAdd(); };
        const sh = sheet({ label: 'Welcome', closable: false, onEscape: fresh });
        sh.show(screen(
            h('img', { src: 'web-icons/favicon.svg', alt: '', width: 72, height: 72, class: 'welcome-icon' }),
            title('Welcome to Notemaker'),
            lead('Starting here for the first time, or moving from another device?'),
            primary('Start fresh', fresh),
            h('button', { class: 'btn v-cta', type: 'button', onclick: () => { sh.close(); NM.transfer.restore({ fromWelcome: true }); } }, 'Restore from another device')));
    };
    NM.transfer.maybeWelcome = function () {
        if (T.shouldShowWelcome(S.doc, !!NM.ls.get(WELCOMED))) NM.transfer.welcome();
    };

    // ======================= entry points =======================
    function isTransferName(n) { return /\.notemaker$/i.test(n || ''); }
    document.addEventListener('dragover', (e) => {
        if (e.defaultPrevented || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault(); // don't let the browser open the dropped file
    });
    document.addEventListener('drop', (e) => {
        if (e.defaultPrevented || !e.dataTransfer || !e.dataTransfer.files.length) return;
        e.preventDefault();
        const f = [...e.dataTransfer.files].find((x) => isTransferName(x.name));
        if (f) NM.transfer.restore({ file: f });
        else NM.toast('Drop a .notemaker transfer file to restore from another device.');
    });
    if (NM.native) {
        NM.native.on('openTransfer', (d) => {
            const b64 = String((d && d.base64) || '');
            const size = Math.floor(b64.length * 3 / 4);
            if (size > T.MAX_BYTES) { NM.toast('That file is larger than 1 GB, which Notemaker can’t restore in one go.', 'error', 8000); return; }
            let text;
            try { text = new TextDecoder().decode(V.unb64(b64)); } catch (e) { NM.toast('That file couldn’t be read.', 'error'); return; }
            NM.transfer.restore({ text, name: (d && d.fileName) || 'Transfer file', size });
        });
    }
})();
