import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = readFileSync(new URL('../www/index.html', import.meta.url), 'utf8');
const version = '2026-11-02';
function section(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from + 1);
  assert.ok(from >= 0 && to > from);
  return html.slice(from, to);
}
function shareAdapter() {
  const calls = [];
  const email = { sess: { uid: 'member-a' }, epoch: 1, refreshBackup: async () => {},
    req: async (url, options, uid) => { calls.push({ url, body: JSON.parse(options.body), uid }); } };
  const api = { backupState: { generation: 'generation-a' }, backupReady: true };
  const context = vm.createContext({ B: email, email, api, claude: {}, IronAtlasBackup: { sharingVersion: version }, IronAtlasModeration: { allowed: () => true } });
  const adapter = vm.runInContext('({' + section('    async sharePlan(', '    async fetchPlan(') + '})', context);
  return { calls, email, api, adapter };
}

test('hosted plan publishing requires the sharing notice and uses captured owner and generation', async () => {
  const f = shareAdapter();
  await assert.rejects(f.adapter.sharePlan({ n: 'My plan' }), /Confirm the plan-sharing notice/);
  assert.equal(f.calls.length, 0);
  await f.adapter.sharePlan({ n: 'My plan' }, version);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.sharing_notice_version, version);
  assert.equal(f.calls[0].body.owner, 'member-a');
  assert.equal(f.calls[0].body.consent_generation, 'generation-a');
  assert.equal(f.calls[0].uid, 'member-a');
});

test('a plan-sharing refresh cannot publish into a changed identity or generation', async () => {
  for (const change of [f => { f.email.sess.uid = 'member-b'; }, f => { f.email.epoch++; }, f => { f.api.backupState.generation = 'generation-b'; }]) {
    const f = shareAdapter(); f.email.refreshBackup = async () => change(f);
    await assert.rejects(f.adapter.sharePlan({ n: 'My plan' }, version), /Account or cloud backup changed/);
    assert.equal(f.calls.length, 0);
  }
});

test('trainer connection requires a versioned notice and binds its request to the original member', async () => {
  const calls = [], email = { sess: { uid: 'member-a' }, epoch: 1, refreshBackup: async () => {} };
  const api = { backupState: { generation: 'generation-a' }, backupReady: true, rpc: async (...args) => calls.push(args) };
  const join = vm.runInNewContext('({' + section('      join: async ', '      leave:') + '}).join', { email, api, IronAtlasBackup: { sharingVersion: version } });
  await assert.rejects(join('ABC234', 'Member'), /Agree to the trainer-sharing notice/);
  assert.equal(calls.length, 0);
  await join('ABC234', 'Member', version);
  assert.equal(calls[0][1].p_sharing_version, version);
  assert.equal(calls[0][1].p_generation, 'generation-a');
  assert.equal(calls[0][2], 'member-a');
  email.refreshBackup = async () => { email.sess.uid = 'member-b'; };
  await assert.rejects(join('ABC234', 'Member', version), /Account or cloud backup changed/);
  assert.equal(calls.length, 1);
});

test('the rendered trainer choice starts unticked and the submit handler cannot bypass it', async () => {
  const cloud = { coachOnline: true, acct: 'e:member-a', coach: {} }, fields = {
    '#joinCode': { value: 'ABC234' }, '#joinName': { value: 'Member' }, '#trainerSharing': { checked: false }, '#joinMsg': {},
  };
  const calls = [], state = { name: 'Member' };
  cloud.coach.join = async (...args) => { calls.push(args); return { name: 'Trainer' }; };
  const context = { Cloud: cloud, S: state, sheetData: { owner: 'e:member-a' }, $: selector => fields[selector],
    IronAtlasBackup: { sharingVersion: version, privacyReady: () => true }, Native: { CFG: { privacyUrl: 'https://ironatlas.insomnia-it.co.uk/privacy/' } },
    esc: value => value, ICON: {}, busyBtn() {}, Store: { save() {} }, closeSheet() {}, render() {}, toast() {}, coachSync() {}, coachStatus: async () => {}, IronAtlasModeration: { allowed: () => true } };
  const render = vm.runInNewContext('({' + section('    joinCoach(d) {', '    assignPlan(d) {') + '}).joinCoach', context);
  const markup = render({});
  assert.match(markup, /id="trainerSharing"/);
  assert.doesNotMatch(markup.match(/<input[^>]+id="trainerSharing"[^>]*>/)[0], /checked/);
  assert.match(markup, /training goal, weekly training target and streak/);
  const submit = vm.runInNewContext(section('  async function submitJoin(', '  async function leaveCoach(') + '\nsubmitJoin', context);
  await submit({}); assert.equal(calls.length, 0); assert.match(fields['#joinMsg'].textContent, /Tick the trainer-sharing choice/);
  fields['#trainerSharing'].checked = true; await submit({});
  assert.equal(calls.length, 1); assert.equal(calls[0][2], version);
});

test('plan sharing waits for confirmation and preserves the disclosed snapshot', async () => {
  const calls = [], context = vm.createContext({
    Cloud: { kind: 'email', backupReady: true, acct: 'e:member-a', backupState: { generation: 'generation-a' }, sharePlan: async (...args) => { calls.push(args); return 'ABC234'; } },
    BRAND: null, firstName: () => 'Member', IronAtlasBackup: { sharingVersion: version }, IronAtlasModeration: { allowed: () => true },
    confirmDialog: async () => false, toast() {}, refreshSheet() {}, PlanCode: { encode: () => 'long-code' },
  });
  context.openSheet = (kind, data) => { context.sheetKind = kind; context.sheetData = data; };
  const open = vm.runInContext(section('  async function openSharePlan(', '  async function importPlanCode(') + '\nopenSharePlan', context);
  const plan = { name: 'My plan', items: [['lift', 3, '8']], note: 'Personal note' };
  await open(plan); assert.equal(calls.length, 0);
  context.confirmDialog = async notice => {
    assert.match(notice.text, /author name “Member”/); assert.match(notice.text, /free-text notes/); assert.match(notice.text, /Anyone with the code/);
    plan.items[0][1] = 9; return true;
  };
  await open(plan); assert.equal(calls.length, 1); assert.equal(calls[0][0].i[0][1], 3); assert.equal(calls[0][1], version);
  context.confirmDialog = async () => { context.Cloud.acct = 'e:member-b'; return true; };
  await open(plan); assert.equal(calls.length, 1);
});
