// Generates docs/transfer-test-vector.json with WebCrypto + zlib (Node 20+), deterministic inputs.
const { webcrypto: c, createHash } = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const te = new TextEncoder();
const b64 = (u) => Buffer.from(u).toString('base64');
const seq = (n, s) => Uint8Array.from({ length: n }, (_, i) => (s + i) & 0xff);
const ALPH = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function crockford(bytes) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += ALPH[(val >>> (bits - 5)) & 31]; bits -= 5; } val &= (1 << bits) - 1; }
  if (bits > 0) out += ALPH[(val << (5 - bits)) & 31];
  return out;
}
(async () => {
  const codeBytes = seq(20, 0x31);
  const check = createHash('sha256').update(codeBytes).digest().subarray(0, 2);
  const code = crockford(Buffer.concat([Buffer.from(codeBytes), check])).match(/.{1,6}/g).join('-');

  const vault = JSON.parse(fs.readFileSync(__dirname + '/vault-test-vector.json', 'utf8')).vault; // reuse: includes blobs
  const doc = {
    app: 'notemaker', version: 2, exportedAt: '2026-11-16T09:00:00Z',
    tasks: [{ id: '0f0f0f0f-0000-4000-8000-000000000001', title: 'Move to the new laptop', date: '2026-11-16', done: false, completedAt: null,
      createdAt: '2026-11-16T08:00:00Z', priority: 'high', tags: ['setup'], subtasks: [], status: 'todo', order: 0, recurrence: null,
      doneDates: {}, skipDates: {}, reminder: '10:00', timeBlock: null, pomodoros: { estimate: 1, done: 0 }, rolledFrom: null, notes: '' }],
    notes: { '2026-11-16': { markdown: '# Moving day\n- [x] export\n- [ ] import', updatedAt: '2026-11-16T08:30:00Z', locked: false, cipher: null } },
    habits: [], templates: [], focusSessions: [],
    settings: { theme: 'dark', autoRollover: true, focusMinutes: 25, breakMinutes: 5, reviewTime: '18:00', weekStartsOn: 1,
      dayStart: '07:00', dayEnd: '21:00', lockHash: null, vaultAutoLockMinutes: 5 },
    vault,
  };
  const docJson = JSON.stringify(doc);
  const payload = {
    manifest: { tasks: 1, notes: 1, lockedNotes: 0, habits: 0, templates: 0, focusSessions: 0,
      vaultItems: vault.items.length, vaultFiles: Object.keys(vault.blobs).length,
      vaultFileBytes: 0 /* filled below */, docSha256: createHash('sha256').update(Buffer.from(docJson, 'utf8')).digest('hex') },
    doc, prefs: { accent: 'violet', editorMode: 'split', lastView: 'day' },
  };
  // vaultFileBytes = total plaintext bytes of files (from item payloads in the vault vector)
  const vv = JSON.parse(fs.readFileSync(__dirname + '/vault-test-vector.json', 'utf8'));
  payload.manifest.vaultFileBytes = Object.values(vv.expectedPayloads).filter(p => p.type === 'file').reduce((s, p) => s + p.size, 0);

  // Note: the payload re-serialises doc; docSha256 is over JSON.stringify(doc) as it appears after JSON.parse of the payload.
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const salt = seq(16, 0x51), iv = seq(12, 0x61);
  const ikm = await c.subtle.importKey('raw', codeBytes, 'HKDF', false, ['deriveBits']);
  const keyBytes = new Uint8Array(await c.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('notemaker/transfer/v1') }, ikm, 256));
  const key = await c.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode('notemaker/transfer/v1') }, key, plain));
  const file = {
    format: 'notemaker-transfer', version: 1, createdAt: '2026-11-16T09:00:00Z',
    source: { app: 'web', appVersion: '2.1.0', device: 'Test laptop' },
    summary: { tasks: 1, notes: 1, vaultItems: vault.items.length, vaultFiles: Object.keys(vault.blobs).length, bytes: plain.length },
    salt: b64(salt), iv: b64(iv), ct: b64(ct),
  };
  fs.writeFileSync(__dirname + '/transfer-test-vector.json', JSON.stringify({
    _readme: 'Test-only. "file" is a complete .notemaker transfer file; "code" opens it; "expected" is the decrypted payload manifest.',
    code, codeBytes: b64(codeBytes), expectedManifest: payload.manifest, file,
  }, null, 2));
  console.log('transfer code:', code, '| file bytes:', JSON.stringify(file).length);
})();
