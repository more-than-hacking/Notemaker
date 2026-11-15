/* Notemaker — Markdown notes: edit/read toggle, toolbar, live preview + synced scroll, undo/redo,
   templates, private (encrypted) notes, wiki links + backlinks, Markdown export. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h, $ = NM.$;

    let editor, preview, isEditing = false, syncScrollEnabled = true, loadedDate = null, loadedStamp = null;
    let history = [], historyIndex = -1, historyTimer = null;

    const note = (d) => S.doc.notes[d || S.date];
    const isLockedHidden = (d) => { const n = note(d); return n && n.locked && S.unlocked[d || S.date] == null; };
    /** Current plaintext of a day's note (decrypted session copy for private notes). */
    function textOf(d) {
        const n = note(d);
        if (!n) return '';
        if (n.locked) return S.unlocked[d] != null ? S.unlocked[d] : '';
        return n.markdown;
    }
    NM.noteText = textOf;

    // ---------------- persistence ----------------
    async function storeNote(d, content) {
        const n = note(d);
        if (n && n.locked) {
            if (S.unlocked[d] === content) return;
            if (!S.passcode) { NM.toast('Unlock with your passcode before saving a private note', 'error'); return; }
            const cipher = await C.encryptNote(content, S.passcode);
            S.unlocked[d] = content;
            NM.update(() => { S.doc.notes[d] = { markdown: '', updatedAt: new Date().toISOString(), locked: true, cipher }; });
            return;
        }
        if (!content.trim()) {
            if (n) NM.update(() => { delete S.doc.notes[d]; });
            return;
        }
        if (n && n.markdown === content) return;
        NM.update(() => { S.doc.notes[d] = { markdown: content, updatedAt: new Date().toISOString(), locked: false, cipher: null }; });
    }
    NM.setNoteText = storeNote;

    // ---------------- view state ----------------
    function showMode() {
        const locked = isLockedHidden(loadedDate);
        $('#lockedPanel').hidden = !locked;
        $('#editorWrapper').hidden = locked || !isEditing;
        $('#notesPreviewOnly').hidden = locked || isEditing;
        $('#editToggleBtn').hidden = isEditing || locked;
        $('#saveBtn').hidden = !isEditing;
        $('#fmtGroup').classList.toggle('disabled', !isEditing);
        const n = note(loadedDate);
        const pb = $('#privateBtn');
        pb.textContent = n && n.locked ? (locked ? '🔒 Private' : '🔐 Lock now') : '🔒 Make private';
        pb.disabled = locked;
        $('#noteFlag').textContent = n ? (n.locked ? '🔒' : '•') : '';
    }

    function load() {
        loadedDate = S.date;
        const n = note(loadedDate);
        loadedStamp = n ? n.updatedAt : null;
        isEditing = false;
        editor.value = textOf(loadedDate);
        $('#notesPreviewContent').innerHTML = C.markdownToHtml(editor.value) || '<p class="muted empty-note">No note for this day yet. Click <b>Edit</b> to start writing.</p>';
        $('#unlockInput').value = '';
        $('#unlockError').textContent = '';
        history = []; historyIndex = -1;
        showMode();
        renderBacklinks();
    }

    function enableEditing() {
        if (isLockedHidden(loadedDate)) return;
        isEditing = true;
        showMode();
        editor.readOnly = false;
        editor.focus();
        updatePreview();
        history = []; historyIndex = -1;
        pushHistory();
    }
    async function saveAndLock() {
        isEditing = false;
        await storeNote(loadedDate, editor.value);
        const n = note(loadedDate);
        loadedStamp = n ? n.updatedAt : null;
        $('#notesPreviewContent').innerHTML = C.markdownToHtml(editor.value) || '<p class="muted empty-note">No note for this day yet. Click <b>Edit</b> to start writing.</p>';
        showMode();
        renderBacklinks();
    }
    /** Called before navigating to another day: autosave an open editor. */
    NM.beforeDateChange = function () {
        if (isEditing && loadedDate) { storeNote(loadedDate, editor.value); isEditing = false; }
    };
    window.addEventListener('beforeunload', () => {
        if (isEditing && loadedDate) {
            const n = note(loadedDate);
            if (!(n && n.locked)) {
                if (editor.value.trim()) S.doc.notes[loadedDate] = { markdown: editor.value, updatedAt: new Date().toISOString(), locked: false, cipher: null };
                NM.save();
            }
        }
    });

    function updatePreview() {
        preview.innerHTML = C.markdownToHtml(editor.value);
    }

    // ---------------- undo / redo (per editing session) ----------------
    function pushHistory() {
        if (!isEditing) return;
        if (history[historyIndex] === editor.value) return;
        history = history.slice(0, historyIndex + 1);
        history.push(editor.value);
        if (history.length > 100) history.shift();
        historyIndex = history.length - 1;
    }
    function undo() {
        if (!isEditing || historyIndex <= 0) return;
        historyIndex--;
        editor.value = history[historyIndex];
        updatePreview(); editor.focus();
    }
    function redo() {
        if (!isEditing || historyIndex >= history.length - 1) return;
        historyIndex++;
        editor.value = history[historyIndex];
        updatePreview(); editor.focus();
    }

    // ---------------- formatting ----------------
    function changed() { pushHistory(); updatePreview(); syncScrollSoon(); }
    function insertMarkdown(before, after) {
        if (!isEditing) return;
        const start = editor.selectionStart, end = editor.selectionEnd, text = editor.value;
        editor.value = text.slice(0, start) + before + text.slice(start, end) + after + text.slice(end);
        editor.setSelectionRange(start + before.length, end + before.length);
        editor.focus();
        changed();
    }
    function lineBounds() {
        const start = editor.selectionStart, text = editor.value;
        const ls = text.lastIndexOf('\n', start - 1) + 1;
        let le = text.indexOf('\n', start);
        if (le === -1) le = text.length;
        return { ls, le, line: text.slice(ls, le), start, end: editor.selectionEnd, text };
    }
    function insertMarkdownLine(prefix) {
        if (!isEditing) return;
        const b = lineBounds();
        const nl = prefix + b.line;
        editor.value = b.text.slice(0, b.ls) + nl + b.text.slice(b.le);
        const p = b.ls + nl.length;
        editor.setSelectionRange(p, p);
        editor.focus();
        changed();
    }
    function insertTable() {
        insertMarkdown('', '\n| Header 1 | Header 2 | Header 3 |\n|----------|----------|----------|\n| Cell 1   | Cell 2   | Cell 3   |\n| Cell 4   | Cell 5   | Cell 6   |\n');
    }
    function indent(out) {
        if (!isEditing) return;
        const b = lineBounds();
        const m = (out ? /^(\s{2,})([-*+]|\d+\.)\s+(.*)$/ : /^(\s*)([-*+]|\d+\.)\s+(.*)$/).exec(b.line);
        if (!m) return;
        const nl = (out ? m[1].slice(2) : m[1] + '  ') + m[2] + ' ' + m[3];
        editor.value = b.text.slice(0, b.ls) + nl + b.text.slice(b.le);
        const d = out ? -2 : 2;
        editor.setSelectionRange(Math.max(b.ls, b.start + d), Math.max(b.ls, b.end + d));
        changed();
    }
    function smartEnter(e) {
        const b = lineBounds();
        if (b.start !== b.end) return;
        let m = /^(\s*)(\d+)\.\s+(.*)$/.exec(b.line);
        let next = null;
        if (m) next = m[3].trim() ? m[1] + (parseInt(m[2], 10) + 1) + '. ' : '';
        else if ((m = /^(\s*)([-*+])\s+(\[[ xX]\]\s+)?(.*)$/.exec(b.line))) next = (m[4].trim() || (m[3] && m[4].trim())) ? m[1] + m[2] + ' ' + (m[3] ? '[ ] ' : '') : '';
        if (next === null) return;
        e.preventDefault();
        if (next === '') {
            // empty list item → end the list
            editor.value = b.text.slice(0, b.ls) + b.text.slice(b.le);
            editor.setSelectionRange(b.ls, b.ls);
        } else {
            editor.value = b.text.slice(0, b.le) + '\n' + next + b.text.slice(b.le);
            const p = b.le + 1 + next.length;
            editor.setSelectionRange(p, p);
        }
        changed();
    }

    // ---------------- sync scroll ----------------
    let syncing = false;
    function ratioScroll(from, to) {
        if (syncing) return;
        const max = from.scrollHeight - from.clientHeight;
        if (max <= 0) return;
        syncing = true;
        to.scrollTop = (from.scrollTop / max) * (to.scrollHeight - to.clientHeight);
        requestAnimationFrame(() => { syncing = false; });
    }
    function syncScrollSoon() { if (syncScrollEnabled) setTimeout(() => ratioScroll(editor, preview), 10); }

    // ---------------- templates ----------------
    function renderTemplateSelect() {
        const sel = $('#templateSelect');
        NM.clear(sel);
        sel.appendChild(h('option', { value: '' }, '📄 Template…'));
        S.doc.templates.forEach((t) => sel.appendChild(h('option', { value: t.id }, t.name)));
        sel.appendChild(h('option', { value: '__manage' }, 'Manage templates…'));
        sel.value = '';
    }
    async function applyTemplate(id) {
        if (id === '__manage') { NM.setView('settings'); setTimeout(() => { const el = document.getElementById('templatesSection'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 50); return; }
        const t = S.doc.templates.find((x) => x.id === id);
        if (!t) return;
        if (isLockedHidden(loadedDate)) { NM.toast('Unlock this private note first', 'error'); return; }
        const text = C.applyTemplate(t.markdown, loadedDate);
        if (!isEditing) enableEditing();
        const cur = editor.value;
        if (!cur.trim()) editor.value = text;
        else {
            const p = editor.selectionStart;
            const atEnd = document.activeElement !== editor;
            const pos = atEnd ? cur.length : p;
            const ins = (pos > 0 && cur[pos - 1] !== '\n' ? '\n\n' : '') + text;
            editor.value = cur.slice(0, pos) + ins + cur.slice(pos);
            editor.setSelectionRange(pos + ins.length, pos + ins.length);
        }
        editor.focus();
        changed();
        NM.toast('Applied template “' + t.name + '”', 'ok');
    }

    // ---------------- private notes ----------------
    async function ensurePasscode(reason) {
        const lh = S.doc.settings.lockHash;
        if (!lh) {
            const go = await NM.confirm('Set a notes passcode in Settings first. Only a hash of it is stored — if you forget it, private notes cannot be recovered.', 'Open Settings');
            if (go) { NM.setView('settings'); setTimeout(() => { const el = document.getElementById('passcodeSection'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 50); }
            return null;
        }
        if (S.passcode) return S.passcode;
        const p = await NM.prompt(reason || 'Enter passcode', 'Notes passcode', { type: 'password', ok: 'Continue' });
        if (!p) return null;
        if (!(await C.verifyPasscode(p, lh))) { NM.toast('Wrong passcode', 'error'); return null; }
        S.passcode = p;
        return p;
    }
    async function onPrivateBtn() {
        const d = loadedDate, n = note(d);
        if (isEditing) await saveAndLock();
        if (n && n.locked) {
            const choice = await NM.choose('Private note', 'Lock hides the text again (it stays encrypted). Remove encryption stores this note as plain text again.', [
                { label: 'Cancel', value: null }, { label: 'Remove encryption', value: 'remove', kind: 'danger' }, { label: '🔐 Lock now', value: 'lock', kind: 'primary' }
            ]);
            if (choice === 'lock') { delete S.unlocked[d]; load(); }
            if (choice === 'remove') {
                const text = S.unlocked[d] || '';
                delete S.unlocked[d];
                NM.update(() => { S.doc.notes[d] = { markdown: text, updatedAt: new Date().toISOString(), locked: false, cipher: null }; });
                load();
                NM.toast('Encryption removed', 'ok');
            }
            return;
        }
        const text = textOf(d);
        if (!text.trim()) { NM.toast('Write something first — empty notes cannot be made private'); return; }
        const pass = await ensurePasscode('Make this note private');
        if (!pass) return;
        try {
            const cipher = await C.encryptNote(text, pass);
            S.unlocked[d] = text;
            NM.update(() => { S.doc.notes[d] = { markdown: '', updatedAt: new Date().toISOString(), locked: true, cipher }; });
            load();
            NM.toast('Note encrypted. It is excluded from search and backlinks.', 'ok', 5000);
        } catch (e) { NM.toast('Encryption failed: ' + e.message, 'error'); }
    }
    async function onUnlock(e) {
        e.preventDefault();
        const d = loadedDate, n = note(d);
        const pass = $('#unlockInput').value;
        const err = $('#unlockError');
        if (!pass) { err.textContent = 'Enter your passcode.'; return; }
        err.textContent = 'Unlocking…';
        try {
            const text = await C.decryptNote(n.cipher, pass);
            S.unlocked[d] = text;
            S.passcode = pass;
            err.textContent = '';
            load();
        } catch (ex) {
            err.textContent = /WebCrypto/.test(ex.message) ? ex.message : 'Wrong passcode.';
        }
    }

    // ---------------- backlinks ----------------
    function renderBacklinks() {
        const list = $('#backlinksList');
        NM.clear(list);
        const days = C.backlinks(S.doc.notes, loadedDate);
        if (!days.length) {
            list.appendChild(h('p', { class: 'muted small' }, 'No other day links here yet. Link days with ', h('code', null, '[[' + loadedDate + ']]'), '.'));
            return;
        }
        days.forEach((d) => {
            const md = S.doc.notes[d].markdown;
            const i = md.indexOf('[[' + loadedDate + ']]');
            const snip = md.slice(Math.max(0, i - 50), i + 60).replace(/\s+/g, ' ');
            list.appendChild(h('button', { class: 'backlink', type: 'button', onclick: () => { NM.setDate(d); NM.setDayTab('notes'); } },
                h('span', { class: 'backlink-date' }, NM.shortDate(d)), h('span', { class: 'backlink-snip muted' }, (i > 50 ? '…' : '') + snip + '…')));
        });
    }

    // ---------------- markdown export ----------------
    async function mdExport() {
        const choice = await NM.choose('Export as Markdown', 'Export the tasks and note of this day, or of the whole week?', [
            { label: 'Cancel', value: null }, { label: 'This week', value: 'week' }, { label: 'This day', value: 'day', kind: 'primary' }
        ]);
        if (!choice) return;
        if (isEditing) await saveAndLock();
        let days = [S.date];
        if (choice === 'week') { const s = C.startOfWeek(S.date, S.doc.settings.weekStartsOn); days = [0, 1, 2, 3, 4, 5, 6].map((i) => C.addDays(s, i)); }
        const md = C.exportMarkdown(S.doc, days, S.unlocked);
        NM.download('notemaker_' + (choice === 'week' ? 'week_' + days[0] : days[0]) + '.md', md, 'text/markdown');
    }
    NM.exportMarkdown = mdExport;

    NM.notes = {
        /** Re-sync with state: reload when the date changed or the note changed underneath (import, review…). */
        sync() {
            renderTemplateSelect();
            const n = note(S.date);
            const stamp = n ? n.updatedAt : null;
            if (loadedDate !== S.date || (!isEditing && stamp !== loadedStamp)) load();
            else { showMode(); renderBacklinks(); }
        },
        reload: load,
        isEditing: () => isEditing,
        enableEditing,
        textOf
    };

    NM.notesInit = function () {
        editor = $('#notesEditorMd');
        preview = $('#notesPreview');
        $('#editToggleBtn').addEventListener('click', enableEditing);
        $('#saveBtn').addEventListener('click', saveAndLock);
        $('#notesPreviewOnly').addEventListener('dblclick', enableEditing);
        editor.addEventListener('input', () => {
            if (!isEditing) return;
            updatePreview();
            syncScrollSoon();
            clearTimeout(historyTimer);
            historyTimer = setTimeout(pushHistory, 350);
        });
        editor.addEventListener('keydown', (e) => {
            if (!isEditing) return;
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) smartEnter(e);
            if (e.key === 'Tab') { const b = lineBounds(); if (/^\s*([-*+]|\d+\.)\s/.test(b.line)) { e.preventDefault(); indent(e.shiftKey); } }
            if (e.ctrlKey || e.metaKey) {
                const k = e.key.toLowerCase();
                if (k === 'z' && !e.shiftKey) { e.preventDefault(); pushHistory(); undo(); }
                else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
                else if (k === 'b') { e.preventDefault(); insertMarkdown('**', '**'); }
                else if (k === 'i') { e.preventDefault(); insertMarkdown('*', '*'); }
                else if (k === 's' || k === 'enter') { e.preventDefault(); saveAndLock(); }
            }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); saveAndLock(); }
        });
        $('#undoBtn').addEventListener('click', () => { pushHistory(); undo(); });
        $('#redoBtn').addEventListener('click', redo);
        $('#syncScroll').addEventListener('change', (e) => { syncScrollEnabled = e.target.checked; });
        editor.addEventListener('scroll', () => { if (syncScrollEnabled && isEditing) ratioScroll(editor, preview); });
        preview.addEventListener('scroll', () => { if (syncScrollEnabled && isEditing) ratioScroll(preview, editor); });
        const fmt = {
            boldBtn: () => insertMarkdown('**', '**'), italicBtn: () => insertMarkdown('*', '*'), codeBtn: () => insertMarkdown('`', '`'),
            linkBtn: () => insertMarkdown('[', '](https://)'), imageBtn: () => insertMarkdown('![', '](https://)'),
            wikiBtn: () => insertMarkdown('[[' + C.addDays(loadedDate, -1), ']]'),
            h1Btn: () => insertMarkdownLine('# '), h2Btn: () => insertMarkdownLine('## '), h3Btn: () => insertMarkdownLine('### '),
            ulBtn: () => insertMarkdownLine('- '), olBtn: () => insertMarkdownLine('1. '), blockquoteBtn: () => insertMarkdownLine('> '),
            hrBtn: () => insertMarkdownLine('\n---\n'), tableBtn: insertTable, indentBtn: () => indent(false), outdentBtn: () => indent(true)
        };
        Object.keys(fmt).forEach((id) => document.getElementById(id).addEventListener('click', fmt[id]));
        $('#templateSelect').addEventListener('change', (e) => { const v = e.target.value; e.target.value = ''; if (v) applyTemplate(v); });
        $('#privateBtn').addEventListener('click', onPrivateBtn);
        $('#unlockForm').addEventListener('submit', onUnlock);
        $('#mdExportBtn').addEventListener('click', mdExport);
        // wiki links anywhere in rendered markdown
        document.addEventListener('click', (e) => {
            const a = e.target.closest && e.target.closest('a.wikilink');
            if (!a) return;
            e.preventDefault();
            const d = a.dataset.date;
            if (C.isValidDate(d)) { if (S.view !== 'day') NM.setView('day'); NM.setDate(d); NM.setDayTab('notes'); }
        });
    };
})();
