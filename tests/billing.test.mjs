import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../www/index.html', import.meta.url), 'utf8');
const billing = html.slice(html.indexOf('const Billing = '), html.indexOf('/* ---------- reminders'));
function fixture({ native = true, key = 'appl_test_key', plugin = true, platform = 'ios', saved = new Map() } = {}) {
  let customer = '$RCAnonymousID:local';
  let listener;
  const cloud = { kind: 'device', user: null, verifyAccount: async () => true,
    LS: { get: key => saved.get(key), set: (key, value) => { saved.set(key, value); return true; } } };
  const ledger = new Map([['trainer', { coach: { productIdentifier: 'coach_monthly' } }]]);
  const info = () => ({ customerInfo: { entitlements: { active: ledger.get(customer) || {} } } });
  const pack = { packageType: 'MONTHLY', identifier: '$rc_monthly', product: { priceString: '€8.49' } };
  const calls = [], purchaseOptions = [], sdkCalls = [];
  const P = {
    configure: async ({ appUserID }) => { sdkCalls.push(['configure', appUserID]); if (appUserID) customer = appUserID; },
    getAppUserID: async () => ({ appUserID: customer }),
    isAnonymous: async () => ({ isAnonymous: customer.startsWith('$RCAnonymousID:') }),
    logIn: async ({ appUserID }) => { sdkCalls.push(['login', appUserID]); customer = appUserID; return info(); },
    logOut: async () => { sdkCalls.push(['logout', customer]); customer = '$RCAnonymousID:next'; return info(); },
    getCustomerInfo: async () => { sdkCalls.push(['info', customer]); return info(); },
    addCustomerInfoUpdateListener: async callback => { listener = callback; return '1'; },
    getOfferings: async () => ({ all: { default: { availablePackages: [pack] }, coach: { availablePackages: [pack] } } }),
    purchasePackage: async options => { purchaseOptions.push(options); calls.push([customer, options.aPackage.identifier]); return info(); },
    restorePurchases: async () => info(),
  };
  const cfg = { revenuecatAppleKey: key, revenuecatGoogleKey: key, prices: { monthly: '£4.99' } };
  const B = vm.runInNewContext(billing + '\nBilling;', {
    Native: { CFG: cfg, isNative: native, platform: native ? platform : 'web', plugin: () => plugin ? P : null },
    Cloud: cloud, location: { protocol: native ? 'capacitor:' : 'file:', origin: native ? 'capacitor://localhost' : 'null' },
  });
  return { B, P, cloud, calls, ledger, purchaseOptions, sdkCalls, saved, emit: () => listener?.(), customer: () => customer };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('native builds remain free when a store key or the bridge plugin is missing', async () => {
  for (const config of [{ key: '' }, { plugin: false }]) {
    const { B } = fixture(config); await B.init();
    assert.equal(B.mode, 'store'); assert.equal(B.unlocked, false); assert.equal(B.coachUnlocked, false);
    assert.equal(B.price('monthly'), ''); await assert.rejects(B.buy('monthly'));
  }
});
test('browser preview remains available offline', async () => {
  const { B } = fixture({ native: false }); await B.init();
  assert.equal(B.mode, 'preview'); assert.equal(B.unlocked, true);
});
test('Coach purchases use the logged-in user and the actual offering price', async () => {
  const { B, P, cloud, calls } = fixture(); await B.init();
  assert.equal(B.price('monthly', true), '€8.49');
  await assert.rejects(B.buy('coach-monthly'), /Sign in/); assert.deepEqual(calls, []);
  Object.assign(cloud, { kind: 'email', user: { id: 'trainer' } });
  assert.equal(await B.buy('coach-monthly'), 'ok'); assert.equal(B.unlocked, true); assert.equal(B.coachUnlocked, true);
  assert.deepEqual(calls, [['trainer', '$rc_monthly']]);
  Object.assign(cloud, { kind: 'email', user: { id: 'another-user' } }); assert.equal(B.unlocked, false);
  P.logIn = async () => { throw Error('offline'); };
  await assert.rejects(B.buy('coach-monthly')); assert.equal(calls.length, 1); assert.equal(B.coachUnlocked, false);
  Object.assign(cloud, { kind: 'device', user: null }); await B.identify();
  assert.equal(B.unlocked, false); assert.equal(await B.restore(), false);
});
test('an unavailable product cannot start a transaction', async () => {
  const { B, calls } = fixture(); await B.init(); await assert.rejects(B.buy('annual'), /unavailable/); assert.deepEqual(calls, []);
});

test('Google Play upgrades replace the existing recurring Premium product', async () => {
  const { B, cloud, ledger, purchaseOptions } = fixture({ platform: 'android' });
  Object.assign(cloud, { kind: 'email', user: { id: 'member' } });
  ledger.set('member', { premium: { store: 'PLAY_STORE', productIdentifier: 'ia_premium:monthly', expirationDate: '2030-01-01' } });
  await B.init();
  await B.buy('coach-monthly');
  assert.equal(purchaseOptions[0].storeProductChangeInfo.oldProductIdentifier, 'ia_premium');
  ledger.set('member', { premium: { store: 'APP_STORE', productIdentifier: 'ia_premium_monthly', expirationDate: '2030-01-01' } });
  await assert.rejects(B.buy('coach-monthly'), /original store/);
  assert.equal(purchaseOptions.length, 1);
});

test('stale identity reads stop after getAppUserID and isAnonymous without fetching old customer info', async () => {
  for (const delayed of ['getAppUserID', 'isAnonymous']) {
    const f = fixture(); await f.B.init();
    if (delayed === 'getAppUserID') { Object.assign(f.cloud, { kind: 'email', user: { id: 'member' } }); await f.B.identify(); }
    const entered = deferred(), release = deferred(), original = f.P[delayed];
    f.P[delayed] = async () => { entered.resolve(); await release.promise; return original(); };
    const start = f.sdkCalls.length, waiting = f.B.identify(); await entered.promise;
    Object.assign(f.cloud, delayed === 'getAppUserID' ? { kind: 'device', user: null } : { kind: 'email', user: { id: 'other' } });
    release.resolve(); assert.equal(await waiting, false);
    assert.deepEqual(f.sdkCalls.slice(start), []);
  }
});

test('deletion drains pending purchase and restore work before logout and drops later old callbacks', async () => {
  for (const operation of ['purchase', 'restore']) {
    const f = fixture(); Object.assign(f.cloud, { kind: 'email', user: { id: 'member' } }); await f.B.init();
    const entered = deferred(), release = deferred();
    f.P[operation === 'purchase' ? 'purchasePackage' : 'restorePurchases'] = async () => {
      entered.resolve(); await release.promise;
      return { customerInfo: { entitlements: { active: { premium: {} } } } };
    };
    const pending = (operation === 'purchase' ? f.B.buy('monthly') : f.B.restore()).catch(error => error);
    await entered.promise;
    let prepared = false; const prepare = f.B.prepareAccountDeletion('member').then(() => { prepared = true; });
    await Promise.resolve(); assert.equal(prepared, false); assert.equal(f.customer(), 'member');
    release.resolve(); assert.match((await pending).message, /Account changed/); await prepare;
    assert.match(f.customer(), /^\$RCAnonymousID:/);
    const afterDelete = f.sdkCalls.length;
    Object.assign(f.cloud, { kind: 'device', user: null }); await f.B.finishAccountDeletion('member', true);
    f.emit(); await f.B.identify();
    assert.ok(f.sdkCalls.slice(afterDelete).every(([op, id]) => !['info', 'login'].includes(op) || id !== 'member'));
  }
});

test('failed deletion restores only a verified current account and unknown failure stays detached', async () => {
  const f = fixture(); Object.assign(f.cloud, { kind: 'email', user: { id: 'member' } }); await f.B.init();
  await f.B.prepareAccountDeletion('member');
  f.cloud.verifyAccount = async () => false;
  await f.B.finishAccountDeletion('member', false);
  assert.match(f.customer(), /^\$RCAnonymousID:/);
  assert.ok(f.saved.get('iron-atlas:pending-store-erasure').includes('member'));
  await assert.rejects(f.B.buy('monthly'), /deletion needs to be resolved/);
  f.cloud.verifyAccount = async () => true; await f.B.identify();
  assert.equal(f.customer(), 'member');
  assert.equal(f.saved.get('iron-atlas:pending-store-erasure'), '[]');
  await f.B.prepareAccountDeletion('member');
  Object.assign(f.cloud, { kind: 'email', user: { id: 'other' } }); await f.B.finishAccountDeletion('member', false);
  assert.equal(f.customer(), 'other');
});

test('a persisted uncertain deletion blocks startup configuration with the old UUID', async () => {
  const saved = new Map([['iron-atlas:pending-store-erasure', '["member"]']]);
  const f = fixture({ saved }); Object.assign(f.cloud, { kind: 'email', user: { id: 'member' } }); f.cloud.verifyAccount = async () => false;
  await f.B.init();
  assert.ok(f.sdkCalls.every(([op, id]) => !['configure', 'info', 'login'].includes(op) || id !== 'member'));
  assert.match(f.customer(), /^\$RCAnonymousID:/);
  f.cloud.verifyAccount = async () => true; await f.B.identify(); assert.equal(f.customer(), 'member');
});

test('device storage failure stops deletion preparation before detaching the store', async () => {
  const f = fixture(); Object.assign(f.cloud, { kind: 'email', user: { id: 'member' } }); await f.B.init();
  f.cloud.LS.set = () => false;
  await assert.rejects(f.B.prepareAccountDeletion('member'), /Device storage is unavailable/);
  assert.equal(f.customer(), 'member');
});
