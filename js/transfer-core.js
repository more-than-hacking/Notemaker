/*
 * Notemaker transfer file (.notemaker) — pure logic for docs/TRANSFER_FORMAT.md (format v1).
 * Works in the browser (window.NotemakerTransfer) and in Node (module.exports). No DOM, no storage.
 * The transfer code is only ever held in memory by the caller; nothing here persists it.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NotemakerTransfer = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const FORMAT = 'notemaker-transfer';
    const AAD = 'notemaker/transfer/v1';
    const MIME = 'application/vnd.notemaker.transfer+json';
    const MAX_BYTES = 1024 * 1024 * 1024;   // refuse above 1 GB
    const WARN_BYTES = 200 * 1024 * 1024;   // warn above 200 MB
    const ALPH = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const te = new TextEncoder(), td = new TextDecoder();

    const load = (g, path) => globalThis[g] || (typeof require === 'function' ? require(path) : null);
    const C = () => load('NotemakerCore', './core.js');
    const V = () => load('NotemakerVault', './vault-core.js');
    const subtle = () => globalThis.crypto.subtle;
    const err = (msg, code) => { const e = new Error(msg); e.code = code; return e; };

    // ---------------- transfer code ----------------
    function crockford(bytes) {
        let bits = 0, val = 0, out = '';
        for (const b of bytes) {
            val = (val << 8) | b; bits += 8;
            while (bits >= 5) { out += ALPH[(val >>> (bits - 5)) & 31]; bits -= 5; }
            val &= (1 << bits) - 1;
        }
        if (bits > 0) out += ALPH[(val << (5 - bits)) & 31];
        return out;
    }
    function uncrockford(str, n) {
        const out = [];
        let bits = 0, val = 0;
        for (const ch of str) {
            const v = ALPH.indexOf(ch);
            if (v < 0) throw err('That code has a character that isn’t used in transfer codes (“' + ch + '”).', 'format');
            val = (val << 5) | v; bits += 5;
            if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; val &= (1 << bits) - 1; }
        }
        return Uint8Array.from(out.slice(0, n));
    }
    async function sha256(bytes) { return new Uint8Array(await subtle().digest('SHA-256', bytes)); }
    async function sha256Hex(bytes) { return Array.from(await sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join(''); }

    async function formatCode(codeBytes) {
        if (codeBytes.length !== 20) throw new Error('Transfer code must be 20 bytes');
        const all = new Uint8Array(22);
        all.set(codeBytes); all.set((await sha256(codeBytes)).subarray(0, 2), 20);
        return crockford(all).match(/.{1,6}/g).join('-');
    }
    async function generateCode() {
        const bytes = new Uint8Array(20);
        globalThis.crypto.getRandomValues(bytes);
        return { bytes, text: await formatCode(bytes) };
    }
    /** Normalise user input the way the UI shows it (uppercase, O→0, I/L→1, groups of 6). */
    function normalizeCodeInput(text) {
        const raw = String(text || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '').slice(0, 36);
        return { raw, display: (raw.match(/.{1,6}/g) || []).join('-'), complete: raw.length === 36 };
    }
    /** → 20 code bytes; throws {code:'format'|'checksum'} */
    async function parseCode(text) {
        const { raw } = normalizeCodeInput(text);
        if (raw.length !== 36) throw err('A transfer code has 36 characters (6 groups of 6).', 'format');
        const all = uncrockford(raw, 22);
        const bytes = all.subarray(0, 20);
        const check = (await sha256(bytes)).subarray(0, 2);
        if (check[0] !== all[20] || check[1] !== all[21]) throw err('There’s a typo in this code — check each group.', 'checksum');
        return new Uint8Array(bytes);
    }

    // ---------------- gzip (CompressionStream in browsers / Node ≥ 18, zlib fallback) ----------------
    async function streamThrough(bytes, ts) {
        const stream = new Blob([bytes]).stream().pipeThrough(ts);
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    async function gzip(bytes) {
        if (typeof CompressionStream === 'function') return streamThrough(bytes, new CompressionStream('gzip'));
        return new Uint8Array(require('zlib').gzipSync(bytes));
    }
    async function gunzip(bytes) {
        if (typeof DecompressionStream === 'function') return streamThrough(bytes, new DecompressionStream('gzip'));
        return new Uint8Array(require('zlib').gunzipSync(bytes));
    }

    // ---------------- key ----------------
    async function deriveKey(codeBytes, salt) {
        const ikm = await subtle().importKey('raw', codeBytes, 'HKDF', false, ['deriveKey']);
        return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(AAD) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    // ---------------- manifest ----------------
    /** Plaintext bytes of an AES-GCM blob = ciphertext length − 16-byte tag (verifiable without the vault key). */
    function blobPlainBytes(b) { return Math.max(0, V().unb64(b.ct).length - 16); }
    function countDoc(doc) {
        const notes = doc.notes || {};
        const v = doc.vault;
        const blobs = (v && v.blobs) || {};
        return {
            tasks: (doc.tasks || []).length,
            notes: Object.keys(notes).length,
            lockedNotes: Object.values(notes).filter((n) => n && n.locked).length,
            habits: (doc.habits || []).length,
            templates: (doc.templates || []).length,
            focusSessions: (doc.focusSessions || []).length,
            vaultItems: v ? (v.items || []).length : 0,
            vaultFiles: Object.keys(blobs).length,
            vaultFileBytes: Object.values(blobs).reduce((s, b) => s + blobPlainBytes(b), 0)
        };
    }
    async function manifestFor(doc) {
        return Object.assign(countDoc(doc), { docSha256: await sha256Hex(te.encode(JSON.stringify(doc))) });
    }
    const MANIFEST_KEYS = ['tasks', 'notes', 'lockedNotes', 'habits', 'templates', 'focusSessions', 'vaultItems', 'vaultFiles', 'vaultFileBytes'];

    /**
     * Document for the payload: a normalised v2 export, with vault.blobs filled (blobs: {id: {iv, ct}} base64)
     * or the vault removed (omitVault, "Move without the vault").
     */
    function prepareExportDoc(doc, opts) {
        opts = opts || {};
        const out = C().exportDoc(doc, opts.now);
        if (opts.omitVault || !out.vault) out.vault = null;
        else out.vault.blobs = Object.assign({}, opts.blobs || {});
        return out;
    }

    // ---------------- build / open ----------------
    /**
     * → { fileText, file (envelope object), code: {bytes, text}, manifest, plainBytes }
     * source: {app, appVersion, device}; codeBytes optional (tests).
     */
    async function buildTransferFile(opts) {
        const doc = opts.doc;
        const manifest = await manifestFor(doc);
        const payload = { manifest, doc, prefs: opts.prefs || {} };
        const plain = await gzip(te.encode(JSON.stringify(payload)));
        if (plain.length > MAX_BYTES) throw err('This is more than 1 GB even after compression, which is too large to move in one file.', 'too-large');
        const code = opts.codeBytes ? { bytes: opts.codeBytes, text: await formatCode(opts.codeBytes) } : await generateCode();
        const salt = opts.salt || V().randomBytes(16), iv = opts.iv || V().randomBytes(12);
        const key = await deriveKey(code.bytes, salt);
        const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(AAD) }, key, plain));
        const file = {
            format: FORMAT, version: 1, createdAt: opts.createdAt || new Date().toISOString(),
            source: { app: sourceApp(opts.source && opts.source.app), appVersion: String((opts.source && opts.source.appVersion) || ''), device: String((opts.source && opts.source.device) || '') },
            summary: { tasks: manifest.tasks, notes: manifest.notes, vaultItems: manifest.vaultItems, vaultFiles: manifest.vaultFiles, bytes: plain.length },
            salt: V().b64(salt), iv: V().b64(iv), ct: V().b64(ct)
        };
        return { fileText: JSON.stringify(file), file, code, manifest, plainBytes: plain.length };
    }

    /** source.app: which app made the file (shown before decrypting). */
    const SOURCE_APPS = ['web', 'macos', 'windows', 'linux', 'android'];
    const sourceApp = (a) => (SOURCE_APPS.includes(a) ? a : 'web');
    const isB64 = (s, len) => { try { const b = V().unb64(s); return len == null || b.length === len; } catch (e) { return false; } };
    /** Validate the (untrusted) envelope. text: file contents. */
    function parseEnvelope(text, sizeBytes) {
        if (sizeBytes != null && sizeBytes > MAX_BYTES) throw err('This file is larger than 1 GB, which Notemaker can’t restore in one go.', 'too-large');
        let f;
        try { f = JSON.parse(text); } catch (e) { throw err('This isn’t a Notemaker transfer file.', 'not-transfer'); }
        if (!f || f.format !== FORMAT) {
            if (f && (f.app === 'notemaker' || Array.isArray(f.tasks))) throw err('This is an unencrypted backup, not a transfer file. Import it from Settings › Data instead.', 'json-backup');
            throw err('This isn’t a Notemaker transfer file.', 'not-transfer');
        }
        if (f.version !== 1) throw err('This transfer file was made by a newer version of Notemaker. Update Notemaker on this device first.', 'version');
        if (!isB64(f.salt, 16) || !isB64(f.iv, 12) || typeof f.ct !== 'string' || !isB64(f.ct)) throw err('This transfer file is damaged.', 'damaged');
        const s = f.summary && typeof f.summary === 'object' ? f.summary : {};
        const n = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.floor(Number(x)) : 0);
        const src = f.source && typeof f.source === 'object' ? f.source : {};
        return {
            format: FORMAT, version: 1, createdAt: typeof f.createdAt === 'string' && !isNaN(Date.parse(f.createdAt)) ? f.createdAt : null,
            source: { app: sourceApp(src.app), appVersion: String(src.appVersion || '').slice(0, 40), device: String(src.device || '').slice(0, 120) },
            summary: { tasks: n(s.tasks), notes: n(s.notes), vaultItems: n(s.vaultItems), vaultFiles: n(s.vaultFiles), bytes: n(s.bytes) },
            salt: f.salt, iv: f.iv, ct: f.ct
        };
    }
    /** → payload {manifest, doc, prefs}; throws {code:'wrong-code'} for a wrong code or tampering, 'damaged' otherwise. */
    async function openTransferFile(envelope, codeText) {
        const codeBytes = typeof codeText === 'string' ? await parseCode(codeText) : codeText;
        let plain;
        try {
            const key = await deriveKey(codeBytes, V().unb64(envelope.salt));
            plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: V().unb64(envelope.iv), additionalData: te.encode(AAD) }, key, V().unb64(envelope.ct)));
        } catch (e) { throw err('That code doesn’t match this file.', 'wrong-code'); } finally { if (typeof codeText === 'string') codeBytes.fill(0); }
        let payload;
        try { payload = JSON.parse(td.decode(await gunzip(plain))); } catch (e) { throw err('This transfer file is damaged (it couldn’t be unpacked).', 'damaged'); }
        if (!payload || typeof payload !== 'object' || !payload.doc || typeof payload.doc !== 'object' || !payload.manifest) throw err('This transfer file is damaged (no data inside).', 'damaged');
        if (!payload.prefs || typeof payload.prefs !== 'object') payload.prefs = {};
        return payload;
    }
    /** Checks docSha256 and every manifest count against the received document. → {ok, problems:[{key, expected, actual}]} */
    async function verifyPayload(payload) {
        const problems = [];
        const m = payload.manifest || {};
        const sha = await sha256Hex(te.encode(JSON.stringify(payload.doc)));
        if (sha !== m.docSha256) problems.push({ key: 'docSha256', expected: m.docSha256, actual: sha });
        const counts = countDoc(payload.doc);
        for (const k of MANIFEST_KEYS) if (Number(m[k]) !== counts[k]) problems.push({ key: k, expected: m[k], actual: counts[k] });
        return { ok: !problems.length, problems, counts };
    }

    // ---------------- restore ----------------
    /**
     * Pure restore plan. mode: 'replace' | 'merge'.
     * → { doc (normalised, no blobs), prefs (to apply, or null when kept), blobs ({id:{iv,ct}} to store), stats }
     */
    function planRestore(localDoc, payload, mode) {
        const incomingVault = payload.doc && payload.doc.vault;
        const blobs = incomingVault ? V().extractBlobs(incomingVault) : {};
        const incoming = C().normalizeDoc(payload.doc);
        if (mode === 'merge') {
            const r = C().mergeDocs(localDoc, incoming);
            return { doc: C().normalizeDoc(r.doc), prefs: null, blobs: r.stats.vaultAdopted ? blobs : {}, stats: r.stats, mode };
        }
        return { doc: incoming, prefs: sanitizePrefs(payload.prefs), blobs, stats: null, mode: 'replace' };
    }
    const ACCENTS = ['violet', 'ocean', 'sunset', 'forest', 'purple'];
    const VIEWS = ['day', 'calendar', 'planner', 'board', 'habits', 'insights', 'settings', 'vault'];
    /** UI preferences are untrusted too: keep known keys with valid values only. */
    function sanitizePrefs(p) {
        p = p && typeof p === 'object' ? p : {};
        const out = {};
        if (ACCENTS.includes(p.accent)) out.accent = p.accent;
        if (VIEWS.includes(p.lastView)) out.lastView = p.lastView;
        if (p.dayTab === 'tasks' || p.dayTab === 'notes') out.dayTab = p.dayTab;
        if (p.sort === 'manual' || p.sort === 'priority') out.sort = p.sort;
        if (p.editorMode === 'split' || p.editorMode === 'preview') out.editorMode = p.editorMode;
        if (typeof p.syncScroll === 'boolean') out.syncScroll = p.syncScroll;
        if (typeof p.sidebarCollapsed === 'boolean') out.sidebarCollapsed = p.sidebarCollapsed;
        return out;
    }

    /** No user data yet (only built-in templates and default settings) → offer the welcome screen. */
    function isEmptyDoc(doc) {
        if (!doc) return true;
        if ((doc.tasks || []).length || Object.keys(doc.notes || {}).length || (doc.habits || []).length || (doc.focusSessions || []).length || doc.vault) return false;
        return (doc.templates || []).every((t) => /^builtin-/.test(t.id));
    }
    function shouldShowWelcome(doc, alreadyWelcomed) { return !alreadyWelcomed && isEmptyDoc(doc); }

    function fileName(dateStr) { return 'Notemaker transfer ' + dateStr + '.notemaker'; }
    function formatBytes(n) {
        if (n < 1024) return n + ' bytes';
        if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
        if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
        return (n / 1073741824).toFixed(2) + ' GB';
    }

    return {
        FORMAT, AAD, MIME, MAX_BYTES, WARN_BYTES, MANIFEST_KEYS, SOURCE_APPS,
        formatCode, generateCode, parseCode, normalizeCodeInput, gzip, gunzip, sha256Hex,
        countDoc, manifestFor, prepareExportDoc, buildTransferFile, parseEnvelope, openTransferFile, verifyPayload,
        planRestore, sanitizePrefs, isEmptyDoc, shouldShowWelcome, fileName, formatBytes
    };
});
