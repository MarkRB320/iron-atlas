'use strict';

window.IronAtlasSync = (() => {
  const absent = Symbol('absent');
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const copy = value => JSON.parse(JSON.stringify(value));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function stable(value) {
    if (value === absent) return 'absent';
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  const equal = (a, b) => stable(a) === stable(b);
  const makeId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() :
    Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

  function merge(base, local, remote) {
    const conflicts = [];
    for (const snapshot of [base, local, remote]) {
      if (snapshot?.__invalidLegacy) conflicts.push('state.log.invalid');
      for (const [name, doc] of Object.entries(snapshot || {})) {
        const lists = /^log-/.test(name) ? [[name + '.e', doc?.e, true]] : name === 'main' ?
          ['meas', 'photos', 'myPlans'].map(field => ['main.' + field, doc?.[field], false]) : [];
        for (const [path, rows, log] of lists) {
          if (rows === undefined) continue;
          if (!Array.isArray(rows)) { conflicts.push(path + '.invalid'); continue; }
          const ids = new Set();
          for (const row of rows) {
            const valid = log ? Array.isArray(row) && row.length >= 4 : object(row) && typeof row.id === 'string';
            if (!valid) { conflicts.push(path + '.invalid'); continue; }
            const id = log ? row[4] || 'legacy:' + row[0] + '|' + row[1] : row.id;
            if (ids.has(id)) conflicts.push(path + '.duplicate');
            ids.add(id);
          }
        }
      }
    }
    function value(b, l, r, path) {
      if (equal(l, b)) return r;
      if (equal(r, b) || equal(l, r)) return l;
      if (path === 'main.saved' || path === 'main.v') return Math.max(...[b, l, r].map(x => x === absent ? 0 : Number(x) || 0));
      if (l === absent || r === absent) { conflicts.push(path); return l; }
      const records = /^log-\d{4}q[1-4]\.e$/.test(path) || /^main\.(meas|photos|myPlans)$/.test(path);
      if (records && Array.isArray(l) && Array.isArray(r)) {
        const key = path.endsWith('.e') ? row => row[4] || 'legacy:' + row[0] + '|' + row[1] : row => row.id;
        function map(rows) {
          const result = new Map();
          for (const row of rows) {
            if (!row || (path.endsWith('.e') ? !Array.isArray(row) || row.length < 4 : !object(row))) {
              conflicts.push(path + '.invalid'); continue;
            }
            const id = key(row);
            if (!id || result.has(id)) conflicts.push(path + '.duplicate');
            result.set(id, row);
          }
          return result;
        }
        const bm = map(Array.isArray(b) ? b : []), lm = map(l), rm = map(r), out = [];
        for (const id of new Set([...lm.keys(), ...rm.keys(), ...bm.keys()])) {
          const item = value(bm.has(id) ? bm.get(id) : absent, lm.has(id) ? lm.get(id) : absent,
            rm.has(id) ? rm.get(id) : absent, path + '.' + id);
          if (item !== absent) out.push(item);
        }
        return out;
      }
      if (object(l) && object(r) && (object(b) || b === absent)) {
        const out = Object.create(null), before = b === absent ? {} : b;
        for (const k of new Set([...Object.keys(before), ...Object.keys(l), ...Object.keys(r)])) {
          const item = value(own(before, k) ? before[k] : absent, own(l, k) ? l[k] : absent,
            own(r, k) ? r[k] : absent, path ? path + '.' + k : k);
          if (item !== absent) out[k] = item;
        }
        return out;
      }
      conflicts.push(path);
      return l;
    }
    return { docs: canonical(value(base, local, remote, '')), conflicts };
  }

  function canonical(raw) {
    const docs = copy(raw || {});
    if (!docs.main && docs.state) {
      const state = docs.state;
      docs.main = { ...state }; delete docs.main.log;
      const rows = state.example ? [] : state.log || [];
      const valid = Array.isArray(rows) && rows.every(row => object(row) && Number.isFinite(row.t) && typeof row.ex === 'string');
      if (!valid) docs.__invalidLegacy = copy(state);
      for (const row of valid ? rows : []) {
        const date = new Date(row.t), key = 'log-' + date.getFullYear() + 'q' + (Math.floor(date.getMonth() / 3) + 1);
        const entry = [row.t, row.ex, row.reps, row.kg]; if (row.id) entry.push(row.id);
        (docs[key] ||= { e: [] }).e.push(entry);
      }
    }
    delete docs.state;
    delete docs.__receipt;
    const order = (timeA, idA, timeB, idB) => timeA - timeB || (idA < idB ? -1 : idA > idB ? 1 : 0);
    for (const [name, doc] of Object.entries(docs)) {
      if (/^log-/.test(name) && Array.isArray(doc?.e) && doc.e.every(Array.isArray)) {
        doc.e.sort((a, b) => order(a[0], String(a[4] || a[1]), b[0], String(b[4] || b[1])));
      }
    }
    for (const name of ['photos', 'meas']) {
      const rows = docs.main?.[name];
      if (Array.isArray(rows) && rows.every(object)) rows.sort((a, b) => order(a.t || 0, String(a.id), b.t || 0, String(b.id)));
    }
    return docs;
  }
  function comparable(docs) {
    const out = copy(docs);
    if (out.main) { delete out.main.saved; delete out.main.v; }
    for (const key of Object.keys(out)) if (/^log-/.test(key) && !out[key].e?.length) delete out[key];
    return out;
  }

  function indexedStore() {
    let opening;
    function open() {
      return opening ||= new Promise((resolve, reject) => {
        const request = indexedDB.open('iron-atlas-sync', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('accounts');
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
        request.onerror = request.onblocked = () => { opening = null; reject(new Error('Sync history storage is unavailable. Your device copy is kept.')); };
      });
    }
    async function run(mode, action) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('accounts', mode), request = action(transaction.objectStore('accounts'));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = transaction.onabort = () => reject(new Error('Could not save sync history. Your device copy is kept.'));
      });
    }
    return {
      read: key => run('readonly', s => s.get(key)),
      write: (key, data) => run('readwrite', s => s.put(data, key)),
      remove: key => run('readwrite', s => s.delete(key)),
      removePrefix: prefix => run('readwrite', store => {
        const request = store.openCursor();
        request.onsuccess = () => { const cursor = request.result; if (!cursor) return; if (String(cursor.key).startsWith(prefix)) cursor.delete(); cursor.continue(); };
        return request;
      }),
    };
  }

  function create({ key, storage, readRemote, commit, current = () => true }) {
    let queue = Promise.resolve(), issue = null;
    const check = () => { if (!current()) throw new Error('Account changed. Sign in again.'); };
    const serial = fn => { const work = queue.catch(() => {}).then(fn); queue = work; return work; };
    async function save(record) { check(); await storage.write(key, copy(record)); check(); issue = record.issue || null; }
    async function read() { check(); const record = await storage.read(key); check(); return record || { version: 1, base: null }; }
    function working(record, input) {
      let local = canonical(input || record.pending || record.base || {});
      const hasLocal = !!input || Object.keys(record.pending || {}).length > 0;
      if (record.receipt) {
        if (input?.__receipt === record.receipt.id) return { base: record.receipt.confirmed, local, conflicts: [], input: local, hasLocal };
        const result = merge(record.receipt.input, local, record.receipt.output);
        return { base: record.receipt.confirmed, local: result.docs, conflicts: result.conflicts, input: local, hasLocal };
      }
      return { base: record.base, local, conflicts: [], input: local, hasLocal };
    }
    async function review(record, local, remote, kind, conflicts = []) {
      record.pending = local;
      record.issue = { kind, local, remote, conflicts };
      await save(record);
      return { docs: local, issue: record.issue };
    }
    async function deliver(record, input, output, confirmed) {
      const receipt = { id: makeId(), input, output, confirmed };
      record.pending = input; record.receipt = receipt; delete record.issue; delete record.attempt;
      await save(record);
      return { docs: output, confirmed, receipt: receipt.id };
    }
    async function operate(input, upload) {
      const record = await read(), state = working(record, input);
      record.pending = canonical(input || state.local);
      await save(record); // A failed or ambiguous HTTP write always retains its input and baseline.
      if (record.issue) return review(record, state.local, record.issue.remote, record.issue.kind, record.issue.conflicts);
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await readRemote(); check();
        const remote = canonical(raw);
        if (record.attempt) {
          const attempted = record.attempt;
          if (!Object.entries(attempted.docs).every(([name, data]) => equal(raw?.[name], data))) {
            return review(record, state.local, remote, 'uncertain');
          }
          const afterReceipt = merge(attempted.input, state.input, attempted.output);
          const afterRemote = merge(attempted.output, afterReceipt.docs, remote);
          if (afterReceipt.conflicts.length || afterRemote.conflicts.length) {
            return review(record, state.local, remote, 'conflict', [...afterReceipt.conflicts, ...afterRemote.conflicts]);
          }
          return deliver(record, state.input, afterRemote.docs, remote);
        }
        if (state.base === null) {
          if (state.hasLocal && !equal(comparable(state.local), comparable(remote))) return review(record, state.local, remote, 'legacy');
          state.base = remote; state.local = remote;
        }
        const merged = merge(state.base, state.local, remote);
        if (state.conflicts.length || merged.conflicts.length) return review(record, state.local, remote, 'conflict', [...state.conflicts, ...merged.conflicts]);
        const output = merged.docs;
        if (!upload) return deliver(record, state.input, output, remote);
        const expected = Object.create(null), docs = Object.create(null);
        for (const name of new Set([...Object.keys(remote), ...Object.keys(output)])) {
          const next = own(output, name) ? output[name] : /^log-/.test(name) ? { e: [] } : null;
          if (next === null) return review(record, state.local, remote, 'conflict', [name]);
          if (!equal(own(raw || {}, name) ? raw[name] : absent, next)) {
            expected[name] = own(raw || {}, name) ? raw[name] : null; docs[name] = next; output[name] = next;
          }
        }
        if (!Object.keys(docs).length) return deliver(record, state.input, output, remote);
        record.attempt = { input: state.input, output, docs };
        await save(record);
        const result = await commit(expected, docs); check();
        if (result?.applied === true) return deliver(record, state.input, output, output);
        if (result?.applied !== false) throw new Error('Unexpected sync response. Your device copy is kept.');
        delete record.attempt;
        await save(record);
      }
      throw new Error('Your other device is still syncing. Your changes are saved here and will retry.');
    }
    return {
      get issue() { return issue; },
      load: input => { const snapshot = input ? copy(input) : null; return serial(() => operate(snapshot, false)); },
      sync: input => { const snapshot = copy(input); return serial(() => operate(snapshot, true)); },
      acknowledge: (receipt, local) => { const snapshot = canonical(local); return serial(async () => {
        const record = await read();
        if (!record.receipt || record.receipt.id !== receipt) throw new Error('Sync history changed. Please retry.');
        record.base = record.receipt.confirmed; record.pending = snapshot; delete record.receipt;
        await save(record);
      }); },
      recover: (choice, local) => { const snapshot = local ? copy(local) : null; return serial(async () => {
        const record = await read(), remote = canonical(await readRemote()); check();
        record.archive = { local: canonical(snapshot || record.issue?.local || record.pending), remote, saved: Date.now() };
        record.base = remote; delete record.receipt; delete record.issue; delete record.attempt;
        return deliver(record, canonical(snapshot || record.pending), choice === 'local' ? record.archive.local : remote, remote);
      }); },
      export: () => serial(async () => {
        const record = await read();
        return { ...(record.issue || record.archive || { local: record.pending, confirmed: record.base }), receipt: record.receipt, attempt: record.attempt };
      }),
      clear: () => serial(async () => { check(); await storage.remove(key); issue = null; }),
    };
  }
  return { create, indexedStore, merge, equal, canonical, makeId };
})();
