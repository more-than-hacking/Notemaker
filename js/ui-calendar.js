/* Notemaker — Calendar month view: completion heatmap per day, note dots, today highlight. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h;
    let month = null;     // 'YYYY-MM-01' being shown
    let seenDate = null;  // month follows the selected date only when the date changes

    function level(r) {
        if (!r.total) return -1;
        const p = r.done / r.total;
        return p === 0 ? 0 : p < 0.34 ? 1 : p < 0.67 ? 2 : p < 1 ? 3 : 4;
    }

    function render() {
        const root = document.getElementById('view-calendar');
        if (!month || seenDate !== S.date) { month = S.date.slice(0, 8) + '01'; seenDate = S.date; }
        const [y, m] = month.split('-').map(Number);
        const ws = C.normalizeWeekStart(S.doc.settings.weekStartsOn);
        const gridStart = C.startOfWeek(month, ws);
        const last = y + '-' + C.pad2(m) + '-' + C.pad2(C.daysInMonth(y, m));
        const weeks = Math.ceil((C.diffDays(gridStart, last) + 1) / 7);
        const gridEnd = C.addDays(gridStart, weeks * 7 - 1);
        const ratios = C.rangeRatios(S.doc.tasks, gridStart, gridEnd);
        NM.clear(root);

        const go = (n) => { month = C.addMonths(month, n); render(); };
        root.appendChild(h('div', { class: 'view-head' },
            h('div', { class: 'inline' },
                NM.iconBtn('left', 'Previous month', () => go(-1)),
                h('h2', { class: 'month-title' }, C.monthLabel(y, m)),
                NM.iconBtn('right', 'Next month', () => go(1)),
                h('button', { class: 'btn small', type: 'button', onclick: () => { month = S.today.slice(0, 8) + '01'; render(); } }, 'This month')),
            h('div', { class: 'legend' }, h('span', { class: 'muted small' }, 'Completion'),
                [0, 1, 2, 3, 4].map((l) => h('span', { class: 'heat-swatch heat-' + l, title: ['none done', '<⅓', '<⅔', 'most', 'all done'][l] })),
                h('span', { class: 'cal-dot legend-dot' }), h('span', { class: 'muted small' }, 'note'))));

        const grid = h('div', { class: 'cal-grid', role: 'grid' });
        for (let i = 0; i < 7; i++) grid.appendChild(h('div', { class: 'cal-wd', role: 'columnheader' }, C.WEEKDAY_NAMES[((ws - 1 + i) % 7)].slice(0, 3)));
        for (let i = 0; i < weeks * 7; i++) {
            const d = C.addDays(gridStart, i);
            const r = ratios[d];
            const lv = level(r);
            const n = S.doc.notes[d];
            const inMonth = d.slice(0, 7) === month.slice(0, 7);
            const cls = ['cal-cell', lv >= 0 ? 'heat-' + lv : 'heat-empty', inMonth ? '' : 'out', d === S.today ? 'today' : '', d === S.date ? 'selected' : ''].join(' ');
            grid.appendChild(h('button', {
                class: cls, type: 'button', role: 'gridcell',
                title: NM.shortDate(d) + (r.total ? ' — ' + r.done + '/' + r.total + ' done' : '') + (n ? (n.locked ? ' · private note' : ' · note') : ''),
                onclick: () => { NM.setDate(d); NM.setView('day'); }
            },
            h('span', { class: 'cal-num' }, String(+d.slice(8))),
            r.total ? h('span', { class: 'cal-count' }, r.done + '/' + r.total) : null,
            n ? h('span', { class: 'cal-dot' + (n.locked ? ' locked' : ''), 'aria-label': 'has note' }) : null));
        }
        root.appendChild(grid);

        // month summary
        let tot = 0, dn = 0, noteDays = 0;
        for (let d = month; d <= last; d = C.addDays(d, 1)) { tot += ratios[d].total; dn += ratios[d].done; if (S.doc.notes[d]) noteDays++; }
        root.appendChild(h('p', { class: 'muted cal-summary' }, dn + ' of ' + tot + ' tasks completed this month (' + (tot ? Math.round(dn / tot * 100) : 0) + '%) · ' + noteDays + ' day(s) with notes'));
    }

    NM.views.calendar = {
        title: () => 'Calendar',
        subtitle: () => 'Click a day to open it',
        render
    };
})();
