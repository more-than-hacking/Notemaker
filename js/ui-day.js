/* Notemaker — Day view: quick add, task list (filters, sort, subtasks, drag reorder), stats. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h, $ = NM.$;

    // ---------------- quick add ----------------
    function previewChips(q) {
        const chips = [];
        const chip = (icon, text, cls) => h('span', { class: 'qa-chip ' + (cls || '') }, icon ? NM.icon(icon) : null, text);
        if (q.date !== S.date) chips.push(chip('calendar', NM.shortDate(q.date) + ' · ' + NM.relativeDay(q.date)));
        if (q.reminder) chips.push(chip('bell', q.reminder));
        if (q.recurrence) chips.push(chip('repeat', NM.recurrenceLabel(q.recurrence)));
        if (q.priority !== 'none') chips.push(chip('flag', q.priority, 'prio-' + q.priority));
        q.tags.forEach((t) => chips.push(NM.tagChip(t)));
        if (q.estimate) chips.push(chip('tomato', '×' + q.estimate));
        return chips;
    }
    function updateQuickPreview() {
        const input = $('#newTaskInput'), box = $('#quickPreview');
        NM.clear(box);
        const v = input.value.trim();
        if (!v) return;
        const q = C.parseQuickAdd(v, S.date);
        const chips = previewChips(q);
        if (!chips.length) return;
        box.appendChild(h('span', { class: 'qa-title' }, q.title ? '“' + q.title + '”' : '(no title yet)'));
        chips.forEach((c) => box.appendChild(c));
    }
    NM.addTaskFromText = function (text, baseDate) {
        const raw = String(text || '').trim();
        if (!raw) return null;
        const q = C.parseQuickAdd(raw, baseDate || S.date);
        const title = q.title || raw;
        let created = null;
        NM.mutateTasks(() => {
            created = C.newTask({
                title, date: q.date, priority: q.priority, tags: q.tags, reminder: q.reminder, recurrence: q.recurrence,
                pomodoros: { estimate: q.estimate, done: 0 }, order: NM.nextOrder(q.date)
            }, S.date);
            S.doc.tasks.push(created);
        });
        if (created.date !== S.date && !C.occursOn(created, S.date)) {
            NM.toast('Added to ' + NM.shortDate(created.date), 'ok', 4000, { label: 'Go', fn: () => NM.setDate(created.date) });
        }
        return created;
    };
    function addTask() {
        const input = $('#newTaskInput');
        if (NM.addTaskFromText(input.value)) { input.value = ''; updateQuickPreview(); }
    }
    NM.focusQuickAdd = function () {
        if (S.view !== 'day') NM.setView('day');
        setDayTab('tasks');
        const i = $('#newTaskInput');
        i.focus();
        i.select();
    };

    // ---------------- task actions ----------------
    NM.toggleTask = function (id, day) {
        day = day || S.date;
        const t = NM.task(id);
        if (!t) return;
        NM.mutateTasks(() => C.setDoneOn(t, day, !C.isDoneOn(t, day)));
    };
    NM.deleteTask = async function (id, day) {
        day = day || S.date;
        const t = NM.task(id);
        if (!t) return;
        if (t.recurrence) {
            const choice = await NM.choose('Delete recurring task', '“' + t.title + '” repeats (' + NM.recurrenceLabel(t.recurrence) + '). Delete only this occurrence or the whole series?', [
                { label: 'Cancel', value: null }, { label: 'This occurrence', value: 'one' }, { label: 'Whole series', value: 'all', kind: 'danger' }
            ]);
            if (!choice) return;
            if (choice === 'one') { NM.mutateTasks(() => { t.skipDates[day] = true; delete t.doneDates[day]; }); NM.toast('Occurrence on ' + NM.shortDate(day) + ' removed', '', 4000, { label: 'Undo', fn: NM.undoTasks }); return; }
        }
        NM.mutateTasks(() => { S.doc.tasks = S.doc.tasks.filter((x) => x.id !== id); });
        if (NM.closeDetailIf) NM.closeDetailIf(id);
        NM.toast('Task deleted', '', 4000, { label: 'Undo', fn: NM.undoTasks });
    };
    function addSubtask(task, input) {
        const title = input.value.trim();
        if (!title) return;
        S.expanded.add(task.id);
        NM.mutateTasks(() => task.subtasks.push({ id: C.uuid(), title, done: false }));
        const again = document.getElementById('subtask-input-' + task.id);
        if (again) again.focus();
    }
    function forwardIncomplete() {
        const tomorrow = C.addDays(S.date, 1);
        const list = NM.dayTasks().filter((t) => !t.recurrence && !t.done);
        if (!list.length) { NM.toast('No incomplete tasks to forward'); return; }
        NM.confirm('Forward ' + list.length + ' incomplete task(s) to ' + NM.shortDate(tomorrow) + '?', 'Forward').then((ok) => {
            if (!ok) return;
            NM.mutateTasks(() => list.forEach((t) => C.snooze(t, tomorrow)));
            NM.toast('Forwarded ' + list.length + ' task(s) to ' + C.fullDate(tomorrow), 'ok');
        });
    }

    // ---------------- rendering ----------------
    function taskMeta(t, day) {
        const meta = [];
        const pb = NM.priorityBadge(t.priority);
        if (pb) meta.push(pb);
        const od = C.overdueDays(t, S.today);
        if (od > 0 && day === S.today) meta.push(h('span', { class: 'badge overdue', title: 'Originally ' + (t.rolledFrom || t.date) }, 'Overdue ' + od + (od === 1 ? ' day' : ' days')));
        if (t.recurrence) meta.push(h('span', { class: 'meta-item', title: NM.recurrenceLabel(t.recurrence) }, NM.icon('repeat'), NM.recurrenceLabel(t.recurrence)));
        if (t.reminder) meta.push(h('span', { class: 'meta-item', title: 'Reminder' }, NM.icon('bell'), t.reminder));
        if (t.timeBlock) meta.push(h('span', { class: 'meta-item', title: 'Planned' }, NM.icon('clock'), t.timeBlock.start + '–' + t.timeBlock.end));
        if (t.pomodoros.estimate || t.pomodoros.done) meta.push(h('span', { class: 'meta-item', title: 'Pomodoros done / estimate' }, '🍅 ' + t.pomodoros.done + (t.pomodoros.estimate ? '/' + t.pomodoros.estimate : '')));
        if (t.status === 'doing' && !C.isDoneOn(t, day)) meta.push(h('span', { class: 'badge doing' }, 'In progress'));
        t.tags.forEach((g) => meta.push(NM.tagChip(g, (tag) => { S.filter.tag = tag; NM.saveUi(); NM.render(); })));
        return meta;
    }

    function renderTaskItem(t, day, manual) {
        const done = C.isDoneOn(t, day);
        const subs = t.subtasks;
        const subDone = subs.filter((s) => s.done).length;
        const open = S.expanded.has(t.id);
        const wrapper = h('div', { class: 'task-item-wrapper', role: 'listitem', dataset: { id: t.id }, draggable: manual ? 'true' : null });
        const item = h('div', {
            class: 'task-item' + (done ? ' completed' : '') + ' prio-edge-' + t.priority,
            onclick: (e) => { if (e.target.closest('button, input, a, .tag-chip')) return; NM.toggleTask(t.id, day); },
            ondblclick: (e) => { if (e.target.closest('button')) return; NM.openDetail(t.id, day); }
        },
        manual ? h('span', { class: 'drag-handle', title: 'Drag to reorder' }, NM.icon('drag')) : null,
        h('button', {
            class: 'task-checkbox' + (done ? ' checked' : ''), type: 'button', role: 'checkbox', 'aria-checked': String(done),
            'aria-label': (done ? 'Mark incomplete: ' : 'Mark complete: ') + t.title, onclick: () => NM.toggleTask(t.id, day)
        }),
        h('div', { class: 'task-main' },
            h('div', { class: 'task-text' }, t.title),
            h('div', { class: 'task-meta' }, taskMeta(t, day))),
        h('div', { class: 'task-actions' },
            h('button', { class: 'task-subtask-btn' + (open ? ' active' : ''), type: 'button', title: 'Subtasks', onclick: () => { if (open) S.expanded.delete(t.id); else S.expanded.add(t.id); NM.views.day.renderTasks(); } },
                '📋', subs.length ? ' ' + subDone + '/' + subs.length : ''),
            NM.iconBtn('play', 'Start focus timer', () => NM.focus.start(t.id), 'task-act'),
            NM.iconBtn('edit', 'Details', () => NM.openDetail(t.id, day), 'task-act'),
            NM.iconBtn('trash', 'Delete', () => NM.deleteTask(t.id, day), 'task-act danger')));
        wrapper.appendChild(item);

        if (open) {
            const input = h('input', { type: 'text', id: 'subtask-input-' + t.id, class: 'subtask-input', placeholder: 'Add subtask…', onkeydown: (e) => { if (e.key === 'Enter') addSubtask(t, input); } });
            wrapper.appendChild(h('div', { class: 'subtasks-container' },
                h('div', { class: 'subtasks-list' }, subs.map((s) => h('div', {
                    class: 'subtask-item' + (s.done ? ' completed' : ''),
                    onclick: (e) => { if (e.target.closest('.subtask-delete')) return; NM.mutateTasks(() => { s.done = !s.done; }); }
                },
                h('span', { class: 'subtask-checkbox' + (s.done ? ' checked' : '') }),
                h('span', { class: 'subtask-text' }, s.title),
                h('button', { class: 'subtask-delete', type: 'button', 'aria-label': 'Delete subtask', onclick: () => NM.mutateTasks(() => { t.subtasks = t.subtasks.filter((x) => x.id !== s.id); }) }, '×')))),
                h('div', { class: 'add-subtask-section' }, input, h('button', { class: 'add-subtask-btn', type: 'button', onclick: () => addSubtask(t, input) }, '+'))));
        }
        if (manual) attachReorder(wrapper, t.id);
        return wrapper;
    }

    let dragId = null;
    function attachReorder(el, id) {
        el.addEventListener('dragstart', (e) => {
            dragId = id;
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/x-task-id', id);
            e.dataTransfer.setData('text/plain', id);
        });
        el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); NM.$$('.drop-before').forEach((x) => x.classList.remove('drop-before')); });
        el.addEventListener('dragover', (e) => { if (!dragId || dragId === id) return; e.preventDefault(); el.classList.add('drop-before'); });
        el.addEventListener('dragleave', () => el.classList.remove('drop-before'));
        el.addEventListener('drop', (e) => {
            e.preventDefault();
            el.classList.remove('drop-before');
            const from = dragId;
            if (!from || from === id) return;
            const ids = C.sortTasks(NM.dayTasks(), 'manual').map((t) => t.id).filter((x) => x !== from);
            ids.splice(ids.indexOf(id), 0, from);
            NM.mutateTasks(() => ids.forEach((tid, i) => { NM.task(tid).order = i; }));
        });
    }

    function renderTagFilter() {
        const sel = $('#tagFilter');
        const tags = NM.allTags();
        if (S.filter.tag !== 'any' && !tags.includes(S.filter.tag)) tags.push(S.filter.tag);
        NM.clear(sel);
        sel.appendChild(h('option', { value: 'any' }, 'Any tag'));
        tags.forEach((t) => sel.appendChild(h('option', { value: t }, '#' + t)));
        sel.value = S.filter.tag;
    }

    function renderTasks() {
        const day = S.date;
        const all = NM.dayTasks(day);
        const manual = S.sort === 'manual';
        const list = C.sortTasks(C.filterTasks(all, day, S.filter), S.sort);
        const box = $('#tasksList'), empty = $('#emptyState');
        $('#taskFilter').value = S.filter.status;
        $('#priorityFilter').value = S.filter.priority;
        $('#sortMode').value = S.sort;
        renderTagFilter();
        NM.clear(box);
        const doneN = all.filter((t) => C.isDoneOn(t, day)).length;
        $('#tasksCount').textContent = all.length ? doneN + '/' + all.length : '';
        if (!list.length) {
            box.hidden = true; empty.hidden = false;
            const filtered = S.filter.status !== 'all' || S.filter.priority !== 'any' || S.filter.tag !== 'any';
            empty.querySelector('p').textContent = !all.length ? 'No tasks for this date' : filtered ? 'No tasks match the filters' : 'No tasks';
        } else {
            box.hidden = false; empty.hidden = true;
            const frag = document.createDocumentFragment();
            list.forEach((t) => frag.appendChild(renderTaskItem(t, day, manual)));
            box.appendChild(frag);
        }
        const fwd = $('#forwardTasks');
        fwd.hidden = !all.some((t) => !t.recurrence && !t.done);
    }

    NM.renderStats = function () {
        const day = S.date;
        const all = NM.dayTasks(day);
        const done = all.filter((t) => C.isDoneOn(t, day)).length;
        $('#statsTitle').textContent = day === S.today ? "Today's Stats" : NM.shortDate(day);
        $('#totalTasks').textContent = all.length;
        $('#completedTasks').textContent = done;
        $('#remainingTasks').textContent = all.length - done;
        $('#dayProgress').style.width = (all.length ? Math.round(done / all.length * 100) : 0) + '%';
        let st = 0, sd = 0;
        all.forEach((t) => { st += t.subtasks.length; sd += t.subtasks.filter((s) => s.done).length; });
        const sub = $('#subtaskStats');
        sub.hidden = !st;
        sub.textContent = st ? 'Subtasks: ' + sd + '/' + st : '';
        const s = C.streaks(C.completionsByDay(S.doc.tasks), S.today);
        $('#streakLine').textContent = '🔥 Streak: ' + s.current + ' day' + (s.current === 1 ? '' : 's') + ' · best ' + s.best;
    };

    function setDayTab(tab) {
        S.dayTab = tab;
        NM.saveUi();
        NM.$$('#view-day .subtab').forEach((b) => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
        NM.$$('#view-day .day-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
    }
    NM.setDayTab = setDayTab;

    NM.views.day = {
        title: () => C.fullDate(S.date),
        subtitle: () => NM.relativeDay(S.date),
        renderTasks,
        render() {
            setDayTab(S.dayTab);
            renderTasks();
            if (NM.notes) NM.notes.sync();
        },
        init() {
            const input = $('#newTaskInput');
            input.addEventListener('input', updateQuickPreview);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); addTask(); }
                if (e.key === 'Escape') { input.value = ''; updateQuickPreview(); input.blur(); }
            });
            $('#addTaskBtn').addEventListener('click', addTask);
            $('#undoTaskBtn').addEventListener('click', NM.undoTasks);
            $('#redoTaskBtn').addEventListener('click', NM.redoTasks);
            $('#forwardTasks').addEventListener('click', forwardIncomplete);
            const onFilter = () => {
                S.filter.status = $('#taskFilter').value;
                S.filter.priority = $('#priorityFilter').value;
                S.filter.tag = $('#tagFilter').value;
                S.sort = $('#sortMode').value;
                NM.saveUi();
                renderTasks();
            };
            ['#taskFilter', '#priorityFilter', '#tagFilter', '#sortMode'].forEach((s) => $(s).addEventListener('change', onFilter));
            NM.$$('#view-day .subtab').forEach((b) => b.addEventListener('click', () => setDayTab(b.dataset.tab)));
        }
    };
})();
