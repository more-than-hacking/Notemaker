/* Notemaker — Time-blocking planner: 30-min rows between dayStart and dayEnd, drag tasks onto slots,
   drag blocks to move, drag the bottom edge to resize, current-time line. Tap-to-place fallback for touch. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h;
    const ROW = 36;              // px per 30 minutes
    const PPM = ROW / 30;        // px per minute
    const SNAP = 15;             // minutes
    let armed = null;            // task id selected for tap-to-place
    let lineTimer = null;

    const tm = C.timeToMin;
    function layout(blocks) {
        // assign side-by-side columns to overlapping blocks
        blocks.sort((a, b) => a.s - b.s || b.e - a.e);
        let cluster = [], clusterEnd = -1;
        const flush = () => { const cols = Math.max(...cluster.map((b) => b.col)) + 1; cluster.forEach((b) => { b.cols = cols; }); cluster = []; };
        for (const b of blocks) {
            if (cluster.length && b.s >= clusterEnd) flush();
            const used = cluster.filter((x) => x.e > b.s).map((x) => x.col);
            let c = 0;
            while (used.includes(c)) c++;
            b.col = c;
            cluster.push(b);
            clusterEnd = Math.max(clusterEnd, b.e);
        }
        if (cluster.length) flush();
        return blocks;
    }

    function schedule(id, startMin) {
        const t = NM.task(id);
        if (!t) return;
        const len = t.timeBlock ? tm(t.timeBlock.end) - tm(t.timeBlock.start) : 30;
        const s = Math.max(0, Math.min(startMin, 24 * 60 - 15));
        NM.mutateTasks(() => { t.timeBlock = { start: C.minToTime(s), end: C.minToTime(Math.min(s + len, 24 * 60 - 1)) }; });
    }

    function render() {
        const root = document.getElementById('view-planner');
        NM.clear(root);
        const st = S.doc.settings;
        const dayS = tm(st.dayStart), dayE = Math.max(tm(st.dayEnd), dayS + 60);
        const rows = Math.ceil((dayE - dayS) / 30);
        const tasks = C.sortTasks(NM.dayTasks(), S.sort);
        const unscheduled = tasks.filter((t) => !t.timeBlock);
        const scheduled = tasks.filter((t) => t.timeBlock);

        // side list
        const side = h('div', { class: 'planner-side card' },
            h('h3', null, 'Unscheduled'),
            h('p', { class: 'muted small' }, 'Drag a task onto the timeline (or tap it, then tap a slot).'),
            unscheduled.length ? null : h('p', { class: 'muted small empty-side' }, 'Everything is planned 🎉'),
            unscheduled.map((t) => {
                const done = C.isDoneOn(t, S.date);
                const el = h('div', {
                    class: 'plan-item' + (done ? ' completed' : '') + (armed === t.id ? ' armed' : '') + ' prio-edge-' + t.priority, draggable: 'true', tabindex: 0,
                    onclick: () => { armed = armed === t.id ? null : t.id; render(); },
                    onkeydown: (e) => { if (e.key === 'Enter') { armed = t.id; render(); } }
                }, h('span', { class: 'plan-title' }, t.title), NM.priorityBadge(t.priority));
                el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-task-id', t.id); e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; });
                return el;
            }),
            scheduled.some((t) => tm(t.timeBlock.end) <= dayS || tm(t.timeBlock.start) >= dayE)
                ? h('p', { class: 'muted small' }, 'Some blocks are outside ' + st.dayStart + '–' + st.dayEnd + ' (change hours in Settings).') : null);

        // timeline
        const grid = h('div', { class: 'timeline', style: { height: rows * ROW + 'px' } });
        for (let i = 0; i < rows; i++) {
            const min = dayS + i * 30;
            const slot = h('div', { class: 'slot' + (min % 60 === 0 ? ' hour' : ''), style: { top: i * ROW + 'px', height: ROW + 'px' }, dataset: { min: String(min) },
                onclick: () => { if (armed) { const id = armed; armed = null; schedule(id, min); } } },
            h('span', { class: 'slot-label' }, min % 60 === 0 ? C.minToTime(min) : ''));
            slot.addEventListener('dragover', (e) => { e.preventDefault(); slot.classList.add('drop'); });
            slot.addEventListener('dragleave', () => slot.classList.remove('drop'));
            slot.addEventListener('drop', (e) => {
                e.preventDefault(); slot.classList.remove('drop');
                const id = e.dataTransfer.getData('text/x-task-id') || e.dataTransfer.getData('text/plain');
                // dropping a moved block keeps the grab offset
                const off = +(e.dataTransfer.getData('text/x-offset') || 0);
                const rect = slot.getBoundingClientRect();
                let m = min + Math.round(((e.clientY - rect.top) / PPM - off) / SNAP) * SNAP;
                if (!off) m = min;
                if (id) schedule(id, m);
            });
            grid.appendChild(slot);
        }
        const blocks = layout(scheduled.map((t) => ({ t, s: tm(t.timeBlock.start), e: tm(t.timeBlock.end) })));
        const lane = h('div', { class: 'lane' });
        for (const b of blocks) {
            const t = b.t;
            if (b.e <= dayS || b.s >= dayE) continue;
            const top = (Math.max(b.s, dayS) - dayS) * PPM;
            const height = Math.max(18, (Math.min(b.e, dayE) - Math.max(b.s, dayS)) * PPM - 2);
            const done = C.isDoneOn(t, S.date);
            const block = h('div', {
                class: 'block' + (done ? ' completed' : '') + ' prio-' + t.priority, draggable: 'true',
                style: { top: top + 'px', height: height + 'px', left: 'calc(' + (b.col / b.cols * 100) + '% + 2px)', width: 'calc(' + (100 / b.cols) + '% - 4px)', '--tag-h': String(t.tags.length ? C.tagHue(t.tags[0]) : 265) },
                title: t.title + ' ' + t.timeBlock.start + '–' + t.timeBlock.end,
                ondblclick: () => NM.openDetail(t.id, S.date)
            },
            h('div', { class: 'block-head' },
                h('button', { class: 'block-check' + (done ? ' checked' : ''), type: 'button', 'aria-label': 'Toggle done', onclick: (e) => { e.stopPropagation(); NM.toggleTask(t.id, S.date); } }),
                h('span', { class: 'block-title' }, t.title),
                h('button', { class: 'block-x', type: 'button', title: 'Remove from planner', 'aria-label': 'Remove from planner', onclick: (e) => { e.stopPropagation(); NM.mutateTasks(() => { t.timeBlock = null; }); } }, '×')),
            h('span', { class: 'block-time' }, t.timeBlock.start + '–' + t.timeBlock.end));
            block.addEventListener('dragstart', (e) => {
                const r = block.getBoundingClientRect();
                e.dataTransfer.setData('text/x-task-id', t.id);
                e.dataTransfer.setData('text/plain', t.id);
                e.dataTransfer.setData('text/x-offset', String(Math.round((e.clientY - r.top) / PPM)));
                e.dataTransfer.effectAllowed = 'move';
            });
            const handle = h('div', { class: 'resize', title: 'Drag to resize' });
            handle.addEventListener('pointerdown', (e) => startResize(e, t, block, b.s));
            handle.addEventListener('mousedown', (e) => e.stopPropagation());
            block.appendChild(handle);
            lane.appendChild(block);
        }
        grid.appendChild(lane);
        const nowLine = h('div', { class: 'now-line', hidden: true }, h('span', { class: 'now-dot' }));
        grid.appendChild(nowLine);
        const placeNow = () => {
            const d = new Date();
            const n = d.getHours() * 60 + d.getMinutes();
            const show = S.date === C.localToday() && n >= dayS && n <= dayE;
            nowLine.hidden = !show;
            if (show) nowLine.style.top = (n - dayS) * PPM + 'px';
        };
        placeNow();
        clearInterval(lineTimer);
        lineTimer = setInterval(() => { if (!document.contains(nowLine)) { clearInterval(lineTimer); return; } placeNow(); }, 30000);

        root.appendChild(h('div', { class: 'view-head' },
            h('div', null, h('h2', null, 'Plan your day'), h('p', { class: 'muted small' }, st.dayStart + '–' + st.dayEnd + ' · 30-minute slots · ' + scheduled.length + ' planned')),
            armed ? h('div', { class: 'armed-hint' }, 'Tap a slot to place “' + (NM.task(armed) || {}).title + '”', h('button', { class: 'btn ghost small', type: 'button', onclick: () => { armed = null; render(); } }, 'Cancel')) : null));
        root.appendChild(h('div', { class: 'planner' }, side, h('div', { class: 'timeline-wrap card' }, grid)));
        if (S.date === C.localToday()) {
            const d = new Date();
            const n = d.getHours() * 60 + d.getMinutes();
            const wrap = root.querySelector('.timeline-wrap');
            if (n > dayS && wrap && !render.scrolled) { wrap.scrollTop = Math.max(0, (n - dayS) * PPM - 120); render.scrolled = true; }
        }
    }

    function startResize(e, t, block, startMin) {
        e.preventDefault();
        e.stopPropagation();
        const y0 = e.clientY, h0 = block.getBoundingClientRect().height;
        block.draggable = false;
        const timeEl = block.querySelector('.block-time');
        let endMin = tm(t.timeBlock.end);
        const move = (ev) => {
            const hNew = Math.max(SNAP * PPM, h0 + (ev.clientY - y0));
            endMin = Math.min(24 * 60 - 1, startMin + Math.max(SNAP, Math.round(hNew / PPM / SNAP) * SNAP));
            block.style.height = ((endMin - startMin) * PPM - 2) + 'px';
            timeEl.textContent = t.timeBlock.start + '–' + C.minToTime(endMin);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            if (endMin !== tm(t.timeBlock.end)) NM.mutateTasks(() => { t.timeBlock = { start: t.timeBlock.start, end: C.minToTime(endMin) }; });
            else block.draggable = true;
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    NM.views.planner = {
        title: () => 'Planner',
        subtitle: () => C.fullDate(S.date),
        render
    };
})();
