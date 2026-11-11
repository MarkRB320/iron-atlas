const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { webcrypto } = require('node:crypto');
const vm = require('node:vm');
const context = vm.createContext({ window: {}, crypto: webcrypto });
vm.runInContext(readFileSync(join(__dirname, '../www/account/cloud-sync.js'), 'utf8'), context);
const Sync = context.window.IronAtlasSync;
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => clone(value);
const row = (id, kg = 10) => [100, 'press', 8, kg, id];
const original = () => ({ main: { v: 2, saved: 1, goal: 'muscle', units: 'metric', photos: [], meas: [], myPlans: [] }, 'log-2026q4': { e: [row('old')] } });
function fixture(initial = original()) {
  let remote = clone(initial), commits = 0, fault;
  const readRemote = async () => { if (fault === 'read') throw Error('offline'); return clone(remote); };
  const commit = async (expected, docs) => {
    commits++;
    if (fault === 'conflict') return { applied: false };
    if (!Object.entries(expected).every(([k, value]) => Sync.equal(value, remote[k] || null))) return { applied: false };
    Object.assign(remote, clone(docs));
    if (fault === 'ambiguous') { fault = null; throw Error('lost response'); }
    return { applied: true };
  };
  const device = () => {
    const data = new Map(); let failWrite = false;
    const storage = { read: async key => data.has(key) ? clone(data.get(key)) : undefined,
      write: async (key, value) => { if (failWrite) throw Error('disk'); data.set(key, clone(value)); }, remove: async key => data.delete(key) };
    const engine = key => Sync.create({ key, storage, readRemote, commit });
    return { engine, data, storage, set failWrite(value) { failWrite = value; } };
  };
  return { device, readRemote, commit, get remote() { return clone(remote); }, set remote(value) { remote = clone(value); },
    get commits() { return commits; }, set fault(value) { fault = value; } };
}
async function start(engine) { const result = await engine.load(null); assert.ok(!result.issue); await engine.acknowledge(result.receipt, result.docs); return plain(result.docs); }
async function send(engine, docs) { const result = await engine.sync(docs); assert.ok(!result.issue); await engine.acknowledge(result.receipt, result.docs); return plain(result.docs); }

test('two devices append to one quarter with CAS conflict retries', async () => {
  const f = fixture(), da = f.device(), db = f.device(), a = da.engine('a'), b = db.engine('b');
  const left = await start(a), right = await start(b);
  left['log-2026q4'].e.push(row('a')); right['log-2026q4'].e.push(row('b'));
  await Promise.all([send(a, left), send(b, right)]);
  assert.deepEqual(f.remote['log-2026q4'].e.map(x => x[4]).sort(), ['a', 'b', 'old']);
  assert.ok(f.commits >= 3);
});
test('deletion on either unchanged side never resurrects during another addition or restart', async () => {
  const f = fixture(), da = f.device(), db = f.device(), a = da.engine('a'), b = db.engine('b');
  const left = await start(a), right = await start(b);
  left['log-2026q4'].e = []; await send(a, left);
  right['log-2026q4'].e.push(row('b')); await send(b, right);
  assert.deepEqual(f.remote['log-2026q4'].e.map(x => x[4]), ['b']);
  const restarted = da.engine('a');
  const loaded = await restarted.load(left);
  assert.deepEqual(plain(loaded.docs['log-2026q4'].e).map(x => x[4]), ['b']);
});
test('unrelated settings and per-ID photos, measurements, plans merge, including known deletions', () => {
  const base = original();
  for (const field of ['photos', 'meas', 'myPlans']) base.main[field] = [{ id: 'old', value: 1 }];
  const a = clone(base), b = clone(base); a.main.goal = 'strength'; b.main.units = 'imperial';
  for (const field of ['photos', 'meas', 'myPlans']) { a.main[field] = []; b.main[field].push({ id: 'new', value: 2 }); }
  const merged = Sync.merge(base, a, b); assert.equal(merged.conflicts.length, 0);
  assert.equal(merged.docs.main.goal, 'strength'); assert.equal(merged.docs.main.units, 'imperial');
  for (const field of ['photos', 'meas', 'myPlans']) assert.deepEqual(plain(merged.docs.main[field]), [{ id: 'new', value: 2 }]);
});
test('delete versus edited record is preserved for explicit review', async () => {
  const f = fixture(), da = f.device(), db = f.device(), a = da.engine('a'), b = db.engine('b');
  const left = await start(a), right = await start(b);
  left['log-2026q4'].e = []; await send(a, left);
  right['log-2026q4'].e[0][3] = 20;
  const result = await b.sync(right); assert.equal(result.issue.kind, 'conflict');
  assert.deepEqual(f.remote['log-2026q4'].e, []);
  assert.equal(db.data.get('b').pending['log-2026q4'].e[0][3], 20);
});
test('ambiguous commit and restart recover pending work without duplicates or deleted records', async () => {
  const f = fixture(), d = f.device(), engine = d.engine('a'), local = await start(engine);
  local['log-2026q4'].e = [row('new')]; f.fault = 'ambiguous';
  await assert.rejects(engine.sync(local), /lost response/);
  const restarted = d.engine('a'); await send(restarted, local);
  assert.deepEqual(f.remote['log-2026q4'].e.map(x => x[4]), ['new']);
});
test('durable delivery receipt rebases edits made while an upload was in flight', async () => {
  const f = fixture(), d = f.device(), a = d.engine('a'), local = await start(a);
  const remote = f.remote; remote.main.units = 'imperial'; f.remote = remote;
  local['log-2026q4'].e.push(row('a'));
  const sent = await a.sync(local); // simulate closure before the receipt was acknowledged
  local.main.goal = 'strength'; local['log-2026q4'].e.push(row('later'));
  const restored = d.engine('a'); const result = await restored.sync(local);
  assert.equal(result.docs.main.units, 'imperial'); assert.equal(result.docs.main.goal, 'strength');
  assert.deepEqual(plain(result.docs['log-2026q4'].e).map(x => x[4]).sort(), ['a', 'later', 'old']);
  assert.ok(sent.receipt);
});
test('three failed conditional writes preserve the input and stop', async () => {
  const f = fixture(), d = f.device(), a = d.engine('a'), local = await start(a);
  local.main.goal = 'strength'; f.fault = 'conflict';
  await assert.rejects(a.sync(local), /still syncing/);
  assert.equal(f.commits, 3); assert.equal(d.data.get('a').pending.main.goal, 'strength');
});
test('failed initial read with pending data remains protected when load is retried without an input', async () => {
  const f = fixture(), d = f.device(), a = d.engine('a'), local = original(); local.main.goal = 'strength';
  f.fault = 'read'; await assert.rejects(a.sync(local), /offline/); f.fault = null;
  const loaded = await d.engine('a').load(null);
  assert.equal(loaded.issue.kind, 'legacy'); assert.equal(loaded.docs.main.goal, 'strength'); assert.equal(f.commits, 0);
});
test('explicit recovery retains both copies and a different account cannot read the base', async () => {
  const f = fixture(), d = f.device(), a = d.engine('a'), local = original(); local.main.goal = 'strength';
  const review = await a.load(local); assert.equal(review.issue.kind, 'legacy');
  const selected = await a.recover('local', local); await a.acknowledge(selected.receipt, selected.docs); await send(a, selected.docs);
  assert.equal(f.remote.main.goal, 'strength');
  const archive = await a.export(); assert.equal(archive.local.main.goal, 'strength'); assert.equal(archive.remote.main.goal, 'muscle');
  assert.equal(d.data.has('different-account'), false); await a.clear(); assert.equal(d.data.has('a'), false);
});
test('merging hostile nested keys does not mutate prototypes', () => {
  const a = JSON.parse('{"main":{"goal":"strength","__proto__":{"polluted":1}}}');
  const result = Sync.merge({ main: {} }, a, { main: { units: 'imperial' } });
  assert.equal({}.polluted, undefined); assert.equal(Object.prototype.hasOwnProperty.call(result.docs.main, '__proto__'), true);
});

test('an already displayed receipt distinguishes a new deletion from an unseen remote addition', async () => {
  const f = fixture(), d = f.device(), a = d.engine('a'), local = await start(a);
  const remote = f.remote; remote['log-2026q4'].e.push(row('remote')); f.remote = remote;
  const delivery = await a.sync(local);
  const edited = plain(delivery.docs); edited.__receipt = delivery.receipt;
  edited['log-2026q4'].e = edited['log-2026q4'].e.filter(x => x[4] !== 'remote');
  // The local cache records the displayed receipt, but IndexedDB acknowledgement was interrupted.
  await send(d.engine('a'), edited);
  assert.deepEqual(f.remote['log-2026q4'].e.map(x => x[4]), ['old']);
});

test('a storage failure prevents any upload and malformed records are retained for review', async () => {
  const f = fixture(), d = f.device(), a = d.engine('a'), local = await start(a);
  local.main.goal = 'strength'; d.failWrite = true;
  await assert.rejects(a.sync(local), /disk/); assert.equal(f.commits, 0);
  d.failWrite = false;
  const bad = original(); bad.main.photos = [null];
  const result = await a.sync(bad); assert.equal(result.issue.kind, 'conflict');
  assert.equal(f.commits, 0); assert.deepEqual(d.data.get('a').pending.main.photos, [null]);
});

test('loss of the local receipt after a successful commit is recoverable from the pending base', async () => {
  const f = fixture(), d = f.device();
  const a = Sync.create({ key: 'a', storage: d.storage, readRemote: f.readRemote,
    commit: async (expected, docs) => { const result = await f.commit(expected, docs); d.failWrite = true; return result; } });
  const local = await start(a); local['log-2026q4'].e = [row('replacement')];
  await assert.rejects(a.sync(local), /disk/);
  d.failWrite = false;
  await send(d.engine('a'), local);
  assert.deepEqual(f.remote['log-2026q4'].e.map(x => x[4]), ['replacement']);
});

test('switching account during a read cannot commit under the new identity', async () => {
  const f = fixture(), d = f.device(); let current = true, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const a = Sync.create({ key: 'a', storage: d.storage, current: () => current,
    readRemote: async () => { await waiting; return f.readRemote(); }, commit: f.commit });
  const pending = a.sync(original());
  await new Promise(resolve => setImmediate(resolve)); current = false; release();
  await assert.rejects(pending, /Account changed/);
  assert.equal(f.commits, 0); assert.equal(d.data.has('b'), false);
});

test('an uncertain accepted upload followed by a remote deletion is never automatically resurrected', async () => {
  const f = fixture(), d = f.device(), a = d.engine('a'), local = await start(a);
  local['log-2026q4'].e.push(row('uncertain')); f.fault = 'ambiguous';
  await assert.rejects(a.sync(local), /lost response/);
  const remote = f.remote; remote['log-2026q4'].e = remote['log-2026q4'].e.filter(x => x[4] !== 'uncertain'); f.remote = remote;
  const review = await d.engine('a').sync(local);
  assert.equal(review.issue.kind, 'uncertain');
  assert.deepEqual(f.remote['log-2026q4'].e.map(x => x[4]), ['old']);
  assert.ok(d.data.get('a').attempt);
});

test('malformed first-version logs are preserved for review and export', async () => {
  for (const log of [[null], { invalid: true }]) {
    const f = fixture({ state: { example: false, log } }), d = f.device(), a = d.engine('a');
    const result = await a.load(null);
    assert.equal(result.issue.kind, 'conflict'); assert.equal(f.commits, 0);
    assert.deepEqual(plain((await a.export()).local.__invalidLegacy.log), log);
  }
});

const html = readFileSync(join(__dirname, '../www/index.html'), 'utf8').replaceAll('\r\n', '\n');
function section(start, end) {
  const first = html.indexOf(start), last = html.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first); return html.slice(first, last);
}

test('the Cloud save entry point snapshots mutable main arrays before awaiting a response', async () => {
  let release, acknowledged;
  const gate = new Promise(resolve => { release = resolve; });
  const current = original(); current.main.photos = [{ id: 'one', t: 1 }];
  const backend = { save: async snapshot => {
    const sent = clone(snapshot); await gate;
    return { docs: sent, confirmed: sent, receipt: 'receipt', engine: { acknowledge: async (_, local) => { acknowledged = clone(local); } } };
  } };
  const ctx = vm.createContext({ B: backend, device: {}, IronAtlasSync: Sync, setStatus: () => {},
    reconcile: (sent, received) => Sync.merge(sent, current, received).docs });
  const method = section('    async save(docs) {\n      if (B === device)', '    async putPhoto(pid, data)');
  vm.runInContext('globalThis.api = { acct: "member", syncIssue: null, ' + method + '};', ctx);
  const pending = ctx.api.save(current);
  current.main.photos.push({ id: 'while-uploading', t: 2 });
  release(); assert.equal(await pending, false);
  assert.deepEqual(acknowledged.main.photos.map(p => p.id), ['one', 'while-uploading']);
});

test('the Store push entry point keeps the dirty marker when a new edit occurs during upload', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), values = new Map();
  const ctx = vm.createContext({
    Cloud: { acct: 'member', kind: 'email', syncIssue: null, save: async () => { await gate; return true; },
      LS: { set: (key, value) => { values.set(key, value); return true; }, del: key => values.delete(key), get: key => values.get(key) } },
    Photos: { flush: async () => true }, S: { saved: 1 }, persisted: () => ({}), toDocs: () => ({}),
    LSKEY: key => key, setTimeout: () => 1, clearTimeout: () => {}, refreshAccountStatus: () => {}, coachSync: () => {},
  });
  vm.runInContext(section('  const Store = {', '  function applySyncDocs(') + '\nglobalThis.store = Store;', ctx);
  const pending = ctx.store.push(); await new Promise(resolve => setImmediate(resolve));
  ctx.store.save(); release(); assert.equal(await pending, false);
  assert.equal(values.get('member:pending'), '1');
});
