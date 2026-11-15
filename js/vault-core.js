/*
 * Notemaker Vault core — pure crypto + format logic for docs/VAULT_FORMAT.md (vault format v1).
 * No DOM, no storage. Works as a classic browser script (window.NotemakerVault) and in Node (module.exports).
 *
 * The Vault Data Key (VDK): raw bytes exist only transiently (at creation and right after a keyslot is opened) and
 * are imported at once as a NON-extractable AES-GCM CryptoKey; callers must zero the raw bytes (bytes.fill(0)).
 * Creating a new keyslot later therefore needs the raw VDK again (re-authentication).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NotemakerVault = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const INFO_RECOVERY = 'notemaker/vault/v1/recovery';
    const INFO_PASSKEY = 'notemaker/vault/v1/passkey-prf';
    const INFO_SE = 'notemaker/vault/v1/secure-enclave';
    const AAD_VERIFIER = 'notemaker/vault/v1/verifier';
    const AAD_SLOT = 'notemaker/vault/v1/slot/';
    const VERIFIER_TEXT = 'notemaker-vault-ok';
    const MAX_FILE_BYTES = 25 * 1024 * 1024;
    const ALPH = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const SLOT_TYPES = ['secure-enclave', 'passkey-prf', 'recovery'];
    const ITEM_TYPES = ['note', 'login', 'card', 'file'];
    const CARD_KINDS = ['card', 'id', 'license', 'other'];

    const te = new TextEncoder(), td = new TextDecoder();
    function subtle() {
        const c = globalThis.crypto;
        const s = (c && c.subtle) || (c && c.webcrypto && c.webcrypto.subtle);
        if (!s) throw new Error('WebCrypto is not available (needs a secure context: https, localhost or file://).');
        return s;
    }
    function randomBytes(n) { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; }
    function uuid() {
        const c = globalThis.crypto;
        if (c.randomUUID) return c.randomUUID();
        const b = randomBytes(16); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
        const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }

    // ---------------- base64 / base64url ----------------
    function b64(bytes) {
        bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
    }
    /** Decodes standard base64 or base64url (padding optional). Throws on garbage. */
    function unb64(s) {
        if (typeof s !== 'string') throw new Error('Expected base64 text');
        let t = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t)) throw new Error('Invalid base64');
        t = t.replace(/=+$/, '');
        while (t.length % 4) t += '=';
        const bin = atob(t);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function b64url(bytes) { return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
    const isB64 = (s, len) => { try { const b = unb64(s); return len == null || b.length === len; } catch (e) { return false; } };

    // ---------------- Crockford Base32 recovery key ----------------
    function crockfordEncode(bytes) {
        let bits = 0, val = 0, out = '';
        for (const b of bytes) {
            val = (val << 8) | b; bits += 8;
            while (bits >= 5) { out += ALPH[(val >>> (bits - 5)) & 31]; bits -= 5; }
            val &= (1 << bits) - 1;
        }
        if (bits > 0) out += ALPH[(val << (5 - bits)) & 31];
        return out;
    }
    function crockfordDecode(str, nBytes) {
        const out = [];
        let bits = 0, val = 0;
        for (const ch of str) {
            const v = ALPH.indexOf(ch);
            if (v < 0) throw new Error('Invalid character “' + ch + '” in recovery key');
            val = (val << 5) | v; bits += 5;
            if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; val &= (1 << bits) - 1; }
        }
        if (nBytes != null && out.length < nBytes) throw new Error('Recovery key is too short');
        return Uint8Array.from(nBytes != null ? out.slice(0, nBytes) : out);
    }
    async function sha256(bytes) { return new Uint8Array(await subtle().digest('SHA-256', bytes)); }
    async function sha256Hex(bytes) { return Array.from(await sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join(''); }

    async function formatRecoveryKey(keyBytes) {
        if (keyBytes.length !== 32) throw new Error('Recovery key must be 32 bytes');
        const check = (await sha256(keyBytes)).subarray(0, 2);
        const all = new Uint8Array(34); all.set(keyBytes); all.set(check, 32);
        return crockfordEncode(all).match(/.{1,5}/g).join('-');
    }
    async function generateRecoveryKey() {
        const bytes = randomBytes(32);
        return { bytes, text: await formatRecoveryKey(bytes) };
    }
    /** Parse user input → 32 key bytes. Throws {code:'format'|'checksum'}. */
    async function parseRecoveryKey(text) {
        const clean = String(text || '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
        if (clean.length !== 55) { const e = new Error('A recovery key has 55 characters (11 groups of 5).'); e.code = 'format'; throw e; }
        let all;
        try { all = crockfordDecode(clean, 34); } catch (err) { err.code = 'format'; throw err; }
        const key = all.subarray(0, 32);
        const check = (await sha256(key)).subarray(0, 2);
        if (check[0] !== all[32] || check[1] !== all[33]) { const e = new Error('This recovery key has a typo (checksum mismatch).'); e.code = 'checksum'; throw e; }
        return new Uint8Array(key);
    }

    // ---------------- keys ----------------
    async function hkdfKey(ikm, salt, info) {
        const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
        return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, base,
            { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
    }
    function generateVdkRaw() { return randomBytes(32); }
    /** Import raw VDK bytes as a non-extractable key (default). */
    async function importVdk(raw, extractable) { return subtle().importKey('raw', raw, { name: 'AES-GCM' }, !!extractable, ['encrypt', 'decrypt']); }

    async function gcmEncrypt(key, plain, aad) {
        const iv = randomBytes(12);
        const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, plain));
        return { iv, ct };
    }
    async function gcmDecrypt(key, iv, ct, aad) {
        return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, ct));
    }

    async function makeVerifier(vdk) {
        const r = await gcmEncrypt(vdk, te.encode(VERIFIER_TEXT), AAD_VERIFIER);
        return { iv: b64(r.iv), ct: b64(r.ct) };
    }
    async function checkVerifier(vdk, verifier) {
        try { return td.decode(await gcmDecrypt(vdk, unb64(verifier.iv), unb64(verifier.ct), AAD_VERIFIER)) === VERIFIER_TEXT; } catch (e) { return false; }
    }

    /** Wrap the raw VDK for a slot: ct = AES-GCM(wrapKey, iv, VDK bytes, AAD "…/slot/<id>"). */
    async function wrapVdk(vdkRaw, wrapKey, slotId) {
        if (!(vdkRaw instanceof Uint8Array) || vdkRaw.length !== 32) throw new Error('VDK must be 32 bytes');
        const r = await gcmEncrypt(wrapKey, vdkRaw, AAD_SLOT + slotId);
        return { iv: b64(r.iv), ct: b64(r.ct) };
    }
    /** → raw VDK bytes (caller imports and zeroes them). */
    async function unwrapVdk(slot, wrapKey) {
        let raw;
        try { raw = await gcmDecrypt(wrapKey, unb64(slot.iv), unb64(slot.ct), AAD_SLOT + slot.id); } catch (e) {
            const err = new Error('This key does not open the vault.'); err.code = 'wrong-key'; throw err;
        }
        if (raw.length !== 32) { const err = new Error('Corrupt keyslot.'); err.code = 'wrong-key'; throw err; }
        return raw;
    }
    /** Import raw VDK, check the verifier, zero the raw bytes. → non-extractable CryptoKey */
    async function sessionKey(vault, raw) {
        try {
            const key = await importVdk(raw, false);
            if (!(await checkVerifier(key, vault.verifier))) { const e = new Error('This key does not open the vault (verifier mismatch).'); e.code = 'wrong-key'; throw e; }
            return key;
        } finally { raw.fill(0); }
    }

    // ---------------- keyslots ----------------
    async function makeRecoverySlot(vdk, recoveryBytes, label) {
        const id = uuid(), salt = randomBytes(16);
        const w = await wrapVdk(vdk, await hkdfKey(recoveryBytes, salt, INFO_RECOVERY), id);
        return { id, type: 'recovery', label: label || 'Recovery key', createdAt: new Date().toISOString(), salt: b64(salt), iv: w.iv, ct: w.ct };
    }
    async function openRecoverySlot(slot, recoveryBytes) { return unwrapVdk(slot, await hkdfKey(recoveryBytes, unb64(slot.salt), INFO_RECOVERY)); }

    /** prfOutput: 32 bytes from the authenticator for input prfSalt. meta: {credentialId (b64url), rpId, prfSalt (bytes), label} */
    async function makePasskeySlot(vdk, prfOutput, meta) {
        const id = uuid(), salt = randomBytes(16);
        const w = await wrapVdk(vdk, await hkdfKey(prfOutput, salt, INFO_PASSKEY), id);
        return {
            id, type: 'passkey-prf', label: meta.label || 'Passkey', createdAt: new Date().toISOString(),
            credentialId: meta.credentialId, rpId: meta.rpId, prfSalt: b64(meta.prfSalt), salt: b64(salt), iv: w.iv, ct: w.ct
        };
    }
    async function openPasskeySlot(slot, prfOutput) { return unwrapVdk(slot, await hkdfKey(prfOutput, unb64(slot.salt), INFO_PASSKEY)); }

    /** Secure Enclave slots are created by the Mac app. The web app never opens them; this exists to prove the math
        (tests use a software P-256 private key in place of the Secure Enclave key). */
    async function openSecureEnclaveSlot(slot, privateKey) {
        const ephRaw = unb64(slot.ephemeralPublicKey);
        const eph = await subtle().importKey('raw', ephRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: eph }, privateKey, 256));
        return unwrapVdk(slot, await hkdfKey(shared, ephRaw, INFO_SE));
    }

    /** vdk: CryptoKey (session key) used to write the verifier. */
    async function newVault(mode, vdk) {
        return {
            version: 1, createdAt: new Date().toISOString(), mode: mode === 'hardware-only' ? 'hardware-only' : 'hardware+recovery',
            verifier: await makeVerifier(vdk), keyslots: [], items: []
        };
    }
    /** Try every recovery slot with the given recovery key text. → { raw (verified VDK bytes; caller must zero), slot } */
    async function unlockWithRecovery(vault, text) {
        const bytes = await parseRecoveryKey(text);
        const slots = vault.keyslots.filter((s) => s.type === 'recovery');
        if (!slots.length) { const e = new Error('This vault has no recovery key (hardware-only mode).'); e.code = 'no-slot'; throw e; }
        try {
            for (const s of slots) {
                let raw;
                try { raw = await openRecoverySlot(s, bytes); } catch (e) { continue; }
                const key = await importVdk(raw, false);
                if (await checkVerifier(key, vault.verifier)) return { raw, slot: s };
                raw.fill(0);
            }
        } finally { bytes.fill(0); }
        const e = new Error('That recovery key does not open this vault.'); e.code = 'wrong-key'; throw e;
    }

    // ---------------- items & blobs ----------------
    const s = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max || 100000);
    /** Decrypted payloads are untrusted (imports): coerce to the documented shape. */
    function normalizePayload(p) {
        p = p && typeof p === 'object' ? p : {};
        const type = ITEM_TYPES.includes(p.type) ? p.type : 'note';
        const out = {
            type, title: s(p.title, 500), favorite: !!p.favorite, notes: s(p.notes),
            tags: Array.isArray(p.tags) ? p.tags.map((t) => s(t, 100)).filter(Boolean).slice(0, 50) : []
        };
        if (type === 'note') out.markdown = s(p.markdown, 1000000);
        if (type === 'login') { out.username = s(p.username, 1000); out.password = s(p.password, 1000); out.url = s(p.url, 2000); out.totpSecret = s(p.totpSecret, 500); }
        if (type === 'card') {
            out.kind = CARD_KINDS.includes(p.kind) ? p.kind : 'card';
            for (const k of ['holder', 'number', 'expiry', 'cvv', 'issuer']) out[k] = s(p[k], 500);
            out.fields = Array.isArray(p.fields) ? p.fields.filter((f) => f && typeof f === 'object').slice(0, 100)
                .map((f) => ({ label: s(f.label, 200), value: s(f.value, 5000), secret: !!f.secret })) : [];
        }
        if (type === 'file') {
            out.fileName = s(p.fileName, 500); out.mime = s(p.mime, 200);
            out.size = Math.max(0, Math.floor(Number(p.size)) || 0);
            out.blobId = s(p.blobId, 100); out.sha256 = /^[0-9a-f]{64}$/.test(p.sha256) ? p.sha256 : '';
        }
        return out;
    }
    async function encryptItem(vdk, id, payload, createdAt) {
        const r = await gcmEncrypt(vdk, te.encode(JSON.stringify(normalizePayload(payload))), id);
        const now = new Date().toISOString();
        return { id, iv: b64(r.iv), ct: b64(r.ct), createdAt: createdAt || now, updatedAt: now };
    }
    async function decryptItem(vdk, item) {
        const pt = await gcmDecrypt(vdk, unb64(item.iv), unb64(item.ct), item.id);
        return normalizePayload(JSON.parse(td.decode(pt)));
    }
    async function encryptBlob(vdk, blobId, bytes) {
        if (bytes.length > MAX_FILE_BYTES) throw new Error('Files are limited to 25 MB.');
        return gcmEncrypt(vdk, bytes, 'blob:' + blobId);
    }
    async function decryptBlob(vdk, blobId, rec) {
        const iv = typeof rec.iv === 'string' ? unb64(rec.iv) : new Uint8Array(rec.iv);
        const ct = typeof rec.ct === 'string' ? unb64(rec.ct) : new Uint8Array(rec.ct);
        return gcmDecrypt(vdk, iv, ct, 'blob:' + blobId);
    }

    // ---------------- normalisation of an untrusted vault document ----------------
    const isoOr = (v) => (typeof v === 'string' && !isNaN(Date.parse(v)) ? v : new Date().toISOString());
    function normalizeSlot(k) {
        if (!k || typeof k !== 'object' || !SLOT_TYPES.includes(k.type) || typeof k.id !== 'string' || !k.id) return null;
        if (!isB64(k.iv, 12) || !isB64(k.ct)) return null;
        const base = { id: s(k.id, 100), type: k.type, label: s(k.label, 200) || k.type, createdAt: isoOr(k.createdAt), iv: k.iv, ct: k.ct };
        if (k.type === 'recovery') return isB64(k.salt) ? Object.assign(base, { salt: k.salt }) : null;
        if (k.type === 'passkey-prf') {
            if (!isB64(k.prfSalt) || !isB64(k.salt) || typeof k.credentialId !== 'string' || !isB64(k.credentialId)) return null;
            return Object.assign(base, { credentialId: k.credentialId, rpId: s(k.rpId, 300), prfSalt: k.prfSalt, salt: k.salt });
        }
        if (!isB64(k.ephemeralPublicKey, 65)) return null;
        return Object.assign(base, { ephemeralPublicKey: k.ephemeralPublicKey, publicKey: isB64(k.publicKey) ? k.publicKey : '', device: s(k.device, 200) });
    }
    /** Returns a clean vault object (without blobs) or null. Blobs are returned separately by splitBlobs. */
    function normalizeVault(v) {
        if (!v || typeof v !== 'object' || !v.verifier || !isB64(v.verifier.iv, 12) || !isB64(v.verifier.ct)) return null;
        const keyslots = (Array.isArray(v.keyslots) ? v.keyslots : []).map(normalizeSlot).filter(Boolean);
        if (!keyslots.length) return null;
        const seen = new Set();
        const items = (Array.isArray(v.items) ? v.items : []).filter((it) => it && typeof it.id === 'string' && it.id && isB64(it.iv, 12) && isB64(it.ct) && !seen.has(it.id) && seen.add(it.id))
            .map((it) => ({ id: s(it.id, 100), iv: it.iv, ct: it.ct, createdAt: isoOr(it.createdAt), updatedAt: isoOr(it.updatedAt) }));
        return {
            version: 1, createdAt: isoOr(v.createdAt), mode: v.mode === 'hardware-only' ? 'hardware-only' : 'hardware+recovery',
            verifier: { iv: v.verifier.iv, ct: v.verifier.ct }, keyslots, items
        };
    }
    function extractBlobs(v) {
        const out = {};
        if (v && v.blobs && typeof v.blobs === 'object') {
            for (const id of Object.keys(v.blobs)) {
                const b = v.blobs[id];
                if (/^[\w-]{1,100}$/.test(id) && b && isB64(b.iv, 12) && isB64(b.ct)) out[id] = { iv: b.iv, ct: b.ct };
            }
        }
        return out;
    }

    // ---------------- password generator & strength ----------------
    const SETS = { lower: 'abcdefghijklmnopqrstuvwxyz', upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', digits: '0123456789', symbols: '!@#$%^&*()-_=+[]{};:,.?/~' };
    const LOOKALIKE = /[O0Il1|]/g;
    function randInt(n) { // unbiased
        const lim = Math.floor(0x100000000 / n) * n, b = new Uint32Array(1);
        do globalThis.crypto.getRandomValues(b); while (b[0] >= lim);
        return b[0] % n;
    }
    function generatePassword(opts) {
        opts = Object.assign({ length: 20, lower: true, upper: true, digits: true, symbols: true, avoidLookalikes: true }, opts || {});
        const len = Math.max(8, Math.min(64, Math.floor(opts.length) || 20));
        const sets = ['lower', 'upper', 'digits', 'symbols'].filter((k) => opts[k]).map((k) => (opts.avoidLookalikes ? SETS[k].replace(LOOKALIKE, '') : SETS[k]));
        if (!sets.length) sets.push(opts.avoidLookalikes ? SETS.lower.replace(LOOKALIKE, '') : SETS.lower);
        const all = sets.join('');
        const chars = sets.map((set) => set[randInt(set.length)]); // at least one of each chosen set
        while (chars.length < len) chars.push(all[randInt(all.length)]);
        for (let i = chars.length - 1; i > 0; i--) { const j = randInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
        return chars.join('');
    }
    /** Rough entropy estimate → {bits, score 0..4, label}. */
    function passwordStrength(pw) {
        pw = String(pw || '');
        if (!pw) return { bits: 0, score: 0, label: 'Empty' };
        let pool = 0;
        if (/[a-z]/.test(pw)) pool += 26;
        if (/[A-Z]/.test(pw)) pool += 26;
        if (/\d/.test(pw)) pool += 10;
        if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
        let bits = pw.length * Math.log2(pool || 1);
        if (/(.)\1{2,}/.test(pw)) bits *= 0.8;
        if (/^(password|123456|qwerty|letmein|admin)/i.test(pw)) bits = Math.min(bits, 10);
        bits = Math.round(bits);
        const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
        return { bits, score, label: ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'][score] };
    }

    return {
        MAX_FILE_BYTES, ITEM_TYPES, CARD_KINDS, SLOT_TYPES,
        b64, unb64, b64url, randomBytes, uuid, sha256Hex,
        crockfordEncode, crockfordDecode, formatRecoveryKey, generateRecoveryKey, parseRecoveryKey,
        generateVdkRaw, importVdk, sessionKey, makeVerifier, checkVerifier,
        makeRecoverySlot, openRecoverySlot, makePasskeySlot, openPasskeySlot, openSecureEnclaveSlot,
        newVault, unlockWithRecovery,
        normalizePayload, encryptItem, decryptItem, encryptBlob, decryptBlob, normalizeVault, extractBlobs,
        generatePassword, passwordStrength
    };
});
