const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const T = (date, recurrence, extra) => C.normalizeTask(Object.assign({ id: 'x', title: 't', date, recurrence }, extra || {}));
const days = (task, from, to) => {
    const out = [];
    for (let d = from; d <= to; d = C.addDays(d, 1)) if (C.occursOn(task, d)) out.push(d);
    return out;
};

test('non-recurring occurs only on its date', () => {
    const t = T('2026-11-15', null);
    assert.deepEqual(days(t, '2026-11-10', '2026-11-20'), ['2026-11-15']);
});

test('daily, interval 1 and 3, until', () => {
    assert.deepEqual(days(T('2026-11-15', { freq: 'daily' }), '2026-11-13', '2026-11-18'),
        ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18']);
    assert.deepEqual(days(T('2026-11-15', { freq: 'daily', interval: 3 }), '2026-11-15', '2026-11-25'),
        ['2026-11-15', '2026-11-18', '2026-11-21', '2026-11-24']);
    assert.deepEqual(days(T('2026-11-15', { freq: 'daily', until: '2026-11-17' }), '2026-11-15', '2026-11-25'),
        ['2026-11-15', '2026-11-16', '2026-11-17']);
});

test('daily across DST change keeps the interval', () => {
    // Europe/US DST shifts in March/Oct/Nov must not matter (UTC arithmetic)
    assert.deepEqual(days(T('2026-03-07', { freq: 'daily', interval: 2 }), '2026-03-07', '2026-03-11'),
        ['2026-03-07', '2026-03-09', '2026-03-11']);
});

test('weekdays: Mon–Fri only, from start date', () => {
    assert.deepEqual(days(T('2026-11-15', { freq: 'weekdays' }), '2026-11-10', '2026-11-22'),
        ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
});

test('weekly: default weekday of date, byWeekday, interval', () => {
    // 2026-11-15 is a Sunday
    assert.deepEqual(days(T('2026-11-15', { freq: 'weekly' }), '2026-11-01', '2026-11-30'),
        ['2026-11-15', '2026-11-22', '2026-11-29']);
    assert.deepEqual(days(T('2026-11-16', { freq: 'weekly', byWeekday: [1, 3, 5] }), '2026-11-15', '2026-11-22'),
        ['2026-11-16', '2026-11-18', '2026-11-20']);
    // every 2 weeks on Mon+Thu, starting Wed 2026-11-18 (its week's Monday = 11-16)
    assert.deepEqual(days(T('2026-11-18', { freq: 'weekly', interval: 2, byWeekday: [1, 4] }), '2026-11-16', '2026-12-13'),
        ['2026-11-19', '2026-11-30', '2026-12-03']);
});

test('monthly: same day, interval, 31st clamps to month end', () => {
    assert.deepEqual(days(T('2026-11-15', { freq: 'monthly' }), '2026-11-01', '2027-02-28'),
        ['2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15']);
    assert.deepEqual(days(T('2026-01-31', { freq: 'monthly' }), '2026-01-01', '2026-06-30'),
        ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    assert.deepEqual(days(T('2028-01-31', { freq: 'monthly' }), '2028-02-01', '2028-02-29'), ['2028-02-29'], 'leap year');
    assert.deepEqual(days(T('2026-01-31', { freq: 'monthly', interval: 2 }), '2026-01-01', '2026-07-31'),
        ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
});

test('skipDates removes a single occurrence; doneDates are per occurrence', () => {
    const t = T('2026-11-15', { freq: 'daily' }, { skipDates: { '2026-11-16': true }, doneDates: { '2026-11-15': true } });
    assert.deepEqual(days(t, '2026-11-15', '2026-11-17'), ['2026-11-15', '2026-11-17']);
    assert.equal(C.isDoneOn(t, '2026-11-15'), true);
    assert.equal(C.isDoneOn(t, '2026-11-17'), false);
    C.setDoneOn(t, '2026-11-17', true);
    assert.equal(C.isDoneOn(t, '2026-11-17'), true);
    assert.equal(t.done, false, 'recurring tasks never set done');
    assert.equal(C.statusOn(t, '2026-11-17'), 'done');
    C.setStatusOn(t, '2026-11-17', 'doing');
    assert.equal(C.statusOn(t, '2026-11-17'), 'doing');
    assert.equal(C.isDoneOn(t, '2026-11-17'), false);
});

test('rollover moves unfinished non-recurring past tasks to today', () => {
    const tasks = [
        T('2026-11-12', null, { id: 'a' }),
        T('2026-11-12', null, { id: 'b', done: true }),
        T('2026-11-10', { freq: 'daily' }, { id: 'c' }),
        T('2026-11-14', null, { id: 'd', rolledFrom: '2026-11-11' }),
        T('2026-11-16', null, { id: 'e' })
    ];
    assert.equal(C.rollover(tasks, '2026-11-15'), 2);
    const by = Object.fromEntries(tasks.map((t) => [t.id, t]));
    assert.equal(by.a.date, '2026-11-15'); assert.equal(by.a.rolledFrom, '2026-11-12');
    assert.equal(by.b.date, '2026-11-12'); assert.equal(by.b.rolledFrom, null);
    assert.equal(by.c.date, '2026-11-10');
    assert.equal(by.d.date, '2026-11-15'); assert.equal(by.d.rolledFrom, '2026-11-11', 'keeps original rolledFrom');
    assert.equal(by.e.date, '2026-11-16');
    assert.equal(C.overdueDays(by.a, '2026-11-15'), 3);
    assert.equal(C.overdueDays(by.d, '2026-11-15'), 4);
    assert.equal(C.rollover(tasks, '2026-11-15'), 0, 'idempotent');
    C.snooze(by.a, '2026-11-20');
    assert.equal(by.a.date, '2026-11-20'); assert.equal(by.a.rolledFrom, null);
});
