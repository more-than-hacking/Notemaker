/* Notemaker — Vault view (docs/VAULT_FORMAT.md): setup wizard, unlock (passkey PRF / Secure Enclave / recovery key),
   encrypted items (note, login, card/ID, file), keyslot management, auto-lock.
   Security rules: no key or secret is ever written to localStorage / IndexedDB / sessionStorage; decrypted data lives
   only in `session` and the DOM while unlocked and is wiped on lock; all item text is rendered with textContent. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h, V = window.NotemakerVault, NC = window.NotemakerNativeClient;

    const TYPES = {
        login: { label: 'Password', icon: 'key', hint: 'Logins for sites and apps' },
        card: { label: 'Card or ID', icon: 'card', hint: 'Bank cards, passport, licence' },
        note: { label: 'Note', icon: 'note', hint: 'Codes, answers, anything private' },
        file: { label: 'File', icon: 'file', hint: 'Scans and documents, up to 25 MB' }
    };
    const KIND_LABEL = { card: 'Payment card', id: 'ID card', license: 'Licence', other: 'Other' };
    let session = null;            // { key: CryptoKey (non-extractable), items: Map<id, payload>, broken: [id] }
    const ui = { filter: 'all', q: '', selectedId: null, draft: null, editing: false, origBlobId: null, pendingBlobs: new Set(), setup: null, recoveryOpen: false,
        busy: false, note: '', noteKind: 'muted', advOpen: false, noRecovery: false, lockReason: '' };
    let pendingRaw = null;          // raw VDK held only while a post-unlock "Add this device" prompt is open
    const urls = new Set();
    const modalCloses = new Set();
    let support = null;             // cached hardware support check
    let lastActivity = Date.now(), hiddenAt = null, clipToken = 0;

    const vault = () => S.doc.vault;
    const isNative = () => !!NM.native;
    const hereName = () => (isNative() ? 'this Mac' : 'this browser');
    const autoLockMin = () => S.doc.settings.vaultAutoLockMinutes || 5;
    const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
    function err(msg, code) { const e = new Error(msg); e.code = code; return e; }
    function trackModal(m) { modalCloses.add(m.close); return m; }

    // ======================= hardware keys =======================
    async function checkSupport() {
        if (isNative()) {
            const r = await NC.seVault.available(NM.native);
            return r.available ? { ok: true, device: r.device || 'Mac' } : { ok: false, reason: 'no-se' };
        }
        if (location.protocol === 'file:') return { ok: false, reason: 'file' };
        if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
        if (!window.PublicKeyCredential || !navigator.credentials) return { ok: false, reason: 'no-webauthn' };
        try {
            if (PublicKeyCredential.getClientCapabilities) {
                const caps = await PublicKeyCredential.getClientCapabilities();
                if (caps && caps['extension:prf'] === false) return { ok: false, reason: 'no-prf' };
            }
        } catch (e) { /* unknown: try at creation time */ }
        return { ok: true, device: browserLabel() };
    }
    function browserLabel() {
        const ua = navigator.userAgent;
        const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
        const p = (navigator.userAgentData && navigator.userAgentData.platform) || (/Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '');
        return b + (p ? ' on ' + p : '') + ' (' + location.hostname + ')';
    }
    function slotsHere(v) {
        if (!v) return [];
        return isNative() ? v.keyslots.filter((s) => s.type === 'secure-enclave') : v.keyslots.filter((s) => s.type === 'passkey-prf' && s.rpId === location.hostname);
    }
    /** Is there a hardware key that works on this device? In the shell, SE slots from another Mac only reveal
        themselves as "not-this-device" when tried, so remember that per vault. */
    let seNotHereFor = null;
    function usableHere(v) {
        const here = slotsHere(v);
        if (!here.length) return false;
        if (isNative() && seNotHereFor === here.map((s) => s.id).join(',')) return false;
        return true;
    }
    function webauthnError(e) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return err('The passkey prompt was cancelled or timed out.', 'cancelled');
        if (e && e.name === 'SecurityError') return err('Passkeys can’t be used at this address (' + location.hostname + ').', 'security');
        if (e && e.name === 'InvalidStateError') return err('This authenticator already has a Notemaker vault passkey for this site.', 'exists');
        return e instanceof Error ? e : err(String(e), 'error');
    }
    const prfUnsupported = () => err('Your passkey provider didn’t return a PRF result — it can’t derive a vault key. Try iCloud Keychain (Safari 18+ / Chrome 116+) or a FIDO2 security key.', 'no-prf');

    async function passkeyPrf(list) {
        const ext = list.length === 1 ? { prf: { eval: { first: list[0].salt } } }
            : { prf: { evalByCredential: Object.fromEntries(list.map((x) => [V.b64url(x.id), { first: x.salt }])) } };
        let a;
        try {
            a = await navigator.credentials.get({ publicKey: {
                challenge: V.randomBytes(32), rpId: location.hostname, timeout: 120000, userVerification: 'required',
                allowCredentials: list.map((x) => ({ type: 'public-key', id: x.id })), extensions: ext
            } });
        } catch (e) { throw webauthnError(e); }
        if (!a) throw err('Cancelled.', 'cancelled');
        const r = a.getClientExtensionResults && a.getClientExtensionResults().prf;
        if (!r || !r.results || !r.results.first) throw prfUnsupported();
        return { output: new Uint8Array(r.results.first), credId: V.b64url(new Uint8Array(a.rawId)) };
    }
    async function passkeyCreate(raw, label) {
        const prfSalt = V.randomBytes(32);
        let cred;
        try {
            cred = await navigator.credentials.create({ publicKey: {
                rp: { name: 'Notemaker Vault', id: location.hostname },
                user: { id: V.randomBytes(16), name: 'Notemaker vault', displayName: 'Notemaker vault — ' + label },
                challenge: V.randomBytes(32), timeout: 120000,
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
                authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
                extensions: { prf: { eval: { first: prfSalt } } }
            } });
        } catch (e) { throw webauthnError(e); }
        if (!cred) throw err('Cancelled.', 'cancelled');
        const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
        if (!ext.prf || ext.prf.enabled === false) throw prfUnsupported();
        const credId = new Uint8Array(cred.rawId);
        let out = ext.prf.results && ext.prf.results.first ? new Uint8Array(ext.prf.results.first) : null;
        if (!out) out = (await passkeyPrf([{ id: credId, salt: prfSalt }])).output; // some authenticators only evaluate PRF on get()
        try { return await V.makePasskeySlot(raw, out, { credentialId: V.b64url(credId), rpId: location.hostname, prfSalt, label }); } finally { out.fill(0); }
    }
    async function hwCreate(raw) {
        const label = (support && support.device) || (isNative() ? 'This Mac' : browserLabel());
        return isNative() ? NC.seVault.createSlot(NM.native, V, raw, label) : passkeyCreate(raw, label);
    }
    /** → { raw (verified VDK bytes; caller zeroes), slot } */
    async function hwUnlock(v) {
        if (isNative()) return NC.seVault.unlock(NM.native, V, v);
        const slots = slotsHere(v);
        if (!slots.length) throw err('This browser has no passkey for this vault. Use the recovery key, then “Add this browser”.', 'no-slot');
        const res = await passkeyPrf(slots.map((s) => ({ id: V.unb64(s.credentialId), salt: V.unb64(s.prfSalt) })));
        const slot = slots.find((s) => V.b64url(V.unb64(s.credentialId)) === res.credId) || slots[0];
        try {
            const raw = await V.openPasskeySlot(slot, res.output);
            const key = await V.importVdk(raw, false);
            if (!(await V.checkVerifier(key, v.verifier))) { raw.fill(0); throw err('That passkey does not open this vault.', 'wrong-key'); }
            return { raw, slot };
        } finally { res.output.fill(0); }
    }
    async function hwRemove(slot) {
        if (slot.type === 'secure-enclave' && isNative()) { try { await NM.native.request('se.deleteSlot', { slotId: slot.id }); } catch (e) { /* not on this Mac */ } }
    }

    // ======================= session =======================
    async function openSession(raw) {
        const key = await V.sessionKey(vault(), raw); // zeroes raw
        const items = new Map(), broken = [];
        for (const it of vault().items) {
            try { items.set(it.id, await V.decryptItem(key, it)); } catch (e) { broken.push(it.id); }
        }
        session = { key, items, broken };
        lastActivity = Date.now();
        ui.note = ''; ui.recoveryOpen = false; ui.selectedId = null; ui.draft = null; ui.editing = false;
    }
    function lock(reason, detail) {
        const wasOpen = !!session;
        if (wasOpen) { const r = LOCK_REASONS[reason === 'system' ? detail : reason]; ui.lockReason = r ? r() : ''; }
        if (pendingRaw) { pendingRaw.fill(0); pendingRaw = null; }
        if (ui.setup) { if (ui.setup.raw) ui.setup.raw.fill(0); abandonSetupSlot(ui.setup); ui.setup = null; }
        if (session) { session.items.clear(); session.key = null; session = null; }
        // unsaved uploads are encrypted orphans now — remove them
        ui.pendingBlobs.forEach((id) => NM.vaultBlobs.delete(id).catch(() => { /* */ }));
        ui.pendingBlobs.clear();
        ui.draft = null; ui.editing = false; ui.selectedId = null; ui.origBlobId = null; ui.q = ''; ui.note = ''; ui.recoveryOpen = false; ui.busy = false;
        urls.forEach((u) => URL.revokeObjectURL(u)); urls.clear();
        modalCloses.forEach((c) => { try { c(); } catch (e) { /* */ } }); modalCloses.clear();
        const root = document.getElementById('view-vault');
        if (root) { NM.clear(root); root.dataset.state = ''; }
        if (S.view === 'vault') render();
        if (wasOpen && reason === 'idle' && S.view !== 'vault') NM.toast('Vault locked after ' + autoLockMin() + ' minutes of inactivity', '', 4000);
    }
    function abandonSetupSlot(st) { if (st && st.hwSlot) hwRemove(st.hwSlot); }

    async function persistItem(id, payload, createdAt) {
        const rec = await V.encryptItem(session.key, id, payload, createdAt);
        NM.update(() => {
            const arr = vault().items;
            const i = arr.findIndex((x) => x.id === id);
            if (i >= 0) arr[i] = rec; else arr.push(rec);
        });
        session.items.set(id, V.normalizePayload(payload));
    }

    // ======================= clipboard =======================
    async function copySecret(text, what) {
        if (!text) return;
        if (isNative()) {
            try { await NM.native.request('clipboard.write', { text, clearAfterSeconds: 30 }); NM.toast('Copied — clears in 30 s', 'ok'); } catch (e) { NM.toast('Couldn’t copy: ' + e.message, 'error'); }
            return;
        }
        try { await navigator.clipboard.writeText(text); } catch (e) { NM.toast('Couldn’t copy — click into the page and try again.', 'error'); return; }
        NM.toast('Copied — clears in 30 s', 'ok');
        const token = ++clipToken;
        setTimeout(async () => {
            if (token !== clipToken) return;
            let current = null;
            try { current = await navigator.clipboard.readText(); } catch (e) { current = null; }
            // clear only if the clipboard still holds our secret; if it can't be read, clear anyway (safer for secrets)
            if (current === null || current === text) { try { await navigator.clipboard.writeText(''); } catch (e) { /* page not focused */ } }
        }, 30000);
    }

    // ======================= re-authentication (to create keyslots later) =======================
    function obtainRawVdk(purpose) {
        return new Promise((resolve) => {
            let done = false, result = null;
            const here = slotsHere(vault());
            const errEl = h('p', { class: 'error-text', role: 'alert' });
            const input = h('input', { class: 'input mono', placeholder: 'XXXXX-XXXXX-…', autocomplete: 'off', spellcheck: 'false' });
            const finish = (raw) => { result = raw; done = true; m.close(); };
            const viaRecovery = async () => {
                errEl.textContent = 'Checking…';
                try { const r = await V.unlockWithRecovery(vault(), input.value); finish(r.raw); } catch (e) { errEl.textContent = e.message; }
            };
            const m = trackModal(NM.modal({
                title: 'Confirm it’s you', onClose: () => { modalCloses.delete(m.close); if (!done) resolve(null); else resolve(result); },
                body: h('div', { class: 'form' },
                    h('p', { class: 'modal-text' }, purpose + ' — please confirm it’s you.'),
                    here.length && support && support.ok ? h('button', { class: 'btn primary', type: 'button', onclick: async () => {
                        errEl.textContent = '';
                        try { const r = await hwUnlock(vault()); finish(r.raw); } catch (e) { errEl.textContent = e.message; }
                    } }, NM.icon('lock'), isNative() ? ' Use Touch ID' : ' Use passkey') : null,
                    vault().keyslots.some((s) => s.type === 'recovery') ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Or enter the recovery key'), input,
                        h('button', { class: 'btn small', type: 'button', onclick: viaRecovery }, 'Use recovery key')) : null,
                    errEl),
                actions: [{ label: 'Cancel' }]
            }));
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') viaRecovery(); });
        });
    }

    async function addHardwareSlot(raw) {
        // raw: VDK bytes (zeroed by the caller)
        const slot = await hwCreate(raw);
        NM.update(() => { vault().keyslots.push(slot); });
        NM.toast('Added ' + hereName() + ' — next time unlock with ' + (isNative() ? 'Touch ID' : 'your passkey') + '.', 'ok', 5000);
    }
    async function addRecoverySlot(raw) {
        const rec = await V.generateRecoveryKey();
        const slot = await V.makeRecoverySlot(raw, rec.bytes);
        rec.bytes.fill(0);
        NM.update(() => { vault().keyslots.push(slot); vault().mode = 'hardware+recovery'; });
        const m = trackModal(NM.modal({ title: 'Save your recovery key', cls: 'wide',
            body: h('div', { class: 'form' }, h('p', { class: 'modal-text' }, 'It’s the only way into your vault if your devices are lost. We can’t show it again.'), recoveryGrid(rec.text), recoveryActions(rec.text)),
            actions: [{ label: 'I’ve saved it', kind: 'primary' }], onClose: () => modalCloses.delete(m.close) }));
    }

    // ======================= keyslot manager =======================
    function openKeyslots() {
        const v = vault();
        const here = new Set(slotsHere(v).map((s) => s.id));
        const typeText = { 'secure-enclave': 'Mac · Secure Enclave', 'passkey-prf': 'Passkey', recovery: 'Recovery key' };
        const typeIcon = { 'secure-enclave': 'lock', 'passkey-prf': 'key', recovery: 'note' };
        const list = h('div', { class: 'slot-list' }, v.keyslots.map((s) => h('div', { class: 'slot-row' },
            h('span', { class: 'v-tile' }, NM.icon(typeIcon[s.type])),
            h('div', { class: 'slot-info' },
                h('div', { class: 'slot-label' }, s.label, here.has(s.id) ? h('span', { class: 'pill ok' }, 'this device') : null),
                h('div', { class: 'muted small' }, typeText[s.type] + (s.type === 'passkey-prf' ? ' · ' + s.rpId : '') + ' · added ' + new Date(s.createdAt).toLocaleDateString())),
            h('button', { class: 'btn ghost small danger-text', type: 'button', disabled: v.keyslots.length <= 1, title: v.keyslots.length <= 1 ? 'The last key can’t be removed' : 'Remove this key',
                onclick: async () => {
                    const warn = s.type === 'recovery' ? 'Without a recovery key, losing your devices means losing the vault.' : here.has(s.id) ? 'You will no longer be able to unlock on ' + hereName() + ' with it.' : '';
                    if (!(await NM.confirm('Remove “' + s.label + '”? ' + warn, 'Remove', true))) return;
                    NM.update(() => {
                        vault().keyslots = vault().keyslots.filter((x) => x.id !== s.id);
                        if (!vault().keyslots.some((x) => x.type === 'recovery')) vault().mode = 'hardware-only';
                    });
                    await hwRemove(s);
                    m.close(); openKeyslots();
                } }, 'Remove'))));
        const canHw = support && support.ok && !usableHere(v);
        const m = trackModal(NM.modal({
            title: 'Devices & recovery', cls: 'wide', onClose: () => modalCloses.delete(m.close),
            body: h('div', { class: 'form' },
                h('p', { class: 'modal-text' }, 'Each of these can open your vault.' + (v.mode === 'hardware-only' ? ' There is no recovery key.' : '')),
                list,
                h('div', { class: 'inline' },
                    canHw ? h('button', { class: 'btn small', type: 'button', onclick: async () => {
                        const raw = await obtainRawVdk('Adding ' + hereName());
                        if (!raw) return;
                        try { await addHardwareSlot(raw); m.close(); } catch (e) { NM.toast(e.message, 'error', 6000); } finally { raw.fill(0); }
                    } }, NM.icon('plus'), isNative() ? ' Add this Mac' : ' Add this browser') : null,
                    !v.keyslots.some((s) => s.type === 'recovery') ? h('button', { class: 'btn small', type: 'button', onclick: async () => {
                        const raw = await obtainRawVdk('Creating a recovery key');
                        if (!raw) return;
                        try { m.close(); await addRecoverySlot(raw); } catch (e) { NM.toast(e.message, 'error'); } finally { raw.fill(0); }
                    } }, NM.icon('plus'), ' Create recovery key') : null),
                support && !support.ok ? h('p', { class: 'muted small' }, isNative() ? 'Touch ID keys can’t be added on this Mac.' : 'Passkeys can’t be added on this page (needs https or localhost and a supported browser).') : null),
            actions: [{ label: 'Done', kind: 'primary' }]
        }));
    }

    // ======================= small UI helpers =======================
    const hw = () => (isNative() ? 'Touch ID' : 'a passkey');
    function iconTile(name, cls) { return h('span', { class: 'v-tile ' + (cls || ''), 'aria-hidden': 'true' }, NM.icon(name)); }
    function linkBtn(label, onClick, cls) { return h('button', { class: 'link-btn ' + (cls || ''), type: 'button', onclick: onClick }, label); }
    /** Anchored popover (Esc / click outside closes). */
    function popover(anchor, content, onClose) {
        const pop = h('div', { class: 'popover', role: 'dialog' }, content);
        document.body.appendChild(pop);
        const place = () => {
            const r = anchor.getBoundingClientRect();
            const pw = pop.offsetWidth, ph = pop.offsetHeight;
            const left = Math.min(window.innerWidth - pw - 8, Math.max(8, r.right - pw));
            let top = r.bottom + 8;
            if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
            pop.style.left = left + 'px'; pop.style.top = top + 'px';
        };
        place();
        const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
        const close = NM.pushOverlay(pop, () => {
            document.removeEventListener('mousedown', outside, true);
            window.removeEventListener('resize', place);
            modalCloses.delete(close);
            if (onClose) onClose();
        });
        modalCloses.add(close);
        setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
        window.addEventListener('resize', place);
        const f = pop.querySelector('button, input');
        if (f) setTimeout(() => f.focus(), 20);
        return close;
    }
    function menu(anchor, items) {
        let close;
        const list = h('div', { class: 'menu', role: 'menu' }, items.map((it) => h('button', { class: 'menu-item', type: 'button', role: 'menuitem', onclick: () => { close(); it.run(); } },
            it.icon ? NM.icon(it.icon) : null, h('span', null, it.label))));
        close = popover(anchor, list);
        return close;
    }

    // ======================= setup (empty state) =======================
    function finishSetup(st) {
        const raw = st.raw;
        NM.update(() => { S.doc.vault = st.draft; });
        ui.setup = null;
        return openSession(raw).then(() => {
            NM.toast('Vault ready — it locks automatically after ' + autoLockMin() + ' minutes', 'ok', 5000);
            render();
        });
    }
    async function startSetup() {
        const mode = ui.noRecovery ? 'hardware-only' : 'hardware+recovery';
        ui.busy = true; ui.note = ''; render();
        const raw = V.generateVdkRaw();
        try {
            const hwSlot = await hwCreate(raw);
            const key = await V.importVdk(raw.slice(), false);
            const draft = await V.newVault(mode, key);
            draft.keyslots.push(hwSlot);
            const st = { raw, draft, hwSlot };
            ui.busy = false;
            if (mode === 'hardware+recovery') {
                const rec = await V.generateRecoveryKey();
                draft.keyslots.push(await V.makeRecoverySlot(raw, rec.bytes));
                rec.bytes.fill(0);
                st.recText = rec.text;
                ui.setup = st;
                render();
            } else await finishSetup(st);
        } catch (e) {
            raw.fill(0);
            ui.busy = false;
            ui.note = e.code === 'cancelled' ? (isNative() ? 'Touch ID was cancelled — try again when you’re ready.' : 'The passkey prompt was closed — try again when you’re ready.') : e.message;
            ui.noteKind = e.code === 'cancelled' ? 'muted' : 'warn';
            render();
        }
    }
    function fixPanel() {
        const cmd = 'python3 -m http.server 8000';
        const why = {
            file: 'Passkeys need a web address, and this page was opened as a file.',
            insecure: 'Passkeys only work on secure pages (https or localhost).',
            'no-webauthn': 'This browser doesn’t support passkeys.',
            'no-prf': 'This browser or passkey can’t be used to lock a vault yet.',
            'no-se': 'This Mac doesn’t have the security chip Touch ID keys need.'
        }[support.reason] || 'Passkeys aren’t available here.';
        const details = h('details', { class: 'fix' },
            h('summary', null, 'How to fix'),
            isNative() ? h('p', { class: 'muted' }, 'Use a Mac with Apple silicon or a T2 chip, or open the vault with its recovery key.') : h('div', { class: 'fix-body' },
                h('p', { class: 'muted' }, 'Open Notemaker from a local web server, then visit ', h('code', null, 'http://localhost:8000'), ' in Safari 18+ or Chrome 116+:'),
                h('div', { class: 'cmd-line' }, h('code', null, cmd), h('button', { class: 'btn ghost small', type: 'button', onclick: async () => {
                    try { await navigator.clipboard.writeText(cmd); NM.toast('Copied', 'ok'); } catch (e) { NM.toast('Copy failed', 'error'); }
                } }, NM.icon('copy'), ' Copy')),
                h('p', { class: 'muted small' }, 'Your passkey can live in iCloud Keychain, your password manager or on a security key.')));
        return h('div', { class: 'unavailable' }, h('p', null, why), details);
    }
    function renderSetup(root) {
        if (ui.setup && ui.setup.recText) return renderRecoveryKey(root);
        const col = h('div', { class: 'v-center' });
        col.appendChild(iconTile('lock', 'big'));
        col.appendChild(h('h2', { class: 'v-title' }, 'Your private vault'));
        col.appendChild(h('p', { class: 'v-lead' }, 'Keep passwords, cards, IDs, private notes and files here. Only ' +
            (isNative() ? 'your fingerprint (Touch ID)' : 'your passkey (Touch ID or security key)') + ' can open it.'));
        col.appendChild(h('div', { class: 'v-tiles', 'aria-hidden': 'true' },
            [['key', 'Passwords'], ['card', 'Cards & IDs'], ['note', 'Notes'], ['file', 'Files']].map(([i, l]) => h('div', { class: 'v-preview' }, NM.icon(i), h('span', null, l)))));
        if (!support) col.appendChild(h('button', { class: 'btn primary v-cta', type: 'button', disabled: true }, 'Checking…'));
        else if (support.ok) {
            const cta = h('button', { class: 'btn primary v-cta', type: 'button', disabled: ui.busy, onclick: startSetup },
                ui.busy ? 'Waiting for ' + hw() + '…' : isNative() ? 'Set up with Touch ID' : 'Set up with a passkey');
            col.appendChild(cta);
            if (ui.note) col.appendChild(h('p', { class: 'v-note ' + (ui.noteKind || 'muted'), role: 'status' }, ui.note));
            const adv = h('div', { class: 'v-advanced' });
            if (!ui.advOpen) adv.appendChild(linkBtn('Advanced options', () => { ui.advOpen = true; render(); }));
            else {
                adv.appendChild(h('label', { class: 'check-line' }, h('input', { type: 'checkbox', checked: !!ui.noRecovery, onchange: (e) => { ui.noRecovery = e.target.checked; render(); } }),
                    h('span', null, 'Don’t create a recovery key')));
                if (ui.noRecovery) adv.appendChild(h('p', { class: 'v-note warn' }, 'If you lose ' + (isNative() ? 'this Mac' : 'this passkey') + ', everything in the vault is lost for good.'));
            }
            col.appendChild(adv);
            if (!ui.busy) setTimeout(() => { if (document.activeElement === document.body) cta.focus(); }, 30);
        } else {
            col.appendChild(fixPanel());
            col.appendChild(linkBtn('Open an existing vault with a recovery key', () => {
                NM.toast('Import the backup that contains your vault, then unlock it with its recovery key.', '', 7000);
                document.getElementById('importFile').click();
            }));
        }
        root.appendChild(col);
    }
    function recoveryGrid(text) {
        return h('div', { class: 'rk-grid', 'aria-label': 'Recovery key' }, text.split('-').map((g) => h('span', null, g)));
    }
    function recoveryActions(text) {
        const print = () => {
            const f = h('iframe', { style: { position: 'fixed', width: '0', height: '0', border: '0', right: '0', bottom: '0' }, 'aria-hidden': 'true' });
            document.body.appendChild(f);
            const d = f.contentDocument;
            d.open(); d.write('<!doctype html><title>Notemaker vault recovery key</title>'); d.close();
            d.body.style.font = '16px -apple-system, sans-serif';
            const add = (tag, t, css) => { const e = d.createElement(tag); e.textContent = t; if (css) e.style.cssText = css; d.body.appendChild(e); };
            add('h1', 'Notemaker vault — recovery key');
            add('p', 'Created ' + new Date().toLocaleString() + '. Anyone with this key can open your vault. Keep it somewhere safe and offline.');
            add('pre', text, 'font: 22px ui-monospace, Menlo, monospace;');
            f.contentWindow.focus(); f.contentWindow.print();
            setTimeout(() => f.remove(), 1500);
        };
        return h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Save the recovery key' },
            h('button', { class: 'btn', type: 'button', onclick: () => copySecret(text) }, NM.icon('copy'), ' Copy'),
            h('button', { class: 'btn', type: 'button', onclick: () => NM.download('Notemaker vault recovery key.txt', 'Notemaker vault recovery key\n\n' + text + '\n\nCreated ' + new Date().toISOString() + '\nAnyone with this key can open your vault. Keep it somewhere safe and offline.\n', 'text/plain') }, NM.icon('download'), ' Save as file'),
            h('button', { class: 'btn', type: 'button', onclick: print }, NM.icon('note'), ' Print'));
    }
    function renderRecoveryKey(root) {
        const st = ui.setup;
        const col = h('div', { class: 'v-center' });
        col.appendChild(iconTile('key', 'big'));
        col.appendChild(h('h2', { class: 'v-title' }, 'Save your recovery key'));
        col.appendChild(h('p', { class: 'v-lead' }, 'It’s the only way into your vault if ' + (isNative() ? 'this Mac' : 'your passkey') + ' is lost. We can’t show it again.'));
        col.appendChild(recoveryGrid(st.recText));
        col.appendChild(recoveryActions(st.recText));
        const open = h('button', { class: 'btn primary v-cta', type: 'button', disabled: !st.saved, onclick: async () => { st.recText = null; open.disabled = true; await finishSetup(st); } }, 'Open my vault');
        col.appendChild(h('label', { class: 'check-line v-check' }, h('input', { type: 'checkbox', checked: !!st.saved, onchange: (e) => { st.saved = e.target.checked; open.disabled = !st.saved; if (st.saved) open.focus(); } }),
            h('span', null, 'I’ve saved my recovery key somewhere safe')));
        col.appendChild(open);
        col.appendChild(linkBtn('Cancel setup', () => { if (st.raw) st.raw.fill(0); abandonSetupSlot(st); ui.setup = null; render(); }, 'muted'));
        root.appendChild(col);
    }

    // ======================= unlock screen =======================
    function recoveryInput(onReady) {
        const input = h('input', { class: 'input rk-input', placeholder: 'XXXXX-XXXXX-XXXXX-…', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', 'aria-label': 'Recovery key', inputmode: 'text' });
        const mark = h('span', { class: 'rk-mark', 'aria-live': 'polite' });
        input.addEventListener('input', async () => {
            const raw = input.value.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '').slice(0, 55);
            input.value = (raw.match(/.{1,5}/g) || []).join('-');
            mark.className = 'rk-mark'; mark.textContent = '';
            if (raw.length === 55) {
                try { const b = await V.parseRecoveryKey(raw); b.fill(0); mark.className = 'rk-mark ok'; mark.textContent = '✓'; mark.title = 'Looks right'; onReady(true); return; } catch (e) { mark.className = 'rk-mark bad'; mark.textContent = 'Check for typos'; }
            }
            onReady(false);
        });
        return { input, el: h('div', { class: 'rk-field' }, input, mark) };
    }
    const LOCK_REASONS = {
        idle: () => 'Locked after ' + autoLockMin() + ' minutes of inactivity', hidden: () => 'Locked while the window was in the background',
        sleep: () => 'Locked because your Mac went to sleep', 'screen-lock': () => 'Locked because your screen locked', quit: () => ''
    };
    function renderLocked(root) {
        const v = vault();
        const canHw = support && support.ok && slotsHere(v).length && usableHere(v);
        const hasRecovery = v.keyslots.some((s) => s.type === 'recovery');
        const col = h('div', { class: 'v-center' });
        col.appendChild(iconTile('lock', 'big'));
        col.appendChild(h('h2', { class: 'v-title' }, 'Vault locked'));
        col.appendChild(h('p', { class: 'v-lead muted' }, v.items.length + ' item' + (v.items.length === 1 ? '' : 's')));
        if (ui.lockReason) col.appendChild(h('p', { class: 'v-note muted small' }, ui.lockReason));
        const showRecovery = ui.recoveryOpen || (!canHw && hasRecovery && support);
        if (!support) col.appendChild(h('button', { class: 'btn primary v-cta', type: 'button', disabled: true }, 'Checking…'));
        else if (canHw && !ui.recoveryOpen) {
            const btn = h('button', { class: 'btn primary v-cta', type: 'button', disabled: ui.busy, onclick: async () => {
                ui.busy = true; ui.note = ''; render();
                try { const r = await hwUnlock(vault()); ui.lockReason = ''; await openSession(r.raw); } catch (e) {
                    if (e.code === 'not-this-device') seNotHereFor = slotsHere(vault()).map((s) => s.id).join(',');
                    ui.note = e.code === 'not-this-device' ? '' : e.code === 'cancelled' ? (isNative() ? 'Touch ID was cancelled — try again when you’re ready.' : 'The passkey prompt was closed — try again when you’re ready.') : e.message;
                    ui.noteKind = e.code === 'cancelled' ? 'muted' : 'warn';
                }
                ui.busy = false; render();
            } }, ui.busy ? 'Waiting for ' + hw() + '…' : isNative() ? 'Unlock with Touch ID' : 'Unlock with passkey');
            col.appendChild(btn);
            if (ui.note) col.appendChild(h('p', { class: 'v-note ' + (ui.noteKind || 'muted'), role: 'status' }, ui.note));
            if (hasRecovery) col.appendChild(linkBtn('Use recovery key instead', () => { ui.recoveryOpen = true; ui.note = ''; render(); }));
            if (!ui.busy) setTimeout(() => { if (!NM.overlayOpen() && S.view === 'vault' && document.activeElement && !NM.isTyping({ target: document.activeElement })) btn.focus(); }, 30);
        } else if (showRecovery && hasRecovery) {
            if (support && !support.ok) col.appendChild(fixPanel());
            else if (!canHw) col.appendChild(h('p', { class: 'v-note muted' }, (isNative() ? 'This Mac' : 'This browser') + ' can’t open the vault yet. Use your recovery key — you can add ' + (isNative() ? 'Touch ID' : 'a passkey') + ' afterwards.'));
            const unlockBtn = h('button', { class: 'btn primary v-cta', type: 'button', disabled: true });
            unlockBtn.textContent = 'Unlock';
            const rk = recoveryInput((ok) => { unlockBtn.disabled = !ok || ui.busy; });
            const go = async () => {
                if (unlockBtn.disabled) return;
                ui.busy = true; unlockBtn.disabled = true; unlockBtn.textContent = 'Unlocking…'; ui.note = '';
                try {
                    const r = await V.unlockWithRecovery(vault(), rk.input.value);
                    rk.input.value = '';
                    const offer = support && support.ok && !usableHere(vault());
                    if (offer) pendingRaw = r.raw.slice();
                    ui.lockReason = '';
                    await openSession(r.raw);
                    ui.busy = false; render();
                    if (offer) offerAddDevice();
                    return;
                } catch (e) { ui.note = e.message; ui.noteKind = 'warn'; }
                ui.busy = false; render();
            };
            rk.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape' && canHw) { e.stopPropagation(); ui.recoveryOpen = false; render(); } });
            unlockBtn.addEventListener('click', go);
            col.appendChild(h('label', { class: 'field v-field' }, h('span', { class: 'field-label' }, 'Recovery key'), rk.el));
            col.appendChild(unlockBtn);
            if (ui.note) col.appendChild(h('p', { class: 'v-note ' + (ui.noteKind || 'muted'), role: 'status' }, ui.note));
            if (canHw) col.appendChild(linkBtn('Use ' + (isNative() ? 'Touch ID' : 'your passkey') + ' instead', () => { ui.recoveryOpen = false; ui.note = ''; render(); }));
            setTimeout(() => rk.input.focus(), 30);
        } else {
            if (support && !support.ok) col.appendChild(fixPanel());
            col.appendChild(h('p', { class: 'v-note muted' }, 'This vault has no recovery key, so it only opens on the device that created it.'));
        }
        root.appendChild(col);
    }
    async function offerAddDevice() {
        const choice = await NM.choose(isNative() ? 'Use Touch ID next time?' : 'Use a passkey next time?',
            'Add ' + hereName() + ' so you can unlock with ' + (isNative() ? 'Touch ID' : 'a passkey') + ' instead of typing the recovery key.',
            [{ label: 'Not now', value: null }, { label: isNative() ? 'Add this Mac' : 'Add this browser', value: 'add', kind: 'primary' }]);
        const raw = pendingRaw;
        pendingRaw = null;
        if (!raw) return;
        try { if (choice === 'add' && session) { await addHardwareSlot(raw); render(); } } catch (e) { NM.toast(e.message, 'error', 7000); } finally { raw.fill(0); }
    }

    // ======================= unlocked: list + detail =======================
    function itemMatches(p, q) {
        if (!q) return true;
        const hay = [p.title, p.notes, p.tags.join(' '), p.username, p.url, p.fileName, p.issuer, p.holder, p.markdown, KIND_LABEL[p.kind]].filter(Boolean).join(' ').toLowerCase();
        return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
    }
    const last4 = (n) => String(n || '').replace(/\s/g, '').slice(-4);
    function subtitle(p) {
        if (p.type === 'login') return p.username || p.url || 'No username';
        if (p.type === 'card') return (p.number ? '•••• ' + last4(p.number) : KIND_LABEL[p.kind] || '');
        if (p.type === 'file') return p.size ? fmtSize(p.size) + (p.fileName ? ' · ' + p.fileName : '') : 'No file';
        return (p.markdown || '').split('\n').find((l) => l.trim()) ? 'Note' : 'Empty note';
    }
    function avatar(p) {
        if (p.type === 'login' || p.type === 'card') {
            const letter = (p.title || '?').trim().charAt(0).toUpperCase() || '?';
            return h('span', { class: 'v-avatar', style: { '--tag-h': String(C.tagHue((p.title || '?').toLowerCase())) }, 'aria-hidden': 'true' }, letter);
        }
        return h('span', { class: 'v-avatar icon-avatar', 'aria-hidden': 'true' }, NM.icon(TYPES[p.type].icon));
    }
    function renderList(box) {
        NM.clear(box);
        const entries = [...session.items.entries()].filter(([, p]) =>
            (ui.filter === 'all' || (ui.filter === 'fav' ? p.favorite : p.type === ui.filter)) && itemMatches(p, ui.q))
            .sort((a, b) => (b[1].favorite - a[1].favorite) || a[1].title.localeCompare(b[1].title));
        if (!entries.length) box.appendChild(h('p', { class: 'muted small v-empty-list' }, ui.q ? 'Nothing matches “' + ui.q + '”.' : 'Nothing here yet.'));
        for (const [id, p] of entries) {
            box.appendChild(h('button', { class: 'v-row' + (ui.selectedId === id ? ' active' : ''), type: 'button', onclick: () => select(id) },
                avatar(p),
                h('span', { class: 'v-row-text' }, h('span', { class: 'v-row-title' }, p.title || 'Untitled'), h('span', { class: 'v-row-sub' }, subtitle(p))),
                p.favorite ? h('span', { class: 'v-row-star', title: 'Favorite' }, NM.icon('star')) : null));
        }
        if (session.broken.length) box.appendChild(h('p', { class: 'v-note warn small' }, session.broken.length + ' item(s) couldn’t be opened (damaged or from another vault).'));
    }
    async function discardDraft() {
        if (ui.draft && ui.draft.blobId && ui.pendingBlobs.has(ui.draft.blobId)) {
            ui.pendingBlobs.delete(ui.draft.blobId);
            try { await NM.vaultBlobs.delete(ui.draft.blobId); } catch (e) { /* */ }
        }
        ui.pendingBlobs.forEach((id) => NM.vaultBlobs.delete(id).catch(() => { /* */ }));
        ui.pendingBlobs.clear();
        ui.draft = null; ui.editing = false; ui.origBlobId = null;
    }
    async function select(id) {
        await discardDraft();
        ui.selectedId = id;
        rerenderUnlocked();
    }
    async function newItem(type) {
        await discardDraft();
        ui.selectedId = 'new:' + V.uuid();
        ui.draft = V.normalizePayload({ type, title: '' });
        if (type === 'card') ui.draft.fields = [];
        ui.editing = true; ui.origBlobId = null;
        rerenderUnlocked();
        setTimeout(() => { const t = document.querySelector('#view-vault [data-f="title"]'); if (t) t.focus(); }, 30);
    }
    function startEdit() {
        ui.draft = JSON.parse(JSON.stringify(session.items.get(ui.selectedId)));
        ui.origBlobId = ui.draft.blobId || null;
        ui.editing = true;
        rerenderUnlocked();
        setTimeout(() => { const t = document.querySelector('#view-vault [data-f="title"]'); if (t) t.focus(); }, 30);
    }
    function rerenderUnlocked() { renderUnlocked(document.getElementById('view-vault'), true); }

    const field = (label, ...kids) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), ...kids);
    function textField(label, key, opts) {
        opts = opts || {};
        const d = ui.draft;
        const input = h(opts.multiline ? 'textarea' : 'input', { class: 'input' + (opts.mono ? ' mono' : ''), rows: opts.rows || null, placeholder: opts.placeholder || '', dataset: { f: key },
            autocomplete: 'off', spellcheck: opts.spell ? 'true' : 'false', oninput: (e) => { d[key] = e.target.value; } });
        input.value = d[key] || '';
        return field(label, input);
    }
    function secretField(label, get, set, opts) {
        opts = opts || {};
        const input = h('input', { class: 'input mono', type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: opts.placeholder || '', oninput: (e) => { set(e.target.value); if (opts.onInput) opts.onInput(e.target.value); } });
        input.value = get() || '';
        const eye = NM.iconBtn('eye', 'Show', () => { const show = input.type === 'password'; input.type = show ? 'text' : 'password'; eye.title = show ? 'Hide' : 'Show'; eye.classList.toggle('active', show); });
        const acts = [eye].concat(opts.extra ? [opts.extra] : []);
        return { input, el: field(label, h('div', { class: 'secret-row', style: { '--actions': String(acts.length) } }, input, h('span', { class: 'field-actions' }, acts))) };
    }
    function strengthBar(pw) {
        const s = V.passwordStrength(pw);
        return h('div', { class: 'strength s' + s.score, title: pw ? s.label : '' }, h('div', { class: 'strength-bar' }, h('span', { style: { width: (pw ? (s.score + 1) * 20 : 0) + '%' } })),
            h('span', { class: 'strength-label' }, pw ? s.label : ''));
    }
    function openGenerator(anchor, onUse) {
        const o = { length: 20, upper: true, lower: true, digits: true, symbols: true, avoidLookalikes: true };
        const out = h('div', { class: 'gen-output' });
        const meter = h('div');
        let pw = '';
        const regen = () => { pw = V.generatePassword(o); out.textContent = pw; NM.clear(meter).appendChild(strengthBar(pw)); };
        const lenVal = h('span', { class: 'gen-len' }, String(o.length));
        const range = h('input', { type: 'range', min: 8, max: 64, value: o.length, 'aria-label': 'Length', oninput: (e) => { o.length = +e.target.value; lenVal.textContent = e.target.value; regen(); } });
        const tog = (k, label) => h('label', { class: 'check-line' }, h('input', { type: 'checkbox', checked: o[k], onchange: (e) => { o[k] = e.target.checked; regen(); } }), h('span', null, label));
        regen();
        let close;
        const content = h('div', { class: 'gen' },
            h('div', { class: 'gen-head' }, h('span', { class: 'field-label' }, 'Generated password'), NM.iconBtn('repeat', 'New password', regen)),
            out, meter,
            h('div', { class: 'gen-length' }, h('span', null, 'Length'), range, lenVal),
            h('div', { class: 'gen-toggles' }, tog('upper', 'A–Z'), tog('lower', 'a–z'), tog('digits', '0–9'), tog('symbols', '!@#'), tog('avoidLookalikes', 'No look-alikes')),
            h('button', { class: 'btn primary', type: 'button', onclick: () => { onUse(pw); close(); } }, 'Use password'));
        close = popover(anchor, content, () => { pw = ''; });
    }
    async function attachFile(file, rerender) {
        if (!file) return;
        if (file.size > V.MAX_FILE_BYTES) { NM.toast('Files can be up to 25 MB (this one is ' + fmtSize(file.size) + ').', 'error'); return; }
        const d = ui.draft;
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const blobId = V.uuid();
            const enc = await V.encryptBlob(session.key, blobId, bytes);
            const sha = await V.sha256Hex(bytes);
            bytes.fill(0);
            await NM.vaultBlobs.put(blobId, enc.iv, enc.ct);
            if (d.blobId && ui.pendingBlobs.has(d.blobId)) { ui.pendingBlobs.delete(d.blobId); NM.vaultBlobs.delete(d.blobId).catch(() => { /* */ }); }
            ui.pendingBlobs.add(blobId);
            Object.assign(d, { fileName: file.name, mime: file.type || 'application/octet-stream', size: file.size, blobId, sha256: sha });
            if (!d.title) d.title = file.name;
            rerender();
        } catch (e) { NM.toast('Couldn’t add the file: ' + e.message, 'error', 7000); }
    }
    async function fileBytes(p) {
        const rec = await NM.vaultBlobs.get(p.blobId);
        if (!rec) throw new Error('This file isn’t on this device yet — import a backup that includes it.');
        const bytes = await V.decryptBlob(session.key, p.blobId, rec);
        if (p.sha256 && (await V.sha256Hex(bytes)) !== p.sha256) throw new Error('The file looks damaged.');
        return bytes;
    }
    async function previewFile(p) {
        let bytes;
        try { bytes = await fileBytes(p); } catch (e) { NM.toast(e.message, 'error'); return; }
        const isImg = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/.test(p.mime), isPdf = p.mime === 'application/pdf';
        const url = URL.createObjectURL(new Blob([bytes], { type: isImg || isPdf ? p.mime : 'application/octet-stream' }));
        bytes.fill(0);
        urls.add(url);
        const viewer = isImg ? h('img', { src: url, alt: p.fileName, class: 'file-preview-img' }) : h('iframe', { src: url, class: 'file-preview-frame', title: p.fileName });
        const m = trackModal(NM.modal({ title: p.fileName, cls: 'wide', body: viewer, actions: [{ label: 'Close', kind: 'primary' }],
            onClose: () => { modalCloses.delete(m.close); URL.revokeObjectURL(url); urls.delete(url); } }));
    }
    const isPreviewable = (mime) => /^image\/|^application\/pdf$/.test(mime || '');

    /** Read-only label/value row with inline Show / Copy / Open actions. */
    function dRow(label, value, opts) {
        opts = opts || {};
        if (!value && !opts.always) return null;
        const text = h('span', { class: 'd-value' + (opts.mono ? ' mono' : '') + (opts.secret ? ' masked' : '') });
        let shown = !opts.secret;
        const paint = () => { text.textContent = shown ? value : '••••••••••'; text.classList.toggle('masked', !shown); };
        paint();
        const acts = [];
        if (opts.secret) {
            const eye = NM.iconBtn('eye', 'Show', () => { shown = !shown; paint(); eye.title = shown ? 'Hide' : 'Show'; eye.setAttribute('aria-label', eye.title); eye.classList.toggle('active', shown); });
            acts.push(eye);
        }
        if (opts.open) acts.push(NM.iconBtn('link', 'Open website', () => NM.openExternal(value)));
        if (!opts.noCopy) acts.push(NM.iconBtn('copy', 'Copy', () => copySecret(value)));
        return h('div', { class: 'd-row' }, h('span', { class: 'd-label' }, label), h('div', { class: 'd-main' }, text, h('span', { class: 'd-actions' }, acts)), opts.after || null);
    }
    function renderDetail(box) {
        NM.clear(box);
        const p = session.items.get(ui.selectedId);
        if (!p) return;
        const t = TYPES[p.type];
        box.appendChild(h('div', { class: 'd-head' },
            h('button', { class: 'icon-btn back-btn', type: 'button', 'aria-label': 'All items', title: 'All items', onclick: () => { ui.selectedId = null; rerenderUnlocked(); } }, NM.icon('back')),
            avatar(p),
            h('div', { class: 'd-titles' }, h('h3', { class: 'd-title' }, p.title || 'Untitled'), h('span', { class: 'd-type' }, t.label)),
            h('button', { class: 'icon-btn star-btn' + (p.favorite ? ' active' : ''), type: 'button', title: p.favorite ? 'Remove from favorites' : 'Add to favorites', 'aria-pressed': String(p.favorite),
                onclick: async () => { const np = Object.assign({}, p, { favorite: !p.favorite }); const rec = vault().items.find((x) => x.id === ui.selectedId); await persistItem(ui.selectedId, np, rec && rec.createdAt); rerenderUnlocked(); } }, NM.icon('star')),
            h('button', { class: 'btn small', type: 'button', onclick: startEdit }, NM.icon('edit'), ' Edit')));
        const rows = h('div', { class: 'd-rows' });
        const add = (r) => { if (r) rows.appendChild(r); };
        if (p.type === 'login') {
            add(dRow('Username', p.username));
            add(dRow('Password', p.password, { secret: true, mono: true, after: p.password ? strengthBar(p.password) : null }));
            add(dRow('Website', p.url, { open: /^https?:\/\//i.test(p.url) }));
            add(dRow('One-time code secret', p.totpSecret, { secret: true, mono: true }));
        } else if (p.type === 'card') {
            add(dRow('Type', KIND_LABEL[p.kind], { noCopy: true }));
            add(dRow('Name', p.holder));
            add(dRow('Number', p.number, { secret: true, mono: true }));
            add(dRow('Expires', p.expiry, { mono: true }));
            add(dRow(p.kind === 'card' ? 'Security code' : 'PIN', p.cvv, { secret: true, mono: true }));
            add(dRow('Issuer', p.issuer));
            p.fields.forEach((f) => add(dRow(f.label || 'Field', f.value, { secret: f.secret, mono: f.secret })));
        } else if (p.type === 'note') {
            rows.appendChild(h('div', { class: 'd-note' }, p.markdown || 'This note is empty.'));
        } else if (p.type === 'file') {
            rows.appendChild(h('div', { class: 'd-file' }, h('span', { class: 'v-avatar icon-avatar' }, NM.icon('file')),
                h('div', { class: 'd-titles' }, h('span', { class: 'd-file-name' }, p.fileName || 'No file'), h('span', { class: 'd-type' }, fmtSize(p.size) + (p.mime ? ' · ' + p.mime : ''))),
                h('div', { class: 'btn-group' },
                    isPreviewable(p.mime) ? h('button', { class: 'btn small', type: 'button', onclick: () => previewFile(p) }, NM.icon('eye'), ' Preview') : null,
                    h('button', { class: 'btn small', type: 'button', onclick: async () => { try { const b = await fileBytes(p); NM.download(p.fileName || 'file', b, p.mime || 'application/octet-stream'); } catch (e) { NM.toast(e.message, 'error'); } } }, NM.icon('download'), ' Download'))));
        }
        if (p.type !== 'note' && p.notes) rows.appendChild(h('div', { class: 'd-row' }, h('span', { class: 'd-label' }, 'Notes'), h('div', { class: 'd-note' }, p.notes)));
        if (p.tags.length) rows.appendChild(h('div', { class: 'd-row' }, h('span', { class: 'd-label' }, 'Tags'), h('div', { class: 'chip-row' }, p.tags.map((g) => NM.tagChip(g)))));
        box.appendChild(rows);
        const rec = vault().items.find((x) => x.id === ui.selectedId);
        if (rec) box.appendChild(h('p', { class: 'd-meta' }, 'Updated ' + new Date(rec.updatedAt).toLocaleString()));
    }

    function renderEditor(box) {
        NM.clear(box);
        const d = ui.draft;
        const isNew = String(ui.selectedId).startsWith('new:');
        const rerender = () => renderEditor(box);
        const t = TYPES[d.type];
        const title = h('input', { class: 'input title-input', placeholder: t.label === 'Password' ? 'Name, e.g. “Bank”' : 'Name', dataset: { f: 'title' }, oninput: (e) => { d.title = e.target.value; } });
        title.value = d.title;
        box.appendChild(h('div', { class: 'd-head' }, h('span', { class: 'v-avatar icon-avatar' }, NM.icon(t.icon)), h('div', { class: 'd-titles' }, h('h3', { class: 'd-title' }, isNew ? 'New ' + t.label.toLowerCase() : 'Edit ' + t.label.toLowerCase()))));
        const body = h('div', { class: 'editor-body' });
        body.appendChild(field('Name', title));
        if (d.type === 'note') {
            body.appendChild(textField('Note', 'markdown', { multiline: true, rows: 12, spell: true, placeholder: 'Anything private.' }));
        } else if (d.type === 'login') {
            body.appendChild(textField('Username or email', 'username'));
            const meter = h('div');
            const genBtn = h('button', { class: 'btn small', type: 'button' }, NM.icon('sparkle'), ' Generate');
            const pw = secretField('Password', () => d.password, (v) => { d.password = v; }, { onInput: (v) => NM.clear(meter).appendChild(strengthBar(v)) });
            genBtn.addEventListener('click', () => openGenerator(genBtn, (v) => { d.password = v; pw.input.value = v; pw.input.type = 'text'; NM.clear(meter).appendChild(strengthBar(v)); }));
            meter.appendChild(strengthBar(d.password));
            body.appendChild(h('div', { class: 'pw-block' }, pw.el, h('div', { class: 'pw-under' }, meter, genBtn)));
            body.appendChild(textField('Website', 'url', { placeholder: 'https://' }));
            body.appendChild(secretField('One-time code secret (optional)', () => d.totpSecret, (v) => { d.totpSecret = v; }).el);
        } else if (d.type === 'card') {
            body.appendChild(field('Type', h('select', { class: 'select', onchange: (e) => { d.kind = e.target.value; } },
                V.CARD_KINDS.map((k) => h('option', { value: k, selected: d.kind === k }, KIND_LABEL[k])))));
            body.appendChild(textField('Name on card', 'holder'));
            body.appendChild(secretField('Number', () => d.number, (v) => { d.number = v; }).el);
            body.appendChild(h('div', { class: 'grid2' }, textField('Expires', 'expiry', { placeholder: 'MM/YY' }), secretField('Security code or PIN', () => d.cvv, (v) => { d.cvv = v; }).el));
            body.appendChild(textField('Issuer', 'issuer'));
            const fields = h('div', { class: 'custom-fields' });
            const drawFields = () => {
                NM.clear(fields);
                d.fields.forEach((f, i) => {
                    const label = h('input', { class: 'input', placeholder: 'Label', oninput: (e) => { f.label = e.target.value; } });
                    label.value = f.label;
                    const value = h('input', { class: 'input mono', type: f.secret ? 'password' : 'text', placeholder: 'Value', autocomplete: 'off', oninput: (e) => { f.value = e.target.value; } });
                    value.value = f.value;
                    fields.appendChild(h('div', { class: 'custom-field' }, label, value,
                        h('label', { class: 'check-line', title: 'Hide this value' }, h('input', { type: 'checkbox', checked: f.secret, onchange: (e) => { f.secret = e.target.checked; value.type = f.secret ? 'password' : 'text'; } }), h('span', null, 'Hidden')),
                        NM.iconBtn('x', 'Remove field', () => { d.fields.splice(i, 1); drawFields(); })));
                });
                fields.appendChild(h('div', null, h('button', { class: 'btn ghost small', type: 'button', onclick: () => { d.fields.push({ label: '', value: '', secret: false }); drawFields(); } }, NM.icon('plus'), ' Add a field')));
            };
            drawFields();
            body.appendChild(field('More details', fields));
        } else if (d.type === 'file') {
            const picker = h('input', { type: 'file', hidden: true, onchange: (e) => { attachFile(e.target.files[0], rerender); e.target.value = ''; } });
            const drop = h('div', { class: 'drop-zone', tabindex: 0, role: 'button', 'aria-label': 'Choose a file', onclick: () => picker.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } } },
                d.blobId ? h('div', { class: 'd-file' }, h('span', { class: 'v-avatar icon-avatar' }, NM.icon('file')),
                    h('div', { class: 'd-titles' }, h('span', { class: 'd-file-name' }, d.fileName), h('span', { class: 'd-type' }, fmtSize(d.size) + ' · click to replace')))
                    : h('div', { class: 'drop-empty' }, NM.icon('upload'), h('span', null, 'Drop a file here or click to choose'), h('span', { class: 'muted small' }, 'Up to 25 MB')));
            drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drop'); });
            drop.addEventListener('dragleave', () => drop.classList.remove('drop'));
            drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drop'); if (e.dataTransfer.files[0]) attachFile(e.dataTransfer.files[0], rerender); });
            body.appendChild(picker);
            body.appendChild(field('File', drop));
        }
        if (d.type !== 'note') body.appendChild(textField('Notes', 'notes', { multiline: true, rows: 3, spell: true }));
        const tags = h('input', { class: 'input', placeholder: 'personal, finance', oninput: (e) => { d.tags = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); } });
        tags.value = d.tags.join(', ');
        body.appendChild(field('Tags', tags));
        box.appendChild(body);

        const save = async () => {
            if (d.type === 'file' && !d.blobId) { NM.toast('Choose a file first', 'error'); return; }
            if (!d.title.trim()) d.title = d.type === 'file' ? d.fileName : 'Untitled';
            saveBtn.disabled = true;
            const id = isNew ? ui.selectedId.slice(4) : ui.selectedId;
            const existing = vault().items.find((x) => x.id === id);
            try {
                await persistItem(id, d, existing ? existing.createdAt : null);
                if (ui.origBlobId && ui.origBlobId !== d.blobId) NM.vaultBlobs.delete(ui.origBlobId).catch(() => { /* */ });
                ui.pendingBlobs.delete(d.blobId);
                ui.selectedId = id; ui.draft = null; ui.editing = false; ui.origBlobId = null;
                rerenderUnlocked();
            } catch (e) { NM.toast('Couldn’t save: ' + e.message, 'error'); saveBtn.disabled = false; }
        };
        const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save');
        const cancel = async () => { const wasNew = isNew; await discardDraft(); if (wasNew) ui.selectedId = null; rerenderUnlocked(); };
        box.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'Enter')) { e.preventDefault(); save(); }
            if (e.key === 'Escape' && !NM.overlayOpen()) { e.preventDefault(); e.stopPropagation(); cancel(); }
        });
        box.appendChild(h('div', { class: 'editor-actions' },
            !isNew ? h('button', { class: 'btn ghost small danger-text', type: 'button', onclick: async () => {
                if (!(await NM.confirm('Delete “' + (d.title || 'this item') + '”? This can’t be undone.', 'Delete', true))) return;
                const id = ui.selectedId;
                const p = session.items.get(id);
                NM.update(() => { vault().items = vault().items.filter((x) => x.id !== id); });
                session.items.delete(id);
                if (p && p.blobId) NM.vaultBlobs.delete(p.blobId).catch(() => { /* */ });
                if (d.blobId && d.blobId !== (p && p.blobId)) NM.vaultBlobs.delete(d.blobId).catch(() => { /* */ });
                ui.pendingBlobs.clear(); ui.draft = null; ui.editing = false; ui.selectedId = null;
                rerenderUnlocked();
            } }, NM.icon('trash'), ' Delete') : h('span'),
            h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onclick: cancel }, 'Cancel'), saveBtn)));
    }

    function renderEmptyVault(box) {
        NM.clear(box);
        box.appendChild(h('div', { class: 'v-center v-empty' },
            h('h2', { class: 'v-title' }, 'Add your first item'),
            h('p', { class: 'v-lead' }, 'Everything you add is encrypted on this device.'),
            h('div', { class: 'v-first' }, ['login', 'card', 'note', 'file'].map((type) => h('button', { class: 'v-first-btn', type: 'button', onclick: () => newItem(type) },
                iconTile(TYPES[type].icon), h('span', { class: 'v-first-label' }, TYPES[type].label), h('span', { class: 'muted small' }, TYPES[type].hint))))));
    }

    function lockCountdown() {
        const left = Math.max(0, autoLockMin() * 60000 - (Date.now() - lastActivity));
        return 'Locks in ' + Math.floor(left / 60000) + ':' + String(Math.floor(left / 1000) % 60).padStart(2, '0');
    }
    function renderUnlocked(root, full) {
        if (!root || !session) return;
        if (root.dataset.state === 'unlocked' && !full) {
            // background re-render (another part of the app changed): keep the editor and its focus
            const list = root.querySelector('.v-items');
            if (list) renderList(list);
            const c = root.querySelector('.v-count');
            if (c) c.textContent = session.items.size + ' item' + (session.items.size === 1 ? '' : 's');
            return;
        }
        NM.clear(root);
        root.dataset.state = 'unlocked';
        const v = vault();
        const newBtn = h('button', { class: 'btn primary', type: 'button', 'aria-haspopup': 'menu' }, NM.icon('plus'), ' New');
        newBtn.addEventListener('click', () => menu(newBtn, ['login', 'card', 'note', 'file'].map((type) => ({ label: TYPES[type].label, icon: TYPES[type].icon, run: () => newItem(type) }))));
        const lockBtn = h('button', { class: 'btn', type: 'button', title: lockCountdown(), onclick: () => lock('manual') }, NM.icon('lock'), ' Lock');
        const upd = () => { lockBtn.title = lockCountdown(); };
        lockBtn.addEventListener('mouseenter', upd); lockBtn.addEventListener('focus', upd);
        const moreBtn = h('button', { class: 'icon-btn', type: 'button', title: 'More', 'aria-label': 'More', 'aria-haspopup': 'menu' }, NM.icon('more'));
        moreBtn.addEventListener('click', () => menu(moreBtn, [
            { label: 'Devices & recovery', icon: 'key', run: openKeyslots },
            { label: 'Auto-lock settings', icon: 'settings', run: () => { NM.setView('settings'); setTimeout(() => { const el = document.getElementById('vaultSection'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 50); } }
        ]));
        root.appendChild(h('div', { class: 'v-header' },
            h('div', { class: 'v-header-text' }, h('span', { class: 'v-count' }, session.items.size + ' item' + (session.items.size === 1 ? '' : 's')), h('span', { class: 'v-count-sub muted' }, 'Locks after ' + autoLockMin() + ' min idle')),
            h('div', { class: 'btn-row' }, newBtn, lockBtn, moreBtn)));
        if (support && support.ok && !usableHere(v)) {
            root.appendChild(h('div', { class: 'v-banner' },
                h('span', null, 'Unlock faster next time with ' + (isNative() ? 'Touch ID on this Mac.' : 'a passkey in this browser.')),
                h('button', { class: 'btn small', type: 'button', onclick: async () => {
                    const raw = await obtainRawVdk('Adding ' + hereName());
                    if (!raw) return;
                    try { await addHardwareSlot(raw); rerenderUnlocked(); } catch (e) { NM.toast(e.message, 'error', 7000); } finally { raw.fill(0); }
                } }, isNative() ? 'Add this Mac' : 'Add this browser')));
        }
        if (!session.items.size && !ui.draft) {
            const box = h('div', { class: 'card v-empty-card' });
            renderEmptyVault(box);
            root.appendChild(box);
            return;
        }
        const search = h('input', { class: 'input', type: 'search', placeholder: 'Search vault', 'aria-label': 'Search vault', autocomplete: 'off',
            oninput: (e) => { ui.q = e.target.value; renderList(list); } });
        search.value = ui.q;
        const filters = h('div', { class: 'seg v-filters', role: 'group', 'aria-label': 'Filter' }, [['all', 'All'], ['login', 'Passwords'], ['card', 'Cards'], ['note', 'Notes'], ['file', 'Files'], ['fav', '★']].map(([k, l]) =>
            h('button', { class: 'seg-btn' + (ui.filter === k ? ' active' : ''), type: 'button', 'aria-pressed': String(ui.filter === k), title: k === 'fav' ? 'Favorites' : null, onclick: () => { ui.filter = k; rerenderUnlocked(); } }, l)));
        const list = h('div', { class: 'v-items' });
        renderList(list);
        const panel = h('div', { class: 'v-detail card' });
        const hasSel = !!(ui.draft || (ui.selectedId && session.items.has(ui.selectedId)));
        if (ui.draft) renderEditor(panel);
        else if (hasSel) renderDetail(panel);
        else panel.appendChild(h('div', { class: 'v-center v-placeholder' }, iconTile('vault'), h('p', { class: 'muted' }, 'Select an item to see its details.')));
        root.appendChild(h('div', { class: 'v-grid' + (hasSel ? ' has-selection' : '') }, h('div', { class: 'v-list card' }, search, filters, list), panel));
    }

    function render() {
        const root = document.getElementById('view-vault');
        const sub = document.getElementById('viewSubtitle');
        if (S.view === 'vault' && sub) sub.textContent = NM.views.vault.subtitle();
        if (session && vault()) { renderUnlocked(root, root.dataset.state !== 'unlocked'); return; }
        NM.clear(root);
        root.dataset.state = '';
        if (session && !vault()) { session = null; }
        if (!vault()) renderSetup(root); else renderLocked(root);
    }
    let supportStarted = false;
    function ensureSupport() {
        if (supportStarted) return;
        supportStarted = true;
        checkSupport().then((s) => { support = s; if (S.view === 'vault') render(); }).catch(() => { support = { ok: false, reason: 'no-webauthn' }; if (S.view === 'vault') render(); });
    }

    // ======================= export / import of blobs =======================
    async function blobsForExport() {
        let all = null;
        try { all = await NM.vaultBlobs.all(); } catch (e) { NM.toast('Could not read vault files: ' + e.message, 'error'); }
        if (all) return all;
        if (!session) {
            const c = await NM.choose('Vault files', 'The vault is locked. Unlock it to include its encrypted file attachments in the backup, or export without them (the items stay; file contents are left out).',
                [{ label: 'Cancel', value: null }, { label: 'Export without files', value: 'skip' }, { label: 'Unlock vault', value: 'unlock', kind: 'primary' }]);
            if (c === 'skip') return {};
            if (c === 'unlock') { NM.setView('vault'); NM.toast('Unlock the vault, then export again.'); }
            return null;
        }
        const out = {};
        for (const p of session.items.values()) {
            if (p.type !== 'file' || !p.blobId) continue;
            try { const r = await NM.vaultBlobs.get(p.blobId); if (r) out[p.blobId] = { iv: V.b64(r.iv), ct: V.b64(r.ct) }; } catch (e) { /* missing */ }
        }
        return out;
    }
    async function importBlobs(blobs) {
        let ok = 0, failed = 0;
        for (const id of Object.keys(blobs || {})) {
            try { await NM.vaultBlobs.put(id, V.unb64(blobs[id].iv), V.unb64(blobs[id].ct)); ok++; } catch (e) { failed++; }
        }
        if (failed) NM.toast(failed + ' vault file(s) could not be stored on this device.', 'error', 7000);
        return ok;
    }

    // ======================= auto-lock =======================
    function initAutoLock() {
        const touch = () => { lastActivity = Date.now(); };
        ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => document.addEventListener(ev, touch, { capture: true, passive: true }));
        setInterval(() => { if (session && Date.now() - lastActivity > autoLockMin() * 60000) lock('idle'); }, 5000);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') hiddenAt = Date.now();
            else { if (session && hiddenAt && Date.now() - hiddenAt > autoLockMin() * 60000) lock('hidden'); hiddenAt = null; }
        });
        window.addEventListener('pagehide', () => lock('silent'));
        window.addEventListener('beforeunload', () => lock('silent'));
        if (NM.native) NM.native.on('lock', (d) => lock('system', d && d.reason));
    }

    NM.vault = {
        lock, blobsForExport, importBlobs,
        isUnlocked: () => !!session,
        /** another tab / import replaced the document's vault */
        onDocChanged(oldJson) { if (JSON.stringify(S.doc.vault) !== oldJson) lock('silent'); }
    };
    NM.views.vault = {
        title: () => 'Vault',
        subtitle: () => (vault() ? (session ? 'Unlocked' : 'Locked') : 'Private and encrypted'),
        render() { ensureSupport(); render(); }
    };
    initAutoLock();
})();
