/* Notemaker — Settings (all Settings fields), notes passcode, templates manager, notifications, JSON import/export. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h;
    const ACCENTS = [['violet', '#7C3AED'], ['ocean', '#0EA5E9'], ['sunset', '#F97316'], ['forest', '#10B981'], ['purple', '#C026D3']];

    // ---------------- theme ----------------
    NM.applyTheme = function () {
        const t = S.doc.settings.theme;
        const root = document.documentElement;
        if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
        const accent = NM.ls.get('notemaker_accent') || 'violet';
        root.setAttribute('data-accent', accent);
        const dark = t === 'dark' || (t === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
        const btn = document.getElementById('themeToggle');
        if (btn) { NM.clear(btn).appendChild(NM.icon(dark ? 'sun' : 'moon')); btn.title = 'Theme: ' + t + ' (click to switch to ' + (dark ? 'light' : 'dark') + ')'; }
    };
    NM.toggleTheme = function () {
        const t = S.doc.settings.theme;
        const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        NM.update(() => { S.doc.settings.theme = dark ? 'light' : 'dark'; });
        NM.applyTheme();
    };
    function setSetting(k, v) { NM.update(() => { S.doc.settings[k] = v; S.doc.settings = C.normalizeSettings(S.doc.settings); }); NM.applyTheme(); }

    // ---------------- export / import ----------------
    NM.exportJson = async function () {
        if (NM.beforeDateChange) NM.beforeDateChange();
        const data = C.exportDoc(S.doc);
        if (data.vault && NM.vault) {
            const r = await NM.vault.blobsForExport();
            if (r === null) return; // cancelled
            data.vault.blobs = r;
        }
        NM.download('notemaker_backup_' + S.today + '.json', JSON.stringify(data, null, 2));
        if (NM.storage) NM.storage.noteBackup();
        NM.toast('Backup exported (' + data.tasks.length + ' tasks, ' + Object.keys(data.notes).length + ' notes)', 'ok');
    };
    NM.importFile = function (file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onerror = () => NM.toast('Could not read the file', 'error');
        reader.onload = async () => {
            let incoming, incomingBlobs = {};
            try {
                const parsed = JSON.parse(reader.result);
                incoming = C.importToDoc(parsed);
                if (parsed && parsed.vault && window.NotemakerVault) incomingBlobs = window.NotemakerVault.extractBlobs(parsed.vault);
            } catch (e) {
                NM.toast('Import failed: ' + (e instanceof SyntaxError ? 'not valid JSON' : e.message), 'error', 7000);
                return;
            }
            const preview = C.mergeDocs(S.doc, incoming).stats;
            const nNotes = Object.keys(incoming.notes).length;
            const body = h('div', { class: 'form' },
                h('p', { class: 'modal-text' }, 'File contains ' + incoming.tasks.length + ' tasks, ' + nNotes + ' notes (' + Object.values(incoming.notes).filter((n) => n.locked).length + ' private), ' +
                    incoming.habits.length + ' habits, ' + incoming.templates.length + ' templates, ' + incoming.focusSessions.length + ' focus sessions.'),
                h('ul', { class: 'import-list' },
                    h('li', null, h('b', null, 'Merge: '), preview.tasksAdded + ' new tasks (' + preview.tasksSkipped + ' duplicates skipped), ' + preview.notesAdded + ' new notes, ' + preview.notesMerged + ' merged, ' +
                        preview.habitsAdded + ' habits, ' + preview.templatesAdded + ' templates. Your settings are kept.'),
                    h('li', null, h('b', null, 'Replace: '), 'your current data (' + S.doc.tasks.length + ' tasks, ' + Object.keys(S.doc.notes).length + ' notes) is replaced by the file, including settings.'),
                    incoming.vault ? h('li', null, h('b', null, 'Vault: '), 'the file contains an encrypted vault (' + incoming.vault.items.length + ' items). ' +
                        (S.doc.vault ? 'Merge keeps your current vault; Replace swaps it for the file’s vault.' : 'It will be added; open it with its recovery key or a key for this device.')) : null));
            const choice = await NM.chooseWithBody('Import backup', body,
                [{ label: 'Cancel', value: null }, { label: 'Replace all', value: 'replace', kind: 'danger' }, { label: 'Merge', value: 'merge', kind: 'primary' }]);
            if (!choice) return;
            if (choice === 'replace' && !(await NM.confirm('Replace ALL current data with this backup? (You can undo right after.)', 'Replace', true))) return;
            const before = JSON.stringify(S.doc);
            if (NM.beforeDateChange) NM.beforeDateChange();
            const vaultChanges = incoming.vault && (choice === 'replace' || !S.doc.vault);
            if (vaultChanges && NM.vault) NM.vault.lock('import');
            NM.update(() => {
                if (choice === 'replace') { S.doc = incoming; S.unlocked = {}; S.passcode = null; }
                else S.doc = C.normalizeDoc(C.mergeDocs(S.doc, incoming).doc);
            });
            if (vaultChanges && NM.vault) await NM.vault.importBlobs(incomingBlobs, choice === 'replace');
            NM.applyTheme();
            NM.toast(choice === 'replace' ? 'Data replaced from backup' : 'Imported: ' + preview.tasksAdded + ' tasks, ' + (preview.notesAdded + preview.notesMerged) + ' notes', 'ok', 6000,
                { label: 'Undo import', fn: () => { if (NM.vault) NM.vault.lock('import'); NM.update(() => { S.doc = C.normalizeDoc(JSON.parse(before)); }); NM.applyTheme(); NM.toast('Import undone'); } });
        };
        reader.readAsText(file);
    };
    /** Like NM.choose but with a rich body node. */
    NM.chooseWithBody = function (title, body, options) {
        return new Promise((resolve) => {
            let result = null;
            NM.modal({ title, body, onClose: () => resolve(result), actions: options.map((o) => ({ label: o.label, kind: o.kind, onClick: () => { result = o.value; } })) });
        });
    };

    // ---------------- passcode ----------------
    async function setPasscode() {
        const p1 = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', autofocus: true });
        const p2 = h('input', { type: 'password', class: 'input', autocomplete: 'new-password' });
        const err = h('p', { class: 'error-text' });
        NM.modal({
            title: 'Set notes passcode',
            body: h('div', { class: 'form' },
                h('p', { class: 'modal-text' }, 'Private notes are encrypted on this device with AES-GCM; only a salted PBKDF2 hash of the passcode is stored. If you forget it, private notes cannot be recovered.'),
                h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Passcode (min 4 characters)'), p1),
                h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Confirm'), p2), err),
            actions: [{ label: 'Cancel' }, { label: 'Set passcode', kind: 'primary', onClick: async () => {
                if (p1.value.length < 4) { err.textContent = 'Use at least 4 characters.'; return false; }
                if (p1.value !== p2.value) { err.textContent = 'Passcodes do not match.'; return false; }
                err.textContent = 'Working…';
                const lh = await C.makeLockHash(p1.value);
                S.passcode = p1.value;
                setSetting('lockHash', lh);
                NM.toast('Passcode set. Use “Make private” on a note to encrypt it.', 'ok', 5000);
            } }]
        });
    }
    async function changePasscode() {
        const old = h('input', { type: 'password', class: 'input', autocomplete: 'current-password', autofocus: true });
        const p1 = h('input', { type: 'password', class: 'input', autocomplete: 'new-password' });
        const p2 = h('input', { type: 'password', class: 'input', autocomplete: 'new-password' });
        const err = h('p', { class: 'error-text' });
        NM.modal({
            title: 'Change notes passcode',
            body: h('div', { class: 'form' },
                h('p', { class: 'modal-text' }, 'All private notes are re-encrypted with the new passcode.'),
                h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Current passcode'), old),
                h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'New passcode'), p1),
                h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Confirm new passcode'), p2), err),
            actions: [{ label: 'Cancel' }, { label: 'Change', kind: 'primary', onClick: async () => {
                if (p1.value.length < 4) { err.textContent = 'Use at least 4 characters.'; return false; }
                if (p1.value !== p2.value) { err.textContent = 'New passcodes do not match.'; return false; }
                err.textContent = 'Checking…';
                if (!(await C.verifyPasscode(old.value, S.doc.settings.lockHash))) { err.textContent = 'Current passcode is wrong.'; return false; }
                const r = await reencryptAll(old.value, p1.value);
                if (r === false) { err.textContent = 'Could not re-encrypt.'; return false; }
                NM.toast('Passcode changed' + (r.failed ? ' — ' + r.failed + ' note(s) were encrypted with a different passcode and were left unchanged' : '') + '.', r.failed ? 'error' : 'ok', 7000);
            } }]
        });
    }
    async function reencryptAll(oldPass, newPass) {
        const notes = S.doc.notes;
        const updates = {};
        let failed = 0;
        for (const d of Object.keys(notes)) {
            if (!notes[d].locked) continue;
            try {
                const text = await C.decryptNote(notes[d].cipher, oldPass);
                updates[d] = newPass == null ? { markdown: text, updatedAt: new Date().toISOString(), locked: false, cipher: null }
                    : { markdown: '', updatedAt: notes[d].updatedAt, locked: true, cipher: await C.encryptNote(text, newPass) };
            } catch (e) { failed++; }
        }
        const lh = newPass == null ? null : await C.makeLockHash(newPass);
        NM.update(() => { Object.assign(S.doc.notes, updates); S.doc.settings.lockHash = lh; });
        S.passcode = newPass;
        if (newPass == null) S.unlocked = {};
        if (NM.notes) NM.notes.reload();
        return { failed };
    }
    async function removePasscode() {
        const locked = Object.values(S.doc.notes).filter((n) => n.locked).length;
        const p = await NM.prompt('Remove passcode', 'Current passcode', { type: 'password', ok: 'Remove',
            hint: locked ? locked + ' private note(s) will be decrypted and stored as plain text.' : 'No notes are private right now.' });
        if (p == null) return;
        if (!(await C.verifyPasscode(p, S.doc.settings.lockHash))) { NM.toast('Wrong passcode', 'error'); return; }
        const r = await reencryptAll(p, null);
        NM.toast('Passcode removed' + (r.failed ? ' — ' + r.failed + ' note(s) could not be decrypted and stay locked' : ''), r.failed ? 'error' : 'ok', 6000);
    }

    // ---------------- templates ----------------
    function editTemplate(t) {
        const isNew = !t;
        const name = h('input', { class: 'input', value: t ? t.name : '', placeholder: 'Template name', autofocus: true, maxlength: 200 });
        const md = h('textarea', { class: 'input mono', rows: 12, placeholder: '# {{weekday}}, {{date}}\n\n- ' });
        md.value = t ? t.markdown : '';
        const prev = h('div', { class: 'md template-preview' });
        const upd = () => { prev.innerHTML = NM.renderMarkdown(C.applyTemplate(md.value, S.date)); };
        md.addEventListener('input', upd);
        upd();
        NM.modal({
            title: isNew ? 'New template' : 'Edit template', cls: 'wide',
            body: h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
                h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Markdown — {{date}} and {{weekday}} are replaced'), md),
                    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Preview'), prev))),
            actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: () => {
                if (!name.value.trim()) { name.focus(); return false; }
                const clean = C.normalizeTemplate({ id: t ? t.id : C.uuid(), name: name.value.trim(), markdown: md.value });
                NM.update(() => { if (isNew) S.doc.templates.push(clean); else S.doc.templates[S.doc.templates.findIndex((x) => x.id === t.id)] = clean; });
            } }]
        });
    }

    // ---------------- notifications ----------------
    NM.notifyPermission = function () {
        if (NM.native) return S.nativeNotify || 'default';
        if (!('Notification' in window)) return 'unsupported';
        return Notification.permission;
    };
    NM.requestNotifications = async function () {
        if (NM.native) {
            try { const r = await NM.native.request('notify.request'); S.nativeNotify = (r && r.status) || 'default'; } catch (e) { S.nativeNotify = 'default'; }
            NM.toast(S.nativeNotify === 'granted' ? 'Notifications enabled' : 'Notifications are off — enable them in System Settings › Notifications.', S.nativeNotify === 'granted' ? 'ok' : 'error', 6000);
            if (NM.syncNative) NM.syncNative(true);
            NM.render();
            return;
        }
        if (!('Notification' in window)) { NM.toast('Notifications are not supported in this browser — reminders will show in-app.', 'error'); return; }
        try {
            const p = await Notification.requestPermission();
            NM.toast(p === 'granted' ? 'Notifications enabled' : 'Notifications blocked — reminders will appear as in-app toasts.', p === 'granted' ? 'ok' : 'error', 5000);
        } catch (e) { NM.toast('Could not request permission: ' + e.message, 'error'); }
        NM.render();
    };

    // ---------------- render ----------------
    const row = (label, desc, control) => h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('div', { class: 'set-label' }, label), desc ? h('div', { class: 'muted small' }, desc) : null), h('div', { class: 'set-control' }, control));
    const timeInput = (key, opts) => h('input', Object.assign({ type: 'time', class: 'input', value: S.doc.settings[key] || '', onchange: (e) => { if (C.isValidTime(e.target.value)) setSetting(key, e.target.value); } }, opts || {}));
    const numInput = (key, min, max) => h('input', { type: 'number', class: 'input num', min, max, value: S.doc.settings[key], onchange: (e) => setSetting(key, parseInt(e.target.value, 10)) });
    const toggle = (checked, onChange, label) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked), 'aria-label': label }), h('span', { class: 'switch-ui' }));

    function render() {
        const root = document.getElementById('view-settings');
        if (NM.native && S.seCaps === undefined) { S.seCaps = null; NM.vault.capabilities().then((c) => { S.seCaps = c; if (S.view === 'settings') render(); }); }
        const st = S.doc.settings;
        NM.clear(root);
        const accent = NM.ls.get('notemaker_accent') || 'violet';
        const perm = NM.notifyPermission();
        const lockedCount = Object.values(S.doc.notes).filter((n) => n.locked).length;

        const sec = (id, title, ...rows) => h('section', { class: 'card settings-section', id }, h('h3', null, title), ...rows);
        root.appendChild(h('div', { class: 'view-head' }, h('div', null, h('h2', null, 'Settings'), h('p', { class: 'muted small' }, 'Saved automatically in this browser.'))));
        root.appendChild(h('div', { class: 'settings' },
            sec('appearanceSection', 'Appearance',
                row('Theme', 'System follows your OS setting.', h('div', { class: 'seg' }, [['light', '☀️ Light'], ['dark', '🌙 Dark'], ['system', '🖥 System']].map(([v, l]) =>
                    h('button', { type: 'button', class: 'seg-btn' + (st.theme === v ? ' active' : ''), onclick: () => setSetting('theme', v) }, l)))),
                row('Accent colour', 'Personal preference for this browser (not exported).', h('div', { class: 'swatches' }, ACCENTS.map(([k, c]) =>
                    h('button', { type: 'button', class: 'swatch' + (accent === k ? ' active' : ''), style: { background: c }, title: k, 'aria-label': k, onclick: () => { try { NM.ls.set('notemaker_accent', k); } catch (e) { /* */ } NM.applyTheme(); render(); } }))))),
            sec('tasksSection', 'Tasks & calendar',
                row('Smart rollover', 'Unfinished tasks from past days move to today (on start and at midnight) with an “Overdue” badge.', toggle(st.autoRollover, (v) => { setSetting('autoRollover', v); if (v) { const n = NM.runRollover(); if (n) { NM.toast(n + ' task(s) rolled over to today'); NM.render(); } } }, 'Smart rollover')),
                row('Week starts on', null, h('select', { class: 'select', onchange: (e) => setSetting('weekStartsOn', +e.target.value) },
                    [[1, 'Monday'], [6, 'Saturday'], [7, 'Sunday']].map(([v, l]) => h('option', { value: v, selected: st.weekStartsOn === v }, l))))),
            sec('focusSection', 'Focus timer',
                row('Focus length', 'Minutes per Pomodoro.', numInput('focusMinutes', 1, 180)),
                row('Break length', 'Minutes.', numInput('breakMinutes', 1, 60))),
            sec('reviewSection', 'Daily review',
                row('Prompt me daily', 'Opens the review once a day at this time while the app is open.', h('div', { class: 'inline' },
                    toggle(st.reviewTime !== null, (v) => setSetting('reviewTime', v ? '18:00' : null), 'Daily review prompt'),
                    st.reviewTime !== null ? timeInput('reviewTime') : null))),
            sec('plannerSection', 'Planner',
                row('Day starts', null, timeInput('dayStart', { onchange: (e) => { if (C.isValidTime(e.target.value) && e.target.value < st.dayEnd) setSetting('dayStart', e.target.value); else { NM.toast('Start must be before end', 'error'); render(); } } })),
                row('Day ends', null, timeInput('dayEnd', { onchange: (e) => { if (C.isValidTime(e.target.value) && e.target.value > st.dayStart) setSetting('dayEnd', e.target.value); else { NM.toast('End must be after start', 'error'); render(); } } }))),
            sec('notifySection', 'Reminders & notifications',
                row('System notifications', perm === 'granted' ? (!NM.native ? 'Enabled. Reminders fire while Notemaker is open in a tab.'
                    : NM.caps && NM.caps.notifyWhenClosed ? 'Enabled. Reminders arrive even when Notemaker is closed.'
                    : 'Enabled. Reminders arrive while Notemaker is running' + (NM.caps && NM.caps.tray ? ' — closing the window keeps it in the tray.' : '.')) : perm === 'denied' ? 'Blocked in browser settings — reminders show as in-app toasts.' : perm === 'unsupported' ? 'Not supported here — reminders show as in-app toasts.' : 'Not enabled yet — reminders show as in-app toasts until you allow them.',
                    h('div', { class: 'inline' },
                        perm === 'default' ? h('button', { class: 'btn primary small', type: 'button', onclick: NM.requestNotifications }, NM.icon('bell'), ' Enable') : h('span', { class: 'pill ' + (perm === 'granted' ? 'ok' : '') }, perm),
                        h('button', { class: 'btn ghost small', type: 'button', onclick: () => NM.notify('Notemaker', 'This is how reminders look.') }, 'Test')))),
            sec('passcodeSection', 'Private notes',
                row('Notes passcode', st.lockHash ? 'Set. ' + lockedCount + ' private note(s). Only a salted hash is stored (PBKDF2-SHA256, ' + st.lockHash.iterations.toLocaleString() + ' iterations).' : 'Not set. Set one to encrypt individual notes with AES-GCM.',
                    st.lockHash ? h('div', { class: 'inline' },
                        h('button', { class: 'btn small', type: 'button', onclick: changePasscode }, 'Change'),
                        h('button', { class: 'btn ghost small', type: 'button', onclick: removePasscode }, 'Remove'),
                        S.passcode ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => { S.passcode = null; S.unlocked = {}; NM.toast('All private notes locked'); NM.render(); } }, 'Lock all now') : null)
                        : h('button', { class: 'btn primary small', type: 'button', onclick: setPasscode }, NM.icon('lock'), ' Set passcode'))),
            sec('vaultSection', 'Vault',
                row('Auto-lock after', 'Of inactivity — also when the window is hidden that long, and on ' + (NM.native ? 'sleep, screen lock and quit.' : 'closing the tab.'),
                    h('select', { class: 'select', 'aria-label': 'Auto-lock after', onchange: (e) => { setSetting('vaultAutoLockMinutes', +e.target.value); if (NM.vault) NM.vault.syncState(); } },
                        [...new Set([1, 2, 5, 10, 15, 30, 60, 240, st.vaultAutoLockMinutes])].sort((a, b) => a - b).map((v) =>
                            h('option', { value: v, selected: st.vaultAutoLockMinutes === v }, v < 60 ? v + (v === 1 ? ' minute' : ' minutes') : (v / 60) + (v === 60 ? ' hour' : ' hours'))))),
                NM.vault ? NM.vault.securityRows(row, S.seCaps, () => render()) : null,
                row('Vault', S.doc.vault ? NM.plural(S.doc.vault.items.length, 'encrypted item') + ' · ' + NM.plural(S.doc.vault.keyslots.length, 'key') + ' · ' + (S.doc.vault.mode === 'hardware-only' ? 'hardware only' : 'hardware + recovery key') : 'Not set up yet.',
                    h('button', { class: 'btn small', type: 'button', onclick: () => NM.setView('vault') }, NM.icon('lock'), ' Open vault'))),
            sec('templatesSection', 'Note templates',
                h('div', { class: 'template-list' }, S.doc.templates.map((t) => h('div', { class: 'template-row' },
                    h('span', { class: 'template-name' }, t.name), h('span', { class: 'muted small template-snip' }, t.markdown.split('\n')[0].slice(0, 60)),
                    NM.iconBtn('edit', 'Edit', () => editTemplate(t)),
                    NM.iconBtn('trash', 'Delete', async () => { if (await NM.confirm('Delete template “' + t.name + '”?', 'Delete', true)) NM.update(() => { S.doc.templates = S.doc.templates.filter((x) => x.id !== t.id); }); }, 'danger')))),
                h('div', { class: 'inline' },
                    h('button', { class: 'btn small', type: 'button', onclick: () => editTemplate(null) }, NM.icon('plus'), ' New template'),
                    h('button', { class: 'btn ghost small', type: 'button', onclick: () => NM.update(() => {
                        const have = new Set(S.doc.templates.map((t) => t.name.toLowerCase()));
                        C.builtinTemplates().forEach((t) => { if (!have.has(t.name.toLowerCase())) S.doc.templates.push(t); });
                    }) }, 'Restore built-ins'))),
            sec('dataSection', 'Data',
                NM.storage.settingsRows(row),
                row('Move to a new device', 'One encrypted file with everything, including your vault, opened with a one-time code.',
                    h('button', { class: 'btn primary small', type: 'button', onclick: () => NM.transfer.start() }, NM.icon('upload'), ' Move…')),
                row('Restore from another device', 'Open a .notemaker transfer file from your old device.',
                    h('button', { class: 'btn small', type: 'button', onclick: () => NM.transfer.restore() }, NM.icon('download'), ' Restore…')),
                row('Unencrypted backup (JSON)', 'Readable by anyone who gets the file — private notes and the vault stay encrypted, everything else doesn’t.', h('div', { class: 'inline' },
                    h('button', { class: 'btn small', type: 'button', onclick: NM.exportJson }, NM.icon('download'), ' Export'),
                    h('button', { class: 'btn small', type: 'button', onclick: () => document.getElementById('importFile').click() }, NM.icon('upload'), ' Import'))),
                row('Markdown', 'Tasks as checkboxes plus the note, for the selected day or week.', h('button', { class: 'btn small', type: 'button', onclick: () => NM.exportMarkdown() }, NM.icon('download'), ' Export .md')),
                row(NM.storage && NM.storage.folderActive() ? 'Your data' : 'Stored in this browser', S.doc.tasks.length + ' tasks · ' + Object.keys(S.doc.notes).length + ' notes · ' + S.doc.habits.length + ' habits · ' + S.doc.focusSessions.length + ' focus sessions · ~' +
                    Math.round(JSON.stringify(S.doc).length / 1024) + ' KB' + (NM.native ? ' (data.json)' : '') + (NM.ls.get('notemaker_tasks') ? ' · v1 data kept as backup' : ''), null))));
    }

    NM.views.settings = { title: () => 'Settings', subtitle: () => '', render };
})();
