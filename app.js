/* Notemaker v2 (web) — bootstrap: rendering loop, navigation, keyboard shortcuts, PWA registration.
   Logic lives in js/core.js (pure) and js/ui-*.js (views). Data format: docs/DATA_FORMAT.md. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, $ = NM.$, $$ = NM.$$;
    const VIEWS = ['day', 'calendar', 'planner', 'board', 'habits', 'insights', 'settings'];
    const DATE_VIEWS = new Set(['day', 'planner', 'board', 'calendar']);

    // ---------------- render ----------------
    let rendering = false;
    NM.render = function () {
        if (rendering) return; // re-entrancy guard (render → update → render)
        rendering = true;
        try {
            if (!NM.views[S.view]) S.view = 'day';
            const v = NM.views[S.view];
            $$('.view-btn').forEach((b) => { const on = b.dataset.view === S.view; b.classList.toggle('active', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
            $$('.view').forEach((sec) => { sec.hidden = sec.dataset.view !== S.view; });
            $('#viewTitle').textContent = v.title();
            $('#viewSubtitle').textContent = v.subtitle ? v.subtitle() : '';
            $('#datePicker').value = S.date;
            document.body.dataset.view = S.view;
            document.body.classList.toggle('date-view', DATE_VIEWS.has(S.view));
            NM.renderStats();
            v.render();
            if (NM.renderDetail) NM.renderDetail();
        } catch (e) {
            console.error('Notemaker render error', e);
        } finally {
            rendering = false;
        }
    };

    // ---------------- init ----------------
    function hydrateIcons(root) {
        $$('.vi[data-icon]', root).forEach((el) => { if (!el.firstChild) el.appendChild(NM.icon(el.dataset.icon)); });
    }
    function closeSidebar() { document.body.classList.remove('sidebar-open'); }

    function bind() {
        $$('.view-btn').forEach((b) => b.addEventListener('click', () => { NM.setView(b.dataset.view); closeSidebar(); }));
        $('#datePicker').addEventListener('change', (e) => { if (C.isValidDate(e.target.value)) NM.setDate(e.target.value); });
        $('#prevDay').addEventListener('click', () => NM.moveDate(-1));
        $('#nextDay').addEventListener('click', () => NM.moveDate(1));
        $('#todayBtn').addEventListener('click', NM.goToday);
        $('#topPrev').addEventListener('click', () => NM.moveDate(-1));
        $('#topNext').addEventListener('click', () => NM.moveDate(1));
        $('#topToday').addEventListener('click', NM.goToday);
        $('#topSearch').addEventListener('click', NM.openSearch);
        $('#themeToggle').addEventListener('click', NM.toggleTheme);
        $('#searchBtn').addEventListener('click', () => { closeSidebar(); NM.openSearch(); });
        $('#paletteBtn').addEventListener('click', () => { closeSidebar(); NM.openPalette(); });
        $('#reviewBtn').addEventListener('click', () => { closeSidebar(); NM.openReview(S.date); });
        $('#focusBtn').addEventListener('click', () => {
            closeSidebar();
            const f = NM.focus.state();
            if (f.running) NM.focus.togglePause(); else NM.focus.start(null);
        });
        $('#exportBtn').addEventListener('click', NM.exportJson);
        $('#importBtn').addEventListener('click', () => $('#importFile').click());
        $('#importFile').addEventListener('change', (e) => { NM.importFile(e.target.files[0]); e.target.value = ''; });
        $('#helpBtn').addEventListener('click', () => { closeSidebar(); NM.openHelp(); });
        $('#menuBtn').addEventListener('click', () => document.body.classList.add('sidebar-open'));
        $('#sidebarClose').addEventListener('click', closeSidebar);
        $('#sidebarScrim').addEventListener('click', closeSidebar);
        if (window.matchMedia) {
            const mq = matchMedia('(prefers-color-scheme: dark)');
            const onChange = () => { if (S.doc.settings.theme === 'system') NM.applyTheme(); };
            if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
        }
        // keep the app in sync when another tab changes the data
        window.addEventListener('storage', (e) => {
            if (e.key !== 'notemaker_v2' || !e.newValue) return;
            if (NM.notes && NM.notes.isEditing()) return;
            try { S.doc = C.normalizeDoc(JSON.parse(e.newValue)); NM.applyTheme(); NM.render(); } catch (err) { /* ignore */ }
        });
    }

    // ---------------- keyboard ----------------
    function onKey(e) {
        const mod = e.metaKey || e.ctrlKey;
        const k = (e.key || '').toLowerCase();
        if (mod && !e.altKey && k === 'k') { e.preventDefault(); while (NM.closeTopOverlay()) { /* close all */ } NM.openPalette(); return; }
        if (mod && !e.altKey && k === 'f') { e.preventDefault(); while (NM.closeTopOverlay()) { /* */ } NM.openSearch(); return; }
        if (e.key === 'Escape') {
            if (NM.closeTopOverlay()) { e.preventDefault(); return; }
            if (document.body.classList.contains('sidebar-open')) { closeSidebar(); return; }
            if (NM.isTyping(e)) e.target.blur();
            return;
        }
        if (e.defaultPrevented) return;
        const typing = NM.isTyping(e);
        if (mod && k === 'z' && !typing && !NM.overlayOpen()) {
            e.preventDefault();
            if (e.shiftKey) NM.redoTasks(); else NM.undoTasks();
            return;
        }
        if (mod && k === 'y' && !typing && !NM.overlayOpen()) { e.preventDefault(); NM.redoTasks(); return; }
        if (typing || mod || e.altKey || NM.overlayOpen()) return;
        switch (e.key) {
            case 'n': case 'N': e.preventDefault(); NM.focusQuickAdd(); break;
            case '/': e.preventDefault(); NM.openSearch(); break;
            case 'ArrowLeft': e.preventDefault(); NM.moveDate(-1); break;
            case 'ArrowRight': e.preventDefault(); NM.moveDate(1); break;
            case 't': case 'T': e.preventDefault(); NM.goToday(); break;
            case '?': e.preventDefault(); NM.openHelp(); break;
            default:
                if (/^[1-7]$/.test(e.key)) { e.preventDefault(); NM.setView(VIEWS[+e.key - 1]); }
        }
    }

    // ---------------- PWA ----------------
    function registerServiceWorker() {
        // only over http(s); file:// pages keep working without it
        if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker registration failed', err));
        });
    }

    function start() {
        NM.load();
        S.today = C.localToday();
        S.date = S.today;
        const rolled = NM.runRollover();
        hydrateIcons(document);
        NM.applyTheme();
        NM.views.day.init();
        NM.notesInit();
        bind();
        document.addEventListener('keydown', onKey);
        NM.render();
        NM.focus.restore();
        NM.startScheduler();
        if (S.migratedFromV1) NM.toast('Upgraded to Notemaker v2 — your v1 tasks and notes were migrated (the v1 copy is kept as a backup).', 'ok', 8000);
        if (S.loadError) NM.toast(S.loadError, 'error', 10000);
        if (rolled) NM.toast(rolled + ' unfinished task(s) rolled over to today', '', 5000);
    }

    registerServiceWorker();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
