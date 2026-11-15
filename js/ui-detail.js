/* Notemaker — task detail drawer: edit every task field incl. recurrence, reminder, time block, pomodoros. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h;

    let openId = null, openDay = null, closeFn = null;

    NM.openDetail = function (id, day) {
        const t = NM.task(id);
        if (!t) return;
        openId = id;
        openDay = day || (C.occursOn(t, S.date) ? S.date : t.date);
        const drawer = document.getElementById('drawer');
        if (!closeFn) {
            drawer.hidden = false;
            requestAnimationFrame(() => drawer.classList.add('open'));
            // the drawer element is reused, so detach (not remove) on close
            const holder = h('div', { class: 'drawer-scrim', onclick: () => NM.closeDetail() });
            document.body.appendChild(holder);
            closeFn = NM.pushOverlay(holder, () => {
                drawer.classList.remove('open');
                setTimeout(() => { if (!closeFn) drawer.hidden = true; }, 200);
                openId = null; closeFn = null;
            });
        }
        render(true);
    };
    NM.closeDetail = function () { if (closeFn) closeFn(); };
    NM.closeDetailIf = function (id) { if (openId === id) NM.closeDetail(); };
    NM.renderDetail = function () {
        if (!openId) return;
        if (!NM.task(openId)) { NM.closeDetail(); return; }
        render(false);
    };

    const field = (label, ...kids) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), ...kids);

    function render(focusTitle) {
        const t = NM.task(openId);
        const drawer = document.getElementById('drawer');
        const active = document.activeElement && drawer.contains(document.activeElement) ? document.activeElement.dataset.f : null;
        NM.clear(drawer);
        const day = openDay;
        const mut = (fn) => NM.mutateTasks(fn);

        const title = h('input', { class: 'input title-input', value: t.title, dataset: { f: 'title' }, 'aria-label': 'Title',
            onchange: (e) => { const v = e.target.value.trim(); if (v && v !== t.title) mut(() => { t.title = v; }); },
            onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });

        const doneBox = h('input', { type: 'checkbox', checked: C.isDoneOn(t, day), dataset: { f: 'done' }, onchange: () => NM.toggleTask(t.id, day) });
        const status = h('select', { class: 'select', dataset: { f: 'status' }, onchange: (e) => mut(() => C.setStatusOn(t, day, e.target.value)) },
            ['todo', 'doing', 'done'].map((s) => h('option', { value: s, selected: C.statusOn(t, day) === s }, { todo: 'To do', doing: 'Doing', done: 'Done' }[s])));

        const dateIn = h('input', { type: 'date', class: 'input', value: t.date, dataset: { f: 'date' },
            onchange: (e) => { const v = e.target.value; if (!C.isValidDate(v) || v === t.date) return; mut(() => { if (t.recurrence) t.date = v; else C.snooze(t, v); }); openDay = t.recurrence ? openDay : v; } });
        const snoozeBtns = t.recurrence ? null : h('div', { class: 'chip-row' },
            [['Today', S.today], ['Tomorrow', C.addDays(S.today, 1)], ['Next week', C.addDays(S.today, 8 - C.weekday(S.today))]].map(([l, d]) =>
                h('button', { class: 'chip-btn', type: 'button', onclick: () => { mut(() => C.snooze(t, d)); openDay = d; } }, l)));

        const prio = h('div', { class: 'seg' }, C.PRIORITIES.map((p) => h('button', {
            class: 'seg-btn' + (t.priority === p ? ' active' : '') + ' prio-' + p, type: 'button', dataset: { f: 'prio-' + p },
            onclick: () => mut(() => { t.priority = p; })
        }, p === 'none' ? 'None' : p[0].toUpperCase() + p.slice(1))));

        const tags = h('input', { class: 'input', value: t.tags.join(' '), placeholder: 'work home …', dataset: { f: 'tags' },
            onchange: (e) => mut(() => { t.tags = C.normalizeTask({ tags: e.target.value.split(/[\s,]+/) }).tags; }) });

        const reminder = h('div', { class: 'inline' },
            h('input', { type: 'time', class: 'input', value: t.reminder || '', dataset: { f: 'reminder' },
                onchange: (e) => mut(() => { t.reminder = C.isValidTime(e.target.value) ? e.target.value : null; }) }),
            t.reminder ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => mut(() => { t.reminder = null; }) }, 'Clear') : null);

        // recurrence editor
        const r = t.recurrence;
        const freq = h('select', { class: 'select', dataset: { f: 'freq' }, onchange: (e) => {
            const f = e.target.value;
            mut(() => {
                if (!f) { t.recurrence = null; t.doneDates = {}; t.skipDates = {}; t.date = day; return; }
                const wasRecurring = !!t.recurrence;
                t.recurrence = C.normRecurrence({ freq: f, interval: r ? r.interval : 1, byWeekday: f === 'weekly' ? (r && r.byWeekday.length ? r.byWeekday : [C.weekday(t.date)]) : [], until: r ? r.until : null });
                if (!wasRecurring) { if (t.done) t.doneDates[t.date] = true; t.done = false; t.completedAt = null; t.rolledFrom = null; if (t.status === 'done') t.status = 'todo'; }
            });
        } }, [['', 'Does not repeat'], ['daily', 'Daily'], ['weekdays', 'Every weekday (Mon–Fri)'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].map(([v, l]) =>
            h('option', { value: v, selected: (r ? r.freq : '') === v }, l)));
        let recBody = null;
        if (r) {
            const setR = (patch) => mut(() => { t.recurrence = C.normRecurrence(Object.assign({}, t.recurrence, patch)); });
            recBody = h('div', { class: 'rec-body' },
                r.freq !== 'weekdays' ? h('div', { class: 'inline' }, 'Every',
                    h('input', { type: 'number', min: 1, max: 99, class: 'input num', value: r.interval, dataset: { f: 'interval' }, onchange: (e) => setR({ interval: e.target.value }) }),
                    { daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)' }[r.freq]) : null,
                r.freq === 'weekly' ? h('div', { class: 'wd-pick' }, [1, 2, 3, 4, 5, 6, 7].map((n) => h('button', {
                    type: 'button', class: 'wd-btn' + ((r.byWeekday.length ? r.byWeekday : [C.weekday(t.date)]).includes(n) ? ' active' : ''), dataset: { f: 'wd' + n },
                    onclick: () => { const cur = r.byWeekday.length ? r.byWeekday.slice() : [C.weekday(t.date)]; const i = cur.indexOf(n); if (i >= 0) { if (cur.length > 1) cur.splice(i, 1); } else cur.push(n); setR({ byWeekday: cur }); }
                }, C.WEEKDAY_NAMES[n - 1].slice(0, 2)))) : null,
                h('div', { class: 'inline' }, 'Until',
                    h('input', { type: 'date', class: 'input', value: r.until || '', dataset: { f: 'until' }, onchange: (e) => setR({ until: e.target.value || null }) }),
                    r.until ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => setR({ until: null }) }, 'Forever') : null),
                h('p', { class: 'muted small' }, 'Series starts ' + NM.shortDate(t.date) + '. ' + Object.keys(t.doneDates).length + ' done, ' + Object.keys(t.skipDates).length + ' skipped.' +
                    (Object.keys(t.skipDates).length ? '' : '')),
                Object.keys(t.skipDates).length ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => mut(() => { t.skipDates = {}; }) }, 'Restore skipped occurrences') : null);
        }

        const tb = t.timeBlock;
        const timeBlock = h('div', { class: 'inline' },
            h('input', { type: 'time', class: 'input', value: tb ? tb.start : '', step: 900, dataset: { f: 'tbs' }, onchange: (e) => {
                const s = e.target.value; if (!C.isValidTime(s)) return;
                const len = tb ? C.timeToMin(tb.end) - C.timeToMin(tb.start) : 30;
                mut(() => { t.timeBlock = { start: s, end: C.minToTime(Math.min(C.timeToMin(s) + len, 24 * 60 - 1)) }; });
            } }), '–',
            h('input', { type: 'time', class: 'input', value: tb ? tb.end : '', step: 900, disabled: !tb, dataset: { f: 'tbe' }, onchange: (e) => {
                const v = e.target.value; if (!C.isValidTime(v) || !tb || v <= tb.start) return; mut(() => { t.timeBlock = { start: tb.start, end: v }; });
            } }),
            tb ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => mut(() => { t.timeBlock = null; }) }, 'Remove') : null);

        const pomo = h('div', { class: 'inline' },
            h('span', { class: 'pomo-count' }, '🍅 ' + t.pomodoros.done + ' done'), ' · estimate',
            h('input', { type: 'number', min: 0, max: 99, class: 'input num', value: t.pomodoros.estimate, dataset: { f: 'est' },
                onchange: (e) => mut(() => { t.pomodoros.estimate = Math.max(0, Math.min(99, parseInt(e.target.value, 10) || 0)); }) }),
            h('button', { class: 'btn primary small', type: 'button', onclick: () => NM.focus.start(t.id) }, NM.icon('play'), ' Focus'));

        const subInput = h('input', { class: 'input', placeholder: 'Add subtask…', dataset: { f: 'sub' }, onkeydown: (e) => {
            if (e.key === 'Enter' && e.target.value.trim()) { const v = e.target.value.trim(); mut(() => t.subtasks.push({ id: C.uuid(), title: v, done: false })); setTimeout(() => { const el = document.querySelector('#drawer [data-f="sub"]'); if (el) el.focus(); }, 0); }
        } });
        const subs = h('div', { class: 'detail-subs' }, t.subtasks.map((s) => h('div', { class: 'detail-sub' + (s.done ? ' completed' : '') },
            h('input', { type: 'checkbox', checked: s.done, onchange: () => mut(() => { s.done = !s.done; }) }),
            h('input', { class: 'input bare', value: s.title, onchange: (e) => { const v = e.target.value.trim(); if (v) mut(() => { s.title = v; }); } }),
            NM.iconBtn('x', 'Delete subtask', () => mut(() => { t.subtasks = t.subtasks.filter((x) => x.id !== s.id); })))), subInput);

        const notes = h('textarea', { class: 'input', rows: 3, placeholder: 'Notes…', dataset: { f: 'notes' }, onchange: (e) => mut(() => { t.notes = e.target.value; }) });
        notes.value = t.notes;

        drawer.appendChild(h('div', { class: 'drawer-head' },
            h('label', { class: 'done-toggle', title: 'Done on ' + day }, doneBox, h('span', null, 'Done')),
            h('span', { class: 'drawer-day muted' }, t.recurrence ? 'Occurrence: ' + NM.shortDate(day) : ''),
            NM.iconBtn('x', 'Close (Esc)', NM.closeDetail)));
        drawer.appendChild(h('div', { class: 'drawer-body' },
            title,
            C.overdueDays(t, S.today) > 0 ? h('div', { class: 'badge overdue big' }, 'Overdue ' + C.overdueDays(t, S.today) + ' day(s) — from ' + NM.shortDate(t.rolledFrom || t.date)) : null,
            h('div', { class: 'grid2' }, field('Status', status), field(t.recurrence ? 'Series start' : 'Date', dateIn)),
            snoozeBtns ? field('Snooze to', snoozeBtns) : null,
            field('Priority', prio),
            field('Tags', tags),
            field('Reminder', reminder),
            field('Repeat', freq, recBody),
            field('Time block (planner)', timeBlock),
            field('Pomodoros', pomo),
            field('Subtasks', subs),
            field('Notes', notes),
            h('div', { class: 'drawer-foot' },
                h('span', { class: 'muted small' }, 'Created ' + new Date(t.createdAt).toLocaleString()),
                h('button', { class: 'btn danger small', type: 'button', onclick: () => NM.deleteTask(t.id, day) }, NM.icon('trash'), ' Delete'))));
        if (focusTitle) setTimeout(() => title.focus(), 50);
        else if (active) { const el = drawer.querySelector('[data-f="' + active + '"]'); if (el) el.focus(); }
    }
})();
