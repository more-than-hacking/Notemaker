#!/usr/bin/env node
/*
 * Builds tests-web/fixtures/sample-v2.json with the web app's own exporter (NotemakerCore.exportDoc).
 * Run: node tests-web/tools/generate-sample-v2.js
 * The locked note uses the passcode from docs/crypto-test-vector.json ("correct horse battery staple").
 */
const fs = require('fs');
const path = require('path');
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require('crypto').webcrypto;
const C = require('../../js/core.js');

const PASS = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/crypto-test-vector.json'), 'utf8')).passcode;
const TODAY = '2026-11-15';
let n = 0;
const id = () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0');

function task(input, extra) {
    const q = C.parseQuickAdd(input, TODAY);
    return C.normalizeTask(Object.assign({
        id: id(), title: q.title, date: q.date, priority: q.priority, tags: q.tags, reminder: q.reminder, recurrence: q.recurrence,
        pomodoros: { estimate: q.estimate, done: 0 }, createdAt: '2026-11-14T08:00:00.000Z'
    }, extra || {}));
}

(async () => {
    const doc = C.emptyDoc();
    doc.tasks = [
        task('Call Raj tomorrow 3pm #work !high', { order: 0 }),
        task('Standup every weekday at 9:30 #work', { order: 1, doneDates: { '2026-11-12': true, '2026-11-13': true }, skipDates: { '2026-11-11': true } }),
        task('Pay rent every month #home !2', { order: 2 }),
        task('Gym every mon #health', { order: 3, recurrence: { freq: 'weekly', interval: 2, byWeekday: [1, 4], until: '2027-06-30' } }),
        task('Write report ~4 !high #work', {
            order: 4, status: 'doing', timeBlock: { start: '10:00', end: '11:30' }, pomodoros: { estimate: 4, done: 2 }, notes: 'Use the Q3 numbers.',
            subtasks: [{ id: id(), title: 'Collect numbers', done: true }, { id: id(), title: 'Draft summary', done: false }]
        }),
        task('Book dentist #health !low', { order: 5, date: TODAY, rolledFrom: '2026-11-11', createdAt: '2026-11-11T09:00:00.000Z' }),
        task('Read #book #fun', { order: 6, done: true, status: 'done', completedAt: '2026-11-15T07:45:00.000Z' }),
        task('Stretch daily at 7am', { order: 7, date: '2026-11-01', recurrence: { freq: 'daily', interval: 3, byWeekday: [], until: null } })
    ];
    const lockedText = '# Private\nBank PIN reminder: ask Mom 🙂';
    doc.notes = {
        '2026-11-14': { markdown: '# Saturday\n\nPrepared the **quarterly report**. See [[2026-11-15]].\n\n- [x] outline\n- [ ] charts', updatedAt: '2026-11-14T21:00:00.000Z', locked: false, cipher: null },
        '2026-11-15': {
            markdown: '# Sunday, November 15, 2026\n\n## Today\'s focus\n- Finish the report\n\n## Daily review\n\n**Wins**\n- shipped v2\n\n**Blockers**\n- —\n\n**Tomorrow\'s focus**\n- call Raj\n',
            updatedAt: '2026-11-15T18:05:00.000Z', locked: false, cipher: null
        },
        '2026-11-13': { markdown: '', updatedAt: '2026-11-13T22:00:00.000Z', locked: true, cipher: await C.encryptNote(lockedText, PASS) }
    };
    doc.habits = [
        { id: id(), name: 'Meditate', color: '#8B5CF6', days: [], createdAt: '2026-11-01T07:00:00.000Z', log: { '2026-11-12': true, '2026-11-13': true, '2026-11-14': true, '2026-11-15': true } },
        { id: id(), name: 'Run', color: '#10B981', days: [1, 3, 5], createdAt: '2026-11-02T07:00:00.000Z', log: { '2026-11-09': true, '2026-11-11': true, '2026-11-13': true } }
    ];
    doc.templates.push({ id: id(), name: '1:1 with manager', markdown: '## 1:1 — {{weekday}}, {{date}}\n\n- Wins\n- Asks\n' });
    doc.focusSessions = [
        { id: id(), taskId: doc.tasks[4].id, start: '2026-11-15T09:00:00.000Z', end: '2026-11-15T09:25:00.000Z', minutes: 25, kind: 'focus' },
        { id: id(), taskId: doc.tasks[4].id, start: '2026-11-15T09:25:00.000Z', end: '2026-11-15T09:30:00.000Z', minutes: 5, kind: 'break' },
        { id: id(), taskId: doc.tasks[4].id, start: '2026-11-15T09:30:00.000Z', end: '2026-11-15T09:55:00.000Z', minutes: 25, kind: 'focus' },
        { id: id(), taskId: null, start: '2026-11-14T14:00:00.000Z', end: '2026-11-14T14:25:00.000Z', minutes: 25, kind: 'focus' }
    ];
    doc.settings = Object.assign(C.defaultSettings(), { theme: 'dark', reviewTime: '18:30', dayStart: '08:00', dayEnd: '20:00', lockHash: await C.makeLockHash(PASS) });

    const out = C.exportDoc(doc, '2026-11-15T18:10:00.000Z');
    const file = path.join(__dirname, '../fixtures/sample-v2.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    console.log('wrote', file);
})();
