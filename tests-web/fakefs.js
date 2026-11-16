// In-memory FileSystemDirectoryHandle stand-in for tests (File System Access API subset).
let clock = 1000;
const te = new TextEncoder(), td = new TextDecoder();
class FakeFile {
    constructor(bytes, lastModified) { this._b = bytes; this.lastModified = lastModified; this.size = bytes.length; }
    async text() { return td.decode(this._b); }
    async arrayBuffer() { return this._b.slice().buffer; }
}
const notFound = (n) => Object.assign(new Error('A requested file or directory could not be found: ' + n), { name: 'NotFoundError' });
class FakeDir {
    constructor(name) { this.kind = 'directory'; this.name = name; this.map = new Map(); this.perm = 'granted'; this.failNextWrite = false; this.corruptReads = false; }
    async queryPermission() { return this.perm; }
    async requestPermission() { if (this.perm === 'prompt') this.perm = this.onRequest || 'granted'; return this.perm; }
    async getDirectoryHandle(name, o) {
        let e = this.map.get(name);
        if (!e) { if (!(o && o.create)) throw notFound(name); e = { kind: 'dir', dir: new FakeDir(name) }; e.dir.root = this.root || this; this.map.set(name, e); }
        return e.dir;
    }
    async getFileHandle(name, o) {
        const dir = this;
        if (!this.map.has(name)) { if (!(o && o.create)) throw notFound(name); }
        return {
            kind: 'file', name,
            async getFile() {
                const e = dir.map.get(name);
                if (!e) throw notFound(name);
                let b = e.bytes;
                if ((dir.root || dir).corruptReads) { b = b.slice(); if (b.length) b[b.length - 1] ^= 1; }
                return new FakeFile(b, e.mtime);
            },
            async createWritable() {
                const chunks = [];
                const root = dir.root || dir;
                return {
                    async write(d) {
                        if (root.failNextWrite) { root.failNextWrite = false; throw new Error('disk full'); }
                        chunks.push(typeof d === 'string' ? te.encode(d) : new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d));
                    },
                    async close() { // atomic swap: only now does the file change
                        const len = chunks.reduce((s, c) => s + c.length, 0), all = new Uint8Array(len);
                        let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
                        dir.map.set(name, { kind: 'file', bytes: all, mtime: ++clock });
                    },
                    async abort() { chunks.length = 0; }
                };
            }
        };
    }
    async removeEntry(name) { if (!this.map.delete(name)) throw notFound(name); }
    async *entries() { for (const [k, e] of this.map) yield [k, e.kind === 'dir' ? e.dir : { kind: 'file', name: k }]; }
    /** Simulate another device / the Mac app / a sync client changing a file. */
    externalWrite(name, text) { this.map.set(name, { kind: 'file', bytes: te.encode(text), mtime: ++clock }); }
    touch(name) { const e = this.map.get(name); e.mtime = ++clock; }
    textOf(name) { const e = this.map.get(name); return e ? td.decode(e.bytes) : null; }
}
module.exports = { FakeDir };
