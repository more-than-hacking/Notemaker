/*
 * Notemaker — storage location logic (no DOM): folder storage through the File System Access API,
 * capability / install-hint detection, persistent-storage and backup-reminder rules.
 * Browser: window.NotemakerStorage. Node (tests): module.exports.
 *
 * Folder layout (same as the macOS app's data directory):
 *   notemaker-data.json          the v2 document (docs/DATA_FORMAT.md)
 *   notemaker-data.backup.json   the previous version (rotated on every successful write, at most one)
 *   vault-blobs/<blobId>.bin     iv (12 bytes) ‖ ciphertext
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NotemakerStorage = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DATA = 'notemaker-data.json';
    const BACKUP = 'notemaker-data.backup.json';
    const BLOBS = 'vault-blobs';
    const DAY = 86400000;
    const te = new TextEncoder(), td = new TextDecoder();
    const load = (g, path) => globalThis[g] || (typeof require === 'function' ? require(path) : null);
    const C = () => load('NotemakerCore', './core.js');

    async function sha256Hex(bytes) {
        const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
        return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    const isNotFound = (e) => e && (e.name === 'NotFoundError' || e.code === 'ENOENT' || /not.?found/i.test(e.message || ''));

    // ======================= folder store =======================
    /**
     * opts: { handle (FileSystemDirectoryHandle), delay = 500, setTimer, clearTimer,
     *         onConflict(theirs) → called when a debounced write finds the file changed elsewhere,
     *         onError(err), onSaved(meta) }
     */
    function createFolderStore(opts) {
        const dir = opts.handle;
        const delay = opts.delay == null ? 500 : opts.delay;
        const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
        const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
        let lastSeen = null;   // { lastModified, size, sha } of the file as we last read or wrote it
        let pending = null, timer = null, chain = Promise.resolve();

        async function permission(request) {
            const o = { mode: 'readwrite' };
            if (request && dir.requestPermission) return dir.requestPermission(o);
            return dir.queryPermission ? dir.queryPermission(o) : 'granted';
        }
        async function fileOf(name) { try { return await (await dir.getFileHandle(name)).getFile(); } catch (e) { if (isNotFound(e)) return null; throw e; } }
        async function writeFile(handleDir, name, data) {
            const fh = await handleDir.getFileHandle(name, { create: true });
            const w = await fh.createWritable();   // Chrome writes to a swap file and replaces atomically on close()
            try { await w.write(data); await w.close(); } catch (e) { if (w.abort) { try { await w.abort(); } catch (_) { /* */ } } throw e; }
        }
        /** → { doc|null, json|null, meta|null } and remembers what we saw. Throws {code:'unreadable'} on bad JSON. */
        async function read() {
            const f = await fileOf(DATA);
            if (!f) { lastSeen = null; return { doc: null, json: null, meta: null }; }
            const json = await f.text();
            const meta = { lastModified: f.lastModified, size: f.size, sha: await sha256Hex(te.encode(json)) };
            let doc;
            try { doc = C().normalizeDoc(JSON.parse(json)); } catch (e) { const err = new Error('notemaker-data.json in this folder can’t be read (' + e.message + ').'); err.code = 'unreadable'; throw err; }
            lastSeen = meta;
            return { doc, json, meta };
        }
        /** Has the data file changed since we last read/wrote it? → { changed, theirs? } */
        async function checkExternal() {
            const f = await fileOf(DATA);
            if (!f) return { changed: !!lastSeen, missing: true };
            if (lastSeen && f.lastModified === lastSeen.lastModified && f.size === lastSeen.size) return { changed: false };
            const json = await f.text();
            const sha = await sha256Hex(te.encode(json));
            if (lastSeen && sha === lastSeen.sha) { lastSeen = { lastModified: f.lastModified, size: f.size, sha }; return { changed: false }; }
            let doc = null;
            try { doc = C().normalizeDoc(JSON.parse(json)); } catch (e) { doc = null; }
            return { changed: true, theirs: { doc, json, meta: { lastModified: f.lastModified, size: f.size, sha } } };
        }
        /**
         * Write now. Refuses ({conflict, theirs}) if the file changed elsewhere since we last saw it, unless force.
         * Keeps the previous contents as notemaker-data.backup.json.
         */
        async function writeNow(doc, force) {
            const json = JSON.stringify(doc);
            if (!force) {
                const ext = await checkExternal();
                if (ext.changed && !ext.missing) return { conflict: true, theirs: ext.theirs };
            }
            const prev = await fileOf(DATA);
            if (prev) await writeFile(dir, BACKUP, await prev.text());
            await writeFile(dir, DATA, json);
            const f = await fileOf(DATA);
            lastSeen = { lastModified: f.lastModified, size: f.size, sha: await sha256Hex(te.encode(json)) };
            if (opts.onSaved) opts.onSaved(lastSeen);
            return { ok: true, meta: lastSeen };
        }
        function save(doc) {
            pending = doc;
            if (timer) clearTimer(timer);
            timer = setTimer(() => { timer = null; flush(); }, delay);
        }
        function flush() {
            if (timer) { clearTimer(timer); timer = null; }
            if (!pending) return chain;
            const doc = pending;
            pending = null;
            chain = chain.then(() => writeNow(doc)).then((r) => {
                if (r && r.conflict) { pending = doc; if (opts.onConflict) opts.onConflict(r.theirs); }
                return r;
            }).catch((e) => { pending = pending || doc; if (opts.onError) opts.onError(e); });
            return chain;
        }
        /** Accept the other version as the new baseline (after "Load newer") without writing. */
        function adopt(meta) { lastSeen = meta; pending = null; if (timer) { clearTimer(timer); timer = null; } }

        // ---- blobs (iv ‖ ct) ----
        async function blobsDir(create) { try { return await dir.getDirectoryHandle(BLOBS, { create: !!create }); } catch (e) { if (isNotFound(e)) return null; throw e; } }
        async function blobPut(id, iv, ct) {
            if (!/^[\w-]{1,100}$/.test(id)) throw new Error('Bad blob id');
            const all = new Uint8Array(iv.length + ct.length);
            all.set(iv); all.set(ct, iv.length);
            await writeFile(await blobsDir(true), id + '.bin', all);
        }
        async function blobGet(id) {
            const d = await blobsDir(false);
            if (!d) return null;
            try {
                const bytes = new Uint8Array(await (await (await d.getFileHandle(id + '.bin')).getFile()).arrayBuffer());
                return bytes.length > 12 ? { iv: bytes.slice(0, 12), ct: bytes.slice(12) } : null;
            } catch (e) { if (isNotFound(e)) return null; throw e; }
        }
        async function blobDelete(id) { const d = await blobsDir(false); if (!d) return; try { await d.removeEntry(id + '.bin'); } catch (e) { if (!isNotFound(e)) throw e; } }
        async function blobList() {
            const d = await blobsDir(false);
            const out = [];
            if (!d) return out;
            for await (const [name] of d.entries()) if (/\.bin$/.test(name)) out.push(name.slice(0, -4));
            return out.sort();
        }
        /** Summary of what is in the folder (for "this folder already has data"). */
        async function inspect() {
            const f = await fileOf(DATA);
            if (!f) return { exists: false };
            try {
                const doc = C().normalizeDoc(JSON.parse(await f.text()));
                return { exists: true, readable: true, modified: f.lastModified, counts: countsOf(doc) };
            } catch (e) { return { exists: true, readable: false, modified: f.lastModified }; }
        }
        /**
         * Copy a document + blobs into the folder and verify by re-reading (SHA-256 of the data file and of every blob).
         * blobs: { id: { iv: Uint8Array, ct: Uint8Array } }
         */
        async function importAndVerify(doc, blobs) {
            const json = JSON.stringify(doc);
            const prev = await fileOf(DATA);
            if (prev) await writeFile(dir, BACKUP, await prev.text());
            await writeFile(dir, DATA, json);
            for (const id of Object.keys(blobs || {})) await blobPut(id, blobs[id].iv, blobs[id].ct);
            const f = await fileOf(DATA);
            const back = await f.text();
            if ((await sha256Hex(te.encode(back))) !== (await sha256Hex(te.encode(json)))) throw Object.assign(new Error('The data file didn’t read back correctly.'), { code: 'verify' });
            for (const id of Object.keys(blobs || {})) {
                const r = await blobGet(id);
                const want = blobs[id];
                if (!r || (await sha256Hex(r.ct)) !== (await sha256Hex(want.ct)) || (await sha256Hex(r.iv)) !== (await sha256Hex(want.iv))) {
                    throw Object.assign(new Error('A vault file didn’t read back correctly.'), { code: 'verify' });
                }
            }
            lastSeen = { lastModified: f.lastModified, size: f.size, sha: await sha256Hex(te.encode(json)) };
            return { ok: true, meta: lastSeen };
        }
        return {
            name: dir.name, handle: dir, permission, read, checkExternal, writeNow, save, flush, adopt,
            blobPut, blobGet, blobDelete, blobList, inspect, importAndVerify,
            hasPending: () => !!pending, lastSeen: () => lastSeen
        };
    }

    function countsOf(doc) {
        return {
            tasks: (doc.tasks || []).length, notes: Object.keys(doc.notes || {}).length, habits: (doc.habits || []).length,
            vaultItems: doc.vault ? (doc.vault.items || []).length : 0
        };
    }

    // ======================= capabilities & hints =======================
    /** env: { native, hasPicker (typeof showDirectoryPicker === 'function'), secure, mobile } */
    function folderSupported(env) { return !env.native && !!env.hasPicker && env.secure !== false && !env.mobile; }
    function browserKind(ua) {
        ua = String(ua || '');
        if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
        if (/Android/.test(ua)) return 'android';
        if (/Firefox\//.test(ua)) return 'firefox';
        if (/Edg\//.test(ua)) return 'edge';
        if (/OPR\//.test(ua)) return 'opera';
        if (/Chrome\//.test(ua)) return 'chrome';
        if (/Safari\//.test(ua)) return 'safari';
        return 'other';
    }
    /** One-sentence install instructions, or null when installing isn't possible / needed. */
    function installHint(ua, standalone, native) {
        if (native || standalone) return null;
        const k = browserKind(ua);
        const why = ' Installed apps keep their data even when the browser cleans up storage.';
        switch (k) {
            case 'safari': return { kind: k, text: 'In Safari, choose File › Add to Dock.' + why };
            case 'ios': return { kind: k, text: 'Tap Share › Add to Home Screen.' + why };
            case 'chrome': case 'edge': case 'opera': return { kind: k, text: 'Use the Install button at the right of the address bar.' + why };
            case 'android': return { kind: k, text: 'Open the browser menu and choose Install app (or Add to Home screen).' + why };
            default: return null; // Firefox desktop can't install web apps
        }
    }
    const hintVisible = (dismissedAt, now) => !dismissedAt || now - dismissedAt >= 7 * DAY;

    /** Ask for persistent storage once, after the first save that contains real data. */
    function shouldRequestPersist(state) {
        return !state.native && !state.folder && !state.asked && !state.persisted && !!state.hasData && !!state.supported;
    }

    /**
     * Backup reminder: { intervalDays (0 = off), lastBackupAt, firstSeenAt, lastNagDay, hasData, folderActive, folderAvailable, native, now, today }
     * → { due, days } (days since the last backup, or since first use when there never was one)
     */
    function backupReminder(s) {
        if (s.native || !s.intervalDays || !s.hasData) return { due: false };
        if (s.folderActive && s.folderAvailable !== false) return { due: false };
        const since = s.lastBackupAt || s.firstSeenAt || s.now;
        const days = Math.floor((s.now - since) / DAY);
        if (days < s.intervalDays) return { due: false, days };
        if (s.lastNagDay === s.today) return { due: false, days };
        return { due: true, days, never: !s.lastBackupAt };
    }

    /** What to do when the folder's data changed elsewhere: reload silently when nothing local is unsaved, else ask. */
    function externalChangeAction(ext, hasUnsaved) {
        if (!ext || !ext.changed) return 'none';
        if (ext.missing) return 'missing';
        if (!ext.theirs || !ext.theirs.doc) return 'conflict';
        return hasUnsaved ? 'conflict' : 'reload';
    }

    return { DATA, BACKUP, BLOBS, createFolderStore, externalChangeAction, countsOf, folderSupported, browserKind, installHint, hintVisible, shouldRequestPersist, backupReminder, sha256Hex };
});
