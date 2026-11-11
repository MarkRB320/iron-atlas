'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const context = { window: {} };
vm.runInNewContext(readFileSync(join(__dirname, '../www/account/moderation.js'), 'utf8'), context);
const M = context.window.IronAtlasModeration;
const peer = '11111111-1111-4111-8111-111111111111';
const ref = '22222222-2222-4222-8222-222222222222';
const reportId = '33333333-3333-4333-8333-333333333333';
const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const f = { data: new Map(), calls: [], current: true, online: true, blocked: [], failSave: false, onRequest: null };
  f.storage = {
    read: async key => f.data.has(key) ? copy(f.data.get(key)) : undefined,
    write: async (key, value) => { if (f.failSave) throw Error('Storage full'); f.data.set(key, copy(value)); },
  };
  f.request = async (name, args) => {
    f.calls.push({ name, args: copy(args) });
    if (f.onRequest) await f.onRequest(name, args);
    if (!f.online) throw Error('Offline');
    if (name === 'blocked_peers') return f.blocked.map(id => ({ id }));
    if (name === 'block_peer') { f.blocked = [args.p_peer]; return { blocked: true }; }
    if (name === 'unblock_peer') { f.blocked = []; return { blocked: false }; }
    return { id: reportId, status: 'open' };
  };
  f.create = (key = 'account-a') => M.create({ key, storage: f.storage, request: f.request, current: () => f.current });
  return f;
}

test('moderation provenance requires immutable references and an identified sender', () => {
  assert.deepEqual(copy(M.source({ kind: 'shared_plan', reference: ref, author: peer })), { kind: 'shared_plan', reference: ref, author: peer });
  assert.equal(M.source({ kind: 'shared_plan', reference: 'ABC234', author: peer }), null);
  assert.equal(M.source({ kind: 'assigned_plan', reference: '12', author: 'unverified' }), null);
  assert.equal(M.source({ kind: 'assigned_plan', reference: '12', author: peer }).reference, '12');
});

test('new shared text filtering covers nested strings, zero-width characters and supported substitutions', () => {
  assert.equal(M.allowed({ name: 'Full body', items: [['goblet-squat', 3, '8–10']], note: 'Controlled reps' }), true);
  assert.equal(M.allowed({ ignoredExtra: 'p0rn' }), false);
  assert.equal(M.allowed({ note: 'p\u200born' }), false);
  assert.equal(M.allowed({ note: 'I WILL KILL YOU' }), false);
  assert.equal(M.allowed(undefined), false);
});

test('offline block is retained, hides immediately in the cache, and retries after restart', async () => {
  const f = fixture(); f.online = false;
  const first = f.create(); assert.equal((await first.block(peer)).pending, true);
  assert.deepEqual([...first.blocked], [peer]);
  const restarted = f.create(); await restarted.load(); assert.deepEqual([...restarted.blocked], [peer]);
  f.online = true; assert.equal((await restarted.refresh()).pending, false);
  assert.deepEqual(f.blocked, [peer]); assert.equal(restarted.pending, 0);
});

test('pending unblock keeps confirmed blocks until the server accepts it', async () => {
  const f = fixture(), engine = f.create(); await engine.block(peer); f.online = false;
  await engine.unblock(peer); assert.deepEqual([...engine.blocked], [peer]);
  f.online = true; await engine.retry(); assert.deepEqual([...engine.blocked], []);
});

test('reports persist only references and reasons and remain isolated between accounts', async () => {
  const f = fixture(); f.online = false;
  const a = f.create(); await a.report('shared_plan', ref, 'spam');
  assert.deepEqual(f.data.get('account-a').pending, [{ rpc: 'report_content', args: { p_kind: 'shared_plan', p_reference: ref, p_reason: 'spam' } }]);
  const b = f.create('account-b'); await b.load(); assert.equal(b.pending, 0); assert.deepEqual([...b.blocked], []);
  f.online = true; await a.retry(); assert.equal(a.pending, 0);
});

test('storage and identity failures cannot send or confirm another account’s action', async () => {
  const f = fixture(), engine = f.create(); f.failSave = true;
  await assert.rejects(engine.block(peer), /Storage full/); assert.equal(f.calls.length, 0);
  f.failSave = false; f.onRequest = async () => { f.current = false; };
  await assert.rejects(engine.block(peer), /Account changed/);
  assert.equal(f.data.get('account-a').pending.length, 1);
  assert.deepEqual(f.data.get('account-a').blocked, []);
});

test('account deletion closes and drains moderation work before local cache removal', async () => {
  const f = fixture(), engine = f.create();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  f.onRequest = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const action = engine.block(peer); await started;
  const closed = engine.close(); release();
  await assert.rejects(action, /Account changed/); await closed;
  await assert.rejects(engine.report('shared_plan', ref, 'spam'), /Account changed/);
  assert.equal(f.calls.length, 1); assert.equal(f.data.get('account-a').pending.length, 1);
});

test('malformed saved moderation actions are preserved and never executed', async () => {
  const f = fixture(); f.data.set('account-a', { blocked: [], pending: [{ rpc: 'delete_my_account', args: {} }] });
  await assert.rejects(f.create().refresh(), /could not be read/);
  assert.equal(f.calls.length, 0); assert.equal(f.data.get('account-a').pending[0].rpc, 'delete_my_account');
});

test('a permanently failing report cannot prevent a later block or unblock reaching the server', async () => {
  const f = fixture(), engine = f.create();
  f.onRequest = async name => { if (name === 'report_content') throw Error('Reference no longer reportable'); };
  await engine.report('shared_plan', ref, 'spam'); assert.equal(engine.pending, 1);
  await engine.block(peer); assert.deepEqual(f.blocked, [peer]); assert.equal(engine.pending, 1);
  await engine.unblock(peer); assert.deepEqual(f.blocked, []); assert.equal(engine.pending, 1);
});

test('stored operation data is normalized and extra fields never enter requests', async () => {
  const f = fixture(); f.data.set('account-a', { blocked: [peer.toUpperCase()], verified: true, pending: [{ rpc: 'block_peer', args: { p_peer: peer.toUpperCase(), privateNote: 'keep out of requests' } }] });
  const engine = f.create(); await engine.retry();
  assert.deepEqual(f.calls[0].args, { p_peer: peer }); assert.deepEqual([...engine.blocked], [peer]);
});

test('fresh devices wait for a verified block list and coalesce opposing offline peer choices', async () => {
  const f = fixture(), engine = f.create(); await engine.load(); assert.equal(engine.verified, false);
  await engine.refresh(); assert.equal(engine.verified, true);
  f.online = false; await engine.block(peer); await engine.unblock(peer);
  assert.equal(engine.pending, 1); assert.deepEqual([...engine.blocked], [peer]);
  f.online = true; await engine.retry(); assert.deepEqual(f.blocked, []); assert.deepEqual([...engine.blocked], []);
});
