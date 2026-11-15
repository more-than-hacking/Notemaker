// Generates docs/vault-test-vector.json with WebCrypto (Node 20+). Deterministic inputs so
// both apps can assert exact outputs. The "secure-enclave" slot uses a SOFTWARE P-256 key as a
// stand-in for the Secure Enclave key (same math) so the derivation can be tested anywhere.
const { webcrypto: c, createHash } = require('crypto');
const fs = require('fs');
const te = new TextEncoder();
const b64 = (u) => Buffer.from(u).toString('base64');
const seq = (n, start) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
const ALPH = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function crockford(bytes) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += ALPH[(val >>> (bits - 5)) & 31]; bits -= 5; } val &= (1 << bits) - 1; }
  if (bits > 0) out += ALPH[(val << (5 - bits)) & 31];
  return out;
}
async function hkdf(ikm, salt, info) {
  const k = await c.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await c.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, k, 256));
}
async function gcm(keyBytes, iv, plain, aad) {
  const k = await c.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  return new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, k, plain));
}

(async () => {
  const vdk = seq(32, 0x40);
  const rec = seq(32, 0x10);
  const check = createHash('sha256').update(rec).digest().subarray(0, 2);
  const recStr = crockford(Buffer.concat([Buffer.from(rec), check]));
  const recoveryKey = recStr.match(/.{1,5}/g).join('-');

  const verifierIv = seq(12, 0x01);
  const verifier = { iv: b64(verifierIv), ct: b64(await gcm(vdk, verifierIv, te.encode('notemaker-vault-ok'), 'notemaker/vault/v1/verifier')) };

  // recovery slot
  const recSlotId = '11111111-1111-4111-8111-111111111111', recSalt = seq(16, 0x20), recIv = seq(12, 0x30);
  const recWrap = await hkdf(rec, recSalt, 'notemaker/vault/v1/recovery');
  const recovery = { id: recSlotId, type: 'recovery', label: 'Recovery key', createdAt: '2026-11-16T00:00:00Z',
    salt: b64(recSalt), iv: b64(recIv), ct: b64(await gcm(recWrap, recIv, vdk, 'notemaker/vault/v1/slot/' + recSlotId)) };

  // "secure-enclave" slot with software keys (fixed JWKs generated once, test-only)
  const seKP = await c.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephKP = await c.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sePub = new Uint8Array(await c.subtle.exportKey('raw', seKP.publicKey));
  const ephPub = new Uint8Array(await c.subtle.exportKey('raw', ephKP.publicKey));
  const shared = new Uint8Array(await c.subtle.deriveBits({ name: 'ECDH', public: seKP.publicKey }, ephKP.privateKey, 256));
  const seSlotId = '22222222-2222-4222-8222-222222222222', seIv = seq(12, 0x50);
  const seWrap = await hkdf(shared, ephPub, 'notemaker/vault/v1/secure-enclave');
  const seSlot = { id: seSlotId, type: 'secure-enclave', label: 'Test Mac', device: 'Test Mac', createdAt: '2026-11-16T00:00:00Z',
    publicKey: b64(sePub), ephemeralPublicKey: b64(ephPub), iv: b64(seIv),
    ct: b64(await gcm(seWrap, seIv, vdk, 'notemaker/vault/v1/slot/' + seSlotId)) };
  const sePrivJwk = await c.subtle.exportKey('jwk', seKP.privateKey);

  // passkey-prf slot with a fixed fake PRF output
  const prfOut = seq(32, 0x90), pkSalt = seq(16, 0x60), pkIv = seq(12, 0x70), prfSalt = seq(32, 0x80);
  const pkSlotId = '33333333-3333-4333-8333-333333333333';
  const pkWrap = await hkdf(prfOut, pkSalt, 'notemaker/vault/v1/passkey-prf');
  const pkSlot = { id: pkSlotId, type: 'passkey-prf', label: 'Test browser', createdAt: '2026-11-16T00:00:00Z',
    credentialId: 'dGVzdC1jcmVkZW50aWFs', rpId: 'localhost', prfSalt: b64(prfSalt), salt: b64(pkSalt), iv: b64(pkIv),
    ct: b64(await gcm(pkWrap, pkIv, vdk, 'notemaker/vault/v1/slot/' + pkSlotId)) };

  // items
  const common = { favorite: false, notes: '', tags: [] };
  const payloads = [
    ['aaaaaaaa-0000-4000-8000-000000000001', { type: 'note', title: 'Recovery codes', markdown: '- 1234-5678\n- 9999-0000', ...common }],
    ['aaaaaaaa-0000-4000-8000-000000000002', { type: 'login', title: 'Example bank', username: 'raj@example.com', password: 'Tr0ub4dor&3-ü', url: 'https://bank.example.com', totpSecret: '', ...common, favorite: true }],
    ['aaaaaaaa-0000-4000-8000-000000000003', { type: 'card', title: 'Visa', kind: 'card', holder: 'R KUMAR', number: '4111111111111111', expiry: '12/29', cvv: '123', issuer: 'Example Bank', fields: [{ label: 'PIN', value: '0000', secret: true }], ...common }],
  ];
  const blobId = 'bbbbbbbb-0000-4000-8000-000000000001';
  const fileBytes = te.encode('%PDF-1.4 test file bytes ✓');
  payloads.push(['aaaaaaaa-0000-4000-8000-000000000004', { type: 'file', title: 'Passport scan', fileName: 'passport.pdf', mime: 'application/pdf', size: fileBytes.length, blobId, sha256: createHash('sha256').update(fileBytes).digest('hex'), ...common }]);
  const items = [];
  for (let i = 0; i < payloads.length; i++) {
    const [id, p] = payloads[i];
    const iv = seq(12, 0xA0 + i * 12);
    items.push({ id, iv: b64(iv), ct: b64(await gcm(vdk, iv, te.encode(JSON.stringify(p)), id)), createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z' });
  }
  const blobIv = seq(12, 0xE0);
  const blobs = { [blobId]: { iv: b64(blobIv), ct: b64(await gcm(vdk, blobIv, fileBytes, 'blob:' + blobId)) } };

  const vector = {
    _readme: 'Test-only keys. vdk/recoveryBytes/prfOutput/seSoftwarePrivateJwk are given so implementations can assert every step.',
    vdk: b64(vdk), recoveryBytes: b64(rec), recoveryKey, prfOutput: b64(prfOut), seSoftwarePrivateJwk: sePrivJwk,
    expectedPayloads: Object.fromEntries(payloads), fileBytes: b64(fileBytes),
    vault: { version: 1, createdAt: '2026-11-16T00:00:00Z', mode: 'hardware+recovery', verifier, keyslots: [seSlot, pkSlot, recovery], items, blobs },
  };
  fs.writeFileSync(__dirname + '/vault-test-vector.json', JSON.stringify(vector, null, 2));
  console.log('recovery key:', recoveryKey, '| items:', items.length, '| slots:', vector.vault.keyslots.map(s => s.type).join(','));
})();
