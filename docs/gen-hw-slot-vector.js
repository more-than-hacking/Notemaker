// Generates docs/hw-slot-test-vector.json with WebCrypto (Node 20+): one keyslot of each hardware type
// added for Windows / Linux / Android in docs/PLATFORMS.md, made with SOFTWARE stand-ins (same math):
//   windows-hello    a software RSA-2048 key signs `challenge` (RSASSA-PKCS1-v1_5 / SHA-256, deterministic,
//                    exactly what KeyCredential.RequestSignAsync does) → HKDF → AES-GCM wrap
//   fido2-hmac       a fixed 32-byte "hmac-secret output" → HKDF(salt = hkdfSalt) → AES-GCM wrap
//   android-keystore a software AES-256 key encrypts the VDK directly (iv + slot AAD), like the Keystore key
// The VDK and verifier are the same as docs/vault-test-vector.json, so these slots open that vault too.
// The RSA key is generated once and then reused from the existing JSON (pass --new-rsa-key to replace it).
//   node docs/gen-hw-slot-vector.js
const { webcrypto: c } = require('crypto');
const fs = require('fs');
const path = require('path');
const te = new TextEncoder();
const b64 = (u) => Buffer.from(u).toString('base64');
const b64url = (u) => Buffer.from(u).toString('base64url');
const seq = (n, start) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
const OUT = path.join(__dirname, 'hw-slot-test-vector.json');
const CREATED = '2026-11-16T00:00:00Z';

async function hkdf(ikm, salt, info) {
  const k = await c.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await c.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, k, 256));
}
async function gcm(keyBytes, iv, plain, aad) {
  const k = await c.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  return new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, k, plain));
}
const slotAad = (id) => 'notemaker/vault/v1/slot/' + id;

(async () => {
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'vault-test-vector.json'), 'utf8'));
  const vdk = Uint8Array.from(Buffer.from(base.vdk, 'base64'));
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;

  // ---- windows-hello (software RSA-2048 stand-in for the TPM-backed Windows Hello key) ----
  const rsaAlg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  let rsaPriv, rsaPrivJwk;
  if (prev && prev.windowsHelloSoftwarePrivateJwk && !process.argv.includes('--new-rsa-key')) {
    rsaPrivJwk = prev.windowsHelloSoftwarePrivateJwk;
    rsaPriv = await c.subtle.importKey('jwk', rsaPrivJwk, rsaAlg, true, ['sign']);
  } else {
    const kp = await c.subtle.generateKey({ ...rsaAlg, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']);
    rsaPriv = kp.privateKey;
    rsaPrivJwk = await c.subtle.exportKey('jwk', rsaPriv);
  }
  const { d, p, q, dp, dq, qi, ...pubJwk } = rsaPrivJwk; // eslint-disable-line no-unused-vars
  const rsaPub = await c.subtle.importKey('jwk', { ...pubJwk, key_ops: ['verify'] }, rsaAlg, true, ['verify']);
  const whChallenge = seq(32, 0xa0);
  const sig = new Uint8Array(await c.subtle.sign(rsaAlg, rsaPriv, whChallenge));
  const sig2 = new Uint8Array(await c.subtle.sign(rsaAlg, rsaPriv, whChallenge));
  if (b64(sig) !== b64(sig2)) throw new Error('RSASSA-PKCS1-v1_5 signature is not deterministic?!');
  if (!(await c.subtle.verify(rsaAlg, rsaPub, sig, whChallenge))) throw new Error('signature does not verify');
  const whId = '44444444-4444-4444-8444-444444444444', whIv = seq(12, 0xb0);
  const whWrap = await hkdf(sig, whChallenge, 'notemaker/vault/v1/windows-hello');
  const windowsHello = { id: whId, type: 'windows-hello', label: 'Test PC', createdAt: CREATED,
    keyName: 'notemaker-vault-' + whId, challenge: b64(whChallenge), device: 'Test PC',
    iv: b64(whIv), ct: b64(await gcm(whWrap, whIv, vdk, slotAad(whId))) };

  // ---- fido2-hmac (fixed hmac-secret output) ----
  const hmacOut = seq(32, 0xc0), fSalt = seq(32, 0xd0), fHkdfSalt = seq(16, 0xe0), fIv = seq(12, 0xf0);
  const fId = '55555555-5555-4555-8555-555555555555';
  const fWrap = await hkdf(hmacOut, fHkdfSalt, 'notemaker/vault/v1/fido2-hmac');
  const fido2 = { id: fId, type: 'fido2-hmac', label: 'Test security key', createdAt: CREATED,
    credentialId: b64url(te.encode('test-fido2-credential')), rpId: 'notemaker.local', salt: b64(fSalt), hkdfSalt: b64(fHkdfSalt),
    device: 'Test security key', iv: b64(fIv), ct: b64(await gcm(fWrap, fIv, vdk, slotAad(fId))) };

  // ---- android-keystore (software AES-256 key; the real key never leaves the Keystore) ----
  const akKey = seq(32, 0x05), akIv = seq(12, 0x25);
  const akId = '66666666-6666-4666-8666-666666666666';
  const android = { id: akId, type: 'android-keystore', label: 'Test phone', createdAt: CREATED,
    keyAlias: 'notemaker-vault-' + akId, strongBox: false, device: 'Test phone',
    iv: b64(akIv), ct: b64(await gcm(akKey, akIv, vdk, slotAad(akId))) };

  const out = {
    _readme: 'Test-only keys. Software stand-ins for the hardware keys of docs/PLATFORMS.md so every implementation can assert each step. ' +
      'VDK and verifier are those of docs/vault-test-vector.json. Generated by docs/gen-hw-slot-vector.js.',
    vdk: base.vdk,
    verifier: base.vault.verifier,
    windowsHelloSoftwarePrivateJwk: rsaPrivJwk,
    windowsHelloSignature: b64(sig),
    windowsHelloWrapKey: b64(whWrap),
    fido2HmacSecretOutput: b64(hmacOut),
    fido2WrapKey: b64(fWrap),
    androidKeystoreSoftwareKey: b64(akKey),
    keyslots: [windowsHello, fido2, android]
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log('wrote ' + OUT);
})().catch((e) => { console.error(e); process.exit(1); });
