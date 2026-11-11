'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({ window: {}, URL });
vm.runInContext(readFileSync(join(__dirname, '../www/account/account-tools.js'), 'utf8'), context);
const { deleteAccount, recoveryPath, signupPath, clearPhotos, removePhotos, captureGeneration } = context.window.IronAtlasAccounts;
const uid = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const newer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const statusPath = '/rest/v1/rpc/cloud_consent_status';
const removePath = '/functions/v1/cloud-photo-remove';
const deletePath = '/rest/v1/rpc/delete_my_account';

function fakeStorage(paths, initialGeneration = generation) {
  const files = new Set(paths), calls = [];
  let currentGeneration = initialGeneration;
  async function request(path, options) {
    const body = JSON.parse(options.body);
    calls.push({ path, body, method: options.method });
    if (path === statusPath) return { json: async () => ({ generation: currentGeneration }) };
    if (path === '/storage/v1/object/list/progress-photos') {
      const entries = new Map(), prefix = body.prefix + '/';
      for (const file of files) {
        if (!file.startsWith(prefix)) continue;
        const parts = file.slice(prefix.length).split('/');
        entries.set(parts[0], { name: parts[0], id: parts.length > 1 ? null : 'object-id' });
      }
      const rows = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
      return { json: async () => rows.slice(body.offset, body.offset + body.limit) };
    }
    if (path === removePath) {
      assert.equal(options.method, 'POST');
      if (body.generation !== currentGeneration) throw Error('stale generation');
      assert.ok(['photo', 'withdrawal', 'account', 'resume'].includes(body.purpose));
      assert.ok(body.names.length <= 100 && body.names.every(name => name.startsWith(uid + '/')));
      body.names.forEach(name => files.delete(name));
    } else {
      assert.equal(path, deletePath);
      assert.equal(options.method, 'POST');
      if (body.p_generation !== currentGeneration) throw Error('stale generation');
    }
    return { text: async () => '' };
  }
  return { files, calls, request,
    get generation() { return currentGeneration; }, set generation(value) { currentGeneration = value; } };
}

test('recovery redirects only to explicitly configured HTTPS URLs', () => {
  assert.equal(recoveryPath('https://example.invalid/iron/account/'), 'recover?redirect_to=https%3A%2F%2Fexample.invalid%2Firon%2Faccount%2F');
  for (const bad of ['', 'http://example.invalid', 'https://user:password@example.invalid', 'https://example.invalid/#x']) assert.throws(() => recoveryPath(bad));
});

test('sign-up uses the same explicit secure return URL as recovery', () => {
  const target = 'https://ironatlas.insomnia-it.co.uk/account/';
  assert.equal(signupPath(target), 'signup?redirect_to=' + encodeURIComponent(target));
  for (const bad of ['', 'http://example.invalid', 'https://user:password@example.invalid', 'https://example.invalid/#x']) {
    assert.throws(() => signupPath(bad));
  }
});

test('account deletion captures once, drains every photo page and keeps other accounts', async () => {
  const files = Array.from({ length: 237 }, (_, i) => uid + '/' + i + '.jpg');
  const storage = fakeStorage([...files, uid + '/old/nested/photo.jpg', other + '/other.jpg']);
  let cleanup = false;
  await deleteAccount(uid, storage.request, async () => { assert.equal(storage.files.size, 1); cleanup = true; });
  assert.equal(cleanup, true);
  assert.deepEqual([...storage.files], [other + '/other.jpg']);
  assert.equal(storage.calls.filter(c => c.path === statusPath).length, 1);
  const batches = storage.calls.filter(c => c.path === removePath && c.body.purpose === 'account');
  assert.equal(batches.length, 3);
  assert.equal(storage.calls.filter(c => c.path === removePath && c.body.purpose === 'resume').length, 1);
  assert.ok(batches.every(c => c.body.generation === generation && c.body.purpose === 'account'));
  assert.equal(storage.calls.at(-1).path, deletePath);
  assert.deepEqual(storage.calls.at(-1).body, { p_generation: generation });
});

test('partial photo deletion is retryable and does not delete the account', async () => {
  const storage = fakeStorage(Array.from({ length: 150 }, (_, i) => uid + '/' + i + '.jpg'));
  let batches = 0;
  await assert.rejects(deleteAccount(uid, (path, options) => {
    if (path === removePath && ++batches === 2) throw new Error('network');
    return storage.request(path, options);
  }), /network/);
  assert.equal(storage.files.size, 50);
  assert.ok(!storage.calls.some(c => c.path === deletePath));
  await deleteAccount(uid, storage.request);
  assert.equal(storage.files.size, 0);
});

test('residual photos and invalid listings prevent terminal account deletion', async () => {
  const storage = fakeStorage([uid + '/photo.jpg']);
  await assert.rejects(deleteAccount(uid, (path, options) => path === removePath ? {} : storage.request(path, options)), /still stored/);
  await assert.rejects(deleteAccount(uid, (path, options) => path === '/storage/v1/object/list/progress-photos'
    ? { json: async () => [{ name: '../other', id: 'id' }] } : storage.request(path, options)), /could not be read/);
  await assert.rejects(deleteAccount('../other', storage.request), /sign in again/);
  assert.ok(!storage.calls.some(c => c.path === deletePath));
});

test('local cleanup failure prevents terminal account RPC', async () => {
  const storage = fakeStorage([uid + '/photo.jpg']);
  await assert.rejects(deleteAccount(uid, storage.request, () => { throw new Error('device cleanup failed'); }), /device cleanup failed/);
  assert.equal(storage.files.size, 0);
  assert.ok(!storage.calls.some(c => c.path === deletePath));
});

test('null generation is captured once for an account without prior cloud consent', async () => {
  const storage = fakeStorage([], null);
  await deleteAccount(uid, storage.request);
  assert.equal(storage.calls.filter(c => c.path === statusPath).length, 1);
  assert.deepEqual(storage.calls.at(-1).body, { p_generation: null });
});

test('a stale generation during photo removal aborts without refresh or account RPC', async () => {
  const storage = fakeStorage([uid + '/' + generation + '/photo.jpg']);
  await assert.rejects(deleteAccount(uid, (path, options) => {
    if (path === removePath) storage.generation = newer;
    return storage.request(path, options);
  }), /stale generation/);
  assert.equal(storage.files.size, 1);
  assert.equal(storage.calls.filter(c => c.path === statusPath).length, 1);
  assert.ok(!storage.calls.some(c => c.path === deletePath));
});

test('a stale terminal account RPC retains the originally captured generation', async () => {
  const storage = fakeStorage([]);
  await assert.rejects(deleteAccount(uid, (path, options) => {
    if (path === deletePath) storage.generation = newer;
    return storage.request(path, options);
  }), /stale generation/);
  assert.equal(storage.calls.filter(c => c.path === statusPath).length, 1);
  assert.deepEqual(storage.calls.at(-1).body, { p_generation: generation });
});

test('photo removal and explicit withdrawal preserve their requested purpose and generation', async () => {
  const storage = fakeStorage([uid + '/' + generation + '/photo.jpg']);
  await removePhotos(uid, storage.request, [...storage.files], generation);
  assert.equal(storage.calls[0].body.purpose, 'photo');
  const withdrawal = fakeStorage([uid + '/' + generation + '/photo.jpg']);
  const captured = await clearPhotos(uid, withdrawal.request, generation, 'withdrawal');
  assert.equal(captured, generation);
  assert.equal(withdrawal.calls.filter(c => c.path === statusPath).length, 0);
  assert.equal(withdrawal.calls.find(c => c.path === removePath).body.purpose, 'withdrawal');
});

test('malformed generation and foreign photo ownership fail before destructive requests', async () => {
  for (const value of [undefined, '', 'not-a-uuid', 12]) {
    await assert.rejects(captureGeneration(async () => ({ json: async () => ({ generation: value }) })), /Could not verify/);
  }
  const storage = fakeStorage([other + '/photo.jpg']);
  await assert.rejects(removePhotos(uid, storage.request, [other + '/photo.jpg'], generation), /Unexpected photo owner/);
  assert.equal(storage.calls.length, 0);
});

test('account deletion propagates queued subscription erasure and supports legacy empty replies', async () => {
  const storage = fakeStorage([]);
  const request = async (path, options) => path === deletePath
    ? { text: async () => JSON.stringify({ deleted: true, subscription_erasure_queued: true }) }
    : storage.request(path, options);
  assert.deepEqual(JSON.parse(JSON.stringify(await deleteAccount(uid, request))), { deleted: true, subscription_erasure_queued: true });
  for (const body of ['', 'null']) {
    const result = await deleteAccount(uid, (path, options) => path === deletePath ? { text: async () => body } : storage.request(path, options));
    assert.equal(result.deleted, true); assert.equal(result.subscription_erasure_queued, false);
  }
  await assert.rejects(deleteAccount(uid, async (path, options) => {
    if (path === deletePath) throw new Error('HTTP 503');
    return storage.request(path, options);
  }), /HTTP 503/);
  await assert.rejects(deleteAccount(uid, (path, options) => path === deletePath
    ? { text: async () => '{"deleted":false,"subscription_erasure_queued":true}' } : storage.request(path, options)), /Could not verify/);
});

test('public portal deletion reports the queued subscription-profile removal', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { elements: {}, listeners: {}, addEventListener(type, action) { this.listeners[type] = action; }, reset() {}, focus() {} });
    return elements.get(id);
  };
  const portal = vm.createContext({
    window: { IRON_ATLAS_CONFIG: { supabaseUrl: 'https://synthetic.supabase.co', supabaseAnonKey: 'public-fixture' } },
    document: { getElementById: element, querySelectorAll: () => [] }, URL, URLSearchParams,
    location: { hash: '', search: '', pathname: '/account/' }, history: {},
    fetch: async () => ({ ok: true, json: async () => ({ access_token: 'synthetic-token', user: { id: uid, email: 'member@example.invalid' } }) }),
    IronAtlasAccounts: { deleteAccount: async () => ({ deleted: true, subscription_erasure_queued: true }) },
  });
  vm.runInContext(readFileSync(join(__dirname, '../www/account/portal.js'), 'utf8'), portal);
  const signin = element('signIn'); signin.elements = { email: { value: 'member@example.invalid' }, password: { value: 'synthetic-password' } };
  await signin.listeners.submit({ preventDefault() {}, currentTarget: signin });
  const confirm = element('confirmDelete'); confirm.elements = { consent: { checked: true } };
  await confirm.listeners.submit({ preventDefault() {}, currentTarget: confirm });
  assert.match(element('status').textContent, /account and cloud records have been deleted/);
  assert.match(element('status').textContent, /Removal of your subscription profile is queued/);
  assert.match(element('status').textContent, /Manage any active subscription through the store/);
});
