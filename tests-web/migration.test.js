const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');

const v1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/v1-export.json'), 'utf8'));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('v1 → v2 migration of a real v1 export', () => {
    const doc = C.importToDoc(v1);
    assert.equal(doc.version, 2);
    assert.equal(doc.app, 'notemaker');
    assert.equal(doc.tasks.length, 4);

    const rep = doc.tasks.find((t) => t.title === 'Finish quarterly report');
    assert.equal(rep.date, '2026-02-24');
    assert.equal(rep.done, true);
    assert.equal(rep.status, 'done');
    assert.equal(rep.completedAt, '2026-02-24T08:01:10.000Z');
    assert.equal(rep.createdAt, '2026-02-24T08:01:10.000Z');
    assert.equal(rep.priority, 'none');
    assert.deepEqual(rep.tags, []);
    assert.equal(rep.recurrence, null);
    assert.deepEqual(rep.doneDates, {});
    assert.deepEqual(rep.pomodoros, { estimate: 0, done: 0 });
    assert.match(rep.id, UUID_RE);
    assert.deepEqual(rep.subtasks.map((s) => [s.title, s.done]), [['Collect numbers', true], ['Write summary', false]]);
    rep.subtasks.forEach((s) => assert.match(s.id, UUID_RE));

    const plumber = doc.tasks.find((t) => t.title === 'Call plumber');
    assert.equal(plumber.done, false);
    assert.equal(plumber.status, 'todo');
    assert.equal(plumber.completedAt, null);
    assert.equal(plumber.order, 1, 'order within its day');

    const gym = doc.tasks.find((t) => t.title === 'Gym');
    assert.deepEqual(gym.subtasks, [], 'missing subtasks → []');
    assert.equal(doc.tasks.find((t) => t.title.startsWith('Buy')).title, 'Buy <groceries> & milk', 'text kept verbatim');

    assert.deepEqual(Object.keys(doc.notes).sort(), ['2026-02-24', '2026-02-25']);
    assert.equal(doc.notes['2026-02-24'].markdown, '# Tuesday\n\n- shipped **v1**\n- see [[2026-02-25]]');
    assert.equal(doc.notes['2026-02-24'].locked, false);
    assert.equal(doc.notes['2026-02-24'].cipher, null);
    assert.equal(doc.notes['2026-02-24'].updatedAt, '2026-02-24T20:00:00.000Z');

    assert.deepEqual(doc.templates.map((t) => t.name), ['Daily journal', 'Meeting notes', 'Weekly review']);
    assert.deepEqual(doc.settings, C.defaultSettings());
    assert.deepEqual(C.backlinks(doc.notes, '2026-02-25'), ['2026-02-24']);
});

test('v1 migration is deterministic (re-import does not duplicate)', () => {
    const a = C.importToDoc(v1), b = C.importToDoc(JSON.parse(JSON.stringify(v1)));
    assert.deepEqual(a.tasks.map((t) => t.id), b.tasks.map((t) => t.id));
    const merged = C.mergeDocs(a, b);
    assert.equal(merged.stats.tasksAdded, 0);
    assert.equal(merged.doc.tasks.length, 4);
});

test('raw localStorage v1 arrays (notemaker_tasks / notemaker_notes) migrate', () => {
    const doc = C.migrateV1(v1.tasks, v1.notes, { theme: 'dark' });
    assert.equal(doc.tasks.length, 4);
    assert.equal(doc.settings.theme, 'dark');
});

test('macOS v1 shapes (isCompleted, Swift reference-date numbers) migrate', () => {
    const doc = C.migrateV1(
        [{ id: 'A1B2', title: 'Mac task', isCompleted: true, date: 785000000, createdAt: 785000000 }],
        [{ id: 'N1', content: 'mac note', date: '2025-11-16T10:00:00Z', createdAt: '2025-11-16T10:00:00Z' }]);
    assert.equal(doc.tasks[0].done, true);
    assert.equal(doc.tasks[0].createdAt, new Date((785000000 + 978307200) * 1000).toISOString());
    assert.equal(doc.notes['2025-11-16'].markdown, 'mac note');
});

test('import rejects garbage and sanitises hostile v2 fields', () => {
    assert.throws(() => C.importToDoc(null));
    assert.throws(() => C.importToDoc({ hello: 1 }));
    const doc = C.importToDoc({
        version: 2, tasks: [{ id: 1, title: 5, date: 'nope', priority: 'urgent', tags: ['#Work', 'work', 3], reminder: '25:00', recurrence: { freq: 'hourly' } }],
        notes: { 'bad-key': { markdown: 'x' }, '2026-11-15': { markdown: 'ok', locked: true } }, settings: { theme: 'neon', focusMinutes: -4 }
    });
    const t = doc.tasks[0];
    assert.equal(t.id, '1'); assert.equal(t.title, '5'); assert.equal(t.priority, 'none');
    assert.deepEqual(t.tags, ['work', '3']); assert.equal(t.reminder, null); assert.equal(t.recurrence, null);
    assert.deepEqual(Object.keys(doc.notes), ['2026-11-15']);
    assert.equal(doc.notes['2026-11-15'].locked, false, 'locked without cipher is not locked');
    assert.equal(doc.settings.theme, 'system'); assert.equal(doc.settings.focusMinutes, 1);
});
