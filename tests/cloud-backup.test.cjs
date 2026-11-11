const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(join(__dirname, '../www/account/cloud-backup.js'), 'utf8'), context);
const Backup = context.window.IronAtlasBackup;
const clone = value => JSON.parse(JSON.stringify(value));
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const POLICY = 'https://ironatlas.insomnia-it.co.uk/privacy/';
const status = (enabled = false, generation = null, pending = false) => ({
  enabled, generation, cleanup_pending: pending, version: '2026-11-02',
  granted_at: enabled ? '2026-11-02T12:00:00Z' : null, withdrawn_at: null,
});

function fixture(initial = status()) {
  const f = {
    remote: clone(initial), data: new Map(), events: [], current: true,
    cloud: { main: { photos: [{ id: 'photo-a' }] }, 'log-2026q4': { e: [[1, 'goblet-squat', 11, 7.5]] } },
    files: ['owner/' + G1 + '/photo-a.jpg'], missing: new Set(), knownMissing: [],
    onRead: null, onRetain: null, onErase: null, onWrite: null, onRPC: null, onResume: null,
  };
  f.storage = {
    async read(key) { return f.data.has(key) ? clone(f.data.get(key)) : undefined; },
    async write(key, value) {
      if (f.onWrite) await f.onWrite(key, clone(value));
      f.events.push({ type: 'write', phase: value.withdrawal?.phase });
      f.data.set(key, clone(value));
    },
    async remove(key) { f.data.delete(key); },
  };
  f.rpc = async (name, args) => {
    f.events.push({ type: 'rpc', name, args: clone(args) });
    if (f.onRPC) await f.onRPC(name, args);
    if (name === 'cloud_consent_status') return clone(f.remote);
    if (name === 'grant_cloud_consent') {
      assert.equal(args.p_version, '2026-11-02');
      assert.equal(args.p_expected_generation, f.remote.generation);
      f.remote = status(true, f.remote.generation === G1 ? G2 : G1);
      return clone(f.remote);
    }
    if (name === 'begin_cloud_withdrawal') {
      assert.equal(args.p_expected_generation, f.remote.generation);
      f.remote = status(false, f.remote.generation || G1, true);
      return clone(f.remote);
    }
    if (name === 'finish_cloud_withdrawal') {
      assert.equal(args.p_generation, f.remote.generation);
      assert.equal(f.files.length, 0);
      f.remote = status(false, f.remote.generation, false);
      return clone(f.remote);
    }
    throw Error('Unexpected RPC ' + name);
  };
  f.engine = (key = 'owner') => Backup.create({
    key, storage: f.storage, rpc: f.rpc, current: () => f.current,
    async readState() {
      f.events.push({ type: 'readState' });
      if (f.onRead) await f.onRead();
      return clone(f.cloud);
    },
    async listFiles() { f.events.push({ type: 'list' }); return [...f.files]; },
    async retainFile(path) {
      f.events.push({ type: 'retain', path });
      if (f.onRetain) await f.onRetain(path);
      return f.missing.has(path) ? { missing: true } : { id: path, retained: true };
    },
    async missingKnown() { return [...f.knownMissing]; },
    async resumeRemovals(generation) {
      f.events.push({ type: 'resume', generation });
      if (f.onResume) await f.onResume(generation);
    },
    async eraseFiles(paths, generation) {
      f.events.push({ type: 'erase', paths: [...paths], generation });
      if (f.onErase) await f.onErase(paths);
      f.files = f.files.filter(path => !paths.includes(path));
    },
  });
  f.calls = name => f.events.filter(e => e.type === 'rpc' && e.name === name);
  f.erases = () => f.events.filter(e => e.type === 'erase');
  return f;
}

test('backup defaults off and refresh performs no grant or persistent write', async () => {
  const f = fixture(), backup = f.engine();
  assert.equal(backup.enabled, false);
  assert.equal(backup.ready, false);
  assert.equal(backup.state, null);
  await backup.refresh();
  assert.equal(backup.enabled, false);
  assert.equal(backup.ready, false);
  assert.equal(f.data.size, 0);
  assert.deepEqual(f.events.map(e => e.name), ['cloud_consent_status']);
});

test('only the canonical published privacy policy permits grant', async () => {
  for (const url of ['', 'http://ironatlas.insomnia-it.co.uk/privacy/', 'https://example.invalid/privacy/', POLICY + '?draft=1']) {
    const f = fixture();
    await assert.rejects(f.engine().grant(url), /official privacy policy/);
    assert.equal(f.events.length, 0);
  }
  assert.equal(Backup.privacyReady(POLICY), true);
});

test('explicit grant needs generation adoption and retains adoption after restart', async () => {
  const f = fixture(), backup = f.engine();
  await backup.grant(POLICY);
  assert.equal(backup.enabled, true);
  assert.equal(backup.ready, false);
  assert.equal(f.calls('grant_cloud_consent').length, 1);
  assert.deepEqual(f.calls('grant_cloud_consent')[0].args, { p_version: Backup.version, p_expected_generation: null });
  await backup.adopt(G1);
  assert.equal(backup.ready, true);
  const restarted = f.engine();
  await restarted.refresh();
  assert.equal(restarted.ready, true);
  f.remote = status(true, G2);
  await restarted.refresh();
  assert.equal(restarted.enabled, true);
  assert.equal(restarted.ready, false);
  await assert.rejects(restarted.adopt(G1), /changed/);
});

test('invalid remote status and generation fail closed', async () => {
  for (const remote of [{ ...status(), version: 'old' }, { ...status(), enabled: 'true' }, status(true, null), status(false, 'broken', true)]) {
    const f = fixture(remote);
    await assert.rejects(f.engine().refresh(), /could not be verified/);
    assert.equal(f.data.size, 0);
  }
});

test('withdrawal preserves both snapshots and every file durably before erase', async () => {
  const f = fixture(status(true, G1)), backup = f.engine();
  const local = { log: [{ id: 'local-only' }], photos: [] };
  await backup.refresh();
  await backup.adopt(G1);
  f.onErase = () => {
    const task = f.data.get('owner').withdrawal;
    assert.equal(task.phase, 'erasing');
    assert.deepEqual(task.local, local);
    assert.deepEqual(task.cloud, f.cloud);
    assert.equal(task.files.length, 1);
    assert.equal(task.files[0].retained, true);
  };
  const pending = backup.withdraw(local);
  assert.equal(backup.enabled, false, 'new uploads must stop synchronously');
  assert.equal(backup.ready, false);
  const result = await pending;
  assert.equal(result.pending, false);
  assert.equal(backup.removalPending, false);
  assert.equal(f.calls('finish_cloud_withdrawal').length, 1);
  assert.equal((await backup.export()).phase, 'done');
  const exported = await backup.export();
  exported.local.log.length = 0;
  assert.equal((await backup.export()).local.log.length, 1);
});

test('cloud-read failure leaves a resumable local intent and performs no erase', async () => {
  const f = fixture(status(true, G1)), local = { log: ['original'] };
  f.onRead = () => { throw Error('offline'); };
  await assert.rejects(f.engine().withdraw(local), /offline/);
  assert.equal(f.erases().length, 0);
  assert.equal(f.calls('finish_cloud_withdrawal').length, 0);
  assert.deepEqual(f.data.get('owner').withdrawal.local, local);
  f.onRead = null;
  const retry = f.engine();
  await retry.withdraw({ log: ['later argument'] });
  assert.deepEqual(clone((await retry.export()).local), local);
  assert.equal(f.erases().length, 1);
});

test('file-retention failure cannot erase the remote photo and can resume after restart', async () => {
  const f = fixture(status(true, G1));
  f.onRetain = () => { throw Error('photo download failed'); };
  await assert.rejects(f.engine().withdraw({ photos: [] }), /photo download failed/);
  assert.equal(f.erases().length, 0);
  assert.equal(f.files.length, 1);
  assert.equal(f.remote.cleanup_pending, true);
  f.onRetain = null;
  const retry = f.engine();
  await retry.refresh();
  assert.equal(retry.removalPending, true);
  await assert.rejects(retry.grant(POLICY), /Finish removing/);
  await retry.withdraw({});
  assert.equal(f.files.length, 0);
  assert.equal(retry.removalPending, false);
});

test('failure to persist intent prevents begin and failure to persist erasing prevents deletion', async () => {
  const first = fixture(status(true, G1));
  first.onWrite = () => { throw Error('disk full'); };
  await assert.rejects(first.engine().withdraw({}), /disk full/);
  assert.equal(first.calls('begin_cloud_withdrawal').length, 0);
  assert.equal(first.erases().length, 0);
  const later = fixture(status(true, G1));
  later.onWrite = (key, value) => { if (value.withdrawal?.phase === 'erasing') throw Error('disk full'); };
  await assert.rejects(later.engine().withdraw({}), /disk full/);
  assert.equal(later.erases().length, 0);
  assert.equal(later.calls('finish_cloud_withdrawal').length, 0);
});

test('known or downloaded missing photos require explicit confirmation', async () => {
  const f = fixture(status(true, G1)), backup = f.engine();
  f.missing.add(f.files[0]);
  f.knownMissing = ['already-missing'];
  const result = await backup.withdraw({});
  assert.equal(result.pending, true);
  assert.deepEqual(clone(result.missing).sort(), [f.files[0], 'already-missing'].sort());
  assert.equal(f.erases().length, 0);
  await backup.withdraw({}, true);
  assert.equal(f.erases().length, 1);
  assert.equal(f.calls('finish_cloud_withdrawal').length, 1);
});

test('a newly missing photo on retry needs fresh confirmation', async () => {
  const f = fixture(status(true, G1)), backup = f.engine();
  f.missing.add(f.files[0]);
  assert.equal((await backup.withdraw({})).pending, true);
  f.onErase = () => { throw Error('delete interrupted'); };
  await assert.rejects(backup.withdraw({}, true), /delete interrupted/);
  const newPath = 'owner/' + G1 + '/new-missing.jpg';
  f.files.push(newPath);
  f.missing.add(newPath);
  f.onErase = null;
  const before = f.erases().length;
  const retry = f.engine();
  const result = await retry.withdraw({}, false);
  assert.equal(result.pending, true);
  assert.ok(result.missing.includes(newPath));
  assert.equal(f.erases().length, before);
  assert.equal(f.calls('finish_cloud_withdrawal').length, 0);
});

test('account change during retention stops destructive work', async () => {
  const f = fixture(status(true, G1));
  f.onRetain = () => { f.current = false; };
  await assert.rejects(f.engine().withdraw({}), /Account changed/);
  assert.equal(f.erases().length, 0);
  assert.equal(f.calls('finish_cloud_withdrawal').length, 0);
});

test('another-device regrant prevents an old withdrawal from erasing a new generation', async () => {
  const f = fixture(status(true, G1));
  f.onRetain = () => { throw Error('interrupted'); };
  await assert.rejects(f.engine().withdraw({}), /interrupted/);
  f.remote = status(true, G2);
  f.onRetain = null;
  await assert.rejects(f.engine().withdraw({}), /changed on another device/);
  assert.equal(f.erases().length, 0);
  assert.equal(f.calls('begin_cloud_withdrawal').length, 1);
});

test('lost first begin response can resume its null-generation intent when still disabled and pending', async () => {
  const f = fixture(status(false, null));
  let lost = false;
  f.onRPC = name => {
    if (name === 'begin_cloud_withdrawal' && !lost) {
      lost = true;
      f.remote = status(false, G1, true);
      throw Error('lost begin response');
    }
  };
  await assert.rejects(f.engine().withdraw({ log: ['kept'] }), /lost begin response/);
  const retry = f.engine();
  await retry.withdraw({});
  assert.equal(f.erases().length, 1);
  assert.equal(f.calls('finish_cloud_withdrawal').length, 1);
  assert.deepEqual(clone((await retry.export()).local.log), ['kept']);
});

test('clear removes only this identity state and restores off defaults', async () => {
  const f = fixture(status(true, G1)), backup = f.engine('owner');
  f.data.set('other', { keep: true });
  await backup.refresh();
  await backup.adopt(G1);
  backup.pause();
  await backup.clear();
  assert.equal(f.data.has('owner'), false);
  assert.deepEqual(f.data.get('other'), { keep: true });
  assert.equal(backup.state, null);
  assert.equal(backup.ready, false);
  assert.equal(backup.removalPending, false);
});


test('resuming an interrupted removal precedes begin and preserves intent on failure', async () => {
  const f = fixture(status(true, G1)), local = { log: ['kept'] };
  f.onResume = () => { throw Error('resume unavailable'); };
  await assert.rejects(f.engine().withdraw(local), /resume unavailable/);
  assert.equal(f.calls('begin_cloud_withdrawal').length, 0);
  assert.equal(f.erases().length, 0);
  assert.equal(f.data.get('owner').withdrawal.phase, 'prepared');
  assert.deepEqual(f.data.get('owner').withdrawal.local, local);
  f.onResume = null;
  await f.engine().withdraw({});
  assert.equal(f.erases()[0].generation, G1);
});

test('only the known in-progress response retries transitions and the retry is bounded', async () => {
  const f = fixture(status(true, G1));
  f.onRPC = name => {
    if (name === 'begin_cloud_withdrawal') throw Error('Photo removal is in progress. Retry.');
  };
  await assert.rejects(f.engine().withdraw({}), /Photo removal is in progress/);
  assert.equal(f.calls('begin_cloud_withdrawal').length, 3);
  assert.equal(f.events.filter(e => e.type === 'resume').length, 3);
  assert.equal(f.erases().length, 0);
  const other = fixture(status(true, G1));
  other.onRPC = name => { if (name === 'begin_cloud_withdrawal') throw Error('permission denied'); };
  await assert.rejects(other.engine().withdraw({}), /permission denied/);
  assert.equal(other.calls('begin_cloud_withdrawal').length, 1);
});

test('finish retries drain intents without erasing the files again', async () => {
  const f = fixture(status(true, G1));
  let tries = 0;
  f.onRPC = name => {
    if (name === 'finish_cloud_withdrawal' && ++tries < 3) throw Error('Photo removal is in progress.');
  };
  await f.engine().withdraw({});
  assert.equal(tries, 3);
  assert.equal(f.erases().length, 1);
  assert.equal(f.events.filter(e => e.type === 'resume').length, 4);
});

test('account change during intent drain blocks begin', async () => {
  const f = fixture(status(true, G1));
  f.onResume = () => { f.current = false; };
  await assert.rejects(f.engine().withdraw({}), /Account changed/);
  assert.equal(f.calls('begin_cloud_withdrawal').length, 0);
  assert.equal(f.erases().length, 0);
});

test('a later withdrawal archives all earlier preserved snapshots and files', async () => {
  const f = fixture(status(true, G1)), backup = f.engine();
  const previousCloud = clone(f.cloud), previousPath = f.files[0];
  await backup.withdraw({ log: ['first-device-copy'] });
  f.remote = status(true, G2);
  f.cloud = { main: { photos: [{ id: 'photo-b' }] } };
  f.files = ['owner/' + G2 + '/photo-b.jpg'];
  await backup.withdraw({ log: ['second-device-copy'] });
  const exported = clone(await backup.export());
  assert.equal(exported.previous.length, 1);
  assert.deepEqual(exported.previous[0].local.log, ['first-device-copy']);
  assert.deepEqual(exported.previous[0].cloud, previousCloud);
  assert.equal(exported.previous[0].files[0].path, previousPath);
  assert.deepEqual(exported.local.log, ['second-device-copy']);
  exported.previous[0].local.log.length = 0;
  assert.equal((await backup.export()).previous[0].local.log.length, 1);
});

test('explicit stale withdrawal dismissal is local and leaves the new generation unadopted', async () => {
  const f = fixture(status(true, G1)), backup = f.engine();
  f.onRetain = () => { throw Error('interrupted'); };
  await assert.rejects(backup.withdraw({ log: ['saved-old-copy'] }), /interrupted/);
  f.remote = status(true, G2);
  f.onRetain = null;
  const start = f.events.length;
  await backup.dismissStaleWithdrawal();
  assert.equal(backup.enabled, true);
  assert.equal(backup.ready, false);
  assert.equal(backup.removalPending, false);
  const fresh = f.events.slice(start);
  assert.deepEqual(fresh.filter(e => e.type === 'rpc').map(e => e.name), ['cloud_consent_status']);
  assert.equal(fresh.filter(e => e.type === 'erase').length, 0);
  const exported = clone(await backup.export());
  assert.equal(exported.superseded, true);
  assert.deepEqual(exported.local.log, ['saved-old-copy']);
  const restarted = f.engine();
  await restarted.refresh();
  assert.equal(restarted.ready, false);
});

test('current-generation withdrawal cannot be dismissed as stale', async () => {
  const f = fixture(status(true, G1)), backup = f.engine();
  f.onRetain = () => { throw Error('interrupted'); };
  await assert.rejects(backup.withdraw({}), /interrupted/);
  await assert.rejects(backup.dismissStaleWithdrawal(), /must be completed or retried/);
  assert.equal(backup.removalPending, true);
  assert.equal(f.erases().length, 0);
  await assert.rejects(fixture().engine().dismissStaleWithdrawal(), /must be completed or retried/);
});
