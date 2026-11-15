/* Notemaker — Kanban board for the selected day (+ overdue tasks when viewing today). */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h;
    const COLS = [['todo', 'To do'], ['doing', 'Doing'], ['done', 'Done']];

    function boardTasks() {
        const day = S.date;
        const list = NM.dayTasks(day);
        if (day === S.today) {
            // overdue tasks that were not rolled over (auto-rollover off) still belong on today's board
            for (const t of S.doc.tasks) if (!t.recurrence && !t.done && t.date < day && !list.includes(t)) list.push(t);
        }
        return C.sortTasks(list, S.sort);
    }

    function card(t, day) {
        const done = C.isDoneOn(t, day);
        const od = C.overdueDays(t, S.today);
        const el = h('div', { class: 'kcard prio-edge-' + t.priority + (done ? ' completed' : ''), draggable: 'true', tabindex: 0, dataset: { id: t.id },
            ondblclick: () => NM.openDetail(t.id, day),
            onkeydown: (e) => {
                const i = COLS.findIndex((c) => c[0] === C.statusOn(t, day));
                if (e.key === 'ArrowRight' && i < 2) { e.preventDefault(); move(t.id, COLS[i + 1][0]); }
                if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); move(t.id, COLS[i - 1][0]); }
                if (e.key === 'Enter') NM.openDetail(t.id, day);
            } },
        h('div', { class: 'kcard-title' }, t.title),
        h('div', { class: 'task-meta' },
            NM.priorityBadge(t.priority),
            od > 0 ? h('span', { class: 'badge overdue' }, 'Overdue ' + od + 'd') : null,
            t.recurrence ? h('span', { class: 'meta-item' }, NM.icon('repeat')) : null,
            t.reminder ? h('span', { class: 'meta-item' }, NM.icon('bell'), t.reminder) : null,
            t.subtasks.length ? h('span', { class: 'meta-item' }, '📋 ' + t.subtasks.filter((s) => s.done).length + '/' + t.subtasks.length) : null,
            t.tags.map((g) => NM.tagChip(g))),
        h('div', { class: 'kcard-actions' },
            NM.iconBtn('play', 'Focus', () => NM.focus.start(t.id)),
            NM.iconBtn('edit', 'Details', () => NM.openDetail(t.id, day))));
        el.addEventListener('dragstart', (e) => { el.classList.add('dragging'); e.dataTransfer.setData('text/x-task-id', t.id); e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
        return el;
    }

    function move(id, status) {
        const t = NM.task(id);
        if (!t) return;
        const day = S.date;
        if (C.statusOn(t, day) === status) return;
        NM.mutateTasks(() => {
            if (!t.recurrence && t.date < day) C.snooze(t, day); // pulling an overdue task onto today's board
            C.setStatusOn(t, day, status);
        });
        setTimeout(() => { const el = document.querySelector('.kcard[data-id="' + id + '"]'); if (el) el.focus(); }, 0);
    }

    function render() {
        const root = document.getElementById('view-board');
        NM.clear(root);
        const day = S.date;
        const list = boardTasks();
        root.appendChild(h('div', { class: 'view-head' },
            h('div', null, h('h2', null, 'Board'), h('p', { class: 'muted small' }, 'Drag cards between columns (or focus a card and use ← →). Double-click for details.')),
            h('div', { class: 'inline board-add' },
                h('input', { class: 'input', placeholder: 'Quick add to To do…', onkeydown: (e) => { if (e.key === 'Enter' && e.target.value.trim()) { NM.addTaskFromText(e.target.value); e.target.value = ''; } } }))));
        const board = h('div', { class: 'board' });
        for (const [key, label] of COLS) {
            const items = list.filter((t) => C.statusOn(t, day) === key);
            const col = h('div', { class: 'kcol kcol-' + key, dataset: { status: key } },
                h('div', { class: 'kcol-head' }, h('span', { class: 'kcol-dot' }), label, h('span', { class: 'count' }, String(items.length))),
                h('div', { class: 'kcol-body' }, items.length ? items.map((t) => card(t, day)) : h('div', { class: 'kcol-empty muted small' }, 'Drop tasks here')));
            col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
            col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
            col.addEventListener('drop', (e) => {
                e.preventDefault(); col.classList.remove('drop');
                const id = e.dataTransfer.getData('text/x-task-id') || e.dataTransfer.getData('text/plain');
                if (id) move(id, key);
            });
            board.appendChild(col);
        }
        root.appendChild(board);
    }

    NM.views.board = { title: () => 'Board', subtitle: () => C.fullDate(S.date), render };
})();
