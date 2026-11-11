import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("cloud consent gates every personal route and withdrawal is recoverable", async t => {
  const db = await PGlite.create();
  t.after(() => db.close());
  const schema = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
  const a = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const legacy = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
  const fake = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
  const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  const status = () => scalar("select public.cloud_consent_status()");
  const grant = generation => scalar("select public.grant_cloud_consent('2026-11-02',$1)", [generation]);
  const begin = generation => scalar("select public.begin_cloud_withdrawal($1)", [generation]);
  const finish = generation => scalar("select public.finish_cloud_withdrawal($1)", [generation]);
  const commit = (generation, data = { main: {} }) => scalar("select public.commit_app_state($1,$2,$3)",
    [JSON.stringify(Object.fromEntries(Object.keys(data).map(key => [key, null]))), JSON.stringify(data), generation]);
  async function role(name, actor = "") {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    await db.exec("set role " + name);
  }
  const operation = name => db.query("select set_config('test.storage_operation',$1,false)", [name]);
  const photo = path => db.query("insert into storage.objects values ('progress-photos',$1)", [path]);
  async function removePhotos(generation) {
    const actor = await scalar("select auth.uid()");
    await operation("object.list");
    const names = (await db.query("select name from storage.objects")).rows.map(row => row.name);
    const current = await status();
    const purpose = current.cleanup_pending ? "withdrawal" : "photo";
    const authorized = await scalar("select public.authorize_photo_removal($1,$2,$3)", [generation, purpose, names]);
    await db.exec("delete from storage.objects");
    assert.equal((await db.query("select name from storage.objects")).rows.length, names.length, "direct DELETE denied");
    await db.exec("reset role"); // Model the Edge Function's successful Storage HTTP removal.
    await db.query("delete from storage.objects where name = any($1)", [authorized.names]);
    if (authorized.operation) await scalar("select public.complete_photo_removal($1,$2)", [actor, authorized.operation]);
    await role("authenticated", actor);
  }
  const share = (code, generation) => db.query("insert into public.shared_plans(code,plan,consent_generation,sharing_notice_version) values ($1,'{}',$2,'2026-11-02')", [code, generation]);
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
      'select string_to_array($1,''/'')';
    -- The hosted Storage API sets its operation. This local fixture models the documented helper.
    create function storage.allow_any_operation(text[]) returns boolean language sql stable as
      'select current_setting(''test.storage_operation'',true) = any($1)';
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  await db.exec(schema);
  await db.query("insert into auth.users values ($1),($2),($3)", [a, b, legacy]);
  await db.query("insert into public.app_state(user_id,key,data) values ($1,'main','{\"keep\":true}')", [legacy]);
  await photo(legacy + "/old.jpg");
  await db.exec(schema);
  let ca, cb, trainerA, trainerB;

  await t.test("new and legacy accounts default off; receipts and old routes cannot be forged", async () => {
    await role("authenticated", a);
    assert.deepEqual(await status(), { enabled: false, version: "2026-11-02", generation: null,
      cleanup_pending: false, granted_at: null, withdrawn_at: null });
    await assert.rejects(commit(fake), /Cloud consent/);
    await assert.rejects(share("AAAAAA", fake), /Cloud consent/);
    await operation("object.upload");
    await assert.rejects(photo(a + "/" + fake + "/photo.jpg"), /row-level security/);
    for (const table of ["cloud_consent", "cloud_consent_receipts", "photo_removal_intents"]) {
      assert.equal(await scalar("select has_table_privilege('authenticated',$1,'select,insert,update,delete,truncate')", [table]), false);
    }
    for (const signature of ["commit_app_state(jsonb,jsonb)", "summary_put(jsonb)", "assigned_take()",
      "assigned_pending()", "assigned_ack(text[])", "coach_join(text,text)", "coach_assign(uuid,jsonb)",
      "coach_join_checked(uuid,uuid,text,text)", "coach_assign_checked(uuid,uuid,jsonb)",
      "delete_my_account()", "coach_leave()", "coach_remove(uuid)"]) {
      assert.equal(await scalar("select to_regprocedure($1)", [signature]), null, signature);
    }
    await role("authenticated", legacy);
    const old = await status();
    assert.equal(old.enabled, false);
    assert.equal(old.cleanup_pending, true);
    assert.equal(old.granted_at, null);
    assert.equal(old.withdrawn_at, null);
    await assert.rejects(grant(old.generation), /Finish cloud removal/);
    assert.deepEqual(await scalar("select data from public.app_state"), { keep: true });
  });

  await t.test("only explicit current-version grant enables generation-bound writes", async () => {
    await role("authenticated", a);
    await assert.rejects(scalar("select public.grant_cloud_consent('old',null)"), /Refresh the consent notice/);
    ca = await grant(null);
    assert.equal(ca.enabled, true);
    assert.ok(ca.granted_at);
    assert.deepEqual(await grant(ca.generation), ca);
    await assert.rejects(grant(null), /Consent changed/);
    assert.deepEqual(await commit(ca.generation, { main: { measurements: [70] } }), { applied: true });
    await operation("object.upload");
    await photo(a + "/" + ca.generation + "/photo.jpg");
    await assert.rejects(photo(a + "/legacy.jpg"), /row-level security/);
    await assert.rejects(photo(b + "/" + ca.generation + "/photo.jpg"), /row-level security/);
    await operation("object.get_authenticated");
    assert.equal(await scalar("select count(*)::int from storage.objects"), 1);
    for (const op of ["object.sign", "object.sign_many", "object.sign_upload_url", "s3.object.get", ""]) {
      await operation(op);
      assert.equal(await scalar("select count(*)::int from storage.objects"), 0, op);
    }
    await role("authenticated", b);
    cb = await grant(null);
    await commit(cb.generation, { main: { sentinel: true } });
    await share("BBBBBB", cb.generation);
    await role("service_role");
    trainerA = await scalar("select public.coach_setup_checked($1,'A')", [a]);
    trainerB = await scalar("select public.coach_setup_checked($1,'B')", [b]);
    await scalar("select public.coach_join_checked($1,$2,$3,'A',$4,'2026-11-02')", [a, b, trainerB.code, ca.generation]);
    await scalar("select public.coach_join_checked($1,$2,$3,'B',$4,'2026-11-02')", [b, a, trainerA.code, cb.generation]);
    await scalar("select public.coach_assign_checked($1,$2,'{}',$3)", [b, a, ca.generation]);
    await scalar("select public.coach_assign_checked($1,$2,'{}',$3)", [a, b, cb.generation]);
    await role("authenticated", a);
    await scalar("select public.summary_put('{\"weight\":70}',$1)", [ca.generation]);
    await share("AAAAAA", ca.generation);
    await role("anon");
    assert.equal((await scalar("select public.get_shared_plan('AAAAAA')"))._source.author, a);
    await assert.rejects(status(), /permission denied/);
  });

  await t.test("sharing has a separate server-timed notice receipt and legacy sharing stays hidden", async () => {
    await db.exec("reset role");
    await db.query("update public.coach_clients set sharing_notice_version=null, sharing_acknowledged_at=null where client_id=$1", [a]);
    await db.query("update public.shared_plans set sharing_notice_version=null, sharing_acknowledged_at=null where owner=$1", [a]);
    await role("service_role");
    assert.deepEqual(await scalar("select public.coach_clients_checked($1)", [b]), []);
    await assert.rejects(scalar("select public.coach_assign_checked($1,$2,'{}',$3)", [b, a, ca.generation]), /not your client/);
    await assert.rejects(scalar("select public.coach_join_checked($1,$2,$3,'A',$4,'old')", [a, b, trainerB.code, ca.generation]), /sharing notice/);
    await role("anon");
    assert.equal(await scalar("select public.get_shared_plan('AAAAAA')"), null);
    await role("authenticated", a);
    await assert.rejects(db.query("insert into public.shared_plans(code,plan,consent_generation) values ('NOACK1','{}',$1)", [ca.generation]), /sharing notice/);
    await db.query("insert into public.shared_plans(code,plan,consent_generation,sharing_notice_version,sharing_acknowledged_at) values ('NEWACK','{}',$1,'2026-11-02','1900-01-01')", [ca.generation]);
    assert.ok(await scalar("select sharing_acknowledged_at > '2000-01-01' from public.shared_plans where code='NEWACK'"));
    await role("service_role");
    await scalar("select public.coach_join_checked($1,$2,$3,'A',$4,'2026-11-02')", [a, b, trainerB.code, ca.generation]);
    const receipt = await scalar("select sharing_acknowledged_at from public.coach_clients where client_id=$1", [a]);
    assert.ok(receipt);
    await scalar("select public.coach_join_checked($1,$2,$3,'A',$4,'2026-11-02')", [a, b, trainerB.code, ca.generation]);
    assert.deepEqual(await scalar("select sharing_acknowledged_at from public.coach_clients where client_id=$1", [a]), receipt);
    assert.equal((await scalar("select public.coach_clients_checked($1)", [b])).length, 1);
  });

  await t.test("begin freezes the recoverable copy and revokes personal sharing, retaining trainer work", async () => {
    await role("authenticated", a);
    await operation("object.upload");
    const queuedPath = a + "/" + ca.generation + "/queued.jpg";
    await photo(queuedPath);
    const intent = await scalar("select public.authorize_photo_removal($1,'photo',$2)", [ca.generation, [queuedPath]]);
    await assert.rejects(begin(ca.generation), /Photo removal is in progress/);
    await assert.rejects(scalar("select public.complete_photo_removal($1,$2)", [a, intent.operation]), /permission denied/);
    await role("service_role");
    await assert.rejects(scalar("select public.complete_photo_removal($1,$2)", [a, intent.operation]), /incomplete/);
    await db.exec("reset role");
    await db.query("delete from storage.objects where name=$1", [queuedPath]);
    await scalar("select public.complete_photo_removal($1,$2)", [a, intent.operation]);
    await role("authenticated", a);
    await assert.rejects(photo(queuedPath), /row-level security/); // Late duplicate HTTP cannot erase a replacement.
    const withdrawn = await begin(ca.generation);
    assert.equal(withdrawn.enabled, false);
    assert.equal(withdrawn.cleanup_pending, true);
    assert.equal(withdrawn.granted_at, ca.granted_at);
    assert.ok(withdrawn.withdrawn_at);
    assert.deepEqual(await begin(ca.generation), withdrawn);
    assert.deepEqual(await scalar("select data from public.app_state"), { measurements: [70] });
    await operation("object.get_authenticated");
    assert.equal(await scalar("select count(*)::int from storage.objects"), 1);
    await assert.rejects(scalar("select public.authorize_photo_removal($1,'photo',$2)",
      [ca.generation, [a + "/" + ca.generation + "/photo.jpg"]]), /phase changed/);
    await assert.rejects(scalar("select public.wipe_app_state($1)", [ca.generation]), /Cloud consent/);
    await assert.rejects(commit(ca.generation), /Cloud consent/);
    await assert.rejects(share("AAAAAA", ca.generation), /Cloud consent/);
    await assert.rejects(scalar("select public.summary_put('{}',$1)", [ca.generation]), /Cloud consent/);
    await assert.rejects(scalar("select public.assigned_pending($1)", [ca.generation]), /Cloud consent/);
    await operation("object.upload");
    await assert.rejects(photo(a + "/" + ca.generation + "/stale.jpg"), /row-level security/);
    await assert.rejects(grant(ca.generation), /Finish cloud removal/);
    await assert.rejects(finish(ca.generation), /photos still need/);
    await role("service_role");
    await assert.rejects(scalar("select public.coach_join_checked($1,$2,$3,'A',$4,'2026-11-02')", [a, b, trainerB.code, ca.generation]), /Cloud consent/);
    await assert.rejects(scalar("select public.coach_assign_checked($1,$2,'{}',$3)", [b, a, ca.generation]), /Cloud consent/);
    assert.deepEqual(await scalar("select public.coach_clients_checked($1)", [b]), []);
    assert.equal((await scalar("select public.coach_clients_checked($1)", [a]))[0].generation, cb.generation);
    await scalar("select public.coach_assign_checked($1,$2,'{}',$3)", [a, b, cb.generation]);
    assert.equal(await scalar("select count(*)::int from public.coaches where id=$1", [a]), 1);
    assert.equal(await scalar("select count(*)::int from public.assigned_plans where client_id=$1", [a]), 0);
    assert.equal(await scalar("select count(*)::int from public.assigned_plans where client_id=$1", [b]), 2);
    assert.equal(await scalar("select count(*)::int from public.client_summaries where user_id=$1", [a]), 0);
    await role("anon");
    assert.equal(await scalar("select public.get_shared_plan('AAAAAA')"), null);
    assert.equal((await scalar("select public.get_shared_plan('BBBBBB')"))._source.author, b);
  });

  await t.test("finish requires actual photo removal, is idempotent and new consent rejects all stale generations", async () => {
    await role("authenticated", a);
    await removePhotos(ca.generation);
    const done = await finish(ca.generation);
    assert.equal(done.cleanup_pending, false);
    assert.equal(done.enabled, false);
    assert.deepEqual(await finish(ca.generation), done);
    assert.deepEqual(await begin(ca.generation), done);
    assert.equal(await scalar("select count(*)::int from public.app_state"), 0);
    await role("service_role");
    assert.deepEqual((await db.query("select action from public.cloud_consent_receipts where user_id=$1 order by id", [a])).rows,
      [{ action: "grant" }, { action: "withdraw" }, { action: "cleanup" }]);
    await db.exec("reset role");
    assert.equal(await scalar("select count(*)::int from auth.users where id=$1", [a]), 1);
    await role("authenticated", a);
    const fresh = await grant(ca.generation);
    assert.notEqual(fresh.generation, ca.generation);
    assert.equal(await scalar("select count(*)::int from public.app_state"), 0);
    await assert.rejects(begin(ca.generation), /Consent changed/);
    await assert.rejects(finish(ca.generation), /Consent changed/);
    await assert.rejects(commit(ca.generation), /Cloud consent/);
    await assert.rejects(share("AAAAAA", ca.generation), /Cloud consent/);
    await assert.rejects(scalar("select public.wipe_app_state($1)", [ca.generation]), /Cloud consent/);
    await assert.rejects(scalar("select public.delete_my_account($1)", [ca.generation]), /Consent changed/);
    await assert.rejects(scalar("select public.coach_leave($1)", [ca.generation]), /Consent changed/);
    await assert.rejects(db.exec("delete from public.app_state"), /permission denied/);
    await assert.rejects(db.exec("delete from public.shared_plans"), /permission denied/);
    await operation("object.upload");
    await assert.rejects(photo(a + "/" + ca.generation + "/late.jpg"), /row-level security/);
    const freshPath = a + "/" + fresh.generation + "/photo.jpg";
    await photo(freshPath);
    await assert.rejects(scalar("select public.authorize_photo_removal($1,'photo',$2)", [ca.generation, [freshPath]]), /Consent changed/);
    await assert.rejects(scalar("select public.authorize_photo_removal($1,'photo',$2)", [fresh.generation, [b + "/anything.jpg"]]), /Invalid photo/);
    await removePhotos(fresh.generation);
    assert.deepEqual(await commit(fresh.generation), { applied: true });
    await role("service_role");
    await scalar("select public.coach_join_checked($1,$2,$3,'A',$4,'2026-11-02')", [a, b, trainerB.code, fresh.generation]);
    await role("authenticated", b);
    await assert.rejects(scalar("select public.coach_remove($1,$2)", [a, ca.generation]), /Consent changed/);
    assert.deepEqual(await scalar("select data from public.app_state"), { sentinel: true });
    ca = fresh;
  });

  await t.test("legacy removal, complete account deletion and stale bearer identity stay safe", async () => {
    await role("authenticated", legacy);
    const old = await status();
    await begin(old.generation);
    await operation("object.list");
    assert.equal(await scalar("select count(*)::int from storage.objects"), 1);
    await removePhotos(old.generation);
    await finish(old.generation);
    const fresh = await grant(old.generation);
    assert.equal(fresh.enabled, true);
    assert.equal(await scalar("select count(*)::int from public.app_state"), 0);
    await role("authenticated", a);
    await scalar("select public.delete_my_account($1)", [ca.generation]);
    await assert.rejects(status(), /Account unavailable/);
    await assert.rejects(commit(ca.generation), /Account unavailable/);
    await assert.rejects(grant(ca.generation), /Account unavailable/);
    await operation("object.upload");
    await assert.rejects(photo(a + "/" + ca.generation + "/stale.jpg"), /row-level security/);
    await role("service_role");
    assert.equal(await scalar("select count(*)::int from public.cloud_consent_receipts where user_id=$1", [a]), 0);
    assert.equal(await scalar("select count(*)::int from public.cloud_consent where user_id=$1", [a]), 0);
  });

  await t.test("independent full account deletion needs no backup opt-in, including legacy photos", async () => {
    const empty = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
    const old = "ffffffff-ffff-4fff-ffff-ffffffffffff";
    await db.exec("reset role");
    await db.query("insert into auth.users values ($1),($2)", [empty, old]);
    await photo(old + "/legacy.jpg");
    await db.exec(schema);
    await role("authenticated", empty);
    assert.equal((await status()).generation, null);
    await scalar("select public.delete_my_account(null)");
    await role("authenticated", old);
    const pending = await status();
    assert.equal(pending.granted_at, null);
    const removal = await scalar("select public.authorize_photo_removal($1,'account',$2)", [pending.generation, [old + "/legacy.jpg"]]);
    await db.exec("reset role");
    await db.query("delete from storage.objects where name=any($1)", [removal.names]);
    await scalar("select public.complete_photo_removal($1,$2)", [old, removal.operation]);
    await role("authenticated", old);
    await scalar("select public.delete_my_account($1)", [pending.generation]);
    await db.exec("reset role");
    assert.equal(await scalar("select count(*)::int from auth.users where id=any($1)", [[empty, old]]), 0);
  });

  await t.test("provider erasure survives Auth deletion and only the current service lease can complete it", async () => {
    const unbound = "77777777-7777-4777-8777-777777777777";
    const bound = "88888888-8888-4888-8888-888888888888";
    await db.exec("reset role");
    await db.query("insert into auth.users values ($1),($2)", [unbound, bound]);
    await role("authenticated", unbound);
    assert.deepEqual(await scalar("select public.delete_my_account(null)"), { deleted: true, subscription_erasure_queued: false });
    await db.exec("reset role");
    await db.exec("insert into public.account_erasure_settings(singleton,enabled,project_id) values (true,true,'proj_fixture')");
    await role("authenticated", bound);
    for (const table of ["account_erasure_settings", "account_erasure_jobs"]) {
      assert.equal(await scalar("select has_table_privilege('authenticated',$1,'select,insert,update,delete,truncate')", [table]), false);
    }
    await assert.rejects(scalar("select public.claim_account_erasures()"), /permission denied/);
    assert.deepEqual(await scalar("select public.delete_my_account(null)"), { deleted: true, subscription_erasure_queued: true });
    await assert.rejects(scalar("select public.delete_my_account(null)"), /Not signed in/);
    await db.exec("reset role");
    assert.equal(await scalar("select count(*)::int from auth.users where id=$1", [bound]), 0);
    assert.equal(await scalar("select count(*)::int from public.account_erasure_jobs where customer_id=$1", [bound]), 1);
    await role("service_role");
    await assert.rejects(scalar("select public.claim_account_erasures(11,120)"), /claim bounds/);
    const first = (await scalar("select public.claim_account_erasures(5,120)"))[0];
    assert.equal(first.customer_id, bound);
    assert.equal(first.project_id, "proj_fixture");
    assert.deepEqual(await scalar("select public.claim_account_erasures(5,120)"), []);
    assert.equal(await scalar("select public.complete_account_erasure($1,$2)", [first.id, fake]), false);
    await db.exec("reset role");
    await db.query("update public.account_erasure_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [first.id]);
    await role("service_role");
    const second = (await scalar("select public.claim_account_erasures(5,120)"))[0];
    assert.notEqual(second.lease_token, first.lease_token);
    assert.equal(await scalar("select public.complete_account_erasure($1,$2)", [first.id, first.lease_token]), false);
    await assert.rejects(scalar("select public.defer_account_erasure($1,$2,'arbitrary detail',60)", [second.id, second.lease_token]), /Invalid erasure retry/);
    assert.equal(await scalar("select public.defer_account_erasure($1,$2,'verification_pending',60)", [second.id, second.lease_token]), true);
    assert.deepEqual(await scalar("select public.claim_account_erasures(5,120)"), []);
    await db.exec("reset role");
    await db.query("update public.account_erasure_jobs set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1", [first.id]);
    await db.exec("update public.account_erasure_settings set project_id='proj_future'");
    await role("service_role");
    const third = (await scalar("select public.claim_account_erasures(5,120)"))[0];
    assert.equal(third.project_id, "proj_fixture", "queued identity never changes when settings change");
    assert.equal(await scalar("select public.complete_account_erasure($1,$2)", [third.id, third.lease_token]), true);
    const done = (await db.query("select customer_id,status,attempts,last_error_code,lease_token from public.account_erasure_jobs where id=$1", [third.id])).rows[0];
    assert.deepEqual(done, { customer_id: null, status: "complete", attempts: 3, last_error_code: null, lease_token: null });
    assert.deepEqual(await scalar("select public.claim_account_erasures(5,120)"), []);
  });

  await t.test("worker invocation hashes are private, expiring and consumed exactly once", async () => {
    const live = "a".repeat(64), expired = "b".repeat(64), absent = "c".repeat(64);
    await db.exec("reset role");
    await db.query("insert into iron_atlas_private.account_erasure_invocations values ($1,clock_timestamp()+interval '120 seconds'),($2,clock_timestamp()-interval '1 second')", [live, expired]);
    for (const name of ["anon", "authenticated", "service_role"]) {
      assert.equal(await scalar("select has_table_privilege($1,'iron_atlas_private.account_erasure_invocations','select,insert,update,delete,truncate')", [name]), false);
    }
    await role("authenticated", b);
    await assert.rejects(scalar("select public.consume_account_erasure_invocation($1)", [live]), /permission denied/);
    await role("service_role");
    assert.equal(await scalar("select public.consume_account_erasure_invocation($1)", [expired]), false);
    assert.equal(await scalar("select public.consume_account_erasure_invocation($1)", [absent]), false);
    assert.equal(await scalar("select public.consume_account_erasure_invocation('invalid')"), false);
    assert.deepEqual(await Promise.all([
      scalar("select public.consume_account_erasure_invocation($1)", [live]),
      scalar("select public.consume_account_erasure_invocation($1)", [live]),
    ]), [true, false]);
    await db.exec("reset role");
    assert.equal(await scalar("select count(*)::int from iron_atlas_private.account_erasure_invocations where token_hash=$1", [live]), 0);
    // PGlite serializes connections; hosted concurrency still tests the actual network race.
  });
});
