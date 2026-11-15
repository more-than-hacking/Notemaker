const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const done = (date) => C.normalizeTask({ title: 'x', date, done: true });
const open = (date) => C.normalizeTask({ title: 'x', date });

test('streak: current and best', () => {
    const today = '2026-11-15';
    const tasks = [
        done('2026-11-01'), done('2026-11-02'), done('2026-11-03'), done('2026-11-04'), // best run of 4
        done('2026-11-07'),
        done('2026-11-12'), done('2026-11-13'), done('2026-11-14'), done('2026-11-15'), done('2026-11-15'),
        open('2026-11-05')
    ];
    const s = C.streaks(C.completionsByDay(tasks), today);
    assert.deepEqual(s, { current: 4, best: 4 });
});

test('streak: today not done yet counts up to yesterday; gap breaks it', () => {
    const counts = C.completionsByDay([done('2026-11-13'), done('2026-11-14')]);
    assert.equal(C.streaks(counts, '2026-11-15').current, 2);
    assert.equal(C.streaks(counts, '2026-11-16').current, 0);
    assert.equal(C.streaks({}, '2026-11-15').current, 0);
    assert.equal(C.streaks({}, '2026-11-15').best, 0);
});

test('streak counts recurring completions per occurrence', () => {
    const t = C.normalizeTask({ title: 'r', date: '2026-11-01', recurrence: { freq: 'daily' }, doneDates: { '2026-11-14': true, '2026-11-15': true } });
    assert.deepEqual(C.streaks(C.completionsByDay([t]), '2026-11-15'), { current: 2, best: 2 });
});

test('habit streak follows scheduled days only', () => {
    // Mon/Wed/Fri habit; today = Sun 2026-11-15
    const h = C.normalizeHabit({ name: 'Run', days: [1, 3, 5], log: { '2026-11-09': true, '2026-11-11': true, '2026-11-13': true } });
    assert.equal(C.habitStreak(h, '2026-11-15'), 3);
    h.log['2026-11-11'] = false; delete h.log['2026-11-11'];
    assert.equal(C.habitStreak(h, '2026-11-15'), 1);
});

test('habit streak: every day, today logged vs not yet logged', () => {
    const h = C.normalizeHabit({ name: 'Read', days: [], log: { '2026-11-13': true, '2026-11-14': true } });
    assert.equal(C.habitStreak(h, '2026-11-15'), 2, 'today not logged yet → ends yesterday');
    h.log['2026-11-15'] = true;
    assert.equal(C.habitStreak(h, '2026-11-15'), 3);
    assert.equal(C.habitStreak(h, '2026-11-17'), 0);
});

test('range ratios and top tags', () => {
    const tasks = [
        C.normalizeTask({ title: 'a', date: '2026-11-15', done: true, tags: ['work'] }),
        C.normalizeTask({ title: 'b', date: '2026-11-15', tags: ['work', 'home'] }),
        C.normalizeTask({ title: 'r', date: '2026-11-14', recurrence: { freq: 'daily' }, doneDates: { '2026-11-15': true }, tags: ['health'] })
    ];
    const r = C.rangeRatios(tasks, '2026-11-14', '2026-11-15');
    assert.deepEqual(r['2026-11-15'], { total: 3, done: 2 });
    assert.deepEqual(r['2026-11-14'], { total: 1, done: 0 });
    assert.deepEqual(C.dayRatio(tasks, '2026-11-15'), { total: 3, done: 2 });
    assert.equal(C.topTags(tasks)[0].tag, 'work');
});
