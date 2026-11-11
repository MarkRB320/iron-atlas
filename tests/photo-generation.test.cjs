'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const html = readFileSync(join(__dirname, '../www/index.html'), 'utf8').replaceAll('\r\n', '\n');
const start = html.indexOf('    photoHandle(pid) {');
const end = html.indexOf('    async wipe()', start);
assert(start >= 0 && end > start, 'Email photo adapter boundaries must be present');
const methods = html.slice(start, end);
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const G1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const G2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture() {
  const f = { calls: [], removed: [], refreshes: 0, onRefresh: null, onRequest: null, onDecode: null };
  const context = vm.createContext({
    dataUrlToBlob: data => data,
    blobToDataUrl: async data => { if (f.onDecode) await f.onDecode(); return 'data:' + data; },
    IronAtlasAccounts: { async removePhotos(uid, request, names, generation) {
      f.removed.push({ uid, names: [...names], generation });
      await request('/functions/v1/cloud-photo-remove', { method: 'POST' });
    } },
  });
  vm.runInContext('globalThis.api = {' + methods + '};', context);
  const api = f.api = context.api;
  api.sess = { uid: U1 };
  api.epoch = 1;
  api.backup = { state: { generation: G1, enabled: true, cleanup_pending: false }, enabled: true, ready: true };
  api.refreshBackup = async () => { f.refreshes++; if (f.onRefresh) await f.onRefresh(); return api.backup.state; };
  api.req = async (path, options, uid) => {
    f.calls.push({ path, options, uid });
    if (f.onRequest) await f.onRequest();
    return { blob: async () => 'picture' };
  };
  return f;
}

test('photo transfer defaults off without an active generation', async () => {
  const f = fixture();
  f.api.backup = { state: { generation: null, enabled: false, cleanup_pending: false }, enabled: false, ready: false };
  assert.equal(await f.api.putPhoto('one', 'picture'), false);
  assert.equal(await f.api.getPhoto('one'), null);
  assert.equal(f.refreshes, 0);
  assert.equal(f.calls.length, 0);
});

test('an account, session epoch or generation change during refresh prevents all photo requests', async () => {
  for (const method of ['putPhoto', 'getPhoto']) {
    for (const change of [
      api => { api.sess.uid = U2; },
      api => { api.epoch++; },
      api => { api.backup.state.generation = G2; },
    ]) {
      const f = fixture();
      f.onRefresh = async () => { await Promise.resolve(); change(f.api); };
      await assert.rejects(f.api[method]('one', 'picture'), /Account or cloud backup changed/);
      assert.equal(f.calls.length, 0);
    }
  }
});

test('generation adoption is required to upload even with active consent', async () => {
  const f = fixture();
  f.api.backup.ready = false;
  assert.equal(await f.api.putPhoto('one', 'picture'), false);
  assert.equal(f.refreshes, 1);
  assert.equal(f.calls.length, 0);
});

test('pending withdrawal permits authenticated reads but blocks upload', async () => {
  const f = fixture();
  f.api.backup = { state: { generation: G1, enabled: false, cleanup_pending: true }, enabled: false, ready: false };
  assert.equal(await f.api.putPhoto('one', 'picture'), false);
  assert.equal(await f.api.getPhoto('one'), 'data:picture');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, '/storage/v1/object/authenticated/progress-photos/' + U1 + '/' + G1 + '/one.jpg');
  assert.equal(f.calls[0].uid, U1);
});

test('a withdrawal completing during refresh stops the previously eligible read', async () => {
  const f = fixture();
  f.onRefresh = () => { f.api.backup.enabled = false; f.api.backup.state.enabled = false; };
  assert.equal(await f.api.getPhoto('one'), null);
  assert.equal(f.calls.length, 0);
});

test('photo read rechecks ownership and generation after the response body is decoded', async () => {
  for (const change of [api => { api.sess.uid = U2; }, api => { api.backup.state.generation = G2; }]) {
    const f = fixture();
    f.onDecode = async () => { await Promise.resolve(); change(f.api); };
    await assert.rejects(f.api.getPhoto('one'), /Account or cloud backup changed/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].uid, U1);
    assert.ok(f.calls[0].path.includes('/' + G1 + '/'));
  }
});

test('late upload completion cannot be accepted under a newer generation', async () => {
  const f = fixture();
  f.onRequest = () => { f.api.backup.state.generation = G2; };
  await assert.rejects(f.api.putPhoto('one', 'picture'), /Account or cloud backup changed/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].uid, U1);
  assert.ok(f.calls[0].path.includes('/' + G1 + '/'));
});

test('deletion uses the captured raw path and rejects a stale handle before removal', async () => {
  const f = fixture();
  const handle = f.api.photoHandle('photo with space');
  assert.equal(handle.path, U1 + '/' + G1 + '/photo with space.jpg');
  assert.equal(handle.url, U1 + '/' + G1 + '/photo%20with%20space.jpg');
  await f.api.delPhoto(handle);
  assert.deepEqual(f.removed, [{ uid: U1, names: [handle.path], generation: G1 }]);
  assert.equal(f.calls[0].uid, U1);
  const stale = fixture(), old = stale.api.photoHandle('one');
  stale.api.backup.state.generation = G2;
  await assert.rejects(stale.api.delPhoto(old), /Account or cloud backup changed/);
  assert.equal(stale.removed.length, 0);
  assert.equal(stale.calls.length, 0);
});

