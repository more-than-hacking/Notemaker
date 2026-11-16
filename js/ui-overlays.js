/* Notemaker — overlays: global search, command palette, keyboard shortcut help, daily review. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h;

    /** Text with the first match of `q` wrapped in <mark> — built with text nodes (no innerHTML). */
    function highlight(text, q) {
        const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).map((t) => t.replace(/^#/, ''));
        const lower = text.toLowerCase();
        let best = -1, len = 0;
        for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (best < 0 || i < best)) { best = i; len = t.length; } }
        if (best < 0) return [text];
        return [text.slice(0, best), h('mark', null, text.slice(best, best + len)), text.slice(best + len)];
    }

    /** Shared list-picker overlay (search & palette). getItems(q) → [{group?, el(children), run()}] */
    function picker(opts) {
        const input = h('input', { class: 'picker-input', placeholder: opts.placeholder, autocomplete: 'off', spellcheck: 'false', 'aria-label': opts.placeholder });
        const list = h('div', { class: 'picker-list', role: 'listbox' });
        const foot = h('div', { class: 'picker-foot muted small' }, opts.foot || '↑↓ to move · Enter to open · Esc to close');
        const box = h('div', { class: 'picker', role: 'dialog', 'aria-label': opts.title },
            h('div', { class: 'picker-head' }, NM.icon(opts.icon || 'search'), input), list, foot);
        const backdrop = h('div', { class: 'modal-backdrop top' }, box);
        let items = [], sel = 0;
        const close = NM.pushOverlay(backdrop);
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        function draw() {
            items = opts.getItems(input.value.trim());
            NM.clear(list);
            if (sel >= items.length) sel = Math.max(0, items.length - 1);
            let lastGroup = null;
            items.forEach((it, i) => {
                if (it.group && it.group !== lastGroup) { list.appendChild(h('div', { class: 'picker-group' }, it.group)); lastGroup = it.group; }
                const row = h('div', { class: 'picker-item' + (i === sel ? ' sel' : ''), role: 'option', 'aria-selected': String(i === sel),
                    onmousemove: () => { if (sel !== i) { sel = i; mark(); } }, onclick: () => exec(i) }, it.el);
                list.appendChild(row);
            });
            if (!items.length) list.appendChild(h('div', { class: 'picker-empty muted' }, input.value.trim() ? (opts.empty || 'No results') : (opts.hint || '')));
        }
        function mark() {
            NM.$$('.picker-item', list).forEach((el, i) => { el.classList.toggle('sel', i === sel); el.setAttribute('aria-selected', String(i === sel)); if (i === sel) el.scrollIntoView({ block: 'nearest' }); });
        }
        function exec(i) { const it = items[i]; if (!it) return; close(); it.run(); }
        let timer = null;
        input.addEventListener('input', () => { sel = 0; clearTimeout(timer); timer = setTimeout(draw, opts.debounce || 0); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); mark(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
            else if (e.key === 'Enter') { e.preventDefault(); exec(sel); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        });
        document.body.appendChild(backdrop);
        if (opts.initial) input.value = opts.initial;
        draw();
        setTimeout(() => input.focus(), 10);
        return { close, input };
    }

    function openDayAt(d, tab) {
        NM.setDate(d);
        NM.setView('day');
        if (tab) NM.setDayTab(tab);
    }

    // ---------------- search ----------------
    NM.openSearch = function () {
        picker({
            title: 'Search', placeholder: 'Search tasks, subtasks, #tags and notes…', icon: 'search', debounce: 80,
            hint: 'Type to search everything. Private (locked) notes are not searched.',
            getItems(q) {
                if (!q) return [];
                const groups = C.search(S.doc, q, 200);
                const out = [];
                for (const g of groups) {
                    const label = NM.shortDate(g.date) + ' · ' + NM.relativeDay(g.date);
                    for (const it of g.items) {
                        const kindIcon = { task: 'day', subtask: 'list', note: 'note' }[it.kind];
                        out.push({
                            group: label,
                            el: [NM.icon(kindIcon, 'picker-icon'), h('div', { class: 'picker-text' },
                                h('div', null, highlight(it.text, q)),
                                it.kind === 'subtask' ? h('div', { class: 'muted small' }, 'in “' + it.parent + '”') : null,
                                it.kind === 'task' && (it.tags.length || it.recurring) ? h('div', { class: 'task-meta' }, it.recurring ? h('span', { class: 'meta-item' }, NM.icon('repeat'), 'repeats') : null, it.tags.map((t) => NM.tagChip(t))) : null),
                            h('span', { class: 'picker-kind muted small' }, it.kind)],
                            run: () => {
                                if (it.kind === 'note') openDayAt(g.date, 'notes');
                                else { openDayAt(g.date, 'tasks'); NM.openDetail(it.taskId, g.date); }
                            }
                        });
                    }
                }
                return out;
            }
        });
    };

    // ---------------- command palette ----------------
    function commands() {
        const viewCmds = [['day', 'Day'], ['calendar', 'Calendar'], ['planner', 'Planner'], ['board', 'Board'], ['habits', 'Habits'], ['insights', 'Insights'], ['settings', 'Settings']]
            .map(([v, l], i) => ({ label: 'Go to ' + l + ' view', key: String(i + 1), icon: 'right', run: () => NM.setView(v) }));
        const f = NM.focus.state();
        return viewCmds.concat([
            { label: 'New task', key: 'n', icon: 'plus', run: NM.focusQuickAdd },
            { label: 'Search', key: '/', icon: 'search', run: NM.openSearch },
            { label: 'Go to today', key: 't', icon: 'calendar', run: NM.goToday },
            { label: 'Next day', key: '→', icon: 'right', run: () => NM.moveDate(1) },
            { label: 'Previous day', key: '←', icon: 'left', run: () => NM.moveDate(-1) },
            { label: 'Daily review', icon: 'sparkle', run: () => NM.openReview(S.date) },
            f.running ? { label: f.paused ? 'Resume focus timer' : 'Pause focus timer', icon: 'pause', run: NM.focus.togglePause } : { label: 'Start focus timer (no task)', icon: 'tomato', run: () => NM.focus.start(null) },
            f.running ? { label: 'Stop focus timer', icon: 'stop', run: NM.focus.stop } : null,
            { label: 'Toggle theme (light/dark)', icon: 'moon', run: NM.toggleTheme },
            { label: 'Theme: follow system', icon: 'monitor', run: () => { NM.update(() => { S.doc.settings.theme = 'system'; }); NM.applyTheme(); } },
            { label: 'Edit today’s note', icon: 'edit', run: () => { openDayAt(S.date, 'notes'); NM.notes.enableEditing(); } },
            { label: 'New habit', icon: 'target', run: () => { NM.setView('habits'); NM.newHabit(); } },
            { label: 'Move to a new device', icon: 'upload', run: () => NM.transfer.start() },
            { label: 'Restore from another device', icon: 'download', run: () => NM.transfer.restore() },
            { label: 'Unencrypted backup (JSON)', icon: 'download', run: NM.exportJson },
            { label: 'Import a JSON backup…', icon: 'upload', run: () => document.getElementById('importFile').click() },
            { label: 'Export Markdown (day / week)', icon: 'download', run: NM.exportMarkdown },
            { label: 'Undo task change', icon: 'left', run: NM.undoTasks },
            { label: 'Redo task change', icon: 'right', run: NM.redoTasks },
            NM.notifyPermission() === 'default' ? { label: 'Enable notifications', icon: 'bell', run: NM.requestNotifications } : null,
            S.passcode ? { label: 'Lock all private notes', icon: 'lock', run: () => { S.passcode = null; S.unlocked = {}; NM.render(); NM.toast('Private notes locked'); } } : null,
            // vault: the palette may only offer these two (never vault contents)
            { label: 'Open vault', key: '8', icon: 'lock', run: () => NM.setView('vault') },
            NM.vault && NM.vault.isUnlocked() ? { label: 'Lock vault', icon: 'lock', run: () => NM.vault.lock('manual') } : null,
            { label: 'Keyboard shortcuts', key: '?', icon: 'keyboard', run: NM.openHelp }
        ]).filter(Boolean);
    }
    NM.openPalette = function () {
        picker({
            title: 'Command palette', placeholder: 'Type a command, a date (tomorrow, fri, 2026-12-01) or a task…', icon: 'cmd',
            foot: 'Enter to run · try “planner”, “next week”, “export”, or type a new task',
            getItems(q) {
                const out = [];
                const row = (icon, label, key, extra) => [NM.icon(icon, 'picker-icon'), h('div', { class: 'picker-text' }, h('div', null, q ? highlight(label, q) : label), extra || null), key ? h('kbd', null, key) : null];
                const d = C.parseDatePhrase(q, S.today);
                if (d) out.push({ group: 'Date', el: row('calendar', 'Go to ' + C.fullDate(d), null, h('div', { class: 'muted small' }, NM.relativeDay(d))), run: () => openDayAt(d) });
                const cmds = commands().map((c) => ({ c, s: C.fuzzyScore(q, c.label) })).filter((x) => x.s > 0);
                if (q) cmds.sort((a, b) => b.s - a.s);
                cmds.slice(0, q ? 8 : 40).forEach(({ c }) => out.push({ group: 'Commands', el: row(c.icon, c.label, c.key), run: c.run }));
                if (q.length >= 2) {
                    const seen = new Set();
                    const tasks = S.doc.tasks.map((t) => ({ t, s: C.fuzzyScore(q, t.title) })).filter((x) => x.s > q.length * 1.5)
                        .sort((a, b) => b.s - a.s || b.t.date.localeCompare(a.t.date)).filter((x) => (seen.has(x.t.id) ? false : seen.add(x.t.id))).slice(0, 6);
                    tasks.forEach(({ t }) => out.push({
                        group: 'Tasks', el: row('day', t.title, null, h('div', { class: 'muted small' }, NM.shortDate(t.date) + (t.recurrence ? ' · repeats' : '') + (C.isDoneOn(t, t.date) && !t.recurrence ? ' · done' : ''))),
                        run: () => { const day = t.recurrence && C.occursOn(t, S.date) ? S.date : t.date; openDayAt(day, 'tasks'); NM.openDetail(t.id, day); }
                    }));
                    const qa = C.parseQuickAdd(q, S.date);
                    out.push({ group: 'Create', el: row('plus', 'Add task: ' + (qa.title || q), null, h('div', { class: 'muted small' }, NM.shortDate(qa.date) + (qa.reminder ? ' · ' + qa.reminder : '') + (qa.recurrence ? ' · ' + NM.recurrenceLabel(qa.recurrence) : ''))), run: () => NM.addTaskFromText(q) });
                }
                return out;
            }
        });
    };

    // ---------------- shortcut help ----------------
    NM.openHelp = function () {
        const mod = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
        const rows = [
            ['n', 'New task (focus quick add)'], [mod + ' K', 'Command palette'], [mod + ' F  or  /', 'Search everything'],
            ['← / →', 'Previous / next day'], ['t', 'Jump to today'], ['1 – 8', 'Day · Calendar · Planner · Board · Habits · Insights · Settings · Vault'],
            [mod + ' Z / ' + mod + ' ⇧ Z', 'Undo / redo task changes (or note edits while editing)'], [mod + ' S  or  Esc', 'Save note while editing'],
            ['?', 'This help'], ['Esc', 'Close dialogs, drawers and overlays']
        ];
        const grammar = [['#tag', 'tag'], ['!high !med !low  (!1 !2 !3)', 'priority'], ['today · tomorrow · fri · next week · in 3 days · 2026-12-01', 'date'],
            ['3pm · 15:30 · at 9', 'reminder'], ['every day · every weekday · every mon · monthly', 'repeat'], ['~4', 'pomodoro estimate']];
        NM.modal({
            title: 'Keyboard shortcuts', cls: 'wide',
            body: h('div', { class: 'help-grid' },
                h('div', null, h('h4', null, 'Shortcuts'), h('table', { class: 'kbd-table' }, rows.map(([k, d]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, d))))),
                h('div', null, h('h4', null, 'Quick add grammar'), h('table', { class: 'kbd-table' }, grammar.map(([k, d]) => h('tr', null, h('td', null, h('code', null, k)), h('td', null, d)))),
                    h('p', { class: 'muted small' }, 'Example: ', h('code', null, 'Call Raj tomorrow 3pm #work !high')))),
            actions: [{ label: 'Got it', kind: 'primary' }]
        });
    };

    // ---------------- daily review ----------------
    NM.openReview = function (day) {
        day = day || S.today;
        if (NM.beforeDateChange) NM.beforeDateChange();
        const all = C.sortTasks(C.tasksForDay(S.doc.tasks, day), 'priority');
        const done = all.filter((t) => C.isDoneOn(t, day));
        const open = all.filter((t) => !C.isDoneOn(t, day));
        const tomorrow = C.addDays(day, 1);
        const wins = h('textarea', { class: 'input', rows: 2, placeholder: 'What went well?' });
        const blockers = h('textarea', { class: 'input', rows: 2, placeholder: 'What got in the way?' });
        const focus = h('textarea', { class: 'input', rows: 2, placeholder: 'The one or two things that matter tomorrow' });
        const openList = h('div', { class: 'review-open' });
        const drawOpen = () => {
            NM.clear(openList);
            const still = open.filter((t) => NM.task(t.id) && C.occursOn(t, day) && !C.isDoneOn(t, day));
            if (!still.length) { openList.appendChild(h('p', { class: 'muted small' }, open.length ? 'All handled 👍' : 'Nothing left open. Nice!')); return; }
            still.forEach((t) => {
                const snoozeIn = h('input', { type: 'date', class: 'input small-date', value: C.addDays(day, 2), min: C.addDays(day, 1), 'aria-label': 'Snooze until' });
                openList.appendChild(h('div', { class: 'review-row' },
                    h('span', { class: 'review-title' }, t.title, ' ', NM.priorityBadge(t.priority)),
                    h('div', { class: 'inline' },
                        t.recurrence ? h('span', { class: 'muted small' }, 'repeats') : h('button', { class: 'btn small', type: 'button', onclick: () => { NM.mutateTasks(() => C.snooze(t, tomorrow)); drawOpen(); } }, 'Tomorrow'),
                        t.recurrence ? null : snoozeIn,
                        t.recurrence ? null : h('button', { class: 'btn ghost small', type: 'button', title: 'Snooze to the chosen date', onclick: () => { if (C.isValidDate(snoozeIn.value)) { NM.mutateTasks(() => C.snooze(t, snoozeIn.value)); drawOpen(); } } }, NM.icon('snooze'), ' Snooze'),
                        h('button', { class: 'btn ghost small danger-text', type: 'button', title: t.recurrence ? 'Skip this occurrence' : 'Delete this task',
                            onclick: () => { NM.mutateTasks(() => { if (t.recurrence) t.skipDates[day] = true; else S.doc.tasks = S.doc.tasks.filter((x) => x.id !== t.id); }); drawOpen(); } }, t.recurrence ? 'Skip' : 'Drop'))));
            });
        };
        drawOpen();
        NM.modal({
            title: '✨ Daily review — ' + NM.shortDate(day), cls: 'wide review',
            body: h('div', { class: 'review-body' },
                h('section', null, h('h4', null, '✅ Completed (' + done.length + ')'),
                    done.length ? h('ul', { class: 'review-done' }, done.map((t) => h('li', null, t.title))) : h('p', { class: 'muted small' }, 'No completed tasks yet.')),
                h('section', null, h('h4', null, '⏳ Unfinished (' + open.length + ')'), openList),
                h('section', { class: 'review-prompts' },
                    h('label', { class: 'field' }, h('span', { class: 'field-label' }, '🏆 Wins'), wins),
                    h('label', { class: 'field' }, h('span', { class: 'field-label' }, '🧱 Blockers'), blockers),
                    h('label', { class: 'field' }, h('span', { class: 'field-label' }, '🎯 Tomorrow’s focus'), focus)),
                h('p', { class: 'muted small' }, 'Saving appends a “## Daily review” section to this day’s note.')),
            actions: [{ label: 'Close' }, { label: 'Save to note', kind: 'primary', onClick: async () => {
                const n = S.doc.notes[day];
                if (n && n.locked && S.unlocked[day] == null) {
                    const p = await NM.prompt('Private note', 'This day’s note is private. Enter your passcode to append the review.', { type: 'password' });
                    if (!p) return false;
                    try { S.unlocked[day] = await C.decryptNote(n.cipher, p); S.passcode = p; } catch (e) { NM.toast('Wrong passcode', 'error'); return false; }
                }
                const text = C.appendReview(NM.noteText(day), { wins: wins.value, blockers: blockers.value, focus: focus.value });
                await NM.setNoteText(day, text);
                if (NM.notes) NM.notes.sync();
                NM.toast('Review saved to ' + NM.shortDate(day) + '’s note', 'ok', 5000, { label: 'View', fn: () => openDayAt(day, 'notes') });
            } }]
        });
    };
})();
