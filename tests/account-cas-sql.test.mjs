import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("account document compare-and-swap SQL", async t => {
  const db = await PGlite.create();
  t.after(() => db.close());
  const source = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
  const accountSection = source.slice(0, source.indexOf("-- 2. Progress photos.")) + "\ncommit;";
  const a = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    grant usage on schema auth, public to anon, authenticated;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      'select nullif(current_setting(''request.jwt.claim.sub'',true), '''')::uuid';
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
  `);
  await db.exec(accountSection);
  await db.query("insert into auth.users values ($1), ($2)", [a, b]);
  await db.query("insert into public.app_state values ($1,'main','{\"keep\":1}',now())", [a]);
  await db.exec(accountSection);

  const generations = new Map();
  let generation;
  async function user(id) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    await db.exec("set role authenticated");
    generation = generations.get(id);
    if (!generation) {
      generation = (await db.query("select public.grant_cloud_consent('2026-11-02',null) as result")).rows[0].result.generation;
      generations.set(id, generation);
    }
  }
  async function commit(expected, docs) {
    return (await db.query("select public.commit_app_state($1,$2,$3) as result", [JSON.stringify(expected), JSON.stringify(docs), generation])).rows[0].result;
  }
  const rows = async () => (await db.query("select key,data,updated_at from public.app_state order by key")).rows;

  await t.test("reapplying preserves data and removes legacy direct write grants", async () => {
    assert.equal((await rows())[0].data.keep, 1);
    for (const privilege of ["insert", "update", "delete", "truncate"]) {
      assert.equal((await db.query("select has_table_privilege('authenticated','app_state',$1) as allowed", [privilege])).rows[0].allowed, false);
    }
    assert.equal((await db.query("select has_function_privilege('anon','commit_app_state(jsonb,jsonb,uuid)','execute') as allowed")).rows[0].allowed, false);
    await user(a);
    await assert.rejects(db.exec("update public.app_state set data='{}'"), /permission denied/);
    await assert.rejects(db.query("insert into public.app_state(user_id,key,data) values ($1,'state','{}')", [a]), /permission denied/);
  });

  await t.test("all touched documents are compared and committed atomically", async () => {
    const next = { main: { keep: 2 }, "log-2026q4": { e: [[1, "squat", 3, 10]] } };
    assert.deepEqual(await commit({ main: { keep: 1 }, "log-2026q4": null }, next), { applied: true });
    const before = await rows();
    assert.deepEqual(await commit({ main: { keep: 2 }, "log-2026q4": { e: [] } },
      { main: { keep: 999 }, "log-2026q4": { e: [] } }), { applied: false });
    assert.deepEqual(await rows(), before);
    assert.deepEqual(await commit({ main: { keep: 2 } }, { main: { keep: 3 } }), { applied: true });
    assert.deepEqual((await rows()).find(row => row.key === "log-2026q4").data, next["log-2026q4"]);
  });

  await t.test("queued fresh and existing stale submissions each have one winner", async () => {
    // PGlite uses one connection. This verifies stale-client interleavings;
    // hosted multi-connection contention still needs an HTTP integration check.
    const fresh = await Promise.all([
      commit({ state: null }, { state: { winner: 1 } }),
      commit({ state: null }, { state: { winner: 2 } }),
    ]);
    assert.deepEqual(fresh, [{ applied: true }, { applied: false }]);
    const changes = await Promise.all([
      commit({ state: { winner: 1 } }, { state: { winner: 3 } }),
      commit({ state: { winner: 1 } }, { state: { winner: 4 } }),
    ]);
    assert.deepEqual(changes, [{ applied: true }, { applied: false }]);
    assert.deepEqual((await rows()).find(row => row.key === "state").data, { winner: 3 });
  });

  await t.test("invalid maps, keys and document shapes make no changes", async () => {
    const before = await rows();
    for (const [expected, docs] of [
      [null, {}], [{}, []], [{ main: null }, { state: {} }],
      [{ arbitrary: null }, { arbitrary: {} }],
      [{ "log-2026q5": null }, { "log-2026q5": {} }],
      [{ main: { keep: 3 } }, { main: null }],
      [{ main: "invalid" }, { main: {} }],
    ]) await assert.rejects(commit(expected, docs), /must be objects|keys must match|Invalid account document/);
    assert.deepEqual(await rows(), before);
    assert.deepEqual(await commit({}, {}), { applied: true });
  });

  await t.test("JSONB equality accepts reordered properties and retries cannot overwrite newer data", async () => {
    assert.deepEqual(await commit({ main: { keep: 3 } }, { main: { a: 1, b: 2 } }), { applied: true });
    assert.deepEqual(await commit({ main: { b: 2, a: 1 } }, { main: { a: 2 } }), { applied: true });
    assert.deepEqual(await commit({ main: { b: 2, a: 1 } }, { main: { a: 2 } }), { applied: false });
    assert.deepEqual((await rows()).find(row => row.key === "main").data, { a: 2 });
  });

  await t.test("the owner comes only from auth and a second account is isolated", async () => {
    await user(b);
    assert.deepEqual(await rows(), []);
    assert.deepEqual(await commit({ main: null }, { main: { own: true } }), { applied: true });
    await assert.rejects(db.query("delete from public.app_state where user_id=$1", [a]), /permission denied/);
    await user(a);
    assert.deepEqual((await rows()).find(row => row.key === "main").data, { a: 2 });
    await user(b);
    assert.deepEqual((await rows())[0].data, { own: true });
  });

  await t.test("a wipe conflicts with stale bases and deleted accounts cannot be recreated", async () => {
    await user(a);
    await db.query("select public.wipe_app_state($1)", [generation]);
    assert.deepEqual(await commit({ main: { a: 2 } }, { main: { a: 9 } }), { applied: false });
    assert.deepEqual(await rows(), []);
    await db.exec("reset role");
    await db.query("delete from auth.users where id=$1", [a]);
    await user(a);
    await assert.rejects(commit({ main: null }, { main: {} }), /Account unavailable/);
    assert.deepEqual(await rows(), []);
    await user(b);
    assert.deepEqual((await rows())[0].data, { own: true });
  });
});
