const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require('crypto').webcrypto;
const C = require('../js/core.js');
const V = require('../js/vault-core.js');
const N = require('../js/native.js');

const vec = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/vault-test-vector.json'), 'utf8'));
const v1 = fs.readFileSync(path.join(__dirname, 'fixtures/v1-export.json'), 'utf8');
const sample = fs.readFileSync(path.join(__dirname, 'fixtures/sample-v2.json'), 'utf8');

/** Fake shell: window-like EventTarget with NotemakerNative.request routed to handlers; records calls. */
function fakeShell(handlers) {
    const win = new EventTarget();
    const calls = [];
    win.NotemakerNative = {
        isDesktop: true, platform: 'macos', shellVersion: '1.0.0',
        request(method, params) {
            calls.push({ method, params });
            const h = handlers[method];
            if (!h) return Promise.reject(new Error('unknown method ' + method));
            try { return Promise.resolve(h(params)); } catch (e) { return Promise.reject(e); }
        }
    };
    const emit = (detail) => win.dispatchEvent(new CustomEvent('notemaker-native', { detail }));
    return { win, calls, emit };
}
function fakeStorage(init) {
    const m = new Map(Object.entries(init || {}));
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}
function manualTimers() {
    const q = [];
    return { set: (fn) => { q.push(fn); return q.length; }, clear: (id) => { q[id - 1] = null; }, run: () => { const fns = q.splice(0); fns.forEach((f) => f && f()); } };
}

test('createBridge: null in a browser, request + events in the shell', async () => {
    assert.equal(N.createBridge(new EventTarget()), null);
    assert.equal(N.createBridge(null), null);
    const shell = fakeShell({ 'se.available': () => ({ available: true, device: 'Test Mac' }) });
    const b = N.createBridge(shell.win);
    assert.equal(b.isDesktop, true);
    assert.deepEqual(await b.request('se.available'), { available: true, device: 'Test Mac' });
    await assert.rejects(() => b.request('nope'), /unknown method/);
    const seen = [];
    b.on('menu', (d) => seen.push(d.command));
    b.on('openDay', (d) => seen.push(d.day));
    shell.emit({ type: 'menu', command: 'view:vault' });
    shell.emit({ type: 'openDay', day: '2026-11-20' });
    shell.emit({ type: 'other' });
    assert.deepEqual(seen, ['view:vault', '2026-11-20']);
});

test('storage: loads data.json from the shell and saves debounced', async () => {
    let saved = [];
    const shell = fakeShell({ 'storage.load': () => ({ json: sample }), 'storage.save': (p) => { saved.push(p.json); return { ok: true }; } });
    const t = manualTimers();
    const p = N.createPersistence({ bridge: N.createBridge(shell.win), storage: fakeStorage(), core: C, setTimer: t.set, clearTimer: t.clear });
    const r = await p.load();
    assert.equal(r.source, 'native');
    assert.equal(r.doc.tasks.length, JSON.parse(sample).tasks.length);
    assert.equal(saved.length, 0, 'loading existing data does not write');
    r.doc.tasks[0].title = 'one'; p.save(r.doc);
    r.doc.tasks[0].title = 'two'; p.save(r.doc);
    assert.equal(saved.length, 0, 'debounced');
    t.run();
    await p.flush();
    assert.equal(saved.length, 1, 'two saves coalesced into one write');
    assert.equal(JSON.parse(saved[0]).tasks[0].title, 'two');
    r.doc.tasks[0].title = 'three'; p.save(r.doc);
    await p.flush(); // beforeunload / beforeQuit path
    assert.equal(JSON.parse(saved[1]).tasks[0].title, 'three');
});

test('storage: first launch migrates localStorage v2, then v1 keys; leaves localStorage untouched', async () => {
    for (const [ls, source, nTasks] of [
        [{ notemaker_v2: sample }, 'local-v2', JSON.parse(sample).tasks.length],
        [{ notemaker_tasks: JSON.stringify(JSON.parse(v1).tasks), notemaker_notes: JSON.stringify(JSON.parse(v1).notes) }, 'local-v1', 4],
        [{}, 'new', 0]
    ]) {
        const saved = [];
        const shell = fakeShell({ 'storage.load': () => ({ json: null }), 'storage.save': (p) => { saved.push(p.json); return { ok: true }; } });
        const store = fakeStorage(ls);
        const r = await N.createPersistence({ bridge: N.createBridge(shell.win), storage: store, core: C }).load();
        assert.equal(r.source, source);
        assert.equal(r.doc.tasks.length, nTasks);
        assert.equal(saved.length, 1, 'written to data.json immediately');
        assert.equal(JSON.parse(saved[0]).version, 2);
        assert.equal(store.map.size, Object.keys(ls).length, 'localStorage kept as a backup');
    }
});

test('storage: tolerates SwiftUI-era data.json (weekStartsOn 0–7, unknown fields); never overwrites unreadable data.json', async () => {
    const legacy = JSON.parse(sample);
    legacy.settings.weekStartsOn = 0;
    legacy.someFutureField = { x: 1 };
    const shell = fakeShell({ 'storage.load': () => ({ json: JSON.stringify(legacy) }), 'storage.save': () => ({ ok: true }) });
    const r = await N.createPersistence({ bridge: N.createBridge(shell.win), storage: fakeStorage(), core: C }).load();
    assert.equal(r.doc.settings.weekStartsOn, 7, '0 = Sunday → 7');
    for (const w of [1, 7]) assert.equal(C.normalizeSettings({ weekStartsOn: w }).weekStartsOn, w);

    const saves = [];
    const bad = fakeShell({ 'storage.load': () => ({ json: '{not json' }), 'storage.save': (p) => saves.push(p) });
    const p = N.createPersistence({ bridge: N.createBridge(bad.win), storage: fakeStorage(), core: C, delay: 0 });
    const r2 = await p.load();
    assert.ok(r2.error);
    p.save(r2.doc); await p.flush();
    assert.equal(saves.length, 0);
});

test('browser persistence (no bridge) keeps the localStorage behaviour', async () => {
    const store = fakeStorage({ notemaker_v2: sample });
    const p = N.createPersistence({ bridge: null, storage: store, core: C });
    const r = await p.load();
    assert.equal(r.source, 'local-v2');
    r.doc.tasks = [];
    p.save(r.doc);
    assert.equal(JSON.parse(store.getItem('notemaker_v2')).tasks.length, 0, 'synchronous write');
});

test('notify.sync payload: next 14 days, future only, done occurrences skipped, recurring expanded, max 60', () => {
    const now = new Date(2026, 10, 16, 10, 0, 0); // Mon 2026-11-16 10:00 local
    const doc = C.emptyDoc();
    doc.tasks = [
        C.normalizeTask({ id: 'past', title: 'Past', date: '2026-11-16', reminder: '09:00' }),
        C.normalizeTask({ id: 'later', title: 'Later', date: '2026-11-16', reminder: '15:00', tags: ['work'] }),
        C.normalizeTask({ id: 'done', title: 'Done', date: '2026-11-17', reminder: '15:00', done: true }),
        C.normalizeTask({ id: 'far', title: 'Far', date: '2026-12-15', reminder: '08:00' }),
        C.normalizeTask({ id: 'none', title: 'No reminder', date: '2026-11-17' }),
        C.normalizeTask({ id: 'daily', title: 'Pills', date: '2026-11-01', reminder: '08:00', recurrence: { freq: 'daily' }, doneDates: { '2026-11-18': true } }),
        C.normalizeTask({ id: 'wk', title: 'Gym', date: '2026-11-16', reminder: '18:30', recurrence: { freq: 'weekly', byWeekday: [1, 4] } })
    ];
    const items = N.reminderSchedule(doc, now, C);
    const ids = items.map((i) => i.id);
    assert.ok(!ids.some((i) => i.startsWith('past|') || i.startsWith('done|') || i.startsWith('far|') || i.startsWith('none|')));
    assert.ok(ids.includes('later|2026-11-16'));
    const daily = ids.filter((i) => i.startsWith('daily|'));
    assert.equal(daily.length, 12, '13 future days (Nov 17–29) minus the done Nov 18');
    assert.ok(!ids.includes('daily|2026-11-16'), 'today 08:00 already passed');
    assert.deepEqual(ids.filter((i) => i.startsWith('wk|')), ['wk|2026-11-16', 'wk|2026-11-19', 'wk|2026-11-23', 'wk|2026-11-26']);
    const later = items.find((i) => i.id === 'later|2026-11-16');
    assert.equal(later.at, new Date(2026, 10, 16, 15, 0).toISOString());
    assert.equal(later.day, '2026-11-16');
    assert.equal(later.title, '⏰ Later');
    assert.match(later.body, /15:00 · #work/);
    assert.deepEqual(items.map((i) => i.at), items.map((i) => i.at).slice().sort(), 'soonest first');

    for (let i = 0; i < 10; i++) doc.tasks.push(C.normalizeTask({ id: 'm' + i, title: 'Many', date: '2026-11-01', reminder: '12:00', recurrence: { freq: 'daily' } }));
    const capped = N.reminderSchedule(doc, now, C);
    assert.equal(capped.length, 60);
    assert.ok(capped.every((i) => i.at > now.toISOString()));
    assert.equal(N.remainingCount(doc, '2026-11-16', C), 14, 'past, later, daily, wk + 10 daily');
});

test('Secure Enclave slot path: mocked se.unwrapSlot returns the vector VDK', async () => {
    const vault = V.normalizeVault(vec.vault);
    const shell = fakeShell({ 'se.unwrapSlot': (p) => { assert.equal(p.slot.type, 'secure-enclave'); return { vdk: vec.vdk }; } });
    const bridge = N.createBridge(shell.win);
    const { raw, slot } = await N.seVault.unlock(bridge, V, vault);
    assert.equal(Buffer.from(raw).toString('base64'), vec.vdk);
    assert.equal(slot.id, '22222222-2222-4222-8222-222222222222');
    const key = await V.sessionKey(vault, raw);
    assert.ok(raw.every((b) => b === 0), 'raw VDK zeroed');
    assert.equal(key.extractable, false);
    const item = await V.decryptItem(key, vault.items[1]);
    assert.equal(item.password, 'Tr0ub4dor&3-ü');
});

test('Secure Enclave errors: cancelled, not-this-device, wrong VDK', async () => {
    const vault = V.normalizeVault(vec.vault);
    const mk = (fn) => N.createBridge(fakeShell({ 'se.unwrapSlot': fn }).win);
    await assert.rejects(() => N.seVault.unlock(mk(() => { throw new Error('cancelled'); }), V, vault), (e) => e.code === 'cancelled');
    await assert.rejects(() => N.seVault.unlock(mk(() => { throw new Error('not-this-device'); }), V, vault), (e) => e.code === 'not-this-device' && /recovery key/.test(e.message));
    await assert.rejects(() => N.seVault.unlock(mk(() => ({ vdk: V.b64(V.randomBytes(32)) })), V, vault), (e) => e.code === 'wrong-key');
    const noSe = Object.assign({}, vault, { keyslots: vault.keyslots.filter((s) => s.type !== 'secure-enclave') });
    await assert.rejects(() => N.seVault.unlock(mk(() => ({})), V, noSe), (e) => e.code === 'no-slot');
});

test('Secure Enclave createSlot passes the VDK as base64 and validates the returned slot', async () => {
    const raw = V.unb64(vec.vdk);
    const seSlot = vec.vault.keyslots[0];
    let got;
    const bridge = N.createBridge(fakeShell({ 'se.createSlot': (p) => { got = p; return Object.assign({}, seSlot, { id: p.slotId, label: p.label }); } }).win);
    const slot = await N.seVault.createSlot(bridge, V, raw, 'Test Mac');
    assert.equal(got.vdk, vec.vdk);
    assert.equal(slot.type, 'secure-enclave');
    assert.equal(slot.id, got.slotId);
    const bad = N.createBridge(fakeShell({ 'se.createSlot': () => ({ type: 'recovery' }) }).win);
    await assert.rejects(() => N.seVault.createSlot(bad, V, raw, 'x'), /invalid keyslot/);
    const cancel = N.createBridge(fakeShell({ 'se.createSlot': () => { throw new Error('cancelled'); } }).win);
    await assert.rejects(() => N.seVault.createSlot(cancel, V, raw, 'x'), (e) => e.code === 'cancelled');
    const se = await N.seVault.available(N.createBridge(fakeShell({ 'se.available': () => ({ available: true, device: 'MBP' }) }).win));
    assert.deepEqual(se, { available: true, device: 'MBP' });
});

// ---------------- v1.2: Touch ID policy, error screens, lock-on-hide, vaultState, concealed copy ----------------
test('Touch ID only: switchPolicy creates the new slot first, then deletes the old one', async () => {
    const vault = V.normalizeVault(vec.vault);
    const raw = V.unb64(vec.vdk);
    const oldSe = vault.keyslots.find((s) => s.type === 'secure-enclave');
    const order = [];
    const shell = fakeShell({
        'se.createSlot': (p) => { order.push('create'); assert.equal(p.biometryOnly, true); assert.equal(p.vdk, vec.vdk);
            return Object.assign({}, oldSe, { id: p.slotId, label: p.label, policy: 'biometry-current-set' }); },
        'se.deleteSlot': (p) => { order.push('delete:' + p.slotId); return { ok: true }; }
    });
    const r = await N.seVault.switchPolicy(N.createBridge(shell.win), V, vault, raw, { label: 'MBP', biometryOnly: true, oldSlotIds: [oldSe.id] });
    assert.deepEqual(order, ['create', 'delete:' + oldSe.id], 'create before delete');
    assert.equal(r.slot.policy, 'biometry-current-set');
    assert.ok(!r.keyslots.some((s) => s.id === oldSe.id), 'old slot removed');
    assert.ok(r.keyslots.some((s) => s.id === r.slot.id));
    assert.equal(r.keyslots.length, vault.keyslots.length);
    assert.deepEqual(r.deleteFailed, []);
    assert.equal(vault.keyslots.length, 3, 'input vault not mutated');
});

test('Touch ID only: failures leave the vault unchanged; a failed handle delete still drops the old slot from the vault', async () => {
    const vault = V.normalizeVault(vec.vault);
    const before = JSON.stringify(vault);
    const oldSe = vault.keyslots.find((s) => s.type === 'secure-enclave');
    for (const msg of ['biometry-unavailable', 'cancelled', 'some native failure']) {
        let deleted = false;
        const b = N.createBridge(fakeShell({ 'se.createSlot': () => { throw new Error(msg); }, 'se.deleteSlot': () => { deleted = true; return { ok: true }; } }).win);
        await assert.rejects(() => N.seVault.switchPolicy(b, V, vault, V.unb64(vec.vdk), { biometryOnly: true, oldSlotIds: [oldSe.id] }),
            (e) => (msg === 'some native failure' ? e.code === 'error' : e.code === msg));
        assert.equal(deleted, false, 'old key untouched when the new one couldn’t be made');
        assert.equal(JSON.stringify(vault), before);
    }
    const b2 = N.createBridge(fakeShell({
        'se.createSlot': (p) => Object.assign({}, oldSe, { id: p.slotId, policy: 'user-presence' }),
        'se.deleteSlot': () => { throw new Error('not-this-device'); }
    }).win);
    const r = await N.seVault.switchPolicy(b2, V, vault, V.unb64(vec.vdk), { biometryOnly: false, oldSlotIds: [oldSe.id] });
    assert.deepEqual(r.deleteFailed, [oldSe.id]);
    assert.ok(!r.keyslots.some((s) => s.id === oldSe.id), 'the old wrap is gone, so the old key can’t open the vault');
    const unavailable = await assert.rejects(() => N.seVault.createSlot(N.createBridge(fakeShell({ 'se.createSlot': () => { throw new Error('biometry-unavailable'); } }).win), V, V.unb64(vec.vdk), 'x', true),
        (e) => /System Settings/.test(e.message));
    void unavailable;
});

test('se.capabilities and slot policy survive normalisation', async () => {
    const caps = await N.seVault.capabilities(N.createBridge(fakeShell({ 'se.capabilities': () => ({ touchID: true, enrolled: false }) }).win));
    assert.deepEqual(caps, { touchID: true, enrolled: false });
    assert.deepEqual(await N.seVault.capabilities(N.createBridge(fakeShell({}).win)), { touchID: false, enrolled: false }, 'older shell');
    const v = JSON.parse(JSON.stringify(vec.vault));
    v.keyslots[0].policy = 'biometry-current-set';
    assert.equal(V.normalizeVault(v).keyslots[0].policy, 'biometry-current-set');
    v.keyslots[0].policy = 'evil';
    assert.equal(V.normalizeVault(v).keyslots[0].policy, undefined);
    const st = C.normalizeSettings({ vaultBiometryOnly: true, vaultLockOnHide: true, vaultAutoLockMinutes: 1440 });
    assert.equal(st.vaultBiometryOnly, true); assert.equal(st.vaultLockOnHide, true); assert.equal(st.vaultAutoLockMinutes, 1440);
    assert.deepEqual([C.defaultSettings().vaultBiometryOnly, C.defaultSettings().vaultLockOnHide], [false, false]);
});

test('unlock error codes → screens', async () => {
    const vault = V.normalizeVault(vec.vault);
    const changed = await N.seVault.unlock(N.createBridge(fakeShell({ 'se.unwrapSlot': () => { throw new Error('biometry-changed'); } }).win), V, vault).catch((e) => e);
    assert.equal(changed.code, 'biometry-changed');
    assert.equal(changed.slotId, '22222222-2222-4222-8222-222222222222', 'the dead slot is named so it can be replaced');
    assert.equal(changed.screen.recovery, true); assert.equal(changed.screen.hardware, false); assert.equal(changed.screen.replaceSlot, true);
    assert.match(changed.screen.text, /^Your fingerprints changed, so this Mac’s Touch ID key no longer works\. Unlock with your recovery key, then set up Touch ID again\.$/);
    const un = N.seErrorScreen('biometry-unavailable', 'user-presence');
    assert.equal(un.hardware, true, 'Mac password still works');
    assert.match(un.text, /Use your Mac password or recovery key\./);
    const unOnly = N.seErrorScreen('biometry-unavailable', 'biometry-current-set');
    assert.equal(unOnly.hardware, false, 'Touch ID only → recovery key only');
    assert.match(unOnly.text, /use your recovery key/);
    const lockout = N.seErrorScreen('biometry-lockout');
    assert.equal(lockout.text, 'Too many attempts. Unlock your Mac with your password, then try again.');
    assert.equal(lockout.hardware, true);
    assert.equal(N.seErrorScreen('cancelled').quiet, true);
    const lo = await N.seVault.unlock(N.createBridge(fakeShell({ 'se.unwrapSlot': () => { throw new Error('biometry-lockout'); } }).win), V, vault).catch((e) => e);
    assert.equal(lo.code, 'biometry-lockout');
});

test('lock on hide, vaultState payload, concealed copy params', () => {
    assert.equal(N.shouldLockOnHide({ vaultLockOnHide: true }), true);
    assert.equal(N.shouldLockOnHide({ vaultLockOnHide: false }), false);
    assert.equal(N.shouldLockOnHide(null), false);
    assert.deepEqual(N.vaultStatePayload(true, { vaultAutoLockMinutes: 2 }), { unlocked: true, autoLockMinutes: 2 });
    assert.deepEqual(N.vaultStatePayload(false, { vaultAutoLockMinutes: 99999 }), { unlocked: false, autoLockMinutes: 1440 });
    assert.deepEqual(N.vaultStatePayload(false, {}), { unlocked: false, autoLockMinutes: 5 });
    assert.deepEqual(N.secretClipboardParams('hunter2'), { text: 'hunter2', clearAfterSeconds: 30, concealed: true });
});
