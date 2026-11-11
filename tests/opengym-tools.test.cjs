'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const tools = require('../www/opengym/training-tools.js');

test('kg and lb use separate plate inventories without converting physical plates', () => {
  assert.ok(tools.defaultInventory('kg').some(p => p.weight === 20));
  assert.ok(tools.defaultInventory('lb').some(p => p.weight === 45));
  const kg = tools.calculatePlates({ target: 100, bar: 20, unit: 'kg' });
  assert.equal(kg.exact, true);
  assert.deepEqual(kg.perSide, [{ weight: 25, count: 1 }, { weight: 15, count: 1 }]);
  const lb = tools.calculatePlates({ target: 225, bar: 45, unit: 'lb' });
  assert.deepEqual(lb.perSide, [{ weight: 45, count: 2 }]);
  const changed = tools.defaultInventory('kg');
  changed[0].pairs = 19;
  assert.equal(tools.defaultInventory('kg')[0].pairs, 2);
});

test('finite inventory finds an exact combination when greedy cannot', () => {
  const result = tools.calculatePlates({ target: 12, bar: 0, inventory: [{ weight: 4, pairs: 1 }, { weight: 3, pairs: 2 }] });
  assert.equal(result.exact, true);
  assert.deepEqual(result.plateStack, [3, 3]);
  assert.equal(result.achieved, 12);
});

test('insufficient stock returns the closest load below, never above target', () => {
  const result = tools.calculatePlates({ target: 16, bar: 0, inventory: [{ weight: 4, pairs: 1 }, { weight: 3, pairs: 2 }] });
  assert.equal(result.exact, false);
  assert.equal(result.achieved, 14);
  assert.equal(result.remaining, 2);
  assert.deepEqual(result.plateStack, [4, 3]);
  const fraction = tools.calculatePlates({ target: 20.49, bar: 20, inventory: [{ weight: 0.25, pairs: 1 }] });
  assert.equal(fraction.achieved, 20);
  assert.equal(fraction.remaining, 0.49);
});

test('empty, bar-only and single-stack calculations respect quantities', () => {
  assert.equal(tools.calculatePlates({ target: 20, bar: 20, inventory: [] }).barOnly, true);
  assert.equal(tools.calculatePlates({ target: 25, bar: 20, inventory: [] }).achieved, 20);
  const stock = [{ weight: 20, pairs: 1 }];
  assert.equal(tools.calculatePlates({ target: 50, bar: 0, kind: 'single', inventory: stock }).achieved, 40);
  assert.deepEqual(stock, [{ weight: 20, pairs: 1 }]);
  assert.match(tools.calculatePlates({ target: 15, bar: 20 }).error, /lighter than/);
});

test('plate computation agrees with exhaustive small-stock oracle', () => {
  const inventories = [
    [{ weight: 4, pairs: 1 }, { weight: 3, pairs: 2 }, { weight: 1.25, pairs: 2 }],
    [{ weight: 2.5, pairs: 2 }, { weight: 1.5, pairs: 1 }, { weight: 0.5, pairs: 2 }],
  ];
  for (const inventory of inventories) {
    let sums = [0];
    for (const item of inventory) sums = sums.flatMap(sum => Array.from({ length: item.pairs + 1 }, (_, count) => sum + item.weight * count));
    for (let target = 0; target <= 25; target += 0.25) {
      const expected = Math.max(...sums.filter(sum => sum <= target / 2)) * 2;
      const actual = tools.calculatePlates({ target, bar: 0, inventory });
      assert.equal(actual.achieved, expected, JSON.stringify({ inventory, target }));
      assert.ok(actual.achieved <= target);
    }
  }
});

test('invalid and unbounded plate inputs fail before allocation', () => {
  for (const target of [NaN, Infinity, -1, 1501, '', null, true, {}, [], '1e100', 20.123]) {
    assert.ok(tools.calculatePlates({ target }).error, String(target));
  }
  for (const inventory of [null, {}, [{ weight: 0.00001, pairs: 1 }], [{ weight: 1.1, pairs: 1 }], [{ weight: 20, pairs: 1.5 }], [{ weight: 20, pairs: Infinity }], [{ weight: 20, pairs: 21 }], [{ weight: 20, pairs: 1 }, { weight: 20, pairs: 1 }]]) {
    assert.ok(tools.calculatePlates({ target: 100, inventory }).error);
  }
  assert.ok(tools.calculatePlates({ target: 100, unit: 'stone' }).error);
  assert.ok(tools.calculatePlates({ target: 100, kind: 'unequal' }).error);
});

test('plate changes preserve multiplicity', () => {
  assert.deepEqual(tools.plateDelta([20, 20, 5], [20, 10, 5]), { strip: [20], add: [10] });
  assert.throws(() => tools.plateDelta([Infinity], []), /finite plate/);
});

test('named formulas preserve upstream numerical results and single repetitions', () => {
  assert.equal(tools.estimateOneRepMax({ weight: 100, reps: 5 }).estimate, 116.7);
  assert.equal(tools.estimateOneRepMax({ weight: 100, reps: 5, formula: 'brzycki' }).estimate, 112.5);
  assert.equal(tools.formulas.length, 7);
  for (const { id } of tools.formulas) {
    const result = tools.estimateOneRepMax({ weight: 100, reps: 1, formula: id });
    assert.equal(result.estimate, 100);
    assert.match(result.warning, /does not prove your maximum/);
  }
  assert.match(tools.estimateOneRepMax({ weight: 100, reps: 12 }).warning, /not a recommended/);
});

test('high-rep, non-finite and malformed estimates are rejected without fallback claims', () => {
  for (const reps of [0, 13, Infinity, NaN, -1, 1.5, '', null, true]) {
    assert.equal(tools.estimateOneRepMax({ weight: 100, reps }).estimate, null);
  }
  for (const weight of [0, -1, Infinity, NaN, '', {}, [], true]) {
    assert.equal(tools.estimateOneRepMax({ weight, reps: 5 }).estimate, null);
  }
  for (const formula of ['weighted', 'constructor', '__proto__', 'unknown', { toString: null }]) {
    assert.equal(tools.estimateOneRepMax({ weight: 100, reps: 5, formula }).estimate, null);
  }
});

// Independent RFC 4180 reader for checking exported cells without relying on the
// implementation's escaping routine.
function csvRows(text) {
  const rows = [], row = [];
  let cell = '', quoted = false;
  for (let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ',') { row.push(cell); cell = ''; }
    else if (!quoted && c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row.splice(0)); cell = ''; i++; }
    else cell += c;
  }
  assert.equal(quoted, false);
  return rows;
}

test('CSV exports every set chronologically, exact timestamps and exercise identity', () => {
  const later = Date.parse('2026-11-11T21:02:03.123Z'), earlier = later - 60000;
  const logs = [{ t: later, ex: 'lift-a', kg: 22.5, reps: 8 }, { t: earlier, ex: 'lift-a', kg: 0, reps: 10 }];
  const rows = csvRows(tools.exportWorkoutCsv(logs, { 'lift-a': { name: 'Lift, "A"\nÜ', primary: ['chest'] } }));
  const record = row => Object.fromEntries(rows[0].map((key, i) => [key, row[i]]));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].length, 24);
  const first = record(rows[1]), last = record(rows[2]);
  assert.equal(first.exercise, 'Lift, "A"\nÜ');
  assert.equal(first.weight, '0');
  assert.equal(first.set, '1');
  assert.equal(first.set_time, new Date(earlier).toISOString());
  assert.equal(last.set_time, new Date(later).toISOString());
  assert.equal(last.iron_atlas_exercise_id, 'lift-a');
  assert.equal(last.exercise_id, '');
  assert.equal(last.start_time, '');
  assert.equal(last.end_time, '');
  assert.equal(last.workout, '');
  assert.equal(last.weight, '22.5');
  assert.equal(logs[0].t, later, 'the original state array is not sorted in place');
});

test('CSV pounds convert load, not stored state or body-weight reps', () => {
  const log = [{ t: 1794430000000, ex: 'a', kg: 100, reps: 5 }];
  const rows = csvRows(tools.exportWorkoutCsv(log, [{ id: 'a', name: 'A' }], { unit: 'lb' }));
  assert.equal(rows[1][12], '220.462262');
  assert.equal(rows[1][13], 'lb');
  assert.equal(log[0].kg, 100);
});

test('CSV dates are UTC and dumbbell loads keep the recorded convention', () => {
  const instant = Date.parse('2026-11-11T23:30:00-08:00');
  const logs = [{ t: instant, ex: 'db-bench', kg: 22.5, reps: 10 }];
  const rows = csvRows(tools.exportWorkoutCsv(logs, { 'db-bench': { name: 'Dumbbell bench press' } }));
  assert.equal(rows[1][0], '2026-11-12');
  assert.equal(rows[1][23], '2026-11-12T07:30:00.000Z');
  assert.equal(rows[1][12], '22.5', 'per-dumbbell entries are not doubled');
});

test('CSV neutralizes spreadsheet formulas including whitespace and numeric-prefix expressions', () => {
  for (const name of ['=1+1', '+cmd', '-1+cmd', '@SUM(A1)', '  =1+1', '\t=1+1', '\r=1+1', '\n=1+1']) {
    const rows = csvRows(tools.exportWorkoutCsv([{ t: 1794430000000, ex: 'a', kg: 10, reps: 5 }], { a: name }));
    assert.equal(rows[1][5], "'" + name);
  }
  assert.equal(tools.csvField(-12.5), '-12.5');
});

test('invalid CSV records fail the whole export instead of silently losing sets', () => {
  const good = { t: 1794430000000, ex: 'a', kg: 10, reps: 5 };
  for (const bad of [{ ...good, t: Infinity }, { ...good, reps: 0 }, { ...good, kg: -1 }, { ...good, ex: '' }]) {
    assert.throws(() => tools.exportWorkoutCsv([good, bad], {}), /saved set 2/);
  }
  assert.throws(() => tools.exportWorkoutCsv([good], {}, { unit: 'unknown' }), /kg or lb/);
  assert.equal(csvRows(tools.exportWorkoutCsv([], {})).length, 1);
});

test('the same source runs as a browser global without Node or network dependencies', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../www/opengym/training-tools.js'), 'utf8'), context);
  assert.equal(context.IronAtlasOpenGym.calculatePlates({ target: 100 }).achieved, 100);
  assert.equal(context.IronAtlasOpenGym.estimateOneRepMax({ weight: 100, reps: 5 }).estimate, 116.7);
  assert.equal(context.fetch, undefined);
});
