const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// WebCrypto: Node ≥ 19 exposes globalThis.crypto; older versions need require('crypto').webcrypto.
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require('crypto').webcrypto;
const C = require('../js/core.js');

const vector = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/crypto-test-vector.json'), 'utf8'));

test('decrypts docs/crypto-test-vector.json', async () => {
    const pt = await C.decryptNote(vector.cipher, vector.passcode);
    assert.equal(pt, vector.plaintext);
});

test('verifies the vector lockHash and rejects a wrong passcode', async () => {
    assert.equal(await C.verifyPasscode(vector.passcode, vector.lockHash), true);
    assert.equal(await C.verifyPasscode('wrong horse', vector.lockHash), false);
});

test('wrong passcode fails to decrypt', async () => {
    await assert.rejects(() => C.decryptNote(vector.cipher, 'nope'), /Wrong passcode/);
});

test('encrypt → decrypt round trip with spec parameters', async () => {
    const text = '# Secret 🔐\nline 2';
    const c = await C.encryptNote(text, 'pa55');
    assert.equal(c.alg, 'AES-GCM-256');
    assert.equal(c.kdf, 'PBKDF2-SHA256');
    assert.equal(c.iterations, 210000);
    assert.equal(C.b64decode(c.salt).length, 16);
    assert.equal(C.b64decode(c.iv).length, 12);
    assert.equal(C.b64decode(c.ct).length, new TextEncoder().encode(text).length + 16, 'ciphertext ‖ 16-byte tag');
    assert.equal(await C.decryptNote(c, 'pa55'), text);
    const lh = await C.makeLockHash('pa55');
    assert.equal(lh.iterations, 210000);
    assert.equal(await C.verifyPasscode('pa55', lh), true);
});

test('tampered ciphertext is rejected', async () => {
    const bad = Object.assign({}, vector.cipher);
    const ct = C.b64decode(bad.ct); ct[0] ^= 1; bad.ct = C.b64encode(ct);
    await assert.rejects(() => C.decryptNote(bad, vector.passcode));
});
