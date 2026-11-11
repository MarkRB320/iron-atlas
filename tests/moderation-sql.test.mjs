import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("cross-user moderation, privacy and account lifecycle in PostgreSQL", async t => {
  const db = await PGlite.create();
  t.after(() => db.close());
  const schema = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
  const a = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const c = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
  const d = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
  const generation = new Map();
  const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  async function role(name, actor = "") {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    await db.exec("set role " + name);
  }
  const report = (kind, reference, reason = "abuse") => scalar("select public.report_content($1,$2,$3)", [kind, reference, reason]);
  const share = (code, owner, plan = { n: "Training", i: [["squat", 3, "10"]] }) => db.query(
    "insert into public.shared_plans(code,plan,consent_generation,sharing_notice_version) values ($1,$2,$3,'2026-11-02')",
    [code, JSON.stringify(plan), generation.get(owner)]);
  const fetchPlan = code => scalar("select public.get_shared_plan($1)", [code]);
  const block = peer => scalar("select public.block_peer($1)", [peer]);
  const unblock = peer => scalar("select public.unblock_peer($1)", [peer]);
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
    create function storage.foldername(text) returns text[] language sql immutable as 'select string_to_array($1,''/'')';
    create function storage.allow_any_operation(text[]) returns boolean language sql stable as 'select false';
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  await db.exec(schema);
  await db.query("insert into auth.users values ($1),($2),($3),($4)", [a, b, c, d]);
  for (const id of [a, b, c, d]) {
    await role("authenticated", id);
    generation.set(id, (await scalar("select public.grant_cloud_consent('2026-11-02',null)")).generation);
  }
  await role("service_role");
  const coach = await scalar("select public.coach_setup_checked($1,'Trainer')", [a]);
  const join = () => scalar("select public.coach_join_checked($1,$2,$3,'Member',$4,'2026-11-02')", [b, a, coach.code, generation.get(b)]);
  const assign = plan => scalar("select public.coach_assign_checked($1,$2,$3,$4)", [a, b, JSON.stringify(plan), generation.get(b)]);
  await join();

  await t.test("all shared text is checked through RPC and direct writes; private documents are preserved", async () => {
    await assert.rejects(scalar("select public.coach_setup_checked($1,'fUcK')", [a]), /text cannot be shared/);
    await assert.rejects(scalar("select public.coach_join_checked($1,$2,$3,'sh1t',$4,'2026-11-02')", [c, a, coach.code, generation.get(c)]), /text cannot be shared/);
    await assert.rejects(assign({ n: "Training", no: "kill yourself" }), /text cannot be shared/);
    await role("authenticated", b);
    await assert.rejects(scalar("select public.summary_put($1,$2)", [JSON.stringify({ nested: { name: "f\u200buck" } }), generation.get(b)]), /text cannot be shared/);
    await role("authenticated", a);
    await assert.rejects(share("FILTER", a, { n: "Training", i: [["squat", 3, "fuck"]] }), /text cannot be shared/);
    await share("PLANAA", a, { n: "Training", no: "Use a controlled tempo", _source: { author: b } });
    assert.deepEqual(await scalar("select public.commit_app_state($1,$2,$3)", [JSON.stringify({ main: null }), JSON.stringify({ main: { privateNote: "fuck" } }), generation.get(a)]), { applied: true });
    await role("service_role");
    await assert.rejects(db.query("insert into public.assigned_plans(coach_id,client_id,plan) values ($1,$2,$3)", [a, b, JSON.stringify({ n: "fuck" })]), /text cannot be shared/);
    await assert.rejects(db.query("update public.coaches set name='fuck' where id=$1", [a]), /text cannot be shared/);
  });

  let source, assigned, sharedReport;
  await t.test("server provenance and identity receipts allow reporting after acknowledgement", async () => {
    await role("authenticated", b);
    source = (await fetchPlan("PLANAA"))._source;
    assert.equal(source.author, a);
    assert.match(source.reference, /^[a-f0-9-]{36}$/);
    assert.equal((await scalar("select public.coach_status()")).coach.id, a);
    await role("service_role");
    await assign({ n: "Tempo", no: "Rest between sets" });
    await role("authenticated", b);
    assigned = (await scalar("select public.assigned_pending($1)", [generation.get(b)]))[0];
    assert.equal(assigned.author, a);
    await scalar("select public.assigned_ack($1,$2)", [[assigned.id], generation.get(b)]);
    assert.equal((await report("assigned_plan", assigned.id)).status, "open");
    sharedReport = await report("shared_plan", source.reference);
    assert.deepEqual(await report("shared_plan", source.reference), sharedReport);
    await assert.rejects(report("peer", d), /unavailable for reporting/);
    await assert.rejects(report("shared_plan", source.reference, "invented"), /report reason/);
  });

  await t.test("persistent blocks apply in both directions and an unblock never reconnects", async () => {
    await role("service_role");
    await assign({ n: "Queued before the block" });
    await role("authenticated", b);
    await share("PLANBB", b);
    assert.deepEqual(await block(a), { blocked: true });
    assert.deepEqual(await block(a), { blocked: true });
    assert.equal((await scalar("select public.coach_status()")).coach, null);
    assert.deepEqual(await scalar("select public.assigned_pending($1)", [generation.get(b)]), []);
    assert.equal(await fetchPlan("PLANAA"), null);
    await role("authenticated", a);
    assert.equal(await fetchPlan("PLANBB"), null);
    await role("service_role");
    await assert.rejects(join(), /connection is unavailable/);
    await assert.rejects(assign({ n: "Training" }), /not your client/);
    await assert.rejects(db.query("insert into public.assigned_plans(coach_id,client_id,plan) values ($1,$2,'{}')", [a, b]), /connection is unavailable/);
    assert.deepEqual(await scalar("select public.coach_clients_checked($1)", [a]), []);
    await role("anon");
    assert.equal((await fetchPlan("PLANAA"))._source.author, a, "anonymous lookup can only apply global moderation");
    await role("authenticated", a);
    await block(b);
    await role("authenticated", b);
    await unblock(a);
    await role("service_role");
    await assert.rejects(join(), /connection is unavailable/);
    await role("authenticated", a);
    await unblock(b);
    await role("authenticated", b);
    assert.equal((await scalar("select public.coach_status()")).coach, null);
    await role("service_role");
    await join();
  });

  await t.test("legacy objectionable records are hidden at delivery without altering the personal copy", async () => {
    await role("service_role");
    await assign({ n: "Old training" });
    await db.exec("reset role");
    await db.exec("alter table public.assigned_plans disable trigger check_cross_user_content");
    await db.query("update public.assigned_plans set plan='{\"n\":\"fuck\"}' where client_id=$1", [b]);
    await db.exec("alter table public.assigned_plans enable trigger check_cross_user_content");
    await role("authenticated", b);
    assert.deepEqual(await scalar("select public.assigned_pending($1)", [generation.get(b)]), []);
    await db.exec("reset role");
    await db.exec("alter table public.shared_plans disable trigger stamp_plan_sharing");
    await db.exec("update public.shared_plans set plan='{\"n\":\"fuck\"}' where code='PLANBB'");
    await db.exec("alter table public.shared_plans enable trigger stamp_plan_sharing");
    await role("anon");
    assert.equal(await fetchPlan("PLANBB"), null);
  });

  await t.test("operator access is private; removal scrubs cases and suspension closes publishing", async () => {
    await role("authenticated", b);
    for (const signature of ["moderation_list_reports(integer)", "moderation_resolve_report(uuid,text)", "moderation_set_publishing_suspended(uuid,boolean)"]) {
      for (const name of ["anon", "authenticated"]) assert.equal(await scalar("select has_function_privilege($1,$2,'execute')", [name, signature]), false);
    }
    await assert.rejects(scalar("select public.moderation_list_reports()"), /permission denied/);
    await assert.rejects(db.query("select * from iron_atlas_private.content_reports"), /permission denied/);
    for (const table of ["content_reports", "content_receipts", "report_limits", "publishing_controls", "user_blocks"]) {
      for (const name of ["anon", "authenticated", "service_role"]) {
        assert.equal(await scalar("select has_table_privilege($1,$2,'select,insert,update,delete,truncate')",
          [name, "iron_atlas_private." + table]), false);
      }
    }
    await role("service_role");
    assert.equal((await scalar("select public.moderation_list_reports(1)")).length, 1);
    await assert.rejects(scalar("select public.moderation_list_reports(101)"), /limit/);
    const resolved = await scalar("select public.moderation_resolve_report($1,'remove')", [sharedReport.id]);
    assert.equal(resolved.status, "removed");
    assert.deepEqual(await scalar("select public.moderation_resolve_report($1,'remove')", [sharedReport.id]), resolved);
    await db.exec("reset role");
    const row = (await db.query("select * from iron_atlas_private.content_reports where id=$1", [sharedReport.id])).rows[0];
    assert.equal(row.reporter_id, null); assert.equal(row.subject_id, null); assert.equal(row.reference, null); assert.equal(row.kind, null);
    await role("authenticated", b);
    const peerReport = await report("peer", a);
    await role("service_role");
    assert.equal((await scalar("select public.moderation_resolve_report($1,'suspend')", [peerReport.id])).status, "suspended");
    await assert.rejects(scalar("select public.coach_setup_checked($1,'Trainer')", [a]), /Sharing is suspended/);
    await role("authenticated", a);
    assert.equal((await scalar("select data from public.app_state where key='main'")).privateNote, "fuck");
    await assert.rejects(share("PLANAC", a), /Sharing is suspended/);
    await role("service_role");
    await scalar("select public.moderation_set_publishing_suspended($1,false)", [a]);
    await role("anon");
    assert.equal(await fetchPlan("PLANAA"), null);
  });

  await t.test("report limits persist when cases close and receipts survive backup withdrawal", async () => {
    await role("authenticated", b);
    await block(a);
    const blocks = await scalar("select public.blocked_peers()");
    await scalar("select public.begin_cloud_withdrawal($1)", [generation.get(b)]);
    await scalar("select public.finish_cloud_withdrawal($1)", [generation.get(b)]);
    assert.deepEqual(await scalar("select public.blocked_peers()"), blocks);
    assert.equal((await report("peer", a)).status, "open");
    for (let i = 0; i < 11; i++) {
      await role("authenticated", d);
      await share("R" + String(i).padStart(5, "0"), d);
      await role("authenticated", c);
      const item = await fetchPlan("R" + String(i).padStart(5, "0"));
      if (i === 10) await assert.rejects(report("shared_plan", item._source.reference), /Too many reports/);
      else {
        const entry = await report("shared_plan", item._source.reference);
        await role("service_role");
        await scalar("select public.moderation_resolve_report($1,'dismiss')", [entry.id]);
      }
    }
  });

  await t.test("full account deletion clears identity metadata and stale identities cannot act", async () => {
    await role("authenticated", b);
    const entry = await report("peer", a);
    await role("authenticated", a);
    await scalar("select public.delete_my_account($1)", [generation.get(a)]);
    await assert.rejects(block(b), /Account unavailable/);
    await assert.rejects(report("peer", b), /Account unavailable/);
    await assert.rejects(fetchPlan("R00000"), /Account unavailable/);
    await db.exec("reset role");
    const row = (await db.query("select * from iron_atlas_private.content_reports where id=$1", [entry.id])).rows[0];
    assert.equal(row.status, "account_deleted"); assert.equal(row.reporter_id, null); assert.equal(row.subject_id, null); assert.equal(row.reference, null);
    assert.equal(await scalar("select count(*)::int from iron_atlas_private.content_receipts where receiver_id=$1 or author_id=$1", [a]), 0);
    assert.equal(await scalar("select count(*)::int from iron_atlas_private.user_blocks where blocker_id=$1 or blocked_id=$1", [a]), 0);
    await db.exec(schema);
    assert.equal(await scalar("select count(*)::int from iron_atlas_private.content_reports where id=$1", [entry.id]), 1, "schema reapplication preserves redacted audit status");
  });
});
