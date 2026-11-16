/* Notemaker — shared DOM helpers: element builder, icons, toasts, overlays, dialogs. */
(function () {
    'use strict';
    const NM = window.NM;
    const C = NM.C;

    /** Safe element builder. Text children become text nodes; only `html` (trusted, pre-escaped) sets innerHTML. */
    function h(tag, props) {
        const el = document.createElement(tag);
        if (props) {
            for (const k of Object.keys(props)) {
                const v = props[k];
                if (v == null || v === false) continue;
                if (k === 'class') el.className = v;
                else if (k === 'text') el.textContent = v;
                else if (k === 'html') el.innerHTML = v;
                else if (k === 'style' && typeof v === 'object') {
                    for (const sk of Object.keys(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, v[sk]); else el.style[sk] = v[sk]; }
                }
                else if (k === 'dataset') Object.assign(el.dataset, v);
                else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
                else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly') el[k] = v;
                else el.setAttribute(k, v === true ? '' : v);
            }
        }
        for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
        return el;
    }
    function append(el, kid) {
        if (kid == null || kid === false) return;
        if (Array.isArray(kid)) { kid.forEach((k) => append(el, k)); return; }
        el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    NM.h = h;
    NM.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
    NM.$ = (sel, root) => (root || document).querySelector(sel);
    NM.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    // ---------------- icons (static, trusted SVG) ----------------
    const P = {
        left: '<path d="M15 18l-6-6 6-6"/>', right: '<path d="M9 18l6-6-6-6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', cmd: '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 0-6z"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
        moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
        edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        repeat: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
        bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>', flag: '<path d="M4 22V4s1-1 4-1 5 2 8 2 4-1 4-1v11s-1 1-4 1-5-2-8-2-4 1-4 1"/>',
        play: '<path d="M6 4l14 8-14 8z"/>', pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>', stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
        lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1"/>',
        check: '<path d="M20 6L9 17l-5-5"/>', x: '<path d="M18 6L6 18M6 6l12 12"/>', calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        day: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>', board: '<rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="4" height="8" rx="1"/>',
        chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-7"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
        target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>', timeline: '<path d="M3 6h4M3 12h4M3 18h4"/><rect x="10" y="4" width="11" height="5" rx="1.5"/><rect x="10" y="13" width="7" height="7" rx="1.5"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>', upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
        keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>', sparkle: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z"/>',
        menu: '<path d="M3 6h18M3 12h18M3 18h18"/>', tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1.5"/>',
        list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', drag: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
        tomato: '<circle cx="12" cy="13" r="8"/><path d="M12 5V2M9 4l3 1 3-1"/>', forward: '<path d="M13 17l5-5-5-5M6 17l5-5-5-5"/>', note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
        moon2: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>', snooze: '<path d="M4 4h6l-6 7h6M14 10h6l-6 8h6"/>',
        eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
        copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
        shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
        card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
        file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/>',
        more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
        star: '<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
        vault: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="4"/><path d="M12 8v1.5M12 14.5V16M8 12h1.5M14.5 12H16M7 21v1M17 21v1"/>',
        back: '<path d="M15 18l-6-6 6-6"/>'
    };
    NM.icon = function (name, cls) {
        const span = document.createElement('span');
        span.className = 'icon' + (cls ? ' ' + cls : '');
        span.setAttribute('aria-hidden', 'true');
        span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || '') + '</svg>';
        return span;
    };
    NM.iconBtn = function (name, title, onClick, cls) {
        return h('button', { class: 'icon-btn ' + (cls || ''), title, 'aria-label': title, type: 'button', onclick: onClick }, NM.icon(name));
    };

    // ---------------- chips & badges ----------------
    NM.tagChip = function (tag, onClick) {
        const hue = C.tagHue(tag);
        return h(onClick ? 'button' : 'span', {
            class: 'tag-chip', type: onClick ? 'button' : null, title: onClick ? 'Filter by #' + tag : null,
            style: { '--tag-h': String(hue) }, onclick: onClick ? (e) => { e.stopPropagation(); onClick(tag); } : null
        }, '#' + tag);
    };
    NM.priorityBadge = function (p) {
        if (!p || p === 'none') return null;
        return h('span', { class: 'prio-badge prio-' + p, title: p + ' priority' }, { high: 'High', medium: 'Med', low: 'Low' }[p]);
    };
    NM.recurrenceLabel = function (r) {
        if (!r) return '';
        const iv = r.interval > 1 ? r.interval : 0;
        switch (r.freq) {
            case 'daily': return iv ? 'Every ' + iv + ' days' : 'Daily';
            case 'weekdays': return 'Weekdays';
            case 'weekly': {
                const d = (r.byWeekday || []).map((n) => C.WEEKDAY_NAMES[n - 1].slice(0, 3)).join(', ');
                return (iv ? 'Every ' + iv + ' weeks' : 'Weekly') + (d ? ' on ' + d : '');
            }
            case 'monthly': return iv ? 'Every ' + iv + ' months' : 'Monthly';
        }
        return '';
    };
    NM.relativeDay = function (d) {
        const n = C.diffDays(NM.state.today, d);
        if (n === 0) return 'Today';
        if (n === 1) return 'Tomorrow';
        if (n === -1) return 'Yesterday';
        return n > 0 ? 'In ' + n + ' days' : Math.abs(n) + ' days ago';
    };
    NM.shortDate = function (d) {
        const [y, m, dd] = d.split('-').map(Number);
        return C.WEEKDAY_NAMES[C.weekday(d) - 1].slice(0, 3) + ', ' + C.MONTH_NAMES[m - 1].slice(0, 3) + ' ' + dd + (y !== +NM.state.today.slice(0, 4) ? ', ' + y : '');
    };

    // ---------------- toasts ----------------
    NM.toast = function (msg, kind, ms, action) {
        const root = document.getElementById('toasts');
        if (!root) return;
        const t = h('div', { class: 'toast ' + (kind || ''), role: 'status' }, h('span', { class: 'toast-msg' }, msg));
        if (action) t.appendChild(h('button', { class: 'toast-action', type: 'button', onclick: () => { action.fn(); t.remove(); } }, action.label));
        t.appendChild(h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => t.remove() }, '×'));
        root.appendChild(t);
        setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 300); }, ms || 3500);
    };

    // ---------------- overlay stack (Esc closes the topmost) ----------------
    const stack = [];
    NM.overlayOpen = () => stack.length > 0;
    NM.pushOverlay = function (el, onClose) {
        const entry = { el, onClose, prevFocus: document.activeElement };
        stack.push(entry);
        entry.close = function close() {
            const i = stack.indexOf(entry);
            if (i < 0) return;
            stack.splice(i, 1);
            el.remove();
            if (onClose) onClose();
            if (entry.prevFocus && entry.prevFocus.focus && document.contains(entry.prevFocus)) entry.prevFocus.focus();
        };
        return entry.close;
    };
    NM.closeTopOverlay = function () {
        const top = stack[stack.length - 1];
        if (!top) return false;
        top.close();
        return true;
    };

    /** Generic modal. body: Node; actions: [{label, kind, onClick(close) → false keeps it open}] */
    NM.modal = function (opts) {
        const backdrop = h('div', { class: 'modal-backdrop' });
        const box = h('div', { class: 'modal ' + (opts.cls || ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Dialog' });
        let close;
        if (opts.title) box.appendChild(h('div', { class: 'modal-head' }, h('h2', null, opts.title), NM.iconBtn('x', 'Close', () => close())));
        const body = h('div', { class: 'modal-body' }, opts.body);
        box.appendChild(body);
        if (opts.actions && opts.actions.length) {
            box.appendChild(h('div', { class: 'modal-actions' }, opts.actions.map((a) => h('button', {
                class: 'btn ' + (a.kind || ''), type: 'button',
                onclick: async () => { const r = a.onClick ? await a.onClick(close) : undefined; if (r !== false) close(); }
            }, a.label))));
        }
        backdrop.appendChild(box);
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        document.body.appendChild(backdrop);
        close = NM.pushOverlay(backdrop, opts.onClose);
        const f = box.querySelector('[autofocus]') || box.querySelector('input, textarea, select, .btn.primary');
        if (f) setTimeout(() => f.focus(), 30);
        return { close, box, body };
    };

    NM.confirm = function (message, okLabel, danger) {
        return new Promise((resolve) => {
            let result = false;
            NM.modal({
                title: 'Please confirm', body: h('p', { class: 'modal-text' }, message), onClose: () => resolve(result),
                actions: [{ label: 'Cancel' }, { label: okLabel || 'OK', kind: danger ? 'danger' : 'primary', onClick: () => { result = true; } }]
            });
        });
    };
    /** options: [{label, value, kind}] → resolves value or null */
    NM.choose = function (title, message, options) {
        return new Promise((resolve) => {
            let result = null;
            NM.modal({
                title, body: h('p', { class: 'modal-text' }, message), onClose: () => resolve(result),
                actions: options.map((o) => ({ label: o.label, kind: o.kind, onClick: () => { result = o.value; } }))
            });
        });
    };
    NM.prompt = function (title, label, opts) {
        opts = opts || {};
        return new Promise((resolve) => {
            let result = null;
            const input = h('input', { class: 'input', type: opts.type || 'text', value: opts.value || '', placeholder: opts.placeholder || '', autofocus: true, autocomplete: opts.type === 'password' ? 'off' : null });
            const m = NM.modal({
                title, body: h('label', { class: 'field' }, h('span', null, label), input, opts.hint ? h('small', { class: 'muted' }, opts.hint) : null),
                onClose: () => resolve(result),
                actions: [{ label: 'Cancel' }, { label: opts.ok || 'OK', kind: 'primary', onClick: () => { result = input.value; } }]
            });
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); result = input.value; m.close(); } });
        });
    };

    /** Save a file: desktop shell → native save panel (files.save); browser → download link. data: string | Uint8Array */
    NM.download = function (filename, data, mime) {
        mime = mime || 'application/json';
        if (NM.native) {
            const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
            NM.native.request('files.save', { suggestedName: filename, mime, base64: window.NotemakerVault.b64(bytes) })
                .then((r) => { if (r && r.saved) NM.toast('Saved ' + (r.path || filename), 'ok'); })
                .catch((e) => NM.toast('Could not save the file: ' + e.message, 'error'));
            return;
        }
        const blob = new Blob([data], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: filename });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    /** Open an external http(s)/mailto URL (desktop: default browser via the shell). */
    NM.openExternal = function (url) {
        if (!/^(https?:\/\/|mailto:)/i.test(String(url || ''))) return;
        if (NM.native) NM.native.request('app.openExternal', { url }).catch(() => { /* */ });
        else window.open(url, '_blank', 'noopener,noreferrer');
    };

    NM.isTyping = function (e) {
        const t = e.target;
        if (!t || !t.tagName) return false;
        return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    };
})();

// '1 task' / '2 tasks'
window.NM = window.NM || {};
NM.plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
