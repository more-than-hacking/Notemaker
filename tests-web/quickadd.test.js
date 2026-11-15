const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const TODAY = '2026-11-15'; // Sunday

// Test vectors from docs/DATA_FORMAT.md
const vectors = [
    ['Call Raj tomorrow 3pm #work !high', { title: 'Call Raj', date: '2026-11-16', priority: 'high', tags: ['work'], reminder: '15:00', recurrence: null }],
    ['Standup every weekday at 9:30', { title: 'Standup', date: '2026-11-15', priority: 'none', tags: [], reminder: '09:30', recurrence: { freq: 'weekdays', interval: 1, byWeekday: [], until: null } }],
    ['Pay rent every month #home !2', { title: 'Pay rent', date: '2026-11-15', priority: 'medium', tags: ['home'], reminder: null, recurrence: { freq: 'monthly', interval: 1, byWeekday: [], until: null } }],
    ['Gym every mon #health', { title: 'Gym', date: '2026-11-16', priority: 'none', tags: ['health'], reminder: null, recurrence: { freq: 'weekly', interval: 1, byWeekday: [1], until: null } }],
    ['Write report in 3 days ~4', { title: 'Write report', date: '2026-11-18', priority: 'none', tags: [], reminder: null, recurrence: null, estimate: 4 }],
    ['Plan sprint next week !low', { title: 'Plan sprint', date: '2026-11-16', priority: 'low', tags: [], reminder: null, recurrence: null }],
    ['Review 2026-12-01 at 14', { title: 'Review', date: '2026-12-01', priority: 'none', tags: [], reminder: '14:00', recurrence: null }],
    ['Read #book #fun', { title: 'Read', date: '2026-11-15', priority: 'none', tags: ['book', 'fun'], reminder: null, recurrence: null }]
];

for (const [input, want] of vectors) {
    test('quick add vector: ' + input, () => {
        const r = C.parseQuickAdd(input, TODAY);
        for (const k of Object.keys(want)) assert.deepEqual(r[k], want[k], k);
        if (!('estimate' in want)) assert.equal(r.estimate, 0);
    });
}

test('quick add: other tokens', () => {
    const p = (s) => C.parseQuickAdd(s, TODAY);
    assert.equal(p('x tmr').date, '2026-11-16');
    assert.equal(p('x today').date, TODAY);
    assert.equal(p('x sun').date, TODAY, 'today counts if it matches');
    assert.equal(p('x saturday').date, '2026-11-21');
    assert.equal(p('x in 2 weeks').date, '2026-11-29');
    assert.equal(p('x in 1 day').date, '2026-11-16');
    assert.equal(p('x 12am').reminder, '00:00');
    assert.equal(p('x 12pm').reminder, '12:00');
    assert.equal(p('x 3:30pm').reminder, '15:30');
    assert.equal(p('x 15:30').reminder, '15:30');
    assert.equal(p('x at 9').reminder, '09:00');
    assert.equal(p('Room 9').reminder, null, 'bare number needs "at"');
    assert.equal(p('Room 9').title, 'Room 9');
    assert.equal(p('x !h').priority, 'high');
    assert.equal(p('x !med').priority, 'medium');
    assert.equal(p('x !3').priority, 'low');
    assert.equal(p('x daily').recurrence.freq, 'daily');
    assert.equal(p('x every day').recurrence.freq, 'daily');
    assert.equal(p('x weekdays').recurrence.freq, 'weekdays');
    assert.equal(p('x monthly').recurrence.freq, 'monthly');
    const w = p('x weekly');
    assert.equal(w.recurrence.freq, 'weekly');
    assert.deepEqual(w.recurrence.byWeekday, [7], 'weekday from the task date');
    const wf = p('x every Friday #A');
    assert.deepEqual(wf.recurrence.byWeekday, [5]);
    assert.equal(wf.date, '2026-11-20');
    assert.deepEqual(wf.tags, ['a'], 'tags lower-cased');
    assert.equal(p('TOMORROW Lunch AT 1PM').reminder, '13:00', 'case-insensitive');
    assert.equal(p('TOMORROW Lunch AT 1PM').title, 'Lunch');
    assert.equal(p('x 2026-02-30').date, TODAY, 'invalid ISO date is not a date');
});
