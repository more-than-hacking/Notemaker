const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require('crypto').webcrypto;
const C = require('../js/core.js');
const St = require('../js/storage-core.js');
const { FakeDir } = require('./fakefs.js');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample-v2.json'), 'utf8'));
const docWith = (title) => { const d = C.normalizeDoc(JSON.parse(JSON.stringify(sample))); if (title) d.tasks.push(C.normalizeTask({ id: 'x-' + title, title, date: '2026-11-16' })); return d; };
function manualTimers() { const q = []; return { set: (fn) => { q.push(fn); return q.length; }, clear: (i) => { q[i - 1] = null; }, run: () => q.splice(0).forEach((f) => f && f()) }; }

test('folder store: write → read round trip in the macOS data format, previous version kept as one backup', async () => {
    const dir = new FakeDir('Notemaker');
    const store = St.createFolderStore({ handle: dir });
    assert.deepEqual(await store.read(), { doc: null, json: null, meta: null }, 'empty folder');
    const d1 = docWith('one');
    await store.writeNow(d1);
    assert.equal(dir.textOf('notemaker-data.json'), JSON.stringify(d1), 'exactly JSON.stringify of the v2 document');
    assert.equal(dir.textOf('notemaker-data.backup.json'), null, 'no backup before there is a previous version');
    const d2 = docWith('two');
    await store.writeNow(d2);
    assert.equal(dir.textOf('notemaker-data.backup.json'), JSON.stringify(d1));
    const d3 = docWith('three');
    await store.writeNow(d3);
    assert.equal(dir.textOf('notemaker-data.backup.json'), JSON.stringify(d2), 'rotated: only the previous version');
    assert.deepEqual([...dir.map.keys()].sort(), ['notemaker-data.backup.json', 'notemaker-data.json']);
    const r = await St.createFolderStore({ handle: dir }).read();
    assert.deepEqual(r.doc, C.normalizeDoc(d3));
    assert.equal(r.meta.sha.length, 64);
});

test('folder store: a failed write leaves the data file untouched (atomic replace)', async () => {
    const dir = new FakeDir('N');
    const store = St.createFolderStore({ handle: dir });
    const d1 = docWith('safe');
    await store.writeNow(d1);
    dir.failNextWrite = true;
    // the backup write fails first → nothing changed at all
    await assert.rejects(() => store.writeNow(docWith('broken')), /disk full/);
    assert.equal(dir.textOf('notemaker-data.json'), JSON.stringify(d1));
});

test('folder store: debounced saves coalesce; flush writes immediately', async () => {
    const dir = new FakeDir('N');
    const t = manualTimers();
    const store = St.createFolderStore({ handle: dir, setTimer: t.set, clearTimer: t.clear });
    await store.read();
    store.save(docWith('a')); store.save(docWith('b'));
    assert.equal(store.hasPending(), true);
    assert.equal(dir.textOf('notemaker-data.json'), null, 'not yet written');
    t.run(); await store.flush();
    assert.match(dir.textOf('notemaker-data.json'), /"title":"b"/);
    assert.equal(dir.textOf('notemaker-data.backup.json'), null, 'only one write happened');
});

test('permission states: granted / prompt → request / denied', async () => {
    const dir = new FakeDir('N');
    const store = St.createFolderStore({ handle: dir });
    assert.equal(await store.permission(), 'granted');
    dir.perm = 'prompt';
    assert.equal(await store.permission(), 'prompt');
    assert.equal(await store.permission(true), 'granted', 'requestPermission (user gesture)');
    dir.perm = 'prompt'; dir.onRequest = 'denied';
    assert.equal(await store.permission(true), 'denied');
});

test('external changes: same content is ignored; a real change reloads when clean, conflicts when there are unsaved edits', async () => {
    const dir = new FakeDir('N');
    const conflicts = [];
    const t = manualTimers();
    const store = St.createFolderStore({ handle: dir, setTimer: t.set, clearTimer: t.clear, onConflict: (theirs) => conflicts.push(theirs) });
    await store.writeNow(docWith('mine'));
    dir.touch('notemaker-data.json'); // e.g. a sync client re-wrote identical bytes
    assert.deepEqual(await store.checkExternal(), { changed: false });

    const other = docWith('from the Mac app');
    dir.externalWrite('notemaker-data.json', JSON.stringify(other));
    const ext = await store.checkExternal();
    assert.equal(ext.changed, true);
    assert.ok(ext.theirs.doc.tasks.some((x) => x.title === 'from the Mac app'));
    assert.equal(St.externalChangeAction(ext, false), 'reload');
    assert.equal(St.externalChangeAction(ext, true), 'conflict');
    assert.equal(St.externalChangeAction({ changed: false }, true), 'none');

    // a pending local save never overwrites the newer file
    store.save(docWith('local edit'));
    t.run(); await store.flush();
    assert.equal(conflicts.length, 1);
    assert.equal(dir.textOf('notemaker-data.json'), JSON.stringify(other), 'their version is intact');
    assert.equal(store.hasPending(), true, 'our edit is kept pending until the user decides');

    // "Load the newer version": adopt theirs as the baseline
    store.adopt(conflicts[0].meta);
    assert.equal(store.hasPending(), false);
    assert.deepEqual(await store.checkExternal(), { changed: false });
    // "Keep this version": forced write
    await store.writeNow(docWith('kept'), true);
    assert.match(dir.textOf('notemaker-data.json'), /"title":"kept"/);
    // an unreadable external file is a conflict, never a silent reload
    dir.externalWrite('notemaker-data.json', '{broken');
    assert.equal(St.externalChangeAction(await store.checkExternal(), false), 'conflict');
});

test('vault blobs: iv ‖ ct per file in vault-blobs/', async () => {
    const dir = new FakeDir('N');
    const store = St.createFolderStore({ handle: dir });
    const iv = Uint8Array.from({ length: 12 }, (_, i) => i), ct = Uint8Array.from({ length: 40 }, (_, i) => 200 - i);
    await store.blobPut('bbbbbbbb-0000-4000-8000-000000000001', iv, ct);
    const raw = (await dir.getDirectoryHandle('vault-blobs')).map.get('bbbbbbbb-0000-4000-8000-000000000001.bin').bytes;
    assert.equal(raw.length, 52);
    assert.deepEqual(raw.slice(0, 12), iv);
    const back = await store.blobGet('bbbbbbbb-0000-4000-8000-000000000001');
    assert.deepEqual(back.iv, iv); assert.deepEqual(back.ct, ct);
    assert.deepEqual(await store.blobList(), ['bbbbbbbb-0000-4000-8000-000000000001']);
    await store.blobDelete('bbbbbbbb-0000-4000-8000-000000000001');
    assert.equal(await store.blobGet('bbbbbbbb-0000-4000-8000-000000000001'), null);
    await assert.rejects(() => store.blobPut('../evil', iv, ct), /Bad blob id/);
});

test('move to folder: copies data + blobs and verifies by re-reading; detects a bad read-back', async () => {
    const dir = new FakeDir('N');
    const store = St.createFolderStore({ handle: dir });
    const blobs = { b1: { iv: new Uint8Array(12).fill(1), ct: new Uint8Array(30).fill(2) }, b2: { iv: new Uint8Array(12).fill(3), ct: new Uint8Array(17).fill(4) } };
    const d = docWith('moved');
    const r = await store.importAndVerify(d, blobs);
    assert.equal(r.ok, true);
    assert.deepEqual(await store.blobList(), ['b1', 'b2']);
    assert.equal(dir.textOf('notemaker-data.json'), JSON.stringify(d));
    const bad = new FakeDir('Bad');
    bad.corruptReads = true;
    await assert.rejects(() => St.createFolderStore({ handle: bad }).importAndVerify(d, blobs), (e) => e.code === 'verify');
});

test('folder already has data: inspect shows counts and modified date; unreadable data is reported', async () => {
    const dir = new FakeDir('N');
    const store = St.createFolderStore({ handle: dir });
    assert.deepEqual(await store.inspect(), { exists: false });
    await store.writeNow(docWith(null));
    const i = await store.inspect();
    assert.equal(i.exists, true);
    assert.deepEqual(i.counts, { tasks: sample.tasks.length, notes: Object.keys(sample.notes).length, habits: sample.habits.length, vaultItems: 0 });
    assert.ok(i.modified > 0);
    dir.externalWrite('notemaker-data.json', 'not json');
    assert.deepEqual(await store.inspect(), { exists: true, readable: false, modified: i.modified + 1 });
    await assert.rejects(() => store.read(), (e) => e.code === 'unreadable');
});

test('capabilities: folders only on desktop Chromium in a browser, never in the desktop shell', () => {
    assert.equal(St.folderSupported({ hasPicker: true, secure: true }), true, 'Chrome / Edge / Brave / Opera');
    assert.equal(St.folderSupported({ hasPicker: false, secure: true }), false, 'Safari / Firefox');
    assert.equal(St.folderSupported({ hasPicker: true, mobile: true }), false, 'mobile');
    assert.equal(St.folderSupported({ hasPicker: true, native: true }), false, 'Mac app shell hides the feature');
    assert.equal(St.folderSupported({ hasPicker: true, secure: false }), false);
    const ua = {
        safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:132.0) Gecko/20100101 Firefox/132.0',
        ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        edge: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0'
    };
    assert.match(St.installHint(ua.safari, false).text, /^In Safari, choose File › Add to Dock\./);
    assert.match(St.installHint(ua.ios, false).text, /Share › Add to Home Screen/);
    assert.match(St.installHint(ua.chrome, false).text, /Install/);
    assert.equal(St.installHint(ua.edge, false).kind, 'edge');
    assert.equal(St.installHint(ua.firefox, false), null, 'Firefox desktop can’t install');
    assert.equal(St.installHint(ua.safari, true), null, 'already installed');
    assert.equal(St.installHint(ua.safari, false, true), null, 'desktop shell');
    const now = Date.UTC(2026, 10, 16);
    assert.equal(St.hintVisible(null, now), true);
    assert.equal(St.hintVisible(now - 3 * 86400000, now), false, 'dismissed this week');
    assert.equal(St.hintVisible(now - 8 * 86400000, now), true, 'back after a week');
});

test('persistent storage: requested once, after the first save with real data, only where folders aren’t used', () => {
    const base = { supported: true, hasData: true, asked: false, persisted: false, folder: false, native: false };
    assert.equal(St.shouldRequestPersist(base), true);
    assert.equal(St.shouldRequestPersist(Object.assign({}, base, { hasData: false })), false, 'not for an empty notebook');
    assert.equal(St.shouldRequestPersist(Object.assign({}, base, { asked: true })), false, 'only once');
    assert.equal(St.shouldRequestPersist(Object.assign({}, base, { persisted: true })), false);
    assert.equal(St.shouldRequestPersist(Object.assign({}, base, { folder: true })), false);
    assert.equal(St.shouldRequestPersist(Object.assign({}, base, { native: true })), false);
    assert.equal(St.shouldRequestPersist(Object.assign({}, base, { supported: false })), false);
});

test('backup reminder schedule', () => {
    const DAY = 86400000, now = Date.UTC(2026, 10, 16, 12);
    const s = (o) => St.backupReminder(Object.assign({ intervalDays: 14, hasData: true, now, today: '2026-11-16', firstSeenAt: now - 30 * DAY }, o));
    assert.deepEqual(s({ lastBackupAt: now - 15 * DAY }), { due: true, days: 15, never: false });
    assert.equal(s({ lastBackupAt: now - 13 * DAY }).due, false);
    assert.equal(s({ lastBackupAt: null, firstSeenAt: now - 2 * DAY }).due, false, 'new users aren’t nagged right away');
    assert.equal(s({ lastBackupAt: null }).never, true);
    assert.equal(s({ lastBackupAt: now - 15 * DAY, lastNagDay: '2026-11-16' }).due, false, 'once per day');
    assert.equal(s({ lastBackupAt: now - 15 * DAY, intervalDays: 30 }).due, false);
    assert.equal(s({ lastBackupAt: now - 8 * DAY, intervalDays: 7 }).due, true);
    assert.equal(s({ lastBackupAt: now - 99 * DAY, intervalDays: 0 }).due, false, 'off');
    assert.equal(s({ lastBackupAt: now - 99 * DAY, hasData: false }).due, false);
    assert.equal(s({ lastBackupAt: now - 99 * DAY, folderActive: true }).due, false, 'folder users: their data is a file');
    assert.equal(s({ lastBackupAt: now - 99 * DAY, folderActive: true, folderAvailable: false }).due, true, '…unless the folder is unavailable');
    assert.equal(s({ lastBackupAt: now - 99 * DAY, native: true }).due, false, 'not in the Mac app');
});
