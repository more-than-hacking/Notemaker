/* Notemaker — Habit tracker: create/edit/delete, check off today, last 7 days, streak (spec rule). */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h;
    const SWATCHES = ['#8B5CF6', '#EC4899', '#EF4444', '#F97316', '#F59E0B', '#10B981', '#14B8A6', '#0EA5E9', '#6366F1', '#64748B'];

    function editHabit(habit) {
        const isNew = !habit;
        const draft = habit ? JSON.parse(JSON.stringify(habit)) : C.normalizeHabit({ name: '', color: SWATCHES[0], days: [] });
        const name = h('input', { class: 'input', value: isNew ? '' : draft.name, placeholder: 'e.g. Meditate 10 minutes', autofocus: true, maxlength: 200 });
        const colorIn = h('input', { type: 'color', class: 'color-input', value: draft.color.toLowerCase(), 'aria-label': 'Custom colour' });
        const swatchRow = h('div', { class: 'swatches' });
        const drawSwatches = () => {
            NM.clear(swatchRow);
            SWATCHES.forEach((c) => swatchRow.appendChild(h('button', { type: 'button', class: 'swatch' + (draft.color.toUpperCase() === c ? ' active' : ''), style: { background: c }, 'aria-label': c,
                onclick: () => { draft.color = c; colorIn.value = c.toLowerCase(); drawSwatches(); } })));
            swatchRow.appendChild(colorIn);
        };
        colorIn.addEventListener('input', () => { draft.color = colorIn.value.toUpperCase(); drawSwatches(); });
        drawSwatches();
        const days = h('div', { class: 'wd-pick' });
        const drawDays = () => {
            NM.clear(days);
            [1, 2, 3, 4, 5, 6, 7].forEach((n) => days.appendChild(h('button', { type: 'button', class: 'wd-btn' + (draft.days.includes(n) ? ' active' : ''),
                onclick: () => { const i = draft.days.indexOf(n); if (i >= 0) draft.days.splice(i, 1); else draft.days.push(n); draft.days.sort(); drawDays(); } }, C.WEEKDAY_NAMES[n - 1].slice(0, 2))));
        };
        drawDays();
        NM.modal({
            title: isNew ? 'New habit' : 'Edit habit',
            body: h('div', { class: 'form' },
                h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
                h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Colour'), swatchRow),
                h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Scheduled days'), days, h('small', { class: 'muted' }, 'None selected = every day.'))),
            actions: [
                isNew ? null : { label: 'Delete', kind: 'danger left', onClick: async () => {
                    if (await NM.confirm('Delete habit “' + habit.name + '” and its history?', 'Delete', true)) NM.update(() => { S.doc.habits = S.doc.habits.filter((x) => x.id !== habit.id); });
                } },
                { label: 'Cancel' },
                { label: isNew ? 'Create' : 'Save', kind: 'primary', onClick: () => {
                    const n = name.value.trim();
                    if (!n) { name.focus(); NM.toast('Give the habit a name', 'error'); return false; }
                    draft.name = n;
                    const clean = C.normalizeHabit(draft);
                    NM.update(() => {
                        if (isNew) S.doc.habits.push(clean);
                        else { const i = S.doc.habits.findIndex((x) => x.id === habit.id); if (i >= 0) S.doc.habits[i] = clean; }
                    });
                } }
            ].filter(Boolean)
        });
    }
    NM.newHabit = () => editHabit(null);

    function toggle(habit, d) {
        NM.update(() => { if (habit.log[d]) delete habit.log[d]; else habit.log[d] = true; });
    }

    function render() {
        const root = document.getElementById('view-habits');
        NM.clear(root);
        const today = S.today;
        const last7 = [6, 5, 4, 3, 2, 1, 0].map((i) => C.addDays(today, -i));
        root.appendChild(h('div', { class: 'view-head' },
            h('div', null, h('h2', null, 'Habits'), h('p', { class: 'muted small' }, 'Build streaks on the days that matter. Streak = consecutive scheduled days, ending today (or yesterday if today isn’t checked yet).')),
            h('button', { class: 'btn primary', type: 'button', onclick: () => editHabit(null) }, NM.icon('plus'), ' New habit')));
        if (!S.doc.habits.length) {
            root.appendChild(h('div', { class: 'empty-state' }, h('div', { class: 'empty-icon' }, '🌱'), h('p', null, 'No habits yet'),
                h('button', { class: 'btn primary', type: 'button', onclick: () => editHabit(null) }, 'Create your first habit')));
            return;
        }
        const list = h('div', { class: 'habit-list' });
        list.appendChild(h('div', { class: 'habit-row habit-header' }, h('span'), h('span'),
            h('div', { class: 'habit-days' }, last7.map((d) => h('span', { class: 'hd-label' + (d === today ? ' today' : '') }, C.WEEKDAY_NAMES[C.weekday(d) - 1].slice(0, 2), h('small', null, String(+d.slice(8)))))),
            h('span', { class: 'muted small' }, 'Streak'), h('span')));
        for (const hb of S.doc.habits) {
            const streak = C.habitStreak(hb, today);
            const sched = C.habitScheduledOn(hb, today);
            const doneToday = !!hb.log[today];
            list.appendChild(h('div', { class: 'habit-row', style: { '--hc': hb.color } },
                h('button', { class: 'habit-check' + (doneToday ? ' checked' : ''), type: 'button', 'aria-pressed': String(doneToday),
                    title: doneToday ? 'Undo today' : 'Check off today', onclick: () => toggle(hb, today) }, doneToday ? '✓' : ''),
                h('div', { class: 'habit-info' },
                    h('span', { class: 'habit-name' }, hb.name),
                    h('span', { class: 'muted small' }, hb.days.length ? hb.days.map((n) => C.WEEKDAY_NAMES[n - 1].slice(0, 3)).join(' · ') : 'Every day', sched ? '' : ' · not scheduled today')),
                h('div', { class: 'habit-days' }, last7.map((d) => h('button', {
                    type: 'button', class: 'hd' + (hb.log[d] ? ' on' : '') + (C.habitScheduledOn(hb, d) ? '' : ' off') + (d === today ? ' today' : ''),
                    title: NM.shortDate(d) + (hb.log[d] ? ' — done' : ''), 'aria-label': NM.shortDate(d) + (hb.log[d] ? ' done' : ' not done'),
                    onclick: () => toggle(hb, d)
                }))),
                h('span', { class: 'habit-streak' + (streak ? ' hot' : '') }, (streak ? '🔥 ' : '') + streak),
                NM.iconBtn('edit', 'Edit habit', () => editHabit(hb))));
        }
        root.appendChild(list);
    }

    NM.views.habits = { title: () => 'Habits', subtitle: () => C.fullDate(S.today), render };
})();
