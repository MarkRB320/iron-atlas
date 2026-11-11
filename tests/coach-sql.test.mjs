import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("Supabase schema upgrade and Coach access boundaries in PostgreSQL", async t => {
  const db = await PGlite.create();
  t.after(() => db.close());
  const schema = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
  const trainer = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const client = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const other = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
  const generations = new Map();
  let generation;
  const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  async function role(name, actor = "") {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [actor]);
    generation = generations.get(actor);
    await db.exec("set role " + name); // fixed role names used only in this fixture
  }
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    grant usage on schema auth, storage, public to anon, authenticated, service_role;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      'select nullif(current_setting(''request.jwt.claim.sub'',true), '''')::uuid';
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant select, insert, update, delete on storage.objects to authenticated;
    create function storage.foldername(text) returns text[] language sql immutable as
      'select string_to_array($1, ''/'')';
    create function storage.allow_any_operation(text[]) returns boolean language sql stable as
      'select current_setting(''test.storage_operation'',true) = any($1)';
    select set_config('test.storage_operation','object.upload',false);
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    create function public.coach_setup(text) returns void language sql as 'select';
    create function public.coach_join(text,text) returns void language sql as 'select';
    create function public.coach_assign(uuid,jsonb) returns void language sql as 'select';
    create function public.coach_clients() returns void language sql as 'select';
  `);
  await db.exec(schema);
  await db.query("insert into auth.users values ($1), ($2), ($3)", [trainer, client, other]);
  for (const id of [client, other]) {
    await role("authenticated", id);
    generations.set(id, (await scalar("select public.grant_cloud_consent('2026-11-02',null)")).generation);
  }
  await role("service_role");
  const setup = await scalar("select public.coach_setup_checked($1,'Trainer')", [trainer]);
  await db.exec("reset role");
  await db.exec(schema); // Reapplying retains the account, trainer profile and code.
  for (const proc of ["coach_setup(text)", "coach_join(text,text)", "coach_assign(uuid,jsonb)", "coach_clients()"]) {
    assert.equal(await scalar("select to_regprocedure($1)", [proc]), null);
  }
  for (const grantee of ["anon", "authenticated"]) {
    for (const proc of ["coach_setup_checked(uuid,text)", "coach_assign_checked(uuid,uuid,jsonb,uuid)", "coach_clients_checked(uuid)",
      "coach_join_target(text)", "coach_join_checked(uuid,uuid,text,text,uuid,text)", "coach_request_allowed(uuid)"]) {
      assert.equal(await scalar("select has_function_privilege($1,$2,'execute')", [grantee, proc]), false, grantee + " " + proc);
    }
    for (const table of ["coaches", "coach_clients", "assigned_plans", "client_summaries", "coach_request_limits"]) {
      assert.equal(await scalar("select has_table_privilege($1,$2,'select,insert,update,delete,truncate')", [grantee, table]), false, table);
    }
  }
  await role("authenticated", client);
  await assert.rejects(db.query("select public.coach_setup_checked($1,'forged')", [trainer]), /permission denied/);
  await assert.rejects(db.query("insert into public.coaches(id,name,code) values ($1,'Forged','ABCDEF')", [client]), /permission denied/);
  await role("service_role");
  assert.equal(await scalar("select public.coach_join_target($1)", [setup.code]), trainer);
  await assert.rejects(db.query("select public.coach_join_checked($1,$2,$3,'Test',$4,'2026-11-02')", [client, other, setup.code, generations.get(client)]), /No trainer/);
  assert.deepEqual(await scalar("select public.coach_join_checked($1,$2,$3,'Test',$4,'2026-11-02')", [client, trainer, setup.code, generations.get(client)]), { name: "Trainer" });
  await role("authenticated", client);
  await db.query("select public.summary_put($1,$2)", [JSON.stringify({ streak: 2 }), generation]);
  await role("service_role");
  assert.equal((await scalar("select public.coach_clients_checked($1)", [trainer]))[0].summary.streak, 2);
  assert.deepEqual(await scalar("select public.coach_clients_checked($1)", [other]), []);
  await assert.rejects(db.query("select public.coach_assign_checked($1,$2,'{}',$3)", [other, client, generations.get(client)]), /not your client/);
  await db.query("select public.coach_assign_checked($1,$2,'{\"name\":\"Training\"}',$3)", [trainer, client, generations.get(client)]);
  for (let i = 0; i < 20; i++) assert.equal(await scalar("select public.coach_request_allowed($1)", [client]), true);
  assert.equal(await scalar("select public.coach_request_allowed($1)", [client]), false);
  await role("authenticated", client);
  const pending = await scalar("select public.assigned_pending($1)", [generation]);
  assert.equal(pending[0].plan.name, "Training");
  assert.equal(pending[0].recipient, client);
  assert.deepEqual(await scalar("select public.assigned_pending($1)", [generation]), pending);
  await role("authenticated", other);
  await db.query("select public.assigned_ack($1,$2)", [[pending[0].id], generation]);
  await role("authenticated", client);
  assert.deepEqual(await scalar("select public.assigned_pending($1)", [generation]), pending);
  await db.query("select public.assigned_ack($1,$2)", [[pending[0].id], generation]);
  await db.query("select public.assigned_ack($1,$2)", [[pending[0].id], generation]);
  assert.deepEqual(await scalar("select public.assigned_pending($1)", [generation]), []);
  await role("service_role");
  await db.query("select public.coach_assign_checked($1,$2,'{\"name\":\"Legacy client\"}',$3)", [trainer, client, generations.get(client)]);
  await role("authenticated", client);
  await assert.rejects(db.exec("select public.assigned_take()"), /does not exist/);
  await db.query("select public.coach_leave($1)", [generation]);
  await role("service_role");
  assert.deepEqual(await scalar("select public.coach_clients_checked($1)", [trainer]), []);

  await role("authenticated", client);
  await db.query("insert into public.shared_plans(code, plan, consent_generation, sharing_notice_version) values ('PLAN23', '{}', $1, '2026-11-02')", [generation]);
  await db.query("select public.commit_app_state('{\"main\":null}', '{\"main\":{}}',$1)", [generation]);
  await db.query("insert into storage.objects values ('progress-photos', $1)", [client + "/" + generation + "/photo.jpg"]);
  await assert.rejects(db.query("select public.delete_my_account($1)", [generation]), /photos still need/);
  await db.exec("select set_config('test.storage_operation','object.delete_many',false)");
  await db.exec("reset role"); // Model successful service-side Storage HTTP removal.
  await db.query("delete from storage.objects where bucket_id='progress-photos' and name=$1", [client + "/" + generation + "/photo.jpg"]);
  await role("authenticated", client);
  await db.query("select public.delete_my_account($1)", [generation]);
  await assert.rejects(db.query("insert into storage.objects values ('progress-photos', $1)", [client + "/stale.jpg"]), /row-level security/);
  await db.exec("reset role");
  assert.equal(await scalar("select count(*)::int from public.shared_plans"), 0);
  assert.equal(await scalar("select count(*)::int from public.app_state"), 0);
  assert.equal(await scalar("select count(*)::int from public.coach_request_limits"), 0);
  assert.equal(await scalar("select count(*)::int from auth.users where id=$1", [client]), 0);
});
