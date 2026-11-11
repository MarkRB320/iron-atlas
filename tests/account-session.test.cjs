'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const html = readFileSync(join(__dirname, '../www/index.html'), 'utf8').replaceAll('\r\n', '\n');
const section = (start, end) => {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a);
  return html.slice(a, b);
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const session = (id, age = 3600) => ({ user: { id, email: id + '@example.invalid' }, access_token: id + '-access', refresh_token: id + '-refresh', expires_in: age });
function accounts(network) {
  const cache = new Map(), win = new EventTarget();
  win.IRON_ATLAS_CONFIG = { supabaseUrl: 'https://auth.example.invalid', supabaseAnonKey: 'test-public' };
  const ctx = vm.createContext({ window: win, Event, fetch: network, localStorage: {
    getItem: k => cache.get(k), setItem: (k, v) => cache.set(k, v), removeItem: k => cache.delete(k),
  } });
  vm.runInContext(section('const Cloud = (() => {', '})();\n\n/* ====') + '})();\nglobalThis.api=Cloud;', ctx);
  return { api: ctx.api, cache, win };
}
test('concurrent requests share a refresh and both use the returned token', async () => {
  const wait = deferred(), entered = deferred(); let refresh = 0, calls = 0;
  const { api } = accounts(async (url, opts) => {
    if (url.includes('grant_type=password')) return response(session('alpha', 1));
    if (url.includes('grant_type=refresh_token')) {
      refresh++; entered.resolve(); await wait.promise;
      return response({ ...session('alpha'), access_token: 'new-access' });
    }
    assert.equal(opts.headers.Authorization, 'Bearer new-access'); calls++;
    return response([]);
  });
  await api.signIn('alpha@example.invalid', 'test');
  const requests = Promise.all([api.rpc('first'), api.rpc('second')]);
  await entered.promise; wait.resolve(); await requests;
  assert.equal(refresh, 1); assert.equal(calls, 2);
});
test('a refresh finishing after an account switch cannot overwrite the new session or send a request', async () => {
  const wait = deferred(), entered = deferred(); let rpc = 0;
  const { api, cache } = accounts(async (url, options) => {
    if (url.includes('grant_type=password')) {
      const id = JSON.parse(options.body).email; return response(session(id, id === 'alpha' ? 1 : 3600));
    }
    if (url.includes('refresh_token')) { entered.resolve(); await wait.promise; return response(session('alpha')); }
    rpc++; return response([]);
  });
  await api.signIn('alpha', 'test');
  const old = api.rpc('old').catch(e => e);
  await entered.promise; await api.signIn('bravo', 'test'); wait.resolve();
  assert.match((await old).message, /Account changed/);
  assert.equal(rpc, 0); assert.equal(api.user.id, 'bravo');
  assert.equal(JSON.parse(cache.get('iron-atlas:session')).uid, 'bravo');
});
test('a late 401 cannot retry a destructive request with another account bearer', async () => {
  const wait = deferred(), entered = deferred(), tokens = [];
  const { api } = accounts(async (url, options) => {
    if (url.includes('grant_type=password')) return response(session(JSON.parse(options.body).email));
    if (url.includes('logout')) return response({});
    tokens.push(options.headers.Authorization); entered.resolve(); await wait.promise; return response({}, 401);
  });
  await api.signIn('alpha', 'test');
  const old = api.rpc('delete_my_account').catch(e => e);
  await entered.promise; await api.signOut(); await api.signIn('bravo', 'test'); wait.resolve();
  assert.match((await old).message, /Account changed/); assert.deepEqual(tokens, ['Bearer alpha-access']);
});
test('definitively expired refresh clears the session and notifies the UI once; network failure keeps it', async () => {
  let offline = true;
  const { api, cache, win } = accounts(async url => {
    if (url.includes('grant_type=password')) return response(session('alpha', 1));
    if (offline) throw new Error('offline');
    return response({ msg: 'Invalid Refresh Token', error_code: 'refresh_token_not_found' }, 400);
  });
  let events = 0; win.addEventListener('iron-atlas:session-ended', () => { events++; });
  await api.signIn('alpha', 'test');
  await assert.rejects(api.rpc('summary_put'), /reach the server/);
  assert.equal(api.user.id, 'alpha'); assert.equal(events, 0);
  offline = false; await assert.rejects(api.rpc('summary_put'), /signed-out/);
  assert.equal(events, 1); assert.equal(api.acct, 'guest'); assert.equal(cache.get('iron-atlas:session'), undefined);
});

function signOutFixture({ synced, storageOK = true, backupReady = true, withdrawal = null }) {
  const state = new Map([['e:alpha', 'workout'], ['e:bravo', 'other member']]);
  const effects = [], cloud = { acct: 'e:alpha', backupReady, withdrawal,
    LS: { get: k => state.get(k), set(k, v) { if (storageOK) state.set(k, v); return storageOK; }, del(k) { state.delete(k); } },
    Local: { async clearAccount(acct) { effects.push('clear:' + acct); } },
    async signOut() { cloud.acct = 'guest'; effects.push('logout'); },
  };
  const ctx = vm.createContext({
    Cloud: cloud, Store: { push: async () => synced, writeLocal: () => storageOK },
    Billing: { identify: async () => effects.push('identify:' + cloud.acct) },
    showGuest: () => effects.push('show guest'), toast: () => {}, clearTimeout,
    LSKEY: a => a, confirmDialog: async () => true,
  });
  vm.runInContext(section('  async function signOut() {', '  async function wipeAll('), ctx);
  return { state, effects, cloud, ctx };
}
test('offline sign-out keeps records and photos scoped for the original member', async () => {
  const { state, effects, ctx } = signOutFixture({ synced: false });
  await ctx.signOut();
  assert.equal(state.get('e:alpha'), 'workout'); assert.equal(state.get('e:alpha:pending'), '1');
  assert.equal(state.get('e:bravo'), 'other member'); assert.deepEqual(effects, ['logout', 'show guest', 'identify:guest']);
});
test('when backup and device save both fail, sign-out stops before discarding data', async () => {
  const { state, effects, cloud, ctx } = signOutFixture({ synced: false, storageOK: false });
  await ctx.signOut(); assert.equal(state.get('e:alpha'), 'workout'); assert.equal(cloud.acct, 'e:alpha'); assert.deepEqual(effects, []);
});
test('successful backup clears only the departing member on sign-out', async () => {
  const { state, effects, ctx } = signOutFixture({ synced: true });
  await ctx.signOut(); assert.equal(state.has('e:alpha'), false); assert.equal(state.get('e:bravo'), 'other member');
  assert.deepEqual(effects, ['logout', 'show guest', 'clear:e:alpha', 'identify:guest']);
});

test('a signed-in customer without cloud consent keeps the device copy after sign-out', async () => {
  const { state, effects, ctx } = signOutFixture({ synced: true, backupReady: false });
  await ctx.signOut();
  assert.equal(state.get('e:alpha'), 'workout');
  assert.deepEqual(effects, ['logout', 'show guest', 'identify:guest']);
});

test('a retained withdrawal copy stays on the device after later consent and sign-out', async () => {
  const { state, effects, ctx } = signOutFixture({ synced: true, withdrawal: { phase: 'done' } });
  await ctx.signOut();
  assert.equal(state.get('e:alpha'), 'workout');
  assert.deepEqual(effects, ['logout', 'show guest', 'identify:guest']);
});
test('sign-in uses the base-aware reconciliation result and acknowledges the applied receipt', async () => {
  let applied;
  const cached = { saved: 2, log: ['offline set'] };
  const reconciled = { saved: 3, log: ['offline set', 'remote set'] };
  let accepted = false;
  const ctx = vm.createContext({
    Cloud: { acct: 'e:alpha', kind: 'email', load: async input => { assert.equal(input, cached); return reconciled; }, accept: async input => { assert.equal(input, reconciled); accepted = true; } },
    Store: { readLocal: acct => acct === 'e:alpha' ? cached : null, save: () => {}, writeLocal: () => true },
    docsFor: input => input, toDocs: () => applied,
    LSKEY: a => a, fromDocs: d => d, hasOwnData: () => false, apply: d => { applied = d; },
    Photos: { urls: new Map() }, stage: { setSex: () => {} }, S: {}, render: () => {},
  });
  vm.runInContext(section('  async function switchToAccountData(', '  async function submitAuth('), ctx);
  await ctx.switchToAccountData(true); assert.equal(applied, reconciled); assert.equal(accepted, true);
});

test('a failed initial backup read cannot publish guest data to an existing member', async () => {
  const calls = [];
  const ctx = vm.createContext({
    Cloud: { acct: 'e:alpha', kind: 'email', load: async () => undefined, signOut: async () => calls.push('logout') },
    Store: { readLocal: acct => acct === 'guest' ? { guest: true } : null, save: () => calls.push('write') },
    Billing: { identify: async () => calls.push('identify') }, showGuest: () => calls.push('guest'),
  });
  vm.runInContext(section('  async function switchToAccountData(', '  async function submitAuth('), ctx);
  await assert.rejects(ctx.switchToAccountData(true), /backup could not be read/);
  assert.deepEqual(calls, ['logout', 'guest', 'identify']);
});
