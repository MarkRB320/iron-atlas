import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../www/index.html", import.meta.url), "utf8");
const source = html.slice(html.indexOf("  async function receiveAssigned("), html.indexOf("  // a client's phone keeps"));
const deliveries = [{ id: "1", recipient: "client", author: "11111111-1111-4111-8111-111111111111", coach: "Trainer", plan: { name: "Day 1" } }];
function phone() {
  const state = { myPlans: [] }, disk = { saves: true }, received = [];
  const cloud = { acct: "e:client", user: { id: "client" }, sessionEpoch: 1, backupState: { generation: 'generation-one' }, backupReady: true, moderationReady: true, canShowShared: () => true, coach: {
    pendingAssigned: async () => deliveries,
    ackAssigned: async ids => received.push(...ids),
  } };
  const collect = vm.runInNewContext(source + "\nreceiveAssigned", {
    S: state, Cloud: cloud, Store: { save: () => disk.saves }, render() {}, toast() {},
    normPlan: p => p?.name ? p : null, planText: (value, length) => value?.slice(0, length),
    asMyPlan: (plan, extra) => ({ ...plan, ...extra }),
    IronAtlasModeration: { source: value => value.author ? value : null, allowed: () => true },
  });
  return { collect: () => collect("e:client"), state, disk, received, cloud };
}
test("failed reads, full device storage and a lost acknowledgement can be retried without loss or duplication", async () => {
  const p = phone();
  p.cloud.coach.pendingAssigned = async () => { throw Error("lost response"); };
  await assert.rejects(p.collect(), /lost response/);
  assert.deepEqual(p.received, []);
  p.cloud.coach.pendingAssigned = async () => deliveries;
  p.disk.saves = false;
  await p.collect();
  assert.deepEqual(p.received, []);
  p.disk.saves = true;
  p.cloud.coach.ackAssigned = async () => { throw Error("lost ack"); };
  await assert.rejects(p.collect(), /lost ack/);
  p.cloud.coach.ackAssigned = async ids => p.received.push(...ids);
  await p.collect();
  assert.deepEqual(p.received, ["1"]);
  assert.equal(p.state.myPlans.length, 1);
  assert.equal(p.state.myPlans[0].id, "assigned-1");
});

test("old deliveries are ignored after same-user reauthentication, withdrawal or a new generation", async () => {
  for (const change of [p => { p.cloud.sessionEpoch++; }, p => { p.cloud.backupState.generation = 'generation-two'; }, p => { p.cloud.backupReady = false; }]) {
    const p = phone();
    p.cloud.coach.pendingAssigned = async () => { change(p); return deliveries; };
    await p.collect();
    assert.deepEqual(p.state.myPlans, []);
    assert.deepEqual(p.received, []);
  }
});

test("blocked or rejected assigned content is not imported and accepted provenance survives retries", async () => {
  const p = phone();
  p.cloud.canShowShared = () => false;
  await p.collect(); assert.deepEqual(p.state.myPlans, []);
  p.cloud.canShowShared = () => true;
  await p.collect(); await p.collect();
  assert.equal(p.state.myPlans.length, 1);
  assert.equal(p.state.myPlans[0].source.kind, 'assigned_plan');
  assert.equal(p.state.myPlans[0].source.reference, '1');
  assert.equal(p.state.myPlans[0].source.author, deliveries[0].author);
});
test("a response received after an account change or belonging to another user is ignored", async () => {
  const p = phone();
  p.cloud.coach.pendingAssigned = async () => { p.cloud.acct = "e:other"; return deliveries; };
  await p.collect();
  assert.deepEqual(p.state.myPlans, []);
  p.cloud.acct = "e:client";
  p.cloud.coach.pendingAssigned = async () => [{ ...deliveries[0], recipient: "other" }];
  await p.collect();
  assert.deepEqual(p.state.myPlans, []);
  assert.deepEqual(p.received, []);
});
