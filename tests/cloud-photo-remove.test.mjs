import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../supabase/functions/cloud-photo-remove/handler.mjs";

const user = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const generation = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const own = user + "/" + generation + "/photo.jpg";
const config = { supabaseUrl: "https://project.invalid", publicKey: "sb_publishable_fixture", serviceKey: "sb_secret_fixture" };
function fixture(options = {}) {
  const calls = [];
  let completed = false;
  const handler = createHandler(config, async (input, init) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, body });
    assert.equal(url.origin, config.supabaseUrl);
    if (url.pathname === "/auth/v1/user") {
      assert.equal(init.headers.Authorization, "Bearer fixture");
      return Response.json({ id: user }, { status: options.authStatus || 200 });
    }
    if (url.pathname === "/rest/v1/rpc/authorize_photo_removal") {
      assert.equal(init.headers.Authorization, "Bearer fixture");
      assert.equal(init.headers.apikey, config.publicKey);
      if (options.denied) return Response.json({ code: "42501" }, { status: 403 });
      const names = completed ? [] : (options.authorized ?? body.p_names);
      return Response.json({ operation: names.length ? generation : null, names });
    }
    if (url.pathname === "/rest/v1/rpc/complete_photo_removal") {
      assert.equal(init.headers.apikey, config.serviceKey);
      assert.deepEqual(body, { p_actor: user, p_operation: generation });
      completed = true;
      return new Response(null, { status: 204 });
    }
    assert.equal(url.pathname, "/storage/v1/object/progress-photos");
    assert.equal(init.method, "DELETE");
    assert.equal(init.headers.apikey, config.serviceKey);
    assert.equal(init.headers.Authorization, undefined);
    return Response.json({}, { status: options.storageStatus || 200 });
  });
  const call = (body = { generation, purpose: "photo", names: [own] }, token = "Bearer fixture") => handler(new Request("https://edge.invalid", {
    method: "POST", headers: { authorization: token }, body: JSON.stringify(body),
  }));
  return { calls, call };
}

test("photo removal uses authenticated generation authorization and exact existing names", async () => {
  const f = fixture({ authorized: [own] });
  const response = await f.call({ generation, purpose: "photo", names: [own, user + "/missing.jpg"], user_id: "forged" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: 1 });
  assert.deepEqual(f.calls[1].body, { p_generation: generation, p_purpose: "photo", p_names: [own, user + "/missing.jpg"] });
  assert.deepEqual(f.calls[2].body, { prefixes: [own] });
});

test("missing consent remains deletable while invalid identity, generation and paths fail closed", async () => {
  const empty = fixture({ authorized: [] });
  assert.equal((await empty.call({ generation: null, purpose: "account", names: [] })).status, 200);
  assert.equal(empty.calls.length, 2);
  for (const body of [
    { purpose: "photo", names: [own] }, { generation: "bad", purpose: "photo", names: [own] },
    { generation, names: [own] },
    { generation, purpose: "photo", names: [generation + "/foreign.jpg"] },
    { generation, purpose: "photo", names: [user + "/../foreign.jpg"] },
    { generation, purpose: "photo", names: Array(101).fill(own) },
  ]) {
    const f = fixture();
    assert.equal((await f.call(body)).status, 400);
    assert.ok(!f.calls.some(call => call.path.includes("storage")));
  }
  assert.equal((await fixture().call(undefined, "")).status, 401);
  assert.equal((await fixture({ authStatus: 401 }).call()).status, 401);
  assert.equal((await fixture({ denied: true }).call()).status, 403);
});

test("authorization and storage failures preserve a safe retry and never return object paths", async () => {
  const failed = fixture({ storageStatus: 500 });
  const response = await failed.call();
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes(own));
  const retry = fixture({ authorized: [] });
  assert.deepEqual(await (await retry.call()).json(), { removed: 0 });
  const corrupt = fixture({ authorized: [generation + "/foreign.jpg"] });
  assert.equal((await corrupt.call()).status, 503);
  assert.equal(corrupt.calls.length, 2);
});

test("a later consent generation cannot change the exact names already authorized for removal", async () => {
  const f = fixture();
  assert.equal((await f.call()).status, 200);
  const next = user + "/cccccccc-cccc-4ccc-cccc-cccccccccccc/photo.jpg";
  const removed = f.calls.find(call => call.path.includes("/storage/"));
  assert.deepEqual(removed.body.prefixes, [own]);
  assert.ok(!removed.body.prefixes.includes(next));
});

test("resume completes a durable earlier intent without accepting new photo names", async () => {
  const f = fixture({ authorized: [own] });
  assert.deepEqual(await (await f.call({ generation, purpose: "resume", names: [] })).json(), { removed: 1 });
  assert.deepEqual(f.calls.find(call => call.path.includes("/storage/")).body.prefixes, [own]);
});
