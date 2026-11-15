/* Notemaker — encrypted vault file blobs. Browser: IndexedDB `notemaker-vault` / store `blobs` {id, iv, ct}.
   Desktop shell: blobs.put / blobs.get / blobs.delete. Only ciphertext is ever stored here. */
(function () {
    'use strict';
    const NM = window.NM, V = window.NotemakerVault;
    const DB = 'notemaker-vault', STORE = 'blobs';
    let dbp = null;

    function openDb() {
        if (dbp) return dbp;
        dbp = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('IndexedDB is not available in this browser, so vault files cannot be stored.')); return; }
            const req = indexedDB.open(DB, 1);
            req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' }); };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('Could not open IndexedDB'));
            req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
        });
        dbp.catch(() => { dbp = null; });
        return dbp;
    }
    async function tx(mode, fn) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const t = db.transaction(STORE, mode);
            const st = t.objectStore(STORE);
            let result;
            const req = fn(st);
            if (req) req.onsuccess = () => { result = req.result; };
            t.oncomplete = () => resolve(result);
            t.onerror = () => reject(t.error || new Error('IndexedDB error'));
            t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted (storage full?)'));
        });
    }
    const u8 = (x) => (x instanceof Uint8Array ? x : typeof x === 'string' ? V.unb64(x) : new Uint8Array(x));

    NM.vaultBlobs = {
        /** iv, ct: Uint8Array (or base64) */
        async put(id, iv, ct) {
            if (NM.native) return NM.native.request('blobs.put', { id, iv: V.b64(u8(iv)), ct: V.b64(u8(ct)) });
            return tx('readwrite', (st) => st.put({ id, iv: u8(iv), ct: u8(ct) }));
        },
        /** → { iv: Uint8Array, ct: Uint8Array } | null */
        async get(id) {
            const r = NM.native ? await NM.native.request('blobs.get', { id }) : await tx('readonly', (st) => st.get(id));
            return r && r.iv && r.ct ? { iv: u8(r.iv), ct: u8(r.ct) } : null;
        },
        async delete(id) {
            if (!id) return;
            if (NM.native) return NM.native.request('blobs.delete', { id });
            return tx('readwrite', (st) => st.delete(id));
        },
        /** All blobs as { id: {iv, ct} } base64 for export; null when the backend cannot list (desktop shell). */
        async all() {
            if (NM.native) return null;
            const rows = (await tx('readonly', (st) => st.getAll())) || [];
            const out = {};
            for (const r of rows) out[r.id] = { iv: V.b64(u8(r.iv)), ct: V.b64(u8(r.ct)) };
            return out;
        }
    };
})();
