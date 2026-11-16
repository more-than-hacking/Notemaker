/*
 * Notemaker core — pure logic shared by the web UI and the Node test-suite.
 * No DOM access in this file. Works as a classic browser script (window.NotemakerCore)
 * and as a CommonJS module (module.exports).
 *
 * Implements docs/DATA_FORMAT.md (data format v2).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NotemakerCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ------------------------------------------------------------------
    // Dates — all calendar days are 'YYYY-MM-DD' strings, arithmetic in UTC
    // so DST never shifts a day.
    // ------------------------------------------------------------------
    const DAY_MS = 86400000;
    const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
        'September', 'October', 'November', 'December'];
    const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
    const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

    const pad2 = (n) => String(n).padStart(2, '0');

    function isValidDate(s) {
        if (typeof s !== 'string') return false;
        const m = DATE_RE.exec(s);
        if (!m) return false;
        const y = +m[1], mo = +m[2], d = +m[3];
        return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
    }
    function isValidTime(s) { return typeof s === 'string' && TIME_RE.test(s); }
    function parts(s) { const m = DATE_RE.exec(s); return [+m[1], +m[2], +m[3]]; }
    function toUTC(s) { const [y, m, d] = parts(s); return Date.UTC(y, m - 1, d); }
    function fromUTC(ms) {
        const d = new Date(ms);
        return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    function addDays(s, n) { return fromUTC(toUTC(s) + n * DAY_MS); }
    /** b − a in days */
    function diffDays(a, b) { return Math.round((toUTC(b) - toUTC(a)) / DAY_MS); }
    /** ISO weekday: 1 = Monday … 7 = Sunday */
    function weekday(s) { return ((new Date(toUTC(s)).getUTCDay() + 6) % 7) + 1; }
    function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
    function dateFromLocal(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    function localToday(now) { return dateFromLocal(now || new Date()); }
    function localTimeHM(now) { const d = now || new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
    function addMonths(s, n) {
        const [y, m, d] = parts(s);
        const total = (y * 12 + (m - 1)) + n;
        const ny = Math.floor(total / 12), nm = total % 12 + 1;
        return ny + '-' + pad2(nm) + '-' + pad2(Math.min(d, daysInMonth(ny, nm)));
    }
    function startOfWeek(s, weekStartsOn) {
        const ws = normalizeWeekStart(weekStartsOn);
        const off = (weekday(s) - ws + 7) % 7;
        return addDays(s, -off);
    }
    function normalizeWeekStart(v) {
        const n = Number(v);
        if (n === 0) return 7;               // tolerate 0 = Sunday
        return n >= 1 && n <= 7 ? Math.floor(n) : 1;
    }
    function weekdayName(s) { return WEEKDAY_NAMES[weekday(s) - 1]; }
    function longDate(s) { const [y, m, d] = parts(s); return MONTH_NAMES[m - 1] + ' ' + d + ', ' + y; }
    function fullDate(s) { return weekdayName(s) + ', ' + longDate(s); }
    function monthLabel(y, m) { return MONTH_NAMES[m - 1] + ' ' + y; }
    function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
    function minToTime(n) { n = Math.max(0, Math.min(24 * 60 - 1, Math.round(n))); return pad2(Math.floor(n / 60)) + ':' + pad2(n % 60); }

    // ------------------------------------------------------------------
    // IDs
    // ------------------------------------------------------------------
    function uuid() {
        const c = globalThis.crypto;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        const b = new Uint8Array(16);
        if (c && c.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.random() * 256 | 0;
        return bytesToUuid(b);
    }
    function bytesToUuid(b) {
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }
    /** Deterministic UUID-shaped id from a string (FNV-1a based, not cryptographic) — keeps v1 migration idempotent. */
    function uuidFromString(str) {
        const b = new Uint8Array(16);
        let h = [0x811c9dc5, 0x01000193 ^ 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
        const s = 'notemaker-v1:' + str;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            for (let k = 0; k < 4; k++) h[k] = Math.imul(h[k] ^ (c + k * 31), 0x01000193 + k * 2) >>> 0;
        }
        for (let k = 0; k < 4; k++) { b[k * 4] = h[k] >>> 24; b[k * 4 + 1] = (h[k] >>> 16) & 255; b[k * 4 + 2] = (h[k] >>> 8) & 255; b[k * 4 + 3] = h[k] & 255; }
        return bytesToUuid(b);
    }

    // ------------------------------------------------------------------
    // Defaults & normalisation (all imported data is untrusted)
    // ------------------------------------------------------------------
    const PRIORITIES = ['none', 'low', 'medium', 'high'];
    const PRIORITY_RANK = { high: 3, medium: 2, low: 1, none: 0 };
    const FREQS = ['daily', 'weekdays', 'weekly', 'monthly'];

    function defaultSettings() {
        return {
            theme: 'system', autoRollover: true, focusMinutes: 25, breakMinutes: 5, reviewTime: '18:00',
            weekStartsOn: 1, dayStart: '07:00', dayEnd: '21:00', lockHash: null, vaultAutoLockMinutes: 5,
            vaultBiometryOnly: false, vaultLockOnHide: false
        };
    }

    const BUILTIN_TEMPLATES = [
        {
            id: 'builtin-daily-journal', name: 'Daily journal',
            markdown: '# {{weekday}}, {{date}}\n\n## Grateful for\n- \n\n## Today\'s focus\n- \n\n## Notes\n\n## Reflection\n'
        },
        {
            id: 'builtin-meeting-notes', name: 'Meeting notes',
            markdown: '## Meeting — {{date}}\n\n**Attendees:** \n\n### Agenda\n1. \n\n### Discussion\n- \n\n### Decisions\n- \n\n### Action items\n- [ ] \n'
        },
        {
            id: 'builtin-weekly-review', name: 'Weekly review',
            markdown: '# Weekly review — week of {{date}}\n\n## Wins\n- \n\n## What didn\'t go well\n- \n\n## Lessons\n- \n\n## Next week\'s priorities\n1. \n2. \n3. \n'
        }
    ];
    function builtinTemplates() { return BUILTIN_TEMPLATES.map((t) => Object.assign({}, t)); }

    function emptyDoc() {
        return { app: 'notemaker', version: 2, exportedAt: null, tasks: [], notes: {}, habits: [], templates: builtinTemplates(), focusSessions: [], settings: defaultSettings(), vault: null };
    }

    const str = (v, d) => (typeof v === 'string' ? v : (v == null ? (d || '') : String(v)));
    const int = (v, d, min, max) => { let n = Math.floor(Number(v)); if (!isFinite(n)) n = d; if (min != null) n = Math.max(min, n); if (max != null) n = Math.min(max, n); return n; };
    const isoOr = (v, d) => (typeof v === 'string' && !isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : d);
    function dateSet(obj) {
        const out = {};
        if (obj && typeof obj === 'object') {
            const keys = Array.isArray(obj) ? obj : Object.keys(obj).filter((k) => obj[k]);
            for (const k of keys) if (isValidDate(k)) out[k] = true;
        }
        return out;
    }
    function normTags(tags) {
        const out = [];
        if (Array.isArray(tags)) for (let t of tags) {
            t = str(t).trim().replace(/^#+/, '').toLowerCase();
            if (t && !out.includes(t)) out.push(t);
        }
        return out;
    }
    function normRecurrence(r) {
        if (!r || typeof r !== 'object' || !FREQS.includes(r.freq)) return null;
        const by = Array.isArray(r.byWeekday) ? [...new Set(r.byWeekday.map(Number).filter((n) => n >= 1 && n <= 7))].sort() : [];
        return { freq: r.freq, interval: int(r.interval, 1, 1, 999), byWeekday: r.freq === 'weekly' ? by : [], until: isValidDate(r.until) ? r.until : null };
    }
    function normTimeBlock(tb) {
        if (!tb || !isValidTime(tb.start) || !isValidTime(tb.end)) return null;
        if (timeToMin(tb.end) <= timeToMin(tb.start)) return null;
        return { start: tb.start, end: tb.end };
    }

    function normalizeTask(raw, idx, fallbackDate) {
        raw = raw && typeof raw === 'object' ? raw : {};
        const now = new Date().toISOString();
        const recurrence = normRecurrence(raw.recurrence);
        const done = recurrence ? false : !!raw.done;
        let status = ['todo', 'doing', 'done'].includes(raw.status) ? raw.status : (done ? 'done' : 'todo');
        if (recurrence) { if (status === 'done') status = 'todo'; } else if (done) status = 'done'; else if (status === 'done') status = 'todo';
        const pom = raw.pomodoros && typeof raw.pomodoros === 'object' ? raw.pomodoros : {};
        return {
            id: str(raw.id) || uuid(),
            title: str(raw.title).slice(0, 2000),
            date: isValidDate(raw.date) ? raw.date : (fallbackDate || localToday()),
            done,
            completedAt: done ? isoOr(raw.completedAt, null) : null,
            createdAt: isoOr(raw.createdAt, now),
            priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'none',
            tags: normTags(raw.tags),
            subtasks: Array.isArray(raw.subtasks) ? raw.subtasks.filter((s) => s && typeof s === 'object').map((s) => ({
                id: str(s.id) || uuid(), title: str(s.title).slice(0, 2000), done: !!(s.done != null ? s.done : s.completed)
            })) : [],
            status,
            order: isFinite(Number(raw.order)) ? Number(raw.order) : (idx || 0),
            recurrence,
            doneDates: recurrence ? dateSet(raw.doneDates) : {},
            skipDates: recurrence ? dateSet(raw.skipDates) : {},
            reminder: isValidTime(raw.reminder) ? raw.reminder : null,
            timeBlock: normTimeBlock(raw.timeBlock),
            pomodoros: { estimate: int(pom.estimate, 0, 0, 99), done: int(pom.done, 0, 0, 9999) },
            rolledFrom: isValidDate(raw.rolledFrom) ? raw.rolledFrom : null,
            notes: str(raw.notes).slice(0, 100000)
        };
    }

    function normalizeCipher(c) {
        if (!c || typeof c !== 'object') return null;
        if (typeof c.salt !== 'string' || typeof c.iv !== 'string' || typeof c.ct !== 'string') return null;
        return { alg: 'AES-GCM-256', kdf: 'PBKDF2-SHA256', iterations: int(c.iterations, 210000, 1), salt: c.salt, iv: c.iv, ct: c.ct };
    }
    function normalizeNote(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        const cipher = normalizeCipher(raw.cipher);
        const locked = !!raw.locked && !!cipher;
        return { markdown: locked ? '' : str(raw.markdown), updatedAt: isoOr(raw.updatedAt, new Date().toISOString()), locked, cipher: locked ? cipher : null };
    }
    function normalizeHabit(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        const days = Array.isArray(raw.days) ? [...new Set(raw.days.map(Number).filter((n) => n >= 1 && n <= 7))].sort() : [];
        return {
            id: str(raw.id) || uuid(), name: str(raw.name).slice(0, 200) || 'Habit',
            color: /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color.toUpperCase() : '#8B5CF6',
            days, createdAt: isoOr(raw.createdAt, new Date().toISOString()), log: dateSet(raw.log)
        };
    }
    function normalizeTemplate(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        return { id: str(raw.id) || uuid(), name: str(raw.name).slice(0, 200) || 'Template', markdown: str(raw.markdown) };
    }
    function normalizeSession(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        const start = isoOr(raw.start, new Date().toISOString());
        return {
            id: str(raw.id) || uuid(), taskId: raw.taskId == null ? null : str(raw.taskId),
            start, end: isoOr(raw.end, start), minutes: int(raw.minutes, 0, 0, 1440), kind: raw.kind === 'break' ? 'break' : 'focus'
        };
    }
    function normalizeLockHash(lh) {
        if (!lh || typeof lh !== 'object' || typeof lh.salt !== 'string' || typeof lh.hash !== 'string') return null;
        return { salt: lh.salt, iterations: int(lh.iterations, 210000, 1), hash: lh.hash };
    }
    function normalizeSettings(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        const d = defaultSettings();
        return {
            theme: ['light', 'dark', 'system'].includes(raw.theme) ? raw.theme : d.theme,
            autoRollover: typeof raw.autoRollover === 'boolean' ? raw.autoRollover : d.autoRollover,
            focusMinutes: int(raw.focusMinutes, d.focusMinutes, 1, 180),
            breakMinutes: int(raw.breakMinutes, d.breakMinutes, 1, 60),
            reviewTime: raw.reviewTime === null ? null : (isValidTime(raw.reviewTime) ? raw.reviewTime : d.reviewTime),
            weekStartsOn: raw.weekStartsOn == null ? d.weekStartsOn : normalizeWeekStart(raw.weekStartsOn),
            dayStart: isValidTime(raw.dayStart) ? raw.dayStart : d.dayStart,
            dayEnd: isValidTime(raw.dayEnd) && (!isValidTime(raw.dayStart) || raw.dayEnd > raw.dayStart) ? raw.dayEnd : d.dayEnd,
            lockHash: normalizeLockHash(raw.lockHash),
            vaultAutoLockMinutes: int(raw.vaultAutoLockMinutes, d.vaultAutoLockMinutes, 1, 1440),
            vaultBiometryOnly: typeof raw.vaultBiometryOnly === 'boolean' ? raw.vaultBiometryOnly : d.vaultBiometryOnly,
            vaultLockOnHide: typeof raw.vaultLockOnHide === 'boolean' ? raw.vaultLockOnHide : d.vaultLockOnHide
        };
    }

    /** Normalise a v2 document (from storage or an import). */
    function normalizeDoc(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        const tasks = Array.isArray(raw.tasks) ? raw.tasks.map((t, i) => normalizeTask(t, i)) : [];
        const seen = new Set();
        const uniqTasks = tasks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
        const notes = {};
        if (raw.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes)) {
            for (const k of Object.keys(raw.notes)) if (isValidDate(k)) notes[k] = normalizeNote(raw.notes[k]);
        }
        return {
            app: 'notemaker', version: 2,
            exportedAt: isoOr(raw.exportedAt, null),
            tasks: uniqTasks,
            notes,
            habits: Array.isArray(raw.habits) ? raw.habits.map(normalizeHabit) : [],
            templates: Array.isArray(raw.templates) ? raw.templates.map(normalizeTemplate) : builtinTemplates(),
            focusSessions: Array.isArray(raw.focusSessions) ? raw.focusSessions.map(normalizeSession) : [],
            settings: normalizeSettings(raw.settings),
            vault: normalizeVault(raw.vault)
        };
    }
    /** Vault validation lives in vault-core.js (docs/VAULT_FORMAT.md); blobs are never kept in the document. */
    function vaultCore() {
        if (globalThis.NotemakerVault) return globalThis.NotemakerVault;
        if (typeof require === 'function') { try { return require('./vault-core.js'); } catch (e) { /* not available */ } }
        return null;
    }
    function normalizeVault(v) {
        if (v == null) return null;
        const V = vaultCore();
        return V ? V.normalizeVault(v) : null;
    }

    // ------------------------------------------------------------------
    // Migration v1 → v2
    // ------------------------------------------------------------------
    const SWIFT_REF_EPOCH = 978307200; // 2001-01-01T00:00:00Z
    function v1DateToDay(v) {
        if (isValidDate(v)) return v;
        if (typeof v === 'string' && !isNaN(Date.parse(v))) return v.slice(0, 10).match(DATE_RE) ? v.slice(0, 10) : localToday(new Date(v));
        if (typeof v === 'number' && isFinite(v)) return localToday(new Date((v + SWIFT_REF_EPOCH) * 1000));
        return null;
    }
    function v1Iso(v) {
        if (typeof v === 'number' && isFinite(v)) return new Date((v + SWIFT_REF_EPOCH) * 1000).toISOString();
        return isoOr(v, new Date().toISOString());
    }

    /**
     * Convert v1 arrays (web: {id,title,date,completed,createdAt,subtasks}, {date,content,createdAt};
     * macOS: {id,title,isCompleted,date,createdAt}, {id,content,date,createdAt}) to a v2 document.
     */
    function migrateV1(v1Tasks, v1Notes, opts) {
        opts = opts || {};
        const doc = emptyDoc();
        if (opts.theme === 'dark') doc.settings.theme = 'dark';
        const orderPerDay = {};
        (Array.isArray(v1Tasks) ? v1Tasks : []).forEach((t) => {
            if (!t || typeof t !== 'object') return;
            const date = v1DateToDay(t.date) || localToday();
            const done = !!(t.completed != null ? t.completed : t.isCompleted);
            const created = v1Iso(t.createdAt);
            orderPerDay[date] = (orderPerDay[date] || 0) + 1;
            const id = str(t.id);
            doc.tasks.push(normalizeTask({
                id: id ? uuidFromString('task:' + id) : uuid(),
                title: str(t.title).trim(), date, done, completedAt: done ? created : null, createdAt: created,
                status: done ? 'done' : 'todo', order: orderPerDay[date] - 1,
                subtasks: Array.isArray(t.subtasks) ? t.subtasks.map((s, i) => ({
                    id: s && s.id != null ? uuidFromString('sub:' + id + ':' + s.id) : uuidFromString('sub:' + id + ':' + i),
                    title: s && s.title, done: !!(s && (s.done != null ? s.done : s.completed))
                })) : []
            }));
        });
        (Array.isArray(v1Notes) ? v1Notes : []).forEach((n) => {
            if (!n || typeof n !== 'object') return;
            const date = v1DateToDay(n.date);
            if (!date) return;
            const content = str(n.content);
            const updatedAt = v1Iso(n.updatedAt || n.createdAt);
            const ex = doc.notes[date];
            if (ex) {
                if (content.trim() && ex.markdown.trim() !== content.trim()) ex.markdown = ex.markdown.trim() + '\n\n' + content.trim();
            } else doc.notes[date] = { markdown: content, updatedAt, locked: false, cipher: null };
        });
        return doc;
    }

    /** Detect a parsed import file and return a normalised v2 doc (or throw). */
    function importToDoc(json) {
        if (!json || typeof json !== 'object') throw new Error('Not a Notemaker backup (expected a JSON object).');
        if (Number(json.version) === 2 || (json.app === 'notemaker' && json.notes && !Array.isArray(json.notes))) {
            return normalizeDoc(json);
        }
        if (Array.isArray(json.tasks) || Array.isArray(json.notes)) {
            return migrateV1(json.tasks || [], json.notes || []);
        }
        throw new Error('Unrecognised file format: no tasks or notes found.');
    }

    // ------------------------------------------------------------------
    // Tasks: occurrence rule, completion, rollover, sorting
    // ------------------------------------------------------------------
    function occursOn(task, D) {
        const r = task.recurrence;
        if (!r) return task.date === D;
        if (D < task.date) return false;
        if (r.until && D > r.until) return false;
        if (task.skipDates && task.skipDates[D]) return false;
        const iv = Math.max(1, Math.floor(r.interval) || 1);
        switch (r.freq) {
            case 'daily': return diffDays(task.date, D) % iv === 0;
            case 'weekdays': return weekday(D) <= 5;
            case 'weekly': {
                const days = r.byWeekday && r.byWeekday.length ? r.byWeekday : [weekday(task.date)];
                if (!days.includes(weekday(D))) return false;
                const m1 = addDays(task.date, 1 - weekday(task.date));
                const m2 = addDays(D, 1 - weekday(D));
                return (diffDays(m1, m2) / 7) % iv === 0;
            }
            case 'monthly': {
                const [y1, mo1, d1] = parts(task.date), [y2, mo2, d2] = parts(D);
                const months = (y2 - y1) * 12 + (mo2 - mo1);
                if (months % iv !== 0) return false;
                return d2 === Math.min(d1, daysInMonth(y2, mo2));
            }
        }
        return false;
    }
    function tasksForDay(tasks, D) {
        const out = [];
        for (const t of tasks) if (occursOn(t, D)) out.push(t);
        return out;
    }
    function isDoneOn(task, D) { return task.recurrence ? !!task.doneDates[D] : !!task.done; }
    /** Kanban column of a task on day D. */
    function statusOn(task, D) {
        if (isDoneOn(task, D)) return 'done';
        return task.status === 'doing' ? 'doing' : 'todo';
    }
    function setDoneOn(task, D, done, nowIso) {
        if (task.recurrence) {
            if (done) task.doneDates[D] = true; else delete task.doneDates[D];
            if (task.status === 'done') task.status = 'todo';
            if (done && task.status === 'doing') task.status = 'todo';
        } else {
            task.done = !!done;
            task.completedAt = done ? (nowIso || new Date().toISOString()) : null;
            task.status = done ? 'done' : 'todo';
        }
    }
    function setStatusOn(task, D, status, nowIso) {
        if (status === 'done') setDoneOn(task, D, true, nowIso);
        else {
            if (isDoneOn(task, D)) setDoneOn(task, D, false, nowIso);
            task.status = status;
        }
    }
    /** Smart rollover (spec): returns the number of moved tasks. Mutates. */
    function rollover(tasks, today) {
        let n = 0;
        for (const t of tasks) {
            if (!t.recurrence && !t.done && t.date < today) {
                t.rolledFrom = t.rolledFrom || t.date;
                t.date = today;
                n++;
            }
        }
        return n;
    }
    function snooze(task, day) { task.date = day; task.rolledFrom = null; }
    function overdueDays(task, today) {
        if (task.recurrence || task.done) return 0;
        const from = task.rolledFrom || (task.date < today ? task.date : null);
        return from ? Math.max(0, diffDays(from, today)) : 0;
    }
    function sortTasks(list, mode) {
        const arr = list.slice();
        if (mode === 'priority') arr.sort((a, b) => (PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]) || (a.order - b.order) || a.createdAt.localeCompare(b.createdAt));
        else arr.sort((a, b) => (a.order - b.order) || a.createdAt.localeCompare(b.createdAt));
        return arr;
    }
    function filterTasks(list, D, f) {
        f = f || {};
        return list.filter((t) => {
            const done = isDoneOn(t, D);
            if (f.status === 'completed' && !done) return false;
            if (f.status === 'incomplete' && done) return false;
            if (f.priority && f.priority !== 'any' && t.priority !== f.priority) return false;
            if (f.tag && f.tag !== 'any' && !t.tags.includes(f.tag)) return false;
            return true;
        });
    }
    function newTask(fields, today) {
        return normalizeTask(Object.assign({ id: uuid(), createdAt: new Date().toISOString(), date: today }, fields));
    }

    // ------------------------------------------------------------------
    // Quick add grammar
    // ------------------------------------------------------------------
    const WD_TOKENS = { monday: 1, mon: 1, tuesday: 2, tue: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7 };
    const WD_ALT = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun';
    function nextWeekday(today, wd) { return addDays(today, (wd - weekday(today) + 7) % 7); }
    function to24(h, m, ap) {
        h = +h; m = m == null ? 0 : +m;
        if (m > 59) return null;
        if (ap) {
            if (h < 1 || h > 12) return null;
            ap = ap.toLowerCase();
            if (ap === 'am') h = h === 12 ? 0 : h; else h = h === 12 ? 12 : h + 12;
        } else if (h > 23) return null;
        return pad2(h) + ':' + pad2(m);
    }

    /**
     * Parse a quick-add string. today = 'YYYY-MM-DD'.
     * Returns { title, date, priority, tags, reminder, recurrence, estimate, matched: [labels] }.
     */
    function parseQuickAdd(input, today) {
        let s = ' ' + String(input || '').replace(/\s+/g, ' ') + ' ';
        const res = { title: '', date: today, priority: 'none', tags: [], reminder: null, recurrence: null, estimate: 0 };
        let explicitDate = null, freq = null, weeklyDay = null;
        const take = (re, fn) => { s = s.replace(re, function () { const r = fn.apply(null, arguments); return r === false ? arguments[0] : ' '; }); };
        const setFreq = (f) => { if (!freq) freq = f; };
        const setDate = (d) => { if (!explicitDate && d && isValidDate(d)) explicitDate = d; else if (!d || !isValidDate(d)) return false; };

        // recurrence (longest phrases first)
        take(/\severy\s+weekdays?(?=\s)/gi, () => setFreq('weekdays'));
        take(/\sweekdays(?=\s)/gi, () => setFreq('weekdays'));
        take(/\severy\s+day(?=\s)/gi, () => setFreq('daily'));
        take(/\sdaily(?=\s)/gi, () => setFreq('daily'));
        take(new RegExp('\\severy\\s+(' + WD_ALT + ')(?=\\s)', 'gi'), (m, w) => { if (!freq) { freq = 'weekly'; weeklyDay = WD_TOKENS[w.toLowerCase()]; } });
        take(/\severy\s+week(?=\s)/gi, () => setFreq('weekly'));
        take(/\sweekly(?=\s)/gi, () => setFreq('weekly'));
        take(/\severy\s+month(?=\s)/gi, () => setFreq('monthly'));
        take(/\smonthly(?=\s)/gi, () => setFreq('monthly'));

        // dates
        take(/\s(\d{4}-\d{2}-\d{2})(?=\s)/g, (m, d) => setDate(d));
        take(/\sin\s+(\d{1,4})\s+(days?|weeks?)(?=\s)/gi, (m, n, unit) => setDate(addDays(today, +n * (/^w/i.test(unit) ? 7 : 1))));
        take(/\snext\s+week(?=\s)/gi, () => setDate(addDays(today, 8 - weekday(today))));
        take(/\stoday(?=\s)/gi, () => setDate(today));
        take(/\s(tomorrow|tmr)(?=\s)/gi, () => setDate(addDays(today, 1)));
        take(new RegExp('\\s(' + WD_ALT + ')(?=\\s)', 'gi'), (m, w) => setDate(nextWeekday(today, WD_TOKENS[w.toLowerCase()])));

        // reminder time
        const setTime = (t) => { if (!t) return false; if (!res.reminder) res.reminder = t; };
        take(/\sat\s+(\d{1,2})(?::(\d{2}))?\s?(am|pm)?(?=\s)/gi, (m, h, mi, ap) => setTime(to24(h, mi, ap)));
        take(/\s(\d{1,2})(?::(\d{2}))?\s?(am|pm)(?=\s)/gi, (m, h, mi, ap) => setTime(to24(h, mi, ap)));
        take(/\s(\d{1,2}):(\d{2})(?=\s)/g, (m, h, mi) => setTime(to24(h, mi, null)));

        // estimate, priority, tags
        take(/\s~(\d{1,2})(?=\s)/g, (m, n) => { if (!res.estimate) res.estimate = +n; });
        take(/\s!(high|h|1|medium|med|m|2|low|l|3)(?=\s)/gi, (m, p) => {
            p = p.toLowerCase();
            if (res.priority === 'none') res.priority = /^(high|h|1)$/.test(p) ? 'high' : /^(medium|med|m|2)$/.test(p) ? 'medium' : 'low';
        });
        take(/\s#([\w\-À-￿]+)(?=\s)/g, (m, t) => { t = t.toLowerCase(); if (!res.tags.includes(t)) res.tags.push(t); });

        res.date = explicitDate || (weeklyDay ? nextWeekday(today, weeklyDay) : today);
        if (freq) {
            res.recurrence = { freq, interval: 1, byWeekday: freq === 'weekly' ? [weeklyDay || weekday(res.date)] : [], until: null };
        }
        res.title = s.replace(/\s+/g, ' ').trim();
        return res;
    }

    // ------------------------------------------------------------------
    // Streaks & stats
    // ------------------------------------------------------------------
    /** Map date → number of task completions on that day (task day, per occurrence for recurring). */
    function completionsByDay(tasks) {
        const m = {};
        for (const t of tasks) {
            if (t.recurrence) {
                for (const d of Object.keys(t.doneDates || {})) if (t.doneDates[d] && !(t.skipDates && t.skipDates[d])) m[d] = (m[d] || 0) + 1;
            } else if (t.done) m[t.date] = (m[t.date] || 0) + 1;
        }
        return m;
    }
    /** { current, best } — a day counts if ≥1 task completed. Current ends today, or yesterday if today has none yet. */
    function streaks(counts, today) {
        let current = 0;
        let d = counts[today] > 0 ? today : addDays(today, -1);
        while (counts[d] > 0) { current++; d = addDays(d, -1); }
        const days = Object.keys(counts).filter((k) => counts[k] > 0 && k <= today).sort();
        let best = 0, run = 0, prev = null;
        for (const k of days) { run = prev && diffDays(prev, k) === 1 ? run + 1 : 1; if (run > best) best = run; prev = k; }
        return { current, best: Math.max(best, current) };
    }
    function habitScheduledOn(habit, D) { return !habit.days || !habit.days.length || habit.days.includes(weekday(D)); }
    /** Spec: consecutive scheduled days ending today (or yesterday if today isn't logged yet) present in log. */
    function habitStreak(habit, today) {
        let d = today;
        if (!habit.log[today]) d = addDays(today, -1);
        let n = 0;
        for (let i = 0; i < 3700; i++, d = addDays(d, -1)) {
            if (!habitScheduledOn(habit, d)) continue;
            if (habit.log[d]) n++; else break;
        }
        return n;
    }
    /** Occurrence counts (total, done) for a day range — used for completion rate / calendar ratio. */
    function dayRatio(tasks, D) {
        let total = 0, done = 0;
        for (const t of tasks) if (occursOn(t, D)) { total++; if (isDoneOn(t, D)) done++; }
        return { total, done };
    }
    /** Ratios for many days at once — buckets non-recurring tasks by date (fast for thousands of tasks). */
    function rangeRatios(tasks, from, to) {
        const out = {};
        for (let d = from; d <= to; d = addDays(d, 1)) out[d] = { total: 0, done: 0 };
        for (const t of tasks) {
            if (!t.recurrence) {
                const r = out[t.date];
                if (r) { r.total++; if (t.done) r.done++; }
            } else {
                if (t.date > to || (t.recurrence.until && t.recurrence.until < from)) continue;
                for (const d in out) if (occursOn(t, d)) { out[d].total++; if (t.doneDates[d]) out[d].done++; }
            }
        }
        return out;
    }
    function topTags(tasks, limit) {
        const m = {};
        for (const t of tasks) for (const tag of t.tags) {
            const e = m[tag] || (m[tag] = { tag, count: 0, done: 0 });
            e.count++;
            if (t.recurrence ? Object.keys(t.doneDates).length : t.done) e.done++;
        }
        return Object.values(m).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, limit || 8);
    }
    function focusMinutesBetween(sessions, fromDay, toDay) {
        let n = 0;
        for (const s of sessions) {
            if (s.kind !== 'focus') continue;
            const d = localToday(new Date(s.start));
            if (d >= fromDay && d <= toDay) n += s.minutes;
        }
        return n;
    }

    /** Deterministic hue from a tag name. */
    function tagHue(name) {
        let h = 2166136261;
        for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
        return h % 360;
    }

    // ------------------------------------------------------------------
    // Markdown → HTML (safe: escapes everything, allow-listed URLs only)
    // ------------------------------------------------------------------
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function safeLinkUrl(u) {
        u = String(u || '').trim();
        return /^(https?:\/\/|mailto:)[^\s<>"'`]*$/i.test(u) ? u : null;
    }
    function safeImageUrl(u) {
        u = String(u || '').trim();
        if (/^https?:\/\/[^\s<>"'`]+$/i.test(u)) return u;
        if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=]+$/i.test(u)) return u;
        return null;
    }
    const URL_PART = '(<[^<>\\n]*>|[^\\s()<>]*(?:\\([^\\s()<>]*\\)[^\\s()<>]*)*)';
    const IMG_RE = new RegExp('!\\[([^\\]\\n]*)\\]\\(\\s*' + URL_PART + '(?:\\s+"[^"\\n]*")?\\s*\\)', 'g');
    const LINK_RE = new RegExp('\\[([^\\]\\n]+)\\]\\(\\s*' + URL_PART + '(?:\\s+"[^"\\n]*")?\\s*\\)', 'g');
    const unAngle = (u) => (u.startsWith('<') && u.endsWith('>') ? u.slice(1, -1) : u);

    function renderInline(src, noLinks) {
        const store = [];
        const ph = (html) => '\u0000' + (store.push(html) - 1) + '\u0000';
        let s = String(src).replace(/\u0000/g, '');
        s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, t, code) => ph('<code>' + escapeHtml(code) + '</code>'));
        s = s.replace(IMG_RE, (m, alt, url) => {
            const u = safeImageUrl(unAngle(url));
            return ph(u ? '<img src="' + escapeHtml(u) + '" alt="' + escapeHtml(alt) + '" loading="lazy">' : '<span class="md-blocked">' + escapeHtml(m) + '</span>');
        });
        s = s.replace(/\[\[(\d{4}-\d{2}-\d{2})\]\]/g, (m, d) => (isValidDate(d)
            ? ph('<a href="#' + d + '" class="wikilink" data-date="' + d + '">' + d + '</a>') : m));
        if (!noLinks) {
            s = s.replace(LINK_RE, (m, text, url) => {
                const u = safeLinkUrl(unAngle(url));
                const inner = renderInline(text, true);
                return ph(u ? '<a href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer nofollow">' + inner + '</a>' : inner);
            });
            s = s.replace(/\bhttps?:\/\/[^\s<>"'`\u0000]*[^\s<>"'`\u0000.,;:!?)\]]/g, (m) =>
                ph('<a href="' + escapeHtml(m) + '" target="_blank" rel="noopener noreferrer nofollow">' + escapeHtml(m) + '</a>'));
        }
        s = escapeHtml(s);
        s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
        s = s.replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '<em>$1</em>').replace(/\*(?=[^\s*])([^*])\*/g, '<em>$1</em>');
        s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_]|[^\s_])_(?!\w)/g, '$1<em>$2</em>');
        s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
        s = s.replace(/==(?=\S)([^=]*?\S)==/g, '<mark>$1</mark>');
        return s.replace(/\u0000(\d+)\u0000/g, (m, i) => store[+i]);
    }

    const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
    const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
    const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
    const FENCE_RE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
    const splitRow = (l) => { let t = l.trim(); if (t.startsWith('|')) t = t.slice(1); if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1); return t.replace(/\\\|/g, '\u0001').split('|').map((c) => c.trim().replace(/\u0001/g, '|')); };

    function isBlockStart(lines, i) {
        const l = lines[i];
        return /^#{1,6}\s/.test(l) || FENCE_RE.test(l) || HR_RE.test(l) || /^\s*>/.test(l) || LIST_RE.test(l)
            || (l.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-'));
    }
    function renderListItem(text) {
        const m = /^\[([ xX])\]\s+([\s\S]*)$/.exec(text) || /^\[([ xX])\]$/.exec(text);
        const body = (m ? (m[2] || '') : text).split('\n').map((l) => renderInline(l)).join('<br>');
        if (m) return '<li class="task-li"><input type="checkbox" disabled' + (m[1] !== ' ' ? ' checked' : '') + '> ' + body;
        return '<li>' + body;
    }
    function renderList(lines, i) {
        const items = [];
        while (i < lines.length) {
            const m = LIST_RE.exec(lines[i]);
            if (m) {
                items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
                i++;
            } else if (items.length && /^\s{2,}\S/.test(lines[i]) && !isBlockStart(lines, i)) {
                items[items.length - 1].text += '\n' + lines[i].trim(); i++;
            } else break;
        }
        let html = '';
        const stack = [];
        const open = (it) => {
            const tag = it.ordered ? 'ol' : 'ul';
            html += '<' + tag + (it.ordered && it.start !== 1 && isFinite(it.start) ? ' start="' + it.start + '"' : '') + '>';
            stack.push({ indent: it.indent, tag });
        };
        for (const it of items) {
            while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) html += '</li></' + stack.pop().tag + '>';
            const top = stack[stack.length - 1];
            if (!top) open(it);
            else if (it.indent > top.indent) open(it);
            else {
                html += '</li>';
                if (top.tag !== (it.ordered ? 'ol' : 'ul')) { html += '</' + stack.pop().tag + '>'; open(it); }
            }
            html += renderListItem(it.text);
        }
        while (stack.length) html += '</li></' + stack.pop().tag + '>';
        return { html, next: i };
    }
    function renderBlocks(lines, depth) {
        const out = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            if (/^\s*$/.test(line)) { i++; continue; }
            let m = FENCE_RE.exec(line);
            if (m) {
                const fence = m[1], buf = [];
                i++;
                while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
                i++;
                out.push('<pre><code' + (m[2] ? ' class="lang-' + escapeHtml(m[2]) + '"' : '') + '>' + escapeHtml(buf.join('\n')) + '</code></pre>');
                continue;
            }
            m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
            if (m) { const n = m[1].length; out.push('<h' + n + '>' + renderInline(m[2]) + '</h' + n + '>'); i++; continue; }
            if (HR_RE.test(line)) { out.push('<hr>'); i++; continue; }
            if (/^\s*>/.test(line)) {
                const buf = [];
                while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
                out.push('<blockquote>' + (depth > 8 ? escapeHtml(buf.join('\n')) : renderBlocks(buf, (depth || 0) + 1)) + '</blockquote>');
                continue;
            }
            if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
                const head = splitRow(line);
                const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : ''));
                const st = (k) => (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '');
                let html = '<div class="table-wrap"><table><thead><tr>' + head.map((c, k) => '<th' + st(k) + '>' + renderInline(c) + '</th>').join('') + '</tr></thead><tbody>';
                i += 2;
                while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
                    const cells = splitRow(lines[i++]);
                    html += '<tr>' + head.map((_, k) => '<td' + st(k) + '>' + renderInline(cells[k] || '') + '</td>').join('') + '</tr>';
                }
                out.push(html + '</tbody></table></div>');
                continue;
            }
            if (LIST_RE.test(line)) { const r = renderList(lines, i); out.push(r.html); i = r.next; continue; }
            const buf = [];
            do { buf.push(lines[i++]); } while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines, i));
            out.push('<p>' + buf.map((l) => renderInline(l.trim())).join('<br>') + '</p>');
        }
        return out.join('\n');
    }
    function markdownToHtml(md) {
        if (!md) return '';
        return renderBlocks(String(md).replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n'), 0);
    }

    // ------------------------------------------------------------------
    // Wiki links, backlinks, templates, review, search, fuzzy
    // ------------------------------------------------------------------
    function wikiLinks(md) {
        const out = [];
        const re = /\[\[(\d{4}-\d{2}-\d{2})\]\]/g;
        let m;
        while ((m = re.exec(md || ''))) if (isValidDate(m[1]) && !out.includes(m[1])) out.push(m[1]);
        return out;
    }
    function backlinks(notes, day) {
        const needle = '[[' + day + ']]';
        return Object.keys(notes).filter((d) => d !== day && !notes[d].locked && (notes[d].markdown || '').includes(needle)).sort().reverse();
    }
    function applyTemplate(md, day) {
        return String(md).replace(/\{\{\s*date\s*\}\}/g, longDate(day)).replace(/\{\{\s*weekday\s*\}\}/g, weekdayName(day));
    }
    function appendReview(md, r) {
        const line = (v) => (String(v || '').trim() ? String(v).trim().split('\n').map((l) => '- ' + l.replace(/^[-*]\s+/, '')).join('\n') : '- —');
        const sec = '## Daily review\n\n**Wins**\n' + line(r.wins) + '\n\n**Blockers**\n' + line(r.blockers) + '\n\n**Tomorrow\'s focus**\n' + line(r.focus) + '\n';
        md = String(md || '').replace(/\s+$/, '');
        return (md ? md + '\n\n' : '') + sec;
    }
    function snippet(text, q, len) {
        len = len || 90;
        const i = text.toLowerCase().indexOf(q.toLowerCase());
        if (i < 0 || text.length <= len) return text.slice(0, len) + (text.length > len ? '…' : '');
        const start = Math.max(0, i - 30);
        return (start ? '…' : '') + text.slice(start, start + len).replace(/\n/g, ' ') + (start + len < text.length ? '…' : '');
    }
    /**
     * Global search over task titles, subtasks, tags and (unlocked) note text.
     * Returns [{ date, items: [{ kind, taskId, text }] }] newest first.
     */
    function search(doc, query, limit) {
        const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!terms.length) return [];
        limit = limit || 300;
        const all = (hay) => { hay = hay.toLowerCase(); return terms.every((t) => hay.includes(t.replace(/^#/, ''))); };
        const byDate = {};
        let count = 0;
        const add = (date, item) => { if (count >= limit) return; (byDate[date] || (byDate[date] = [])).push(item); count++; };
        for (const t of doc.tasks) {
            if (all(t.title + ' ' + t.tags.map((x) => '#' + x).join(' ') + ' ' + (t.notes || ''))) add(t.date, { kind: 'task', taskId: t.id, text: t.title, tags: t.tags, recurring: !!t.recurrence });
            for (const st of t.subtasks) if (all(st.title)) add(t.date, { kind: 'subtask', taskId: t.id, text: st.title, parent: t.title });
        }
        for (const d of Object.keys(doc.notes)) {
            const n = doc.notes[d];
            if (n.locked || !n.markdown) continue;
            if (all(n.markdown)) add(d, { kind: 'note', text: snippet(n.markdown, terms[0]) });
        }
        return Object.keys(byDate).sort().reverse().map((date) => ({ date, items: byDate[date] }));
    }
    function fuzzyScore(query, text) {
        const q = String(query || '').toLowerCase().trim(), t = String(text || '').toLowerCase();
        if (!q) return 1;
        let ti = 0, score = 0, prev = -2;
        for (const ch of q) {
            if (ch === ' ') continue;
            const idx = t.indexOf(ch, ti);
            if (idx < 0) return 0;
            score += 1 + (idx === prev + 1 ? 3 : 0) + (idx === 0 || /[\s\-_/:]/.test(t[idx - 1]) ? 2 : 0);
            prev = idx; ti = idx + 1;
        }
        if (t.startsWith(q)) score += 15; else if (t.includes(q)) score += 8;
        return score - t.length * 0.01;
    }
    /** Resolve a date phrase for the command palette (today, tomorrow, yesterday, weekday names, YYYY-MM-DD, "in N days"). */
    function parseDatePhrase(q, today) {
        q = String(q || '').trim().toLowerCase();
        if (!q) return null;
        if (q === 'today') return today;
        if (q === 'tomorrow' || q === 'tmr') return addDays(today, 1);
        if (q === 'yesterday') return addDays(today, -1);
        if (isValidDate(q)) return q;
        if (WD_TOKENS[q]) return nextWeekday(today, WD_TOKENS[q]);
        let m = /^next\s+(\w+)$/.exec(q);
        if (m && m[1] === 'week') return addDays(today, 8 - weekday(today));
        if (m && WD_TOKENS[m[1]]) return addDays(nextWeekday(addDays(today, 1), WD_TOKENS[m[1]]), 0);
        m = /^in\s+(\d+)\s+(day|days|week|weeks)$/.exec(q);
        if (m) return addDays(today, +m[1] * (m[2][0] === 'w' ? 7 : 1));
        return null;
    }

    // ------------------------------------------------------------------
    // Markdown export
    // ------------------------------------------------------------------
    /** unlocked: optional map date → decrypted markdown (session only). */
    function exportMarkdown(doc, days, unlocked) {
        const out = [];
        for (const d of days) {
            const list = sortTasks(tasksForDay(doc.tasks, d), 'manual');
            const note = doc.notes[d];
            out.push('# ' + fullDate(d) + '\n');
            if (list.length) {
                out.push('## Tasks\n');
                for (const t of list) {
                    const meta = [];
                    if (t.priority !== 'none') meta.push('!' + t.priority);
                    t.tags.forEach((x) => meta.push('#' + x));
                    if (t.reminder) meta.push('⏰ ' + t.reminder);
                    if (t.recurrence) meta.push('↻ ' + t.recurrence.freq);
                    out.push('- [' + (isDoneOn(t, d) ? 'x' : ' ') + '] ' + t.title + (meta.length ? ' ' + meta.join(' ') : ''));
                    for (const st of t.subtasks) out.push('  - [' + (st.done ? 'x' : ' ') + '] ' + st.title);
                }
                out.push('');
            }
            if (note) {
                const md = note.locked ? (unlocked && unlocked[d] != null ? unlocked[d] : '_🔒 Private note (locked)_') : note.markdown;
                if (md && md.trim()) out.push('## Note\n\n' + md.trim() + '\n');
            }
            if (!list.length && !(note && (note.locked || note.markdown.trim()))) out.push('_Nothing recorded._\n');
        }
        return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
    }

    // ------------------------------------------------------------------
    // Export / import (merge)
    // ------------------------------------------------------------------
    function exportDoc(doc, nowIso) {
        const n = normalizeDoc(doc);
        return {
            app: 'notemaker', version: 2, exportedAt: nowIso || new Date().toISOString(),
            tasks: n.tasks, notes: n.notes, habits: n.habits, templates: n.templates, focusSessions: n.focusSessions, settings: n.settings,
            vault: n.vault
        };
    }
    /**
     * Merge an incoming (normalised) doc into local. Returns { doc, stats }. Pure (does not mutate inputs).
     * Tasks: skip same id or same (date, title) non-recurring duplicates. Notes: add missing, merge differing
     * unlocked text with a separator, keep local on locked conflicts. Habits/templates/sessions: add by id
     * (templates also de-duplicated by name). Settings stay local; lockHash is adopted if local has none.
     */
    function mergeDocs(local, incoming) {
        const doc = JSON.parse(JSON.stringify(local));
        const stats = { tasksAdded: 0, tasksSkipped: 0, notesAdded: 0, notesMerged: 0, notesSkipped: 0, habitsAdded: 0, templatesAdded: 0, sessionsAdded: 0 };
        const ids = new Set(doc.tasks.map((t) => t.id));
        const keys = new Set(doc.tasks.filter((t) => !t.recurrence).map((t) => t.date + '|' + t.title.trim().toLowerCase()));
        let maxOrder = doc.tasks.reduce((m, t) => Math.max(m, t.order), 0);
        for (const t of incoming.tasks) {
            const key = t.date + '|' + t.title.trim().toLowerCase();
            if (ids.has(t.id) || (!t.recurrence && keys.has(key))) { stats.tasksSkipped++; continue; }
            const c = JSON.parse(JSON.stringify(t));
            if (!isFinite(c.order)) c.order = ++maxOrder;
            doc.tasks.push(c); ids.add(t.id); keys.add(key); stats.tasksAdded++;
        }
        for (const d of Object.keys(incoming.notes)) {
            const inc = incoming.notes[d], ex = doc.notes[d];
            if (!ex || (!ex.locked && !ex.markdown.trim())) { doc.notes[d] = JSON.parse(JSON.stringify(inc)); stats.notesAdded++; continue; }
            if (ex.locked || inc.locked) {
                stats.notesSkipped++; // never merge encrypted content; local wins
                continue;
            }
            if (ex.markdown.trim() === inc.markdown.trim() || !inc.markdown.trim()) { stats.notesSkipped++; continue; }
            ex.markdown = ex.markdown.trim() + '\n\n--- Merged from import ---\n\n' + inc.markdown.trim();
            ex.updatedAt = new Date().toISOString();
            stats.notesMerged++;
        }
        const hIds = new Set(doc.habits.map((h) => h.id));
        for (const h of incoming.habits) if (!hIds.has(h.id)) { doc.habits.push(JSON.parse(JSON.stringify(h))); stats.habitsAdded++; }
        const tIds = new Set(doc.templates.map((t) => t.id)), tNames = new Set(doc.templates.map((t) => t.name.toLowerCase()));
        for (const t of incoming.templates) if (!tIds.has(t.id) && !tNames.has(t.name.toLowerCase())) { doc.templates.push(Object.assign({}, t)); stats.templatesAdded++; }
        const sIds = new Set(doc.focusSessions.map((s) => s.id));
        for (const s of incoming.focusSessions) if (!sIds.has(s.id)) { doc.focusSessions.push(Object.assign({}, s)); stats.sessionsAdded++; }
        if (!doc.settings.lockHash && incoming.settings.lockHash) doc.settings.lockHash = Object.assign({}, incoming.settings.lockHash);
        // vault: adopt an incoming vault only when there is none locally; never merge or overwrite a local vault
        stats.vaultAdopted = false; stats.vaultSkipped = false;
        if (incoming.vault) {
            if (!doc.vault) { doc.vault = JSON.parse(JSON.stringify(incoming.vault)); stats.vaultAdopted = true; }
            else if (JSON.stringify(doc.vault) !== JSON.stringify(incoming.vault)) stats.vaultSkipped = true;
        }
        if (doc.vault === undefined) doc.vault = null;
        return { doc, stats };
    }

    // ------------------------------------------------------------------
    // Crypto (WebCrypto; works in browsers and Node ≥ 19)
    // ------------------------------------------------------------------
    const ITERATIONS = 210000;
    function subtle() {
        const c = globalThis.crypto;
        const s = (c && c.subtle) || (c && c.webcrypto && c.webcrypto.subtle);
        if (!s) throw new Error('WebCrypto is not available here (needs https, localhost or file://).');
        return s;
    }
    function randomBytes(n) { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; }
    function b64encode(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin);
    }
    function b64decode(s) {
        const bin = atob(String(s).replace(/\s+/g, ''));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    async function pbkdf2(passcode, saltBytes, iterations) {
        const base = await subtle().importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
        const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, base, 256);
        return new Uint8Array(bits);
    }
    async function makeLockHash(passcode, iterations) {
        const salt = randomBytes(16);
        iterations = iterations || ITERATIONS;
        return { salt: b64encode(salt), iterations, hash: b64encode(await pbkdf2(passcode, salt, iterations)) };
    }
    async function verifyPasscode(passcode, lockHash) {
        if (!lockHash) return false;
        const h = await pbkdf2(passcode, b64decode(lockHash.salt), lockHash.iterations);
        const want = b64decode(lockHash.hash);
        if (h.length !== want.length) return false;
        let diff = 0;
        for (let i = 0; i < h.length; i++) diff |= h[i] ^ want[i];
        return diff === 0;
    }
    async function aesKey(passcode, salt, iterations, usage) {
        const raw = await pbkdf2(passcode, salt, iterations);
        return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
    }
    async function encryptNote(plaintext, passcode, iterations) {
        iterations = iterations || ITERATIONS;
        const salt = randomBytes(16), iv = randomBytes(12);
        const key = await aesKey(passcode, salt, iterations, 'encrypt');
        const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
        return { alg: 'AES-GCM-256', kdf: 'PBKDF2-SHA256', iterations, salt: b64encode(salt), iv: b64encode(iv), ct: b64encode(ct) };
    }
    async function decryptNote(cipher, passcode) {
        const key = await aesKey(passcode, b64decode(cipher.salt), cipher.iterations, 'decrypt');
        try {
            const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64decode(cipher.iv) }, key, b64decode(cipher.ct));
            return new TextDecoder().decode(pt);
        } catch (e) {
            throw new Error('Wrong passcode or corrupted note.');
        }
    }

    return {
        // dates
        isValidDate, isValidTime, addDays, diffDays, weekday, daysInMonth, localToday, localTimeHM, addMonths, startOfWeek,
        normalizeWeekStart, weekdayName, longDate, fullDate, monthLabel, timeToMin, minToTime, pad2, WEEKDAY_NAMES, MONTH_NAMES,
        // ids & docs
        uuid, uuidFromString, defaultSettings, builtinTemplates, emptyDoc, normalizeDoc, normalizeTask, normalizeNote, normalizeHabit,
        normalizeTemplate, normalizeSession, normalizeSettings, normRecurrence, migrateV1, importToDoc, exportDoc, mergeDocs,
        PRIORITIES, PRIORITY_RANK,
        // tasks
        occursOn, tasksForDay, isDoneOn, statusOn, setDoneOn, setStatusOn, rollover, snooze, overdueDays, sortTasks, filterTasks, newTask,
        parseQuickAdd, nextWeekday,
        // stats
        completionsByDay, streaks, habitStreak, habitScheduledOn, dayRatio, rangeRatios, topTags, focusMinutesBetween, tagHue,
        // markdown & text
        escapeHtml, markdownToHtml, renderInline, safeLinkUrl, safeImageUrl, wikiLinks, backlinks, applyTemplate, appendReview,
        search, fuzzyScore, parseDatePhrase, exportMarkdown,
        // crypto
        ITERATIONS, b64encode, b64decode, pbkdf2, makeLockHash, verifyPasscode, encryptNote, decryptNote
    };
});
