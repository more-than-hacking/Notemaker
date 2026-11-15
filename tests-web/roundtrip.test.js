const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require('crypto').webcrypto;
const C = require('../js/core.js');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample-v2.json'), 'utf8'));
const vector = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/crypto-test-vector.json'), 'utf8'));

test('export → JSON → import round trip is lossless', () => {
    const doc = C.importToDoc(sample);
    const exported = C.exportDoc(doc, '2030-01-01T00:00:00.000Z');
    const reimported = C.importToDoc(JSON.parse(JSON.stringify(exported)));
    const strip = (d) => Object.assign({}, d, { exportedAt: null });
    assert.deepEqual(strip(reimported), strip(doc));
    assert.deepEqual(strip(C.exportDoc(reimported, 'x')), strip(exported));
});

test('sample-v2.json is already canonical (exporter output == normalised)', () => {
    const doc = C.importToDoc(sample);
    assert.deepEqual(C.exportDoc(doc, sample.exportedAt), sample);
});

test('sample-v2.json has the required top-level shape and content', () => {
    assert.equal(sample.app, 'notemaker');
    assert.equal(sample.version, 2);
    assert.deepEqual(Object.keys(sample), ['app', 'version', 'exportedAt', 'tasks', 'notes', 'habits', 'templates', 'focusSessions', 'settings']);
    assert.ok(sample.tasks.some((t) => t.recurrence && t.recurrence.freq === 'weekly' && t.recurrence.interval === 2));
    assert.ok(sample.tasks.some((t) => t.timeBlock));
    assert.ok(sample.tasks.some((t) => t.reminder));
    assert.ok(sample.tasks.some((t) => t.subtasks.length));
    assert.ok(sample.tasks.some((t) => t.rolledFrom));
    assert.ok(sample.habits.length >= 2 && sample.templates.length >= 4 && sample.focusSessions.length >= 3);
    assert.ok(Object.values(sample.notes).some((n) => n.locked));
});

test('sample-v2.json locked note decrypts with the test-vector passcode and lockHash verifies', async () => {
    const locked = Object.entries(sample.notes).find(([, n]) => n.locked);
    assert.equal(locked[1].markdown, '');
    assert.equal(await C.decryptNote(locked[1].cipher, vector.passcode), vector.plaintext);
    assert.equal(await C.verifyPasscode(vector.passcode, sample.settings.lockHash), true);
});

test('merge import: no duplicates, notes merged, locked notes untouched', () => {
    const local = C.importToDoc(sample);
    local.notes['2026-11-14'].markdown = 'local text';
    const incoming = C.importToDoc(sample);
    incoming.tasks.push(C.normalizeTask({ id: 'new-1', title: 'Brand new', date: '2026-11-20' }));
    incoming.tasks.push(C.normalizeTask({ id: 'dup-2', title: 'call raj', date: '2026-11-16' }));
    const { doc, stats } = C.mergeDocs(local, incoming);
    assert.equal(stats.tasksAdded, 1);
    assert.equal(doc.tasks.length, local.tasks.length + 1);
    assert.match(doc.notes['2026-11-14'].markdown, /^local text\n\n--- Merged from import ---\n\n# Saturday/);
    assert.deepEqual(doc.notes['2026-11-13'], local.notes['2026-11-13']);
    assert.equal(stats.habitsAdded, 0);
    assert.equal(local.tasks.length, sample.tasks.length, 'inputs not mutated');
});

test('markdown export of a day', () => {
    const doc = C.importToDoc(sample);
    const md = C.exportMarkdown(doc, ['2026-11-15']);
    assert.match(md, /^# Sunday, November 15, 2026/);
    assert.match(md, /- \[x\] Read #book #fun/);
    assert.match(md, /- \[ \] Write report !high #work/);
    assert.match(md, /  - \[x\] Collect numbers/);
    assert.match(md, /## Note\n\n# Sunday/);
    const locked = C.exportMarkdown(doc, ['2026-11-13']);
    assert.match(locked, /Private note \(locked\)/);
    assert.doesNotMatch(locked, /Bank PIN/);
});
