const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require('crypto').webcrypto;
const C = require('../js/core.js');
const V = require('../js/vault-core.js');
const T = require('../js/transfer-core.js');
const N = require('../js/native.js');

const vec = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/transfer-test-vector.json'), 'utf8'));
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample-v2.json'), 'utf8'));
const vectorText = JSON.stringify(vec.file);

test('decrypts docs/transfer-test-vector.json from its code; manifest + docSha256 verify', async () => {
    const env = T.parseEnvelope(vectorText);
    assert.equal(env.source.device, 'Test laptop');
    assert.deepEqual(env.summary, vec.file.summary);
    const payload = await T.openTransferFile(env, vec.code);
    assert.deepEqual(payload.manifest, vec.expectedManifest);
    const v = await T.verifyPayload(payload);
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    assert.equal(payload.doc.tasks[0].title, 'Move to the new laptop');
    assert.ok(payload.doc.vault.blobs['bbbbbbbb-0000-4000-8000-000000000001']);
    assert.equal(await T.formatCode(V.unb64(vec.codeBytes)), vec.code);
    // code input is forgiving: lower case, spaces, O/I/L look-alikes
    const sloppy = vec.code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
    assert.deepEqual(await T.parseCode(sloppy), V.unb64(vec.codeBytes));
});

test('wrong code, tampered ciphertext, typo and format errors', async () => {
    const env = T.parseEnvelope(vectorText);
    const other = await T.generateCode();
    assert.match(other.text, /^([0-9A-HJKMNP-TV-Z]{6}-){5}[0-9A-HJKMNP-TV-Z]{6}$/);
    await assert.rejects(() => T.openTransferFile(env, other.text), (e) => e.code === 'wrong-code' && e.message === 'That code doesn’t match this file.');
    const ct = V.unb64(env.ct); ct[10] ^= 1;
    await assert.rejects(() => T.openTransferFile(Object.assign({}, env, { ct: V.b64(ct) }), vec.code), (e) => e.code === 'wrong-code');
    const typo = (vec.code[0] === '6' ? '7' : '6') + vec.code.slice(1);
    await assert.rejects(() => T.parseCode(typo), (e) => e.code === 'checksum');
    await assert.rejects(() => T.parseCode(vec.code.slice(0, 20)), (e) => e.code === 'format');
    assert.equal(T.normalizeCodeInput('64s36d1n6rvk').display, '64S36D-1N6RVK');
    assert.throws(() => T.parseEnvelope('{"app":"notemaker","version":2,"tasks":[]}'), (e) => e.code === 'json-backup');
    assert.throws(() => T.parseEnvelope('hello'), (e) => e.code === 'not-transfer');
    assert.throws(() => T.parseEnvelope(JSON.stringify(Object.assign({}, vec.file, { version: 2 }))), (e) => e.code === 'version');
    assert.throws(() => T.parseEnvelope(vectorText, T.MAX_BYTES + 1), (e) => e.code === 'too-large');
});

test('verifyPayload reports a docSha256 mismatch and wrong counts', async () => {
    const payload = await T.openTransferFile(T.parseEnvelope(vectorText), vec.code);
    payload.doc.tasks.push(C.normalizeTask({ title: 'sneaked in', date: '2026-11-16' }));
    const r = await T.verifyPayload(payload);
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems.map((p) => p.key).sort(), ['docSha256', 'tasks']);
    assert.equal(r.problems.find((p) => p.key === 'tasks').actual, 2);
});

// ---------- a realistic source device ----------
async function sourceDevice(mode) {
    const doc = C.importToDoc(JSON.parse(JSON.stringify(sample))); // tasks incl. recurring, locked note, habits, templates, sessions, settings
    const raw = V.generateVdkRaw();
    const key = await V.importVdk(raw.slice());
    const vault = await V.newVault(mode, key);
    let recovery = null;
    if (mode === 'hardware+recovery') { recovery = await V.generateRecoveryKey(); vault.keyslots.push(await V.makeRecoverySlot(raw, recovery.bytes)); }
    vault.keyslots.push(await V.makePasskeySlot(raw, V.randomBytes(32), { credentialId: V.b64url(V.randomBytes(16)), rpId: 'localhost', prfSalt: V.randomBytes(32), label: 'Old laptop' }));
    const blobs = {};
    const files = [['passport.pdf', 'application/pdf', '%PDF-1.4 passport ✓'], ['photo.png', 'image/png', '\x89PNG fake image bytes']];
    for (const [name, mime, text] of files) {
        const bytes = new TextEncoder().encode(text);
        const blobId = V.uuid();
        const enc = await V.encryptBlob(key, blobId, bytes);
        blobs[blobId] = { iv: V.b64(enc.iv), ct: V.b64(enc.ct) };
        vault.items.push(await V.encryptItem(key, V.uuid(), { type: 'file', title: name, fileName: name, mime, size: bytes.length, blobId, sha256: await V.sha256Hex(bytes) }));
    }
    vault.items.push(await V.encryptItem(key, V.uuid(), { type: 'login', title: 'Bank', username: 'me', password: 'hunter2', url: 'https://bank.example', totpSecret: '' }));
    doc.vault = vault;
    return { doc, blobs, key, raw, recovery, prefs: { accent: 'forest', lastView: 'planner', dayTab: 'notes', sort: 'priority' } };
}
/** In-memory "device": document + prefs + blob store, applying a restore plan like the UI does. */
function fakeDevice(doc) {
    return {
        doc: doc || C.emptyDoc(), prefs: {}, blobs: {},
        apply(plan) { this.doc = plan.doc; if (plan.prefs) this.prefs = Object.assign({}, plan.prefs); Object.assign(this.blobs, plan.blobs); }
    };
}

test('full round trip into an EMPTY device: doc, prefs and blobs are identical', async () => {
    const src = await sourceDevice('hardware+recovery');
    const exportDoc = T.prepareExportDoc(src.doc, { blobs: src.blobs });
    const built = await T.buildTransferFile({ doc: exportDoc, prefs: src.prefs, source: { app: 'web', appVersion: '2.2.0', device: 'Chrome on macOS' } });
    assert.equal(built.manifest.tasks, sample.tasks.length);
    assert.equal(built.manifest.lockedNotes, 1);
    assert.equal(built.manifest.vaultItems, 3);
    assert.equal(built.manifest.vaultFiles, 2);
    assert.equal(built.manifest.vaultFileBytes, Object.values(src.blobs).reduce((s, b) => s + V.unb64(b.ct).length - 16, 0));
    assert.doesNotMatch(built.fileText, /hunter2|passport|Write report|Bank PIN/, 'no plaintext in the file');
    assert.doesNotMatch(built.fileText, new RegExp(built.code.text.replace(/-/g, '-?')), 'code is not in the file');

    const env = T.parseEnvelope(built.fileText);
    assert.deepEqual(env.summary, { tasks: built.manifest.tasks, notes: built.manifest.notes, vaultItems: 3, vaultFiles: 2, bytes: built.plainBytes });
    const payload = await T.openTransferFile(env, built.code.text);
    assert.equal((await T.verifyPayload(payload)).ok, true);

    const dev = fakeDevice();
    assert.equal(T.shouldShowWelcome(dev.doc, false), true);
    dev.apply(T.planRestore(dev.doc, payload, 'replace'));
    const expected = C.normalizeDoc(JSON.parse(JSON.stringify(src.doc)));
    const strip = (d) => Object.assign({}, d, { exportedAt: null });
    assert.deepEqual(strip(dev.doc), strip(expected));
    assert.deepEqual(dev.prefs, src.prefs);
    assert.deepEqual(dev.blobs, src.blobs);
    assert.equal(dev.doc.vault.blobs, undefined, 'blobs live in blob storage, not the document');
    assert.equal(T.shouldShowWelcome(dev.doc, false), false);

    // the moved vault opens on the new device with the recovery key and every file decrypts
    const { raw } = await V.unlockWithRecovery(dev.doc.vault, src.recovery.text);
    const key = await V.sessionKey(dev.doc.vault, raw);
    for (const item of dev.doc.vault.items) {
        const p = await V.decryptItem(key, item);
        if (p.type === 'file') assert.equal(await V.sha256Hex(await V.decryptBlob(key, p.blobId, dev.blobs[p.blobId])), p.sha256);
    }
    // the locked private note is still encrypted and still opens with its passcode
    const locked = Object.values(dev.doc.notes).find((n) => n.locked);
    assert.equal(locked.markdown, '');
    assert.match(await C.decryptNote(locked.cipher, 'correct horse battery staple'), /Bank PIN/);
});

test('restore into a NON-empty device: Replace and Merge', async () => {
    const src = await sourceDevice('hardware+recovery');
    const built = await T.buildTransferFile({ doc: T.prepareExportDoc(src.doc, { blobs: src.blobs }), prefs: src.prefs, source: { app: 'macos', device: 'Old Mac' } });
    const payload = await T.openTransferFile(T.parseEnvelope(built.fileText), built.code.text);

    const local = C.emptyDoc();
    local.tasks.push(C.normalizeTask({ id: 'local-1', title: 'Only on the new laptop', date: '2026-11-16' }));
    local.settings.theme = 'light';

    const rep = fakeDevice(JSON.parse(JSON.stringify(local)));
    rep.prefs = { accent: 'ocean' };
    rep.apply(T.planRestore(rep.doc, payload, 'replace'));
    assert.ok(!rep.doc.tasks.some((t) => t.id === 'local-1'), 'replace drops local data');
    assert.equal(rep.doc.settings.theme, 'dark', 'replace takes the moved settings');
    assert.deepEqual(rep.prefs, src.prefs);
    assert.equal(Object.keys(rep.blobs).length, 2);

    const mer = fakeDevice(JSON.parse(JSON.stringify(local)));
    mer.prefs = { accent: 'ocean' };
    const plan = T.planRestore(mer.doc, payload, 'merge');
    mer.apply(plan);
    assert.ok(mer.doc.tasks.some((t) => t.id === 'local-1'), 'merge keeps local data');
    assert.equal(mer.doc.tasks.length, sample.tasks.length + 1);
    assert.equal(mer.doc.settings.theme, 'light', 'merge keeps local settings');
    assert.deepEqual(mer.prefs, { accent: 'ocean' }, 'merge keeps local preferences');
    assert.equal(plan.stats.vaultAdopted, true);
    assert.equal(Object.keys(mer.blobs).length, 2);

    // merging into a device that already has its own vault keeps that vault and stores no foreign blobs
    const other = await sourceDevice('hardware+recovery');
    const plan2 = T.planRestore(other.doc, payload, 'merge');
    assert.equal(plan2.stats.vaultSkipped, true);
    assert.deepEqual(plan2.blobs, {});
    assert.equal(plan2.doc.vault.verifier.ct, other.doc.vault.verifier.ct);
});

test('hardware-only vault: create a recovery key → included; move without the vault → omitted and counted as 0', async () => {
    const src = await sourceDevice('hardware-only');
    assert.ok(!src.doc.vault.keyslots.some((s) => s.type === 'recovery'));

    // path 1: create a recovery key now (vault becomes hardware+recovery), then move it
    const rec = await V.generateRecoveryKey();
    src.doc.vault.keyslots.push(await V.makeRecoverySlot(src.raw, rec.bytes));
    src.doc.vault.mode = 'hardware+recovery';
    const b1 = await T.buildTransferFile({ doc: T.prepareExportDoc(src.doc, { blobs: src.blobs }), prefs: {}, source: {} });
    const p1 = await T.openTransferFile(T.parseEnvelope(b1.fileText), b1.code.text);
    assert.equal(p1.manifest.vaultItems, 3);
    assert.equal(p1.doc.vault.mode, 'hardware+recovery');
    const { raw } = await V.unlockWithRecovery(C.normalizeDoc(p1.doc).vault, rec.text);
    assert.equal(raw.length, 32);

    // path 2: move without the vault
    const b2 = await T.buildTransferFile({ doc: T.prepareExportDoc(src.doc, { blobs: src.blobs, omitVault: true }), prefs: {}, source: {} });
    const p2 = await T.openTransferFile(T.parseEnvelope(b2.fileText), b2.code.text);
    assert.equal(p2.doc.vault, null);
    assert.equal(p2.manifest.vaultItems, 0);
    assert.equal(p2.manifest.vaultFiles, 0);
    assert.equal(p2.manifest.vaultFileBytes, 0);
    assert.equal(T.parseEnvelope(b2.fileText).summary.vaultItems, 0);
    assert.equal((await T.verifyPayload(p2)).ok, true);
    assert.doesNotMatch(b2.fileText + JSON.stringify(p2), /verifier/);
});

test('welcome screen logic: only for an empty data set, only once', () => {
    const empty = C.emptyDoc();
    assert.equal(T.isEmptyDoc(empty), true);
    assert.equal(T.shouldShowWelcome(empty, false), true);
    assert.equal(T.shouldShowWelcome(empty, true), false, 'not again after a choice was made');
    const withTask = C.emptyDoc(); withTask.tasks.push(C.normalizeTask({ title: 'x', date: '2026-11-16' }));
    const withNote = C.emptyDoc(); withNote.notes['2026-11-16'] = C.normalizeNote({ markdown: 'hi' });
    const withTemplate = C.emptyDoc(); withTemplate.templates.push({ id: 'custom', name: 'Mine', markdown: '' });
    const withHabit = C.emptyDoc(); withHabit.habits.push(C.normalizeHabit({ name: 'Run' }));
    for (const d of [withTask, withNote, withTemplate, withHabit]) assert.equal(T.shouldShowWelcome(d, false), false);
    const noTemplates = C.emptyDoc(); noTemplates.templates = [];
    assert.equal(T.isEmptyDoc(noTemplates), true);
});

test('restored data drives notify.sync and the file name', async () => {
    const payload = await T.openTransferFile(T.parseEnvelope(vectorText), vec.code);
    const plan = T.planRestore(C.emptyDoc(), payload, 'replace');
    const items = N.reminderSchedule(plan.doc, new Date(2026, 10, 16, 9, 0), C);
    assert.deepEqual(items.map((i) => i.id), ['0f0f0f0f-0000-4000-8000-000000000001|2026-11-16']);
    assert.equal(T.fileName('2026-11-16'), 'Notemaker transfer 2026-11-16.notemaker');
    assert.equal(T.formatBytes(2480), '2.4 KB');
    assert.deepEqual(T.sanitizePrefs({ accent: '<script>', lastView: 'vault', sort: 'x', syncScroll: false }), { lastView: 'vault', syncScroll: false });
});
