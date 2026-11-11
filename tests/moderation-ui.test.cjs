'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = readFileSync(join(__dirname, '../www/index.html'), 'utf8');
const safety = { window: {} };
vm.runInNewContext(readFileSync(join(__dirname, '../www/account/moderation.js'), 'utf8'), safety);
const M = safety.window.IronAtlasModeration;
const author = '11111111-1111-4111-8111-111111111111', reference = '22222222-2222-4222-8222-222222222222';
const provenance = { kind: 'shared_plan', reference, author };
function section(start, end, from = 0) {
  const begin = html.indexOf(start, from), finish = html.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin, start);
  return html.slice(begin, finish);
}
function fixture() {
  const f = { remote: { n: 'Shared session', i: [['lift', 3, '8']], no: 'Controlled reps', by: 'Trainer', _source: provenance }, messages: [], saved: true, blocked: new Set() };
  const message = {};
  const context = vm.createContext({
    EX: { lift: { level: 1, name: 'Lift' } }, EXERCISES: [{ id: 'lift' }], IronAtlasModeration: M,
    atob: value => Buffer.from(value, 'base64').toString('binary'), escape, unescape,
    S: { myPlans: [] }, Cloud: { acct: 'e:member', canShowShared: peer => !f.blocked.has(peer), fetchPlan: async () => f.remote },
    $: () => message, Store: { save: () => f.saved }, toast: value => f.messages.push(value), go() {},
    closeSheet: () => { context.sheetKind = null; }, openSheet: (kind, data) => { context.sheetKind = kind; context.sheetData = data; },
  });
  vm.runInContext(section('  const PlanCode = {', '  function openPlanEditor(') + section('  async function importPlanCode(', '  function celebrate(') +
    '\nglobalThis.actions={importPlanCode,saveImportedPlan,restoreMyPlan,PlanCode};', context);
  return { ...f, f, context, actions: context.actions, message };
}

test('hosted plan import previews the server source before saving and preserves it through restore', async () => {
  const { context, actions } = fixture();
  await actions.importPlanCode('ABC234');
  assert.equal(context.sheetKind, 'sharedPlanPreview'); assert.equal(context.S.myPlans.length, 0);
  assert.equal(context.sheetData.source.reference, reference);
  actions.saveImportedPlan();
  const plan = context.S.myPlans[0]; assert.equal(plan.source.author, author); assert.equal(plan.code, 'ABC234');
  assert.equal(actions.restoreMyPlan(plan).source.reference, reference);
});

test('legacy personal import filters raw content and strips forged server provenance', async () => {
  const { context, actions, f, message } = fixture();
  const encode = value => 'IA1-' + Buffer.from(JSON.stringify(value)).toString('base64url');
  await actions.importPlanCode(encode(f.remote));
  assert.equal(context.sheetData.legacy, true); assert.equal(context.sheetData.source, undefined);
  actions.saveImportedPlan(); assert.equal(context.S.myPlans[0].source, undefined); assert.equal(context.S.myPlans[0].legacyImport, true);
  await actions.importPlanCode(encode({ ...f.remote, unused: 'p0rn' }));
  assert.match(message.textContent, /cannot be imported/); assert.equal(context.S.myPlans.length, 1);
});

test('account switches, new blocks and storage failures cannot save an unreviewed imported plan', async () => {
  const one = fixture(); one.context.Cloud.fetchPlan = async () => { one.context.Cloud.acct = 'e:other'; return one.f.remote; };
  await one.actions.importPlanCode('ABC234'); assert.equal(one.context.S.myPlans.length, 0); assert.equal(one.context.sheetKind, undefined);
  const two = fixture(); await two.actions.importPlanCode('ABC234'); two.f.blocked.add(author); two.actions.saveImportedPlan(); assert.equal(two.context.S.myPlans.length, 0);
  const three = fixture(); await three.actions.importPlanCode('ABC234'); three.f.saved = false; three.actions.saveImportedPlan(); assert.equal(three.context.S.myPlans.length, 0);
});

test('existing private plan text is preserved during restoration', () => {
  const { actions } = fixture();
  const plan = actions.restoreMyPlan({ id: 'personal-1', name: 'Private notes', note: 'shit', items: [['lift', 3, '8']] });
  assert.equal(plan.note, 'shit'); assert.equal(plan.id, 'personal-1');
});

test('email sync cannot reinterpret a pending snapshot after its account or epoch changes', async () => {
  const source = section('    async load(local) {', '    photoHandle(', html.indexOf('  const email = {'));
  for (const operation of ['load', 'save']) {
    let engines = 0;
    const context = vm.createContext({ IronAtlasSync: { canonical: value => value } });
    const adapter = vm.runInContext('({' + source + '})', context);
    adapter.sess = { uid: 'original' }; adapter.epoch = 1; adapter.backup = { enabled: true, ready: true, state: { generation: 'g' } };
    adapter.loadModeration = async () => {};
    adapter.refreshBackup = async () => { adapter.sess.uid = 'other'; adapter.epoch++; };
    adapter.engine = () => { engines++; throw Error('Wrong account reached engine'); };
    await assert.rejects(adapter[operation]({ main: { name: 'Original' } }), /Account changed/);
    assert.equal(engines, 0);
  }
});

test('paywall benefit SVGs have a bounded nonshrinking size', () => {
  const rule = html.match(/\.pw-list li > svg\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule); assert.match(rule, /width:\s*20px/); assert.match(rule, /height:\s*20px/); assert.match(rule, /flex:\s*0 0 20px/);
  assert.match(html, /\.pw-hero\s*\{\s*flex-shrink:\s*0;/);
  assert.match(section('  function openSheet(', '  function refreshSheet('), /sheetBody\.scrollTop = 0/);
  assert.match(html, /\.fld input, \.fld select\s*\{[^}]*color-scheme:\s*dark/);
});

test('hosted reads use member authentication and reject a changed session before and after the response', async () => {
  for (const phase of ['load', 'refresh', 'response']) {
    const email = { sess: { uid: 'member-a' }, epoch: 1 };
    let requests = 0;
    const api = { moderationReady: phase !== 'refresh', canShowShared: () => true };
    email.loadModeration = async () => { if (phase === 'load') email.epoch++; };
    api.refreshModeration = async () => { email.epoch++; api.moderationReady = true; };
    email.req = async (path, options, uid) => {
      requests++; assert.equal(uid, 'member-a'); assert.equal(path, '/rest/v1/rpc/get_shared_plan');
      return { json: async () => { email.epoch++; return { n: 'Shared plan', _source: provenance }; } };
    };
    const method = section('    async fetchPlan(', '\n  };\n  return api;', html.indexOf('const Cloud ='));
    const adapter = vm.runInNewContext('({' + method + '})', { B: email, email, api, IronAtlasModeration: M });
    await assert.rejects(adapter.fetchPlan('ABC234'), /Account changed/);
    assert.equal(requests, phase === 'response' ? 1 : 0);
  }
});

test('summary and assignment requests cannot adopt a changed session or backup generation during refresh', async () => {
  const methods = section('      putSummary: async ', '\n    },\n    // shared plans:');
  for (const method of ['putSummary', 'pendingAssigned', 'ackAssigned']) {
    for (const changed of ['uid', 'epoch', 'generation']) {
      const calls = [], email = { sess: { uid: 'member-a' }, epoch: 1 };
      const api = { backupReady: true, backupState: { generation: 'generation-a' }, rpc: async (...args) => calls.push(args) };
      const scope = { uid: 'member-a', epoch: 1, generation: 'generation-a' };
      email.refreshBackup = async () => {
        if (changed === 'uid') email.sess.uid = 'member-b';
        if (changed === 'epoch') email.epoch++;
        if (changed === 'generation') api.backupState.generation = 'generation-b';
      };
      const adapter = vm.runInNewContext('({' + methods + '})', { email, api });
      const arguments_ = method === 'putSummary' ? [{ sessions: 1 }] : method === 'pendingAssigned' ? [scope] : [['1'], scope];
      await assert.rejects(adapter[method](...arguments_), /Account or cloud backup changed/);
      assert.deepEqual(calls, []);
    }
  }
});

test('failed or signed-out publication cannot fall back to an unmoderated personal-file code', async () => {
  let fallback = 0;
  const context = vm.createContext({
    Cloud: { kind: 'email', backupReady: true, acct: 'e:member', backupState: { generation: 'generation-a' }, sharePlan: async () => { throw Error('Sharing unavailable'); } },
    BRAND: null, firstName: () => 'Member', IronAtlasBackup: { sharingVersion: '2026-11-02' }, IronAtlasModeration: M,
    confirmDialog: async () => true, toast() {}, refreshSheet() {}, PlanCode: { encode: () => { fallback++; } },
  });
  context.openSheet = (kind, data) => { context.sheetKind = kind; context.sheetData = data; };
  const open = vm.runInContext(section('  async function openSharePlan(', '  async function importPlanCode(') + '\nopenSharePlan', context);
  await open({ name: 'Plan', items: [['lift', 3, '8']] });
  assert.equal(context.sheetData.error, 'Sharing unavailable'); assert.equal(fallback, 0);
  context.Cloud.kind = 'claude'; context.sheetKind = null;
  await open({ name: 'Plan', items: [['lift', 3, '8']] });
  assert.equal(context.sheetKind, 'account'); assert.equal(fallback, 0);
});
