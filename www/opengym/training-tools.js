/*
 * Iron Atlas training tools, adapted from openGym.
 * Copyright (C) 2026 Duarte Santos; Iron Atlas adaptations (C) 2026 Mark Evans.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Upstream: https://github.com/DuarteSantos8/openGym
 * Commit: 50ab7f24e3c4ee70e7f26b3beb426f571e03414b
 * Sources: frontend/src/lib/plates.js (plate sizes, plateStack, rowLoad, plateDelta),
 * frontend/src/lib/onerm.js (classic formulas, capped estimate1RM), and
 * frontend/src/lib/export-csv.js (CSV columns, quoting and row serialization).
 *
 * Modified 11 November 2026: standalone browser/CommonJS wrapper; explicit bounded
 * inputs; finite inventory; below-bar errors; no rounded-up plate loads; classic
 * formulas only; no confidence claims; Iron Atlas log adapter and UTC timestamps;
 * stricter spreadsheet-formula escaping. No exercise catalogue or media included.
 * See provenance.json and ../licenses/agpl-3.0.txt for licence details.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IronAtlasOpenGym = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // openGym plates.js. Inventories are separate physical plates for each unit.
  const PLATE_SIZES = Object.freeze({
    kg: Object.freeze([25, 20, 15, 10, 5, 2.5, 2, 1.5, 1.25, 1, 0.5]),
    lb: Object.freeze([45, 35, 25, 15, 10, 5, 2.5, 1.25, 1, 0.5]),
  });
  const UNCOMMON = { kg: new Set([2, 1.5, 1, 0.5]), lb: new Set([15, 1.25, 1, 0.5]) };
  const MAX_LOAD = 1500, MAX_PAIRS = 20, MAX_SIZES = 20;
  const Q = 4;
  const q = w => Math.round(w * Q);
  const rounded = n => Math.round(n * 1e6) / 1e6;
  const unitIsValid = unit => unit === 'kg' || unit === 'lb';

  function number(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return NaN;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function defaultInventory(unit = 'kg') {
    if (!unitIsValid(unit)) throw new Error('Choose kg or lb.');
    // Two pairs is an editable starting inventory, not a claim about the user's gym.
    return PLATE_SIZES[unit].filter(w => !UNCOMMON[unit].has(w)).map(weight => ({ weight, pairs: 2 }));
  }

  function inventoryOf(inventory) {
    if (!Array.isArray(inventory) || inventory.length > MAX_SIZES) throw new Error('Enter up to 20 plate sizes.');
    const seen = new Set();
    return inventory.map(p => {
      const w = number(p?.weight), n = number(p?.pairs);
      if (!(w >= 0.25 && w <= 500) || Math.abs(w * Q - q(w)) > 1e-8) {
        throw new Error('Plate sizes must be between 0.25 and 500, in quarter-unit steps.');
      }
      if (!Number.isInteger(n) || n < 0 || n > MAX_PAIRS) throw new Error('Enter 0 to 20 whole pairs for each plate size.');
      if (seen.has(w)) throw new Error('Enter each plate size once.');
      seen.add(w);
      return { w, n };
    }).sort((a, b) => b.w - a.w);
  }

  // Adapted from openGym plateStack. Validated quarter-unit inventory bounds both
  // the dynamic-programming table and its loops before this function is reached.
  function plateStack(weight, inv) {
    const requested = Math.max(0, weight);
    const target = Math.floor(requested * Q);
    if (target === 0) return { plates: [], missing: requested };
    const items = inv.filter(p => p.w > 0 && p.n > 0).sort((a, b) => b.w - a.w);
    const greedy = [];
    let left = target;
    for (const p of items) {
      const unit = q(p.w);
      let k = Math.min(p.n, Math.floor(left / unit));
      while (k-- > 0) { greedy.push(p.w); left -= unit; }
    }
    const all = items.reduce((sum, p) => sum + q(p.w) * p.n, 0);
    if (left === 0 || target >= all) return { plates: greedy, missing: requested - (target - left) / Q };
    const n = items.length, INF = 1e9;
    const f = Array.from({ length: n + 1 }, () => new Int32Array(target + 1).fill(INF));
    f[n][0] = 0;
    for (let i = n - 1; i >= 0; i--) {
      const unit = q(items[i].w), cap = items[i].n;
      for (let s = 0; s <= target; s++) {
        let best = f[i + 1][s];
        for (let k = 1; k <= cap && k * unit <= s; k++) {
          const v = f[i + 1][s - k * unit];
          if (v + k < best) best = v + k;
        }
        f[i][s] = best;
      }
    }
    let sum = target;
    while (sum > 0 && f[0][sum] >= INF) sum--;
    const plates = [];
    let s = sum;
    for (let i = 0; i < n; i++) {
      const unit = q(items[i].w), cap = items[i].n;
      for (let k = Math.min(cap, Math.floor(s / unit)); k >= 0; k--) {
        if (f[i + 1][s - k * unit] + k === f[i][s]) {
          for (let j = 0; j < k; j++) plates.push(items[i].w);
          s -= k * unit;
          break;
        }
      }
    }
    return { plates, missing: requested - sum / Q };
  }

  // openGym rowLoad, with validated inputs and no rounding that could exceed target.
  function rowLoad(kind, weight, base, inv) {
    if (weight === base) return { kind, barOnly: true, perSide: 0, plates: [], missing: 0 };
    const perSide = (weight - base) / (kind === 'pairs' ? 2 : 1);
    const stock = kind === 'single' ? inv.map(p => ({ ...p, n: p.n * 2 })) : inv;
    const { plates, missing } = plateStack(perSide, stock);
    return { kind, barOnly: false, perSide, plates, missing };
  }

  function calculatePlates({ target, bar = 20, unit = 'kg', inventory, kind = 'pairs' } = {}) {
    const weight = number(target), base = number(bar);
    const failed = error => ({ error, exact: false, perSide: [], plateStack: [], achieved: null, remaining: null, unit, kind });
    if (!unitIsValid(unit)) return failed('Choose kg or lb.');
    if (kind !== 'pairs' && kind !== 'single') return failed('Choose a two-sided bar or a single stack.');
    if (!Number.isFinite(weight) || weight < 0 || weight > MAX_LOAD) return failed('Enter a target from 0 to 1500.');
    if (!Number.isFinite(base) || base < 0 || base > MAX_LOAD) return failed('Enter a bar or base weight from 0 to 1500.');
    if (Math.abs(weight * 100 - Math.round(weight * 100)) > 1e-8 || Math.abs(base * 100 - Math.round(base * 100)) > 1e-8) return failed('Use no more than two decimal places for the target and bar weight.');
    if (base > weight) return failed('The target is lighter than the bar or base. Choose a lighter bar or increase the target.');
    let inv;
    try { inv = inventoryOf(inventory === undefined ? defaultInventory(unit) : inventory); }
    catch (error) { return failed(error.message); }
    const load = rowLoad(kind, weight, base, inv);
    const counts = new Map();
    for (const w of load.plates) counts.set(w, (counts.get(w) || 0) + 1);
    const achieved = rounded(base + load.plates.reduce((sum, w) => sum + w, 0) * (kind === 'pairs' ? 2 : 1));
    const remaining = rounded(weight - achieved);
    return { target: weight, bar: base, unit, kind, achieved, remaining, exact: remaining === 0,
      barOnly: load.barOnly, perSide: [...counts].map(([weight, count]) => ({ weight, count })),
      plateStack: load.plates.slice(), perSideTarget: load.perSide };
  }

  // openGym plateDelta: the multiset difference, not a plate-order instruction.
  function plateDelta(prev, next) {
    const valid = values => Array.isArray(values) && values.length <= MAX_SIZES * MAX_PAIRS * 2 && values.every(w => typeof w === 'number' && Number.isFinite(w) && w > 0 && w <= 500);
    if (!valid(prev) || !valid(next)) throw new Error('Plate changes require two finite plate lists.');
    const count = arr => { const m = new Map(); for (const w of arr) m.set(w, (m.get(w) || 0) + 1); return m; };
    const a = count(prev), b = count(next), strip = [], add = [];
    for (const [w, n] of a) for (let i = 0; i < n - (b.get(w) || 0); i++) strip.push(w);
    for (const [w, n] of b) for (let i = 0; i < n - (a.get(w) || 0); i++) add.push(w);
    const desc = (x, y) => y - x;
    return { strip: strip.sort(desc), add: add.sort(desc) };
  }

  // openGym onerm.js classic formulas and capped estimation, without weighted
  // ensembles or unvalidated confidence/accuracy percentages.
  const FORMULAS = Object.freeze({
    epley: (w, r) => w * (1 + r / 30),
    brzycki: (w, r) => w * 36 / (37 - r),
    lombardi: (w, r) => w * Math.pow(r, 0.1),
    oconner: (w, r) => w * (1 + r / 40),
    mayhew: (w, r) => (w * 100) / (52.2 + 41.9 * Math.exp(-0.055 * r)),
    wathan: (w, r) => (w * 100) / (48.8 + 53.8 * Math.exp(-0.075 * r)),
    lander: (w, r) => (w * 100) / (101.3 - 2.67123 * r),
  });
  const NAMES = { epley: 'Epley', brzycki: 'Brzycki', lombardi: 'Lombardi', oconner: 'O’Conner', mayhew: 'Mayhew', wathan: 'Wathan', lander: 'Lander' };
  const formulas = Object.freeze(Object.keys(FORMULAS).map(id => Object.freeze({ id, label: NAMES[id], maxReps: 12 })));
  function estimateOneRepMax({ weight, reps, formula = 'epley' } = {}) {
    const w = number(weight), r = number(reps);
    const failed = error => ({ estimate: null, error, formula, reps: r });
    if (typeof formula !== 'string' || !Object.hasOwn(FORMULAS, formula)) return failed('Choose one of the listed formulas.');
    if (!(w > 0 && w <= MAX_LOAD)) return failed('Enter a lifted weight above 0 and no more than 1500.');
    if (!Number.isInteger(r) || r < 1 || r > 12) return failed('Use a completed set of 1 to 12 whole repetitions.');
    const value = r === 1 ? w : FORMULAS[formula](w, r);
    if (!Number.isFinite(value) || value <= 0) return failed('This set cannot produce an estimate.');
    return { estimate: Math.round(value * 10) / 10, formula, label: NAMES[formula], reps: r,
      warning: r === 1 ? 'This is the weight of the single repetition entered; it does not prove your maximum.' : 'A formula estimate, not a recommended lifting target. Results vary between people and exercises.' };
  }

  // openGym export-csv.js column order, RFC 4180 field/row writing and UTF-8 BOM.
  const csvColumns = Object.freeze([
    'date', 'start_time', 'end_time', 'workout', 'workout_note', 'exercise', 'exercise_id', 'body_part',
    'superset_id', 'set', 'set_type', 'side', 'weight', 'unit', 'reps', 'rpe', 'rir', 'distance_km',
    'seconds', 'incline', 'note', 'set_note', 'iron_atlas_exercise_id', 'set_time',
  ]);
  function csvField(v) {
    if (v == null) return '';
    let s = String(v);
    // Unlike the original prefix-only test, also neutralize leading whitespace
    // before a formula and '-1+CMD(...)'. Only plain signed decimals stay numeric.
    if (/^[\s\uFEFF]*[=+\-@]/.test(s) && !/^-?\d+(?:\.\d+)?$/.test(s)) s = "'" + s;
    else if (/^[\t\r\n]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const line = cells => cells.map(csvField).join(',');
  const csvText = (header, rows) => '\uFEFF' + [line(header), ...rows.map(line)].join('\r\n') + '\r\n';
  const decimal = value => String(Math.round(value * 1e6) / 1e6);
  const KG_TO_LB = 2.2046226218487757;

  function exportWorkoutCsv(logs, exercises, { unit = 'kg' } = {}) {
    if (!unitIsValid(unit)) throw new Error('Choose kg or lb.');
    if (!Array.isArray(logs) || logs.length > 100000) throw new Error('CSV export supports up to 100,000 saved sets.');
    const rows = [], counts = new Map();
    const catalogue = Array.isArray(exercises) ? new Map(exercises.filter(e => e && typeof e.id === 'string').map(e => [e.id, e])) : exercises;
    const entryFor = id => catalogue instanceof Map ? catalogue.get(id) : catalogue && Object.hasOwn(catalogue, id) ? catalogue[id] : null;
    const checked = logs.map((set, index) => {
      const t = number(set?.t), kg = number(set?.kg), reps = number(set?.reps);
      if (!(t > 0) || !Number.isFinite(new Date(t).getTime()) || !(kg >= 0 && kg <= 10000) || !Number.isInteger(reps) || reps < 1 || reps > 10000 || typeof set?.ex !== 'string' || !set.ex.length || set.ex.length > 200) {
        throw new Error('Cannot export saved set ' + (index + 1) + ': its date, exercise, weight or repetitions are invalid.');
      }
      return { t, kg, reps, ex: set.ex, index };
    }).sort((a, b) => a.t - b.t || a.index - b.index);
    for (const set of checked) {
      const iso = new Date(set.t).toISOString(), day = iso.slice(0, 10), ex = entryFor(set.ex);
      const name = typeof ex === 'string' ? ex : typeof ex?.name === 'string' ? ex.name : set.ex;
      const body = Array.isArray(ex?.primary) ? ex.primary.filter(v => typeof v === 'string').join('; ') : '';
      const key = day + '\0' + set.ex, no = (counts.get(key) || 0) + 1;
      counts.set(key, no);
      // The source log has no workout/session boundaries or OpenGym catalogue IDs.
      // Leave those fields empty instead of inventing a workout duration or ID.
      // kg is the user's recorded load, including their existing per-dumbbell
      // convention. Export changes units only; it never doubles or adds body mass.
      rows.push([day, '', '', '', '', name, '', body, '', no, 'normal', '',
        decimal(set.kg * (unit === 'lb' ? KG_TO_LB : 1)), unit, set.reps, '', '', '', '', '', '', '', set.ex, iso]);
    }
    return csvText(csvColumns, rows);
  }

  return Object.freeze({ version: '1.0.0', upstreamCommit: '50ab7f24e3c4ee70e7f26b3beb426f571e03414b',
    plateSizes: PLATE_SIZES, defaultInventory, calculatePlates, plateDelta,
    formulas, estimateOneRepMax, csvColumns, csvField, exportWorkoutCsv });
});
