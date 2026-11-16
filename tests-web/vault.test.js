const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require('crypto').webcrypto;
const V = require('../js/vault-core.js');
const C = require('../js/core.js');

const vec = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/vault-test-vector.json'), 'utf8'));
const slot = (type) => vec.vault.keyslots.find((s) => s.type === type);
const b64 = (u) => Buffer.from(u).toString('base64');

test('recovery key: encode matches vector, decode round-trips, separators/look-alikes tolerated', async () => {
    const bytes = V.unb64(vec.recoveryBytes);
    assert.equal(await V.formatRecoveryKey(bytes), vec.recoveryKey);
    assert.equal(vec.recoveryKey.split('-').length, 11);
    assert.deepEqual(await V.parseRecoveryKey(vec.recoveryKey), bytes);
    const sloppy = ' ' + vec.recoveryKey.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l') + ' ';
    assert.deepEqual(await V.parseRecoveryKey(sloppy), bytes);
    const fresh = await V.generateRecoveryKey();
    assert.match(fresh.text, /^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/);
    assert.deepEqual(await V.parseRecoveryKey(fresh.text), fresh.bytes);
});

test('recovery key: checksum and format failures', async () => {
    const k = vec.recoveryKey;
    const swapped = (k[0] === '2' ? '3' : '2') + k.slice(1); // single-character typo
    await assert.rejects(() => V.parseRecoveryKey(swapped), (e) => e.code === 'checksum');
    await assert.rejects(() => V.parseRecoveryKey(k.slice(0, -6)), (e) => e.code === 'format');
    await assert.rejects(() => V.parseRecoveryKey(k.replace(/^./, 'U')), (e) => e.code === 'format', 'U is not in the Crockford alphabet');
});

test('recovery slot unwraps to the vector VDK; verifier checks', async () => {
    const raw = await V.openRecoverySlot(slot('recovery'), V.unb64(vec.recoveryBytes));
    assert.equal(b64(raw), vec.vdk);
    const key = await V.importVdk(raw);
    assert.equal(key.extractable, false, 'session key is non-extractable');
    assert.equal(await V.checkVerifier(key, vec.vault.verifier), true);
    const wrong = await V.importVdk(V.randomBytes(32));
    assert.equal(await V.checkVerifier(wrong, vec.vault.verifier), false);
    const { raw: r2 } = await V.unlockWithRecovery(vec.vault, vec.recoveryKey);
    assert.equal(b64(r2), vec.vdk);
    const other = await V.generateRecoveryKey();
    await assert.rejects(() => V.unlockWithRecovery(vec.vault, other.text), (e) => e.code === 'wrong-key');
});

test('passkey-prf slot unwraps with the vector PRF output; wrong PRF fails', async () => {
    const raw = await V.openPasskeySlot(slot('passkey-prf'), V.unb64(vec.prfOutput));
    assert.equal(b64(raw), vec.vdk);
    await assert.rejects(() => V.openPasskeySlot(slot('passkey-prf'), V.randomBytes(32)), (e) => e.code === 'wrong-key');
});

test('secure-enclave slot math (software key stand-in) unwraps to the VDK', async () => {
    const priv = await crypto.subtle.importKey('jwk', vec.seSoftwarePrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const raw = await V.openSecureEnclaveSlot(slot('secure-enclave'), priv);
    assert.equal(b64(raw), vec.vdk);
});

test('all 4 items decrypt to the expected payloads; blob decrypts and matches sha256', async () => {
    const key = await V.importVdk(V.unb64(vec.vdk));
    for (const item of vec.vault.items) {
        assert.deepEqual(await V.decryptItem(key, item), vec.expectedPayloads[item.id], item.id);
    }
    const file = vec.expectedPayloads['aaaaaaaa-0000-4000-8000-000000000004'];
    const bytes = await V.decryptBlob(key, file.blobId, vec.vault.blobs[file.blobId]);
    assert.equal(b64(bytes), vec.fileBytes);
    assert.equal(bytes.length, file.size);
    assert.equal(await V.sha256Hex(bytes), file.sha256);
    // AAD binds ciphertext to its id: moving an item's ct to another id must fail
    const moved = Object.assign({}, vec.vault.items[0], { id: vec.vault.items[1].id });
    await assert.rejects(() => V.decryptItem(key, moved));
    await assert.rejects(() => V.decryptBlob(key, 'other-id', vec.vault.blobs[file.blobId]));
});

test('normalizeVault keeps all slot types (unknown ones preserved), drops garbage, strips blobs', () => {
    const n = V.normalizeVault(vec.vault);
    assert.deepEqual(n.keyslots.map((s) => s.type), ['secure-enclave', 'passkey-prf', 'recovery']);
    assert.equal(n.items.length, 4);
    assert.equal(n.blobs, undefined);
    assert.deepEqual(Object.keys(V.extractBlobs(vec.vault)), ['bbbbbbbb-0000-4000-8000-000000000001']);
    assert.equal(V.normalizeVault({ verifier: { iv: 'x', ct: 'y' }, keyslots: [] }), null);
    const hostile = JSON.parse(JSON.stringify(vec.vault));
    hostile.keyslots.push({ id: 'future', type: 'future-key', extra: { nested: [1, 2] }, iv: 'AAAAAAAAAAAAAAAA', ct: 'AA==' }); // unknown type → preserved
    hostile.keyslots.push({ id: 'evil', type: '<script>', iv: 'AAAAAAAAAAAAAAAA', ct: 'AA==' });                       // not a type name → dropped
    hostile.keyslots.push({ id: 'big', type: 'huge-key', blob: 'x'.repeat(20000), iv: 'AAAAAAAAAAAAAAAA', ct: 'AA==' });  // over the size limit → dropped
    hostile.keyslots.push({ id: 'noct', type: 'future-key', iv: 'AAAAAAAAAAAAAAAA' });                                 // missing common fields → dropped
    hostile.items.push({ id: '<img onerror=x>', iv: 'not base64!', ct: 'x' });
    const h = V.normalizeVault(hostile);
    assert.equal(h.keyslots.length, 4);
    assert.deepEqual(h.keyslots[3].extra, { nested: [1, 2] });
    assert.equal(h.keyslots[3].label, 'future-key');
    assert.equal(h.items.length, 4);
    assert.equal(V.normalizePayload({ type: 'login', title: { x: 1 }, password: 5, evil: '<script>' }).password, '5');
    assert.equal(V.normalizePayload({ type: 'weird' }).type, 'note');
});

test('password generator and strength meter', () => {
    for (const len of [8, 20, 64]) {
        const pw = V.generatePassword({ length: len, symbols: true, avoidLookalikes: true });
        assert.equal(pw.length, len);
        assert.doesNotMatch(pw, /[O0Il1|]/);
        assert.match(pw, /[a-z]/); assert.match(pw, /[A-Z]/); assert.match(pw, /[2-9]/);
    }
    assert.match(V.generatePassword({ length: 12, upper: false, digits: false, symbols: false }), /^[a-z]{12}$/);
    assert.equal(V.generatePassword({ length: 200 }).length, 64);
    assert.equal(V.generatePassword({ length: 2 }).length, 8);
    assert.ok(V.passwordStrength('password').score <= 1);
    assert.equal(V.passwordStrength(V.generatePassword({ length: 24 })).score, 4);
});

test('full round trip: new vault + recovery slot + items + blob → export → import → open with recovery key', async () => {
    let raw = V.generateVdkRaw();
    const key = await V.importVdk(raw.slice());
    const vault = await V.newVault('hardware+recovery', key);
    const rec = await V.generateRecoveryKey();
    vault.keyslots.push(await V.makeRecoverySlot(raw, rec.bytes));
    vault.keyslots.push(await V.makePasskeySlot(raw, V.randomBytes(32), { credentialId: V.b64url(V.randomBytes(16)), rpId: 'localhost', prfSalt: V.randomBytes(32) }));
    raw.fill(0);
    const fileBytes = new TextEncoder().encode('hello vault file');
    const blobId = V.uuid();
    const enc = await V.encryptBlob(key, blobId, fileBytes);
    const payloads = {
        [V.uuid()]: { type: 'login', title: 'Mail', username: 'me', password: 'p@ss', url: 'https://mail.example', totpSecret: '', favorite: true, notes: '', tags: ['work'] },
        [V.uuid()]: { type: 'file', title: 'Doc', fileName: 'a.txt', mime: 'text/plain', size: fileBytes.length, blobId, sha256: await V.sha256Hex(fileBytes), favorite: false, notes: '', tags: [] }
    };
    for (const id of Object.keys(payloads)) vault.items.push(await V.encryptItem(key, id, payloads[id]));

    const doc = C.emptyDoc();
    doc.vault = vault;
    const exported = C.exportDoc(doc, '2026-11-16T00:00:00Z');
    exported.vault.blobs = { [blobId]: { iv: V.b64(enc.iv), ct: V.b64(enc.ct) } };
    const text = JSON.stringify(exported);
    assert.doesNotMatch(text, /p@ss|Mail|hello vault/, 'no plaintext in the export');

    const parsed = JSON.parse(text);
    const blobs = V.extractBlobs(parsed.vault);
    const imported = C.importToDoc(parsed);
    assert.equal(imported.vault.items.length, 2);
    assert.equal(imported.vault.blobs, undefined, 'blobs are stored separately, not in the document');
    const { raw: r2 } = await V.unlockWithRecovery(imported.vault, rec.text.replace(/-/g, ' '));
    const key2 = await V.sessionKey(imported.vault, r2);
    assert.ok(r2.every((b) => b === 0), 'raw VDK zeroed after import');
    for (const item of imported.vault.items) assert.deepEqual(await V.decryptItem(key2, item), V.normalizePayload(payloads[item.id]));
    const back = await V.decryptBlob(key2, blobId, blobs[blobId]);
    assert.equal(new TextDecoder().decode(back), 'hello vault file');
    assert.equal(imported.settings.vaultAutoLockMinutes, 5);
});

test('vault test-vector document imports through the v2 importer', () => {
    const doc = C.importToDoc({ app: 'notemaker', version: 2, tasks: [], notes: {}, vault: vec.vault, settings: { vaultAutoLockMinutes: 12 } });
    assert.equal(doc.vault.keyslots.length, 3);
    assert.equal(doc.settings.vaultAutoLockMinutes, 12);
    // merge: local without a vault adopts the incoming one; a local vault is never overwritten
    const local = C.emptyDoc();
    const m1 = C.mergeDocs(local, doc);
    assert.equal(m1.doc.vault.items.length, 4);
    assert.equal(m1.stats.vaultAdopted, true);
    const m2 = C.mergeDocs(m1.doc, C.importToDoc({ version: 2, vault: Object.assign({}, vec.vault, { items: [] }) }));
    assert.equal(m2.doc.vault.items.length, 4);
    assert.equal(m2.stats.vaultSkipped, true);
});
