import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../supabase/functions/coach-access/handler.mjs";

const actor = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const generation = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const trainer = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const base = {
  supabaseUrl: "https://project.invalid", publicKey: "sb_publishable_fixture", serviceKey: "sb_secret_fixture",
  projectId: "proj_fixture", revenueCatKey: "secret_fixture", coachEntitlement: "coach",
};
function subscription(givesAccess, environment = "production", key = "coach") {
  return { id: "sub_fixture", environment, gives_access: givesAccess, entitlements: { items: [{ lookup_key: key, state: "active" }] } };
}
function fixture(options = {}) {
  const calls = [];
  const list = items => ({ object: "list", items, next_page: null });
  const handler = createHandler({ ...base, ...options.config }, async (input, init) => {
    const url = new URL(input);
    const args = init.body ? JSON.parse(init.body) : {};
    const op = url.pathname.split("/").at(-1);
    calls.push({ url, args, op });
    if (op === "user") {
      assert.equal(init.headers.apikey, base.publicKey);
      assert.equal(init.headers.Authorization, "Bearer session");
      return Response.json({ id: actor, email_confirmed_at: "2026-01-01", ...options.user }, { status: options.authStatus || 200 });
    }
    if (url.hostname === "api.revenuecat.com") {
      assert.equal(init.headers.Authorization, "Bearer " + base.revenueCatKey);
      if (options.revenue) return options.revenue(url);
      return Response.json(list(options.items ?? [subscription(true)]));
    }
    assert.equal(url.hostname, "project.invalid");
    assert.equal(init.headers.apikey, base.serviceKey);
    assert.equal(init.headers.Authorization, undefined);
    if (op === "coach_request_allowed") return Response.json(!options.limited);
    if (op === "coach_join_target") return Response.json(options.target ?? trainer);
    assert.ok(op.endsWith("_checked"));
    if (options.databaseError) return Response.json(options.databaseError, { status: 403 });
    return Response.json(op === "coach_clients_checked" ? [] : { name: "Trainer" });
  });
  async function call(operation = "coach_clients", args = {}, token = "Bearer session") {
    return handler(new Request("https://function.invalid", { method: "POST", headers: { authorization: token },
      body: JSON.stringify({ operation, args }) }));
  }
  return { calls, call };
}

test("only a verified email account can reach store or database services", async () => {
  for (const options of [{ authStatus: 401 }, { user: { is_anonymous: true } }, { user: { email_confirmed_at: null } }]) {
    const f = fixture(options);
    assert.ok([401, 403].includes((await f.call()).status));
    assert.deepEqual(f.calls.map(c => c.op), ["user"]);
  }
  const f = fixture();
  assert.equal((await f.call("coach_clients", {}, "")).status, 401);
  assert.equal((await f.call("delete_my_account")).status, 400);
  assert.equal((await f.call("coach_setup", { p_name: "X".repeat(33000) })).status, 413);
  assert.deepEqual(f.calls, []);
});

test("Coach operations use the authenticated actor and a fresh store decision each time", async () => {
  const items = [subscription(true)];
  const f = fixture({ items });
  const forged = { p_name: "Trainer", p_actor: trainer, p_trainer: trainer, active: true };
  assert.equal((await f.call("coach_setup", forged)).status, 200);
  assert.deepEqual(f.calls.at(-1).args, { p_actor: actor, p_name: "Trainer" });
  assert.equal(f.calls.find(c => c.op === "subscriptions").url.pathname, "/v2/projects/proj_fixture/customers/" + actor + "/subscriptions");
  items[0].gives_access = false; // expiry, refund or transfer away
  assert.equal((await f.call("coach_setup", forged)).status, 403);
  items[0].gives_access = true; // renewal, restore or valid grace period
  assert.equal((await f.call("coach_assign", { p_generation: generation, p_client: trainer, p_plan: { name: "Day 1" } })).status, 200);
  assert.equal(f.calls.filter(c => c.op.endsWith("_checked")).length, 2);
});

test("inactive, missing, wrong-environment and Premium-only purchases do not grant Coach", async () => {
  for (const items of [[], [subscription(false)], [subscription(true, "sandbox")], [subscription(true, "production", "premium")]]) {
    const f = fixture({ items });
    assert.equal((await f.call()).status, 403);
    assert.ok(!f.calls.some(c => c.op.endsWith("_checked")));
  }
});

test("free clients join a subscribed trainer resolved from the code", async () => {
  const f = fixture();
  assert.equal((await f.call("coach_join", { p_sharing_version: "2026-11-02", p_generation: generation, p_code: "abc234", p_name: "Client", p_trainer: actor })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, { p_actor: actor, p_trainer: trainer, p_sharing_version: "2026-11-02", p_generation: generation, p_code: "ABC234", p_name: "Client" });
  assert.ok(f.calls.find(c => c.op === "subscriptions").url.pathname.includes(trainer));
  const inactive = fixture({ items: [] });
  assert.equal((await inactive.call("coach_join", { p_sharing_version: "2026-11-02", p_generation: generation, p_code: "ABC234" })).status, 403);
  assert.ok(!inactive.calls.some(c => c.op.endsWith("_checked")));
});

test("sandbox is limited to explicitly listed tester accounts and links", async () => {
  const f = fixture({ config: { sandboxAccounts: actor }, items: [subscription(true, "sandbox")] });
  assert.equal((await f.call()).status, 200);
  assert.equal(f.calls.find(c => c.op === "subscriptions").url.searchParams.get("environment"), "sandbox");
  assert.equal((await f.call("coach_join", { p_sharing_version: "2026-11-02", p_generation: generation, p_code: "ABC234" })).status, 404);
});

test("rate limiting and store failures close access and preserve existing client data", async () => {
  const f = fixture({ limited: true });
  assert.equal((await f.call()).status, 429);
  assert.deepEqual(f.calls.map(c => c.op), ["user", "coach_request_allowed"]);
  for (const [rcStatus, expected] of [[404, 403], [429, 503], [500, 503], [403, 503]]) {
    const f = fixture({ revenue: () => new Response(null, { status: rcStatus }) });
    assert.equal((await f.call()).status, expected);
    assert.ok(!f.calls.some(c => c.op.endsWith("_checked")));
  }
});

test("subscription pagination preserves identity, host and production scope", async () => {
  const f = fixture({ revenue: url => {
    assert.equal(url.searchParams.get("environment"), "production");
    if (url.searchParams.has("starting_after")) return Response.json({ object: "list", items: [subscription(true)] });
    return Response.json({ object: "list", items: [subscription(false)], next_page: "https://another.invalid/path" });
  } });
  assert.equal((await f.call()).status, 200);
});

test("personal Coach writes require a generation and propagate server consent denial", async () => {
  const missing = fixture();
  assert.equal((await missing.call("coach_join", { p_code: "ABC234" })).status, 400);
  assert.equal((await missing.call("coach_assign", { p_client: trainer, p_plan: {} })).status, 400);
  assert.deepEqual(missing.calls, []);
  const denied = fixture({ databaseError: { code: "42501", message: "Cloud consent required" } });
  assert.equal((await denied.call("coach_join", { p_code: "ABC234", p_generation: generation, p_sharing_version: "2026-11-02" })).status, 403);
  assert.equal(denied.calls.at(-1).args.p_generation, generation);
  const allowed = fixture();
  assert.equal((await allowed.call("coach_assign", { p_client: trainer, p_plan: {}, p_generation: generation })).status, 200);
  assert.equal(allowed.calls.at(-1).args.p_generation, generation);
});

test("server moderation errors reach Coach clients without bypassing store or identity checks", async () => {
  for (const message of ["This text cannot be shared. Edit the name, notes or other text and try again.",
    "This connection is unavailable.", "Sharing is suspended for this account. Contact Iron Atlas support."]) {
    const f = fixture({ databaseError: { code: "P0001", message } });
    const response = await f.call("coach_assign", { p_client: trainer, p_plan: { n: "Training" }, p_generation: generation });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { message });
    assert.equal(f.calls.at(-1).args.p_actor, actor);
    assert.ok(f.calls.some(call => call.op === "subscriptions"));
  }
});
