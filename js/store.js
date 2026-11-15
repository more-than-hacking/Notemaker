/* Notemaker — app state, persistence (localStorage `notemaker_v2`), v1 migration, task undo/redo. */
(function () {
    'use strict';
    const C = window.NotemakerCore;
    const KEY = 'notemaker_v2';
    const UI_KEY = 'notemaker_ui';
    const V1_TASKS = 'notemaker_tasks', V1_NOTES = 'notemaker_notes', V1_THEME = 'notemaker_theme';

    const NM = window.NM = window.NM || {};
    NM.C = C;
    NM.views = NM.views || {};

    const ls = {
        get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set(k, v) { localStorage.setItem(k, v); }
    };
    NM.ls = ls;

    const S = NM.state = {
        doc: null,
        today: C.localToday(),
        date: C.localToday(),
        view: 'day',
        dayTab: 'tasks',
        filter: { status: 'all', priority: 'any', tag: 'any' },
        sort: 'manual',
        unlocked: {},          // date → decrypted markdown (memory only, this session)
        passcode: null,        // notes passcode, memory only after a successful unlock
        expanded: new Set(),   // task ids with subtasks open
        migratedFromV1: false,
        loadError: null
    };

    NM.load = function () {
        const raw = ls.get(KEY);
        let doc = null;
        if (raw) {
            try { doc = C.normalizeDoc(JSON.parse(raw)); } catch (e) {
                // keep the unreadable copy aside instead of overwriting it
                try { ls.set(KEY + '_corrupt_' + Date.now(), raw); } catch (_) { /* quota */ }
                S.loadError = 'Saved data could not be read; a copy was kept and a fresh notebook started.';
            }
        }
        if (!doc) {
            const t = ls.get(V1_TASKS), n = ls.get(V1_NOTES);
            if (t || n) {
                try {
                    // v1 keys are left untouched as a backup
                    doc = C.migrateV1(JSON.parse(t || '[]'), JSON.parse(n || '[]'), { theme: ls.get(V1_THEME) });
                    S.migratedFromV1 = true;
                } catch (e) {
                    S.loadError = 'Could not migrate v1 data (' + e.message + '). Your v1 data is untouched.';
                }
            }
        }
        if (!doc) doc = C.emptyDoc();
        S.doc = doc;
        // accent colour carried over from the v1 colour themes
        const v1Theme = ls.get(V1_THEME);
        if (!ls.get('notemaker_accent') && v1Theme && v1Theme !== 'dark') try { ls.set('notemaker_accent', v1Theme); } catch (_) { /* */ }
        try {
            const ui = JSON.parse(ls.get(UI_KEY) || '{}');
            if (ui.view) S.view = ui.view;
            if (ui.dayTab) S.dayTab = ui.dayTab;
            if (ui.sort) S.sort = ui.sort;
            if (ui.filter) Object.assign(S.filter, ui.filter);
        } catch (e) { /* ignore */ }
        if (!S.loadError || S.migratedFromV1) NM.save();
    };

    let saveFailedShown = false;
    NM.save = function () {
        try {
            ls.set(KEY, JSON.stringify(S.doc));
            saveFailedShown = false;
        } catch (e) {
            if (!saveFailedShown && NM.toast) NM.toast('Could not save — browser storage is full or blocked. Export a backup!', 'error', 8000);
            saveFailedShown = true;
        }
    };
    NM.saveUi = function () {
        try { ls.set(UI_KEY, JSON.stringify({ view: S.view, dayTab: S.dayTab, sort: S.sort, filter: S.filter })); } catch (e) { /* */ }
    };

    // ---------------- task undo / redo (snapshots of doc.tasks) ----------------
    const undo = [], redo = [];
    const LIMIT = 50;
    NM.mutateTasks = function (fn) {
        undo.push(JSON.stringify(S.doc.tasks));
        if (undo.length > LIMIT) undo.shift();
        redo.length = 0;
        const r = fn();
        NM.save();
        NM.render();
        return r;
    };
    NM.undoTasks = function () {
        if (!undo.length) { NM.toast('Nothing to undo'); return; }
        redo.push(JSON.stringify(S.doc.tasks));
        S.doc.tasks = JSON.parse(undo.pop());
        NM.save(); NM.render();
    };
    NM.redoTasks = function () {
        if (!redo.length) { NM.toast('Nothing to redo'); return; }
        undo.push(JSON.stringify(S.doc.tasks));
        S.doc.tasks = JSON.parse(redo.pop());
        NM.save(); NM.render();
    };
    /** Mutations without undo (habits, settings, templates, notes metadata). */
    NM.update = function (fn) { const r = fn(); NM.save(); NM.render(); return r; };

    // ---------------- helpers ----------------
    NM.task = (id) => S.doc.tasks.find((t) => t.id === id);
    NM.dayTasks = (d) => C.tasksForDay(S.doc.tasks, d || S.date);
    NM.nextOrder = function (date) {
        let m = -1;
        for (const t of S.doc.tasks) if (t.date === date && t.order > m) m = t.order;
        return m + 1;
    };
    NM.allTags = function () {
        const set = new Set();
        for (const t of S.doc.tasks) for (const g of t.tags) set.add(g);
        return [...set].sort();
    };
    NM.setDate = function (d) {
        if (!C.isValidDate(d)) return;
        if (NM.beforeDateChange) NM.beforeDateChange(d);
        S.date = d;
        NM.render();
    };
    NM.moveDate = (n) => NM.setDate(C.addDays(S.date, n));
    NM.goToday = () => NM.setDate(S.today);
    NM.setView = function (v) {
        if (!NM.views[v]) return;
        S.view = v;
        NM.saveUi();
        NM.render();
    };
    NM.runRollover = function () {
        if (!S.doc.settings.autoRollover) return 0;
        let n = 0;
        // no undo entry: rollover is automatic
        n = C.rollover(S.doc.tasks, S.today);
        if (n) NM.save();
        return n;
    };
})();
