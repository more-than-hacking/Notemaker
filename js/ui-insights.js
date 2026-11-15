/* Notemaker — Insights: 365-day contribution heatmap, streaks, 7-day bars, focus minutes, completion rate, top tags.
   Hand-drawn SVG/CSS. All user text goes through escapeHtml / textContent. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h;
    const esc = C.escapeHtml;

    function heatLevel(n) { return n <= 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 5 ? 3 : 4; }

    function heatmapSvg(counts, today, ws) {
        const CELL = 12, GAP = 3, STEP = CELL + GAP, LEFT = 28, TOP = 18;
        const start = C.startOfWeek(C.addDays(today, -364), ws);
        const weeks = Math.ceil((C.diffDays(start, today) + 1) / 7);
        const W = LEFT + weeks * STEP, H = TOP + 7 * STEP;
        let s = '<svg class="heatmap" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Tasks completed per day over the last year">';
        let lastMonth = -1;
        for (let w = 0; w < weeks; w++) {
            const wd = C.addDays(start, w * 7);
            const mo = +wd.slice(5, 7);
            if (mo !== lastMonth && +wd.slice(8) <= 7) { s += '<text x="' + (LEFT + w * STEP) + '" y="11" class="hm-label">' + C.MONTH_NAMES[mo - 1].slice(0, 3) + '</text>'; lastMonth = mo; }
            for (let r = 0; r < 7; r++) {
                const d = C.addDays(wd, r);
                if (d > today) continue;
                const n = counts[d] || 0;
                s += '<rect x="' + (LEFT + w * STEP) + '" y="' + (TOP + r * STEP) + '" width="' + CELL + '" height="' + CELL + '" rx="2.5" class="hm heat-' + heatLevel(n) + (d === today ? ' hm-today' : '') +
                    '" data-date="' + d + '"><title>' + esc(NM.shortDate(d)) + ': ' + n + ' completed</title></rect>';
            }
        }
        for (let r = 0; r < 7; r += 2) s += '<text x="0" y="' + (TOP + r * STEP + 10) + '" class="hm-label">' + C.WEEKDAY_NAMES[(ws - 1 + r) % 7].slice(0, 3) + '</text>';
        return s + '</svg>';
    }

    function barsSvg(values, labels, unit) {
        const W = 320, H = 150, PAD = 22, BW = 26;
        const max = Math.max(1, ...values);
        const step = (W - PAD * 2) / values.length;
        let s = '<svg class="bars" viewBox="0 0 ' + W + ' ' + (H + 20) + '" role="img" aria-label="' + esc(unit) + ' per day, last 7 days">';
        s += '<line x1="' + PAD + '" y1="' + H + '" x2="' + (W - PAD) + '" y2="' + H + '" class="axis"/>';
        values.forEach((v, i) => {
            const bh = Math.round((v / max) * (H - 30));
            const x = PAD + i * step + (step - BW) / 2;
            s += '<rect x="' + x + '" y="' + (H - bh) + '" width="' + BW + '" height="' + Math.max(bh, 1) + '" rx="5" class="bar' + (i === values.length - 1 ? ' bar-today' : '') + '"><title>' + esc(labels[i]) + ': ' + v + ' ' + esc(unit) + '</title></rect>';
            s += '<text x="' + (x + BW / 2) + '" y="' + (H - bh - 6) + '" class="bar-val" text-anchor="middle">' + v + '</text>';
            s += '<text x="' + (x + BW / 2) + '" y="' + (H + 15) + '" class="bar-label" text-anchor="middle">' + esc(labels[i]) + '</text>';
        });
        return s + '</svg>';
    }

    function ring(pct) {
        const R = 42, L = 2 * Math.PI * R;
        return '<svg class="ring" viewBox="0 0 100 100" role="img" aria-label="Completion rate ' + pct + '%"><circle cx="50" cy="50" r="' + R + '" class="ring-bg"/>' +
            '<circle cx="50" cy="50" r="' + R + '" class="ring-fg" stroke-dasharray="' + (L * pct / 100).toFixed(1) + ' ' + L.toFixed(1) + '" transform="rotate(-90 50 50)"/>' +
            '<text x="50" y="56" text-anchor="middle" class="ring-text">' + pct + '%</text></svg>';
    }

    function render() {
        const root = document.getElementById('view-insights');
        NM.clear(root);
        const today = S.today;
        const ws = C.normalizeWeekStart(S.doc.settings.weekStartsOn);
        const counts = C.completionsByDay(S.doc.tasks);
        const st = C.streaks(counts, today);
        const yearTotal = Object.keys(counts).filter((d) => d > C.addDays(today, -365) && d <= today).reduce((a, d) => a + counts[d], 0);
        const last7 = [6, 5, 4, 3, 2, 1, 0].map((i) => C.addDays(today, -i));
        const r30 = C.rangeRatios(S.doc.tasks, C.addDays(today, -29), today);
        let tot = 0, dn = 0;
        Object.values(r30).forEach((r) => { tot += r.total; dn += r.done; });
        const rate = tot ? Math.round(dn / tot * 100) : 0;
        const weekStart = C.startOfWeek(today, ws);
        const focusMin = C.focusMinutesBetween(S.doc.focusSessions, weekStart, today);
        const focusSessions = S.doc.focusSessions.filter((s) => s.kind === 'focus' && C.localToday(new Date(s.start)) >= weekStart).length;
        const tags = C.topTags(S.doc.tasks, 8);

        root.appendChild(h('div', { class: 'view-head' }, h('div', null, h('h2', null, 'Insights'), h('p', { class: 'muted small' }, 'A day counts toward your streak when at least one task is completed.'))));

        const kpis = h('div', { class: 'kpis' },
            kpi('🔥', st.current, 'Current streak', st.current === 1 ? 'day' : 'days'),
            kpi('🏆', st.best, 'Best streak', st.best === 1 ? 'day' : 'days'),
            kpi('✅', yearTotal, 'Completed', 'last 365 days'),
            kpi('🍅', focusMin, 'Focus minutes', 'this week · ' + focusSessions + ' session' + (focusSessions === 1 ? '' : 's')));
        root.appendChild(kpis);

        const heat = h('div', { class: 'card insight-card wide' }, h('h3', null, 'Last 365 days'),
            h('div', { class: 'heatmap-scroll', html: heatmapSvg(counts, today, ws) }),
            h('div', { class: 'legend' }, h('span', { class: 'muted small' }, 'Less'), [0, 1, 2, 3, 4].map((l) => h('span', { class: 'heat-swatch heat-' + l })), h('span', { class: 'muted small' }, 'More')));
        heat.addEventListener('click', (e) => { const d = e.target.getAttribute && e.target.getAttribute('data-date'); if (d && C.isValidDate(d)) { NM.setDate(d); NM.setView('day'); } });
        root.appendChild(heat);
        const sc = heat.querySelector('.heatmap-scroll');
        requestAnimationFrame(() => { sc.scrollLeft = sc.scrollWidth; });

        const vals = last7.map((d) => counts[d] || 0);
        const labels = last7.map((d) => C.WEEKDAY_NAMES[C.weekday(d) - 1].slice(0, 3));
        const grid = h('div', { class: 'insight-grid' },
            h('div', { class: 'card insight-card' }, h('h3', null, 'Completed per day'), h('div', { html: barsSvg(vals, labels, 'tasks') })),
            h('div', { class: 'card insight-card center' }, h('h3', null, 'Completion rate'), h('div', { html: ring(rate) }), h('p', { class: 'muted small' }, dn + ' of ' + tot + ' tasks · last 30 days')),
            h('div', { class: 'card insight-card' }, h('h3', null, 'Top tags'),
                tags.length ? h('div', { class: 'tag-bars' }, tags.map((t) => h('div', { class: 'tag-bar-row' },
                    NM.tagChip(t.tag, (tag) => { S.filter.tag = tag; NM.saveUi(); NM.setView('day'); }),
                    h('div', { class: 'tag-bar' }, h('div', { class: 'tag-bar-fill', style: { width: Math.round(t.count / tags[0].count * 100) + '%', '--tag-h': String(C.tagHue(t.tag)) } })),
                    h('span', { class: 'muted small', title: t.done + ' completed' }, String(t.count))))) : h('p', { class: 'muted small' }, 'Add #tags to tasks to see them here.')));
        root.appendChild(grid);
    }
    function kpi(icon, value, label, sub) {
        return h('div', { class: 'kpi card' }, h('span', { class: 'kpi-icon' }, icon), h('div', null, h('div', { class: 'kpi-value' }, String(value)), h('div', { class: 'kpi-label' }, label), h('div', { class: 'muted small' }, sub)));
    }

    NM.views.insights = { title: () => 'Insights', subtitle: () => 'Your progress at a glance', render };
})();
