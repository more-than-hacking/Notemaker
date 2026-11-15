/* Notemaker — Focus timer (Pomodoro): floating mini-timer, pause/stop, logs FocusSessions, counts task pomodoros. */
(function () {
    'use strict';
    const NM = window.NM, C = NM.C, S = NM.state, h = NM.h;
    const KEY = 'notemaker_focus';
    let st = null;   // { kind, taskId, startedAt (ISO), endsAt (ms), durationMin, paused, remainingMs }
    let ticker = null;

    function persist() { try { if (st) NM.ls.set(KEY, JSON.stringify(st)); else localStorage.removeItem(KEY); } catch (e) { /* */ } }
    function remaining() { return st ? (st.paused ? st.remainingMs : Math.max(0, st.endsAt - Date.now())) : 0; }

    function begin(kind, taskId) {
        const min = kind === 'focus' ? S.doc.settings.focusMinutes : S.doc.settings.breakMinutes;
        st = { kind, taskId: taskId || null, startedAt: new Date().toISOString(), endsAt: Date.now() + min * 60000, durationMin: min, paused: false, remainingMs: 0 };
        persist();
        startTicker();
        draw();
    }
    function log(kind, minutes) {
        if (minutes < 1) return;
        NM.update(() => S.doc.focusSessions.push(C.normalizeSession({ id: C.uuid(), taskId: st.taskId, start: st.startedAt, end: new Date().toISOString(), minutes, kind })));
    }
    function complete() {
        const s = st;
        if (s.kind === 'focus') {
            const t = s.taskId ? NM.task(s.taskId) : null;
            log('focus', s.durationMin);
            if (t) NM.update(() => { t.pomodoros.done++; });
            NM.notify('🍅 Focus block complete', (t ? '“' + t.title + '” — ' : '') + 'time for a ' + S.doc.settings.breakMinutes + '-minute break.', 'focus');
            begin('break', s.taskId);
        } else {
            log('break', s.durationMin);
            st = null; persist(); stopTicker(); draw();
            NM.notify('☕ Break over', 'Ready for the next focus block?', 'focus');
        }
    }
    function startTicker() { stopTicker(); ticker = setInterval(tick, 1000); }
    function stopTicker() { clearInterval(ticker); ticker = null; }
    function tick() {
        if (!st) return stopTicker();
        if (!st.paused && Date.now() >= st.endsAt) complete();
        else drawTime();
    }

    const fmt = (ms) => { const s = Math.ceil(ms / 1000); return C.pad2(Math.floor(s / 60)) + ':' + C.pad2(s % 60); };
    let els = null;
    function draw() {
        const root = document.getElementById('focusMini');
        NM.clear(root);
        if (!st) { root.hidden = true; els = null; document.title = 'Notemaker - Daily Notes & Tasks'; return; }
        root.hidden = false;
        root.className = 'focus-mini ' + st.kind + (st.paused ? ' paused' : '');
        const t = st.taskId ? NM.task(st.taskId) : null;
        const R = 20, L = 2 * Math.PI * R;
        const ringEl = h('div', { class: 'fm-ring', html: '<svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="' + R + '" class="ring-bg"/><circle cx="25" cy="25" r="' + R + '" class="ring-fg" stroke-dasharray="0 ' + L + '" transform="rotate(-90 25 25)"/></svg>' });
        const time = h('div', { class: 'fm-time' });
        root.appendChild(ringEl);
        root.appendChild(h('div', { class: 'fm-info' }, time,
            h('div', { class: 'fm-label', title: t ? t.title : '' }, st.kind === 'focus' ? (t ? t.title : 'Focus') : '☕ Break')));
        root.appendChild(h('div', { class: 'fm-actions' },
            NM.iconBtn(st.paused ? 'play' : 'pause', st.paused ? 'Resume' : 'Pause', togglePause),
            st.kind === 'break' ? NM.iconBtn('forward', 'Skip break', () => { log('break', Math.floor((st.durationMin * 60000 - remaining()) / 60000)); st = null; persist(); draw(); }) : null,
            NM.iconBtn('stop', 'Stop', stop)));
        els = { time, fg: ringEl.querySelector('.ring-fg'), L };
        drawTime();
    }
    function drawTime() {
        if (!st || !els) return;
        const rem = remaining();
        els.time.textContent = fmt(rem);
        const frac = 1 - rem / (st.durationMin * 60000);
        els.fg.setAttribute('stroke-dasharray', (els.L * frac).toFixed(1) + ' ' + els.L.toFixed(1));
        document.title = (st.paused ? '⏸ ' : st.kind === 'focus' ? '🍅 ' : '☕ ') + fmt(rem) + ' · Notemaker';
    }

    function start(taskId) {
        const go = () => {
            begin('focus', taskId);
            const t = taskId ? NM.task(taskId) : null;
            NM.toast('Focus started: ' + S.doc.settings.focusMinutes + ' min' + (t ? ' on “' + t.title + '”' : ''), 'ok');
            if (NM.notifyPermission() === 'default') NM.toast('Tip: enable notifications in Settings to be alerted when the timer ends.', '', 6000);
        };
        if (st) {
            NM.confirm('A timer is already running. Stop it and start a new focus block?', 'Start new').then((ok) => { if (ok) { stop(true); go(); } });
        } else go();
    }
    function togglePause() {
        if (!st) return;
        if (st.paused) { st.endsAt = Date.now() + st.remainingMs; st.paused = false; }
        else { st.remainingMs = remaining(); st.paused = true; }
        persist(); draw();
    }
    function stop(silent) {
        if (!st) return;
        if (st.kind === 'focus') {
            const mins = Math.floor((st.durationMin * 60000 - remaining()) / 60000);
            log('focus', mins); // partial block: logged, but does not count as a pomodoro
            if (!silent && mins >= 1) NM.toast('Logged ' + mins + ' focus minute(s)');
        }
        st = null; persist(); stopTicker(); draw();
    }

    NM.focus = {
        start, stop, togglePause,
        state: () => ({ running: !!st, paused: !!(st && st.paused), kind: st && st.kind }),
        restore() {
            try { st = JSON.parse(NM.ls.get(KEY) || 'null'); } catch (e) { st = null; }
            if (st && (typeof st.endsAt !== 'number' || !st.kind)) st = null;
            if (st) {
                if (!st.paused && Date.now() >= st.endsAt) {
                    // finished while the app was closed: log it without chaining a break
                    if (st.kind === 'focus') { const t = st.taskId ? NM.task(st.taskId) : null; log('focus', st.durationMin); if (t) NM.update(() => { t.pomodoros.done++; }); NM.toast('A focus block finished while Notemaker was closed — logged.'); }
                    st = null; persist();
                } else startTicker();
            }
            draw();
        }
    };
})();
