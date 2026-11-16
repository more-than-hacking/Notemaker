// Windows / Linux / Android shells (docs/PLATFORMS.md): new keyslot types, generic hw.* flow, transfer source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require('crypto').webcrypto;
const C = require('../js/core.js');
const V = require('../js/vault-core.js');
const N = require('../js/native.js');
const T = require('../js/transfer-core.js');

const hv = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/hw-slot-test-vector.json'), 'utf8'));
const vv = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/vault-test-vector.json'), 'utf8'));
const b64 = (u) => Buffer.from(u).toString('base64');
const slotOf = (type) => hv.keyslots.find((s) => s.type === type);
/** The vector vault with the three new hardware slots added (same VDK + verifier). */
const vaultWithHw = () => V.normalizeVault(Object.assign({}, vv.vault, { keyslots: vv.vault.keyslots.concat(hv.keyslots) }));

function fakeShell(platform, handlers) {
    const win = new EventTarget();
    const calls = [];
    win.NotemakerNative = {
        isDesktop: true, isMobile: platform === 'android', platform,
        request(method, params) {
            calls.push({ method, params });
            const h = handlers[method];
            if (!h) return Promise.reject(new Error('unknown method ' + method));
            try { return Promise.resolve(h(params)); } catch (e) { return Promise.reject(e); }
        }
    };
    return { bridge: N.createBridge(win), calls };
}

// ---------------- 1. keyslot types ----------------
test('normalizeVault keeps windows-hello, fido2-hmac and android-keystore slots with their fields', () => {
    const v = vaultWithHw();
    assert.deepEqual(v.keyslots.map((s) => s.type), ['secure-enclave', 'passkey-prf', 'recovery', 'windows-hello', 'fido2-hmac', 'android-keystore']);
    const wh = v.keyslots.find((s) => s.type === 'windows-hello');
    assert.equal(wh.keyName, slotOf('windows-hello').keyName);
    assert.equal(wh.challenge, slotOf('windows-hello').challenge);
    assert.equal(wh.device, 'Test PC');
    const f = v.keyslots.find((s) => s.type === 'fido2-hmac');
    for (const k of ['credentialId', 'rpId', 'salt', 'hkdfSalt', 'device']) assert.equal(f[k], slotOf('fido2-hmac')[k], k);
    const a = v.keyslots.find((s) => s.type === 'android-keystore');
    assert.equal(a.keyAlias, slotOf('android-keystore').keyAlias);
    assert.equal(a.strongBox, false);
    assert.equal(a.device, 'Test phone');
});

test('each hardware slot type unwraps the vector VDK (software stand-ins for the hardware step), and opens the vault', async () => {
    const v = vaultWithHw();
    const get = (t) => v.keyslots.find((s) => s.type === t);
    const raws = [
        await V.openWindowsHelloSlot(get('windows-hello'), V.unb64(hv.windowsHelloSignature)),
        await V.openFido2Slot(get('fido2-hmac'), V.unb64(hv.fido2HmacSecretOutput)),
        await V.openAndroidKeystoreSlot(get('android-keystore'), V.unb64(hv.androidKeystoreSoftwareKey))
    ];
    for (const raw of raws) assert.equal(b64(raw), hv.vdk);
    // the Windows Hello signature really is a deterministic RSA PKCS#1 v1.5 signature of the challenge
    const rsa = await crypto.subtle.importKey('jwk', hv.windowsHelloSoftwarePrivateJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    assert.equal(b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rsa, V.unb64(get('windows-hello').challenge)))), hv.windowsHelloSignature);
    const key = await V.sessionKey(v, raws[1]);
    assert.equal((await V.decryptItem(key, v.items[1])).password, 'Tr0ub4dor&3-ü');
    await assert.rejects(() => V.openFido2Slot(get('fido2-hmac'), V.randomBytes(32)), (e) => e.code === 'wrong-key');
});

test('malformed new-type slots are dropped; unknown types survive an export → import round trip', () => {
    const bad = [
        Object.assign({}, slotOf('windows-hello'), { challenge: b64(new Uint8Array(16)) }),   // challenge must be 32 bytes
        Object.assign({}, slotOf('fido2-hmac'), { hkdfSalt: 'not base64!' }),
        Object.assign({}, slotOf('android-keystore'), { keyAlias: '' })
    ];
    const v = V.normalizeVault(Object.assign({}, vv.vault, { keyslots: vv.vault.keyslots.concat(bad) }));
    assert.equal(v.keyslots.length, 3);
    const future = { id: '77777777-7777-4777-8777-777777777777', type: 'tpm2-pcr', label: 'New laptop', createdAt: '2027-01-01T00:00:00Z',
        pcrs: [0, 7], handle: '0x81000001', iv: slotOf('fido2-hmac').iv, ct: slotOf('fido2-hmac').ct };
    const doc = C.emptyDoc();
    doc.vault = Object.assign({}, vv.vault, { keyslots: vv.vault.keyslots.concat([future]) });
    const back = C.importToDoc(JSON.parse(JSON.stringify(C.exportDoc(doc))));
    assert.deepEqual(back.vault.keyslots.find((s) => s.type === 'tpm2-pcr'), future);
});

// ---------------- 2. generic hardware flow ----------------
test('hw.* on Windows: create (validated type), unlock, delete; macOS routes to se.*', async () => {
    const wh = slotOf('windows-hello');
    const win = fakeShell('windows', {
        'hw.available': () => ({ kind: 'windows-hello', available: true, device: 'Yash’s PC' }),
        'hw.createSlot': (p) => Object.assign({}, wh, { id: p.slotId, label: p.label }),
        'hw.unwrapSlot': (p) => { assert.equal(p.slot.type, 'windows-hello'); return { vdk: hv.vdk }; },
        'hw.deleteSlot': () => ({ ok: true })
    });
    assert.deepEqual(await N.hwVault.available(win.bridge), { kind: 'windows-hello', available: true, device: 'Yash’s PC', detail: '', pinSet: false });
    const slot = await N.hwVault.createSlot(win.bridge, V, V.unb64(hv.vdk), { label: 'Yash’s PC' });
    assert.equal(slot.type, 'windows-hello');
    assert.deepEqual(Object.keys(win.calls.find((c) => c.method === 'hw.createSlot').params).sort(), ['label', 'slotId', 'vdk'], 'no pin / biometryOnly on Windows');
    const { raw } = await N.hwVault.unlock(win.bridge, V, vaultWithHw());
    assert.equal(b64(raw), hv.vdk);
    await N.hwVault.deleteSlot(win.bridge, slot.id);
    assert.equal(win.calls.pop().method, 'hw.deleteSlot');

    const wrongType = fakeShell('windows', { 'hw.createSlot': (p) => Object.assign({}, slotOf('fido2-hmac'), { id: p.slotId }) });
    await assert.rejects(() => N.hwVault.createSlot(wrongType.bridge, V, V.unb64(hv.vdk), {}), /invalid keyslot/);

    const mac = fakeShell('macos', { 'se.unwrapSlot': () => ({ vdk: hv.vdk }), 'se.deleteSlot': () => ({ ok: true }) });
    await N.hwVault.unlock(mac.bridge, V, vaultWithHw());
    await N.hwVault.deleteSlot(mac.bridge, 'x');
    assert.deepEqual(mac.calls.map((c) => c.method), ['se.unwrapSlot', 'se.deleteSlot']);
    assert.equal(N.hwSlotType('macos'), 'secure-enclave');
    assert.equal(N.hwSlotType('android'), 'android-keystore');
    assert.equal(N.hwSlotType('linux'), 'fido2-hmac');
});

test('Linux FIDO2: PIN required → retried with the PIN; no-device, not-this-device, blocked PIN', async () => {
    const seenPins = [];
    const lin = fakeShell('linux', {
        'hw.unwrapSlot': (p) => { seenPins.push(p.pin); if (!p.pin) throw new Error('pin-required'); if (p.pin !== '2468') throw new Error('pin-invalid'); return { vdk: hv.vdk }; }
    });
    const v = vaultWithHw();
    await assert.rejects(() => N.hwVault.unlock(lin.bridge, V, v), (e) => e.code === 'pin-required' && e.slotId === '55555555-5555-4555-8555-555555555555');
    await assert.rejects(() => N.hwVault.unlock(lin.bridge, V, v, { pin: '0000' }), (e) => e.code === 'pin-invalid');
    const { raw } = await N.hwVault.unlock(lin.bridge, V, v, { pin: '2468' });
    assert.equal(b64(raw), hv.vdk);
    assert.deepEqual(seenPins, [undefined, '0000', '2468']);

    const none = fakeShell('linux', { 'hw.unwrapSlot': () => { throw new Error('no-device'); } });
    const e1 = await N.hwVault.unlock(none.bridge, V, v).catch((e) => e);
    assert.equal(e1.code, 'no-device');
    assert.equal(e1.screen.title, 'Plug in your security key');
    assert.equal(e1.screen.hardware, true);
    const other = fakeShell('linux', { 'hw.unwrapSlot': () => { throw new Error('not-this-device'); } });
    const e2 = await N.hwVault.unlock(other.bridge, V, v).catch((e) => e);
    assert.equal(e2.code, 'not-this-device');
    assert.match(e2.message, /This security key doesn’t open the vault/);
    const blocked = fakeShell('linux', { 'hw.unwrapSlot': () => { throw new Error('pin-blocked'); } });
    const e3 = await N.hwVault.unlock(blocked.bridge, V, v).catch((e) => e);
    assert.equal(e3.screen.hardware, false);
    assert.equal(e3.screen.recovery, true);
    // creating with a PIN passes it through
    const mk = fakeShell('linux', { 'hw.createSlot': (p) => { assert.equal(p.pin, '2468'); return Object.assign({}, slotOf('fido2-hmac'), { id: p.slotId }); } });
    assert.equal((await N.hwVault.createSlot(mk.bridge, V, V.unb64(hv.vdk), { pin: '2468' })).type, 'fido2-hmac');
});

test('Android: biometry-changed names the dead slot; replaceSlot creates before deleting', async () => {
    const v = vaultWithHw();
    const and = fakeShell('android', { 'hw.unwrapSlot': () => { throw new Error('biometry-changed'); } });
    const e = await N.hwVault.unlock(and.bridge, V, v).catch((x) => x);
    assert.equal(e.code, 'biometry-changed');
    assert.equal(e.slotId, '66666666-6666-4666-8666-666666666666');
    assert.equal(e.screen.replaceSlot, true);
    assert.equal(e.screen.text, 'Your fingerprints or sign-in changed, so this phone can’t open the vault with your fingerprint anymore. Unlock with your recovery key, then set it up again.');
    const order = [];
    const rep = fakeShell('android', {
        'hw.createSlot': (p) => { order.push('create'); return Object.assign({}, slotOf('android-keystore'), { id: p.slotId }); },
        'hw.deleteSlot': (p) => { order.push('delete:' + p.slotId); return { ok: true }; }
    });
    const r = await N.hwVault.replaceSlot(rep.bridge, V, v, V.unb64(hv.vdk), { oldSlotIds: ['66666666-6666-4666-8666-666666666666'] });
    assert.deepEqual(order, ['create', 'delete:66666666-6666-4666-8666-666666666666']);
    assert.ok(!r.keyslots.some((s) => s.id === '66666666-6666-4666-8666-666666666666'));
});

test('wording per platform and macOS strings unchanged', () => {
    assert.equal(N.hwTerms('macos').add, 'Add this Mac');
    assert.equal(N.hwTerms('windows').add, 'Add this PC');
    assert.equal(N.hwTerms('android').add, 'Add this phone');
    assert.equal(N.hwTerms('linux').add, 'Add a security key');
    assert.equal(N.hwTerms('web').add, 'Add this browser');
    assert.equal(N.hwTerms('windows').unlock, 'Unlock with Windows Hello');
    assert.equal(N.hwTerms('linux').portable, true);
    assert.equal(N.seErrorScreen('biometry-lockout').text, 'Too many attempts. Unlock your Mac with your password, then try again.');
    assert.match(N.seErrorScreen('biometry-lockout', null, 'windows').text, /Unlock this PC with your PIN or password/);
    assert.match(N.seErrorScreen('cancelled', null, 'windows').text, /^Windows Hello was cancelled/);
    const caps = N.defaultCapabilities('macos');
    assert.equal(caps.badge, true); assert.equal(caps.hardwareKey, 'secure-enclave');
    assert.equal(N.defaultCapabilities('linux').hardwarePin, true);
    assert.equal(N.defaultCapabilities('windows').badge, false);
});

// ---------------- 3. transfer source ----------------
test('transfer source.app records windows / linux / android; unknown values become web', async () => {
    for (const app of ['windows', 'linux', 'android', 'macos', 'web']) {
        const b = await T.buildTransferFile({ doc: T.prepareExportDoc(C.emptyDoc()), source: { app, appVersion: '2.5.0', device: 'X' } });
        assert.equal(b.file.source.app, app);
        assert.equal(T.parseEnvelope(b.fileText).source.app, app);
    }
    const b = await T.buildTransferFile({ doc: T.prepareExportDoc(C.emptyDoc()), source: { app: 'beos' } });
    assert.equal(b.file.source.app, 'web');
    const env = JSON.parse(b.fileText); env.source.app = '<script>';
    assert.equal(T.parseEnvelope(JSON.stringify(env)).source.app, 'web');
});

test('remote images become a placeholder in the offline apps; data: images still render', () => {
    const md = '![cat](https://example.com/cat.png) ![dot](data:image/png;base64,iVBORw0KGgo=)';
    const off = C.markdownToHtml(md, { offlineImages: true });
    assert.match(off, /<span class="md-img-offline" role="img" aria-label="cat">Image not loaded — offline app<\/span>/);
    assert.doesNotMatch(off, /<img src="https/);
    assert.match(off, /<img src="data:image\/png/);
    assert.match(C.markdownToHtml(md), /<img src="https:\/\/example.com\/cat.png"/, 'web and macOS keep remote images');
    assert.match(C.markdownToHtml('![x" onerror="y](https://a.b/c.png)', { offlineImages: true }), /aria-label="x&quot; onerror=&quot;y"/);
});
