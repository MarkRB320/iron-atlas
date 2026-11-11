-- Iron Atlas: accounts and cloud backup
-- Run in the dedicated Iron Atlas project. This transaction also upgrades the original v1.2 tables in place.
begin;

-- Explicit cloud-training consent. No account metadata or client claims grant permission.
create schema if not exists iron_atlas_private;
revoke all on schema iron_atlas_private from public, anon, authenticated;
grant usage on schema iron_atlas_private to authenticated;
-- pg_net's queue may be readable under managed extension grants. Only a single-use
-- invocation token goes through it; the raw value is never persisted in this table.
create table if not exists iron_atlas_private.account_erasure_invocations (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null
);
revoke all on iron_atlas_private.account_erasure_invocations from public, anon, authenticated, service_role;
create or replace function public.consume_account_erasure_invocation(p_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from iron_atlas_private.account_erasure_invocations
    where token_hash = p_hash and expires_at > clock_timestamp();
  return found;
end $$;
revoke all on function public.consume_account_erasure_invocation(text) from public, anon, authenticated;
grant execute on function public.consume_account_erasure_invocation(text) to service_role;

create table if not exists public.cloud_consent (
  user_id uuid primary key references auth.users(id) on delete cascade,
  generation uuid not null,
  version text not null,
  enabled boolean not null default false,
  cleanup_pending boolean not null default false,
  granted_at timestamptz,
  withdrawn_at timestamptz
);
create table if not exists public.cloud_consent_receipts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  generation uuid not null,
  version text not null,
  action text not null check (action in ('grant', 'withdraw', 'cleanup')),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.cloud_consent enable row level security;
alter table public.cloud_consent_receipts enable row level security;
revoke all on public.cloud_consent, public.cloud_consent_receipts from public, anon, authenticated;
revoke all on sequence public.cloud_consent_receipts_id_seq from public, anon, authenticated;
-- Durable Storage HTTP removals also reserve their paths against later reuse.
create table if not exists public.photo_removal_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  generation uuid,
  purpose text not null check (purpose in ('photo', 'withdrawal', 'account')),
  names text[] not null,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);
create index if not exists photo_removal_intents_user on public.photo_removal_intents(user_id);
alter table public.photo_removal_intents enable row level security;
revoke all on public.photo_removal_intents from public, anon, authenticated;

-- This setting is configured only by the publisher after RevenueCat is bound to this project.
create table if not exists public.account_erasure_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  project_id text not null check (char_length(trim(project_id)) between 1 and 255)
);
-- Intentionally no Auth foreign key: provider erasure must survive deleting the sign-in account.
create table if not exists public.account_erasure_jobs (
  id uuid primary key default gen_random_uuid(),
  customer_id text,
  project_id text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'retry', 'complete')),
  attempts integer not null default 0,
  requested_at timestamptz not null default clock_timestamp(),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  last_error_code text check (last_error_code in ('rate_limited', 'temporary', 'auth', 'project_mismatch',
    'verification_pending', 'invalid_response', 'configuration')),
  unique(project_id, customer_id)
);
alter table public.account_erasure_settings enable row level security;
alter table public.account_erasure_jobs enable row level security;
revoke all on public.account_erasure_settings, public.account_erasure_jobs from public, anon, authenticated;

create or replace function public.claim_account_erasures(p_limit integer default 10, p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; checked_at timestamptz := clock_timestamp();
begin
  if p_limit is null or p_limit not between 1 and 10 or p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'Invalid erasure claim bounds';
  end if;
  with candidates as (
    select id from public.account_erasure_jobs
    where customer_id is not null and
      ((status in ('pending', 'retry') and next_attempt_at <= checked_at)
       or (status = 'processing' and lease_expires_at <= checked_at))
    order by requested_at, id limit p_limit for update skip locked
  ), claimed as (
    update public.account_erasure_jobs j set status = 'processing', attempts = attempts + 1,
      lease_token = gen_random_uuid(), lease_expires_at = checked_at + make_interval(secs => p_lease_seconds)
    from candidates c where j.id = c.id returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'customer_id', customer_id,
    'project_id', project_id, 'lease_token', lease_token) order by requested_at, id), '[]'::jsonb) into result from claimed;
  return result;
end $$;

create or replace function public.complete_account_erasure(p_id uuid, p_lease_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.account_erasure_jobs set customer_id = null, status = 'complete', completed_at = clock_timestamp(),
    lease_token = null, lease_expires_at = null, last_error_code = null
  where id = p_id and status = 'processing' and lease_token = p_lease_token and lease_expires_at > clock_timestamp();
  return found;
end $$;

create or replace function public.defer_account_erasure(p_id uuid, p_lease_token uuid, p_error_code text, p_retry_after integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_error_code is null or p_error_code not in ('rate_limited', 'temporary', 'auth', 'project_mismatch',
    'verification_pending', 'invalid_response', 'configuration') or p_retry_after is null or p_retry_after not between 5 and 86400 then
    raise exception 'Invalid erasure retry';
  end if;
  update public.account_erasure_jobs set status = 'retry', next_attempt_at = clock_timestamp() + make_interval(secs => p_retry_after),
    lease_token = null, lease_expires_at = null, last_error_code = p_error_code
  where id = p_id and status = 'processing' and lease_token = p_lease_token and lease_expires_at > clock_timestamp();
  return found;
end $$;
revoke all on function public.claim_account_erasures(integer, integer), public.complete_account_erasure(uuid, uuid),
  public.defer_account_erasure(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_account_erasures(integer, integer), public.complete_account_erasure(uuid, uuid),
  public.defer_account_erasure(uuid, uuid, text, integer) to service_role;

create or replace function iron_atlas_private.cloud_enabled(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.cloud_consent where user_id = p_user
    and enabled and not cleanup_pending and version = '2026-11-02');
$$;
create or replace function iron_atlas_private.cloud_readable(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.cloud_consent where user_id = p_user
    and ((enabled and version = '2026-11-02') or cleanup_pending));
$$;
-- SHARE conflicts with the NO KEY UPDATE lock used by grant/withdraw/commit.
-- Lock the account before reading consent, never a document or client link first.
create or replace function iron_atlas_private.require_cloud(p_user uuid, p_generation uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from auth.users where id = p_user for share;
  if not found then raise exception 'Account unavailable' using errcode = '42501'; end if;
  if not exists (select 1 from public.cloud_consent where user_id = p_user and enabled
    and not cleanup_pending and version = '2026-11-02' and generation = p_generation) then
    raise exception 'Cloud consent required or changed. Refresh consent status.' using errcode = '42501';
  end if;
end $$;
revoke all on function iron_atlas_private.cloud_enabled(uuid), iron_atlas_private.cloud_readable(uuid),
  iron_atlas_private.require_cloud(uuid, uuid) from public, anon, authenticated;
grant execute on function iron_atlas_private.cloud_enabled(uuid), iron_atlas_private.cloud_readable(uuid) to authenticated;
create or replace function iron_atlas_private.require_generation(p_user uuid, p_generation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare current_generation uuid;
begin
  perform 1 from auth.users where id = p_user for share;
  if not found then raise exception 'Account unavailable' using errcode = '42501'; end if;
  select generation into current_generation from public.cloud_consent where user_id = p_user;
  if p_generation is distinct from current_generation then
    raise exception 'Consent changed. Refresh before starting this action.' using errcode = '42501';
  end if;
end $$;
revoke all on function iron_atlas_private.require_generation(uuid, uuid) from public, anon, authenticated;
create or replace function iron_atlas_private.shared_plan_allowed(p_generation uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform iron_atlas_private.require_cloud(auth.uid(), p_generation);
  return true;
end $$;
revoke all on function iron_atlas_private.shared_plan_allowed(uuid) from public, anon;
grant execute on function iron_atlas_private.shared_plan_allowed(uuid) to authenticated;

create or replace function public.cloud_consent_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.cloud_consent;
begin
  if not exists (select 1 from auth.users where id = auth.uid()) then
    raise exception 'Account unavailable' using errcode = '42501';
  end if;
  select * into c from public.cloud_consent where user_id = auth.uid();
  return jsonb_build_object('enabled', coalesce(c.enabled and c.version = '2026-11-02' and not c.cleanup_pending, false),
    'version', '2026-11-02', 'generation', c.generation, 'cleanup_pending', coalesce(c.cleanup_pending, false),
    'granted_at', c.granted_at, 'withdrawn_at', c.withdrawn_at);
end $$;
create or replace function public.grant_cloud_consent(p_version text, p_expected_generation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.cloud_consent;
begin
  perform 1 from auth.users where id = auth.uid() for no key update;
  if not found then raise exception 'Account unavailable' using errcode = '42501'; end if;
  select * into c from public.cloud_consent where user_id = auth.uid();
  if p_version is distinct from '2026-11-02' then raise exception 'Refresh the consent notice before accepting'; end if;
  if p_expected_generation is distinct from c.generation then raise exception 'Consent changed. Refresh consent status.'; end if;
  if c.cleanup_pending then raise exception 'Finish cloud removal before enabling backup again'; end if;
  if exists (select 1 from public.photo_removal_intents where user_id = auth.uid() and completed_at is null) then
    raise exception 'Photo removal is in progress. Resume it before enabling backup.';
  end if;
  if c.enabled and c.version = p_version then return public.cloud_consent_status(); end if;
  insert into public.cloud_consent(user_id, generation, version, enabled, granted_at)
    values (auth.uid(), gen_random_uuid(), p_version, true, clock_timestamp())
  on conflict (user_id) do update set generation = excluded.generation, version = excluded.version,
    enabled = true, cleanup_pending = false, granted_at = excluded.granted_at, withdrawn_at = null;
  insert into public.cloud_consent_receipts(user_id, generation, version, action)
    select user_id, generation, version, 'grant' from public.cloud_consent where user_id = auth.uid();
  return public.cloud_consent_status();
end $$;
revoke all on function public.cloud_consent_status(), public.grant_cloud_consent(text, uuid) from public, anon;
grant execute on function public.cloud_consent_status(), public.grant_cloud_consent(text, uuid) to authenticated;

-- 1. Records. One row per person per document: settings, measurements and the photo list in 'main',
--    and the logged sets split into one row per quarter ('log-2026q4' and so on).
create table if not exists public.app_state (
  user_id    uuid not null references auth.users (id) on delete cascade,
  key        text not null check (char_length(key) between 1 and 40),
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.app_state enable row level security;
revoke all on public.app_state from public, anon, authenticated;
grant select on public.app_state to authenticated;

drop policy if exists "Read own records" on public.app_state;
drop policy if exists "Add own records" on public.app_state;
drop policy if exists "Change own records" on public.app_state;
drop policy if exists "Delete own records" on public.app_state;
create policy "Read own records"   on public.app_state for select to authenticated using ((select auth.uid()) = user_id and iron_atlas_private.cloud_readable(user_id));
create policy "Delete own records" on public.app_state for delete to authenticated using ((select auth.uid()) = user_id);

-- Writers must supply the documents they read. Serializing on the account also covers fresh keys.
-- The pre-release 1.2 REST upsert writer must be replaced by the CAS-aware client before this update.
drop function if exists public.commit_app_state(jsonb, jsonb);
create or replace function public.commit_app_state(p_expected jsonb, p_docs jsonb, p_generation uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_keys text[];
  v_expected_keys text[];
begin
  if v_user is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if jsonb_typeof(p_expected) is distinct from 'object' or jsonb_typeof(p_docs) is distinct from 'object' then
    raise exception 'Expected and desired documents must be objects' using errcode = '22023';
  end if;
  select array_agg(key order by key) into v_keys from jsonb_object_keys(p_docs) as key;
  select array_agg(key order by key) into v_expected_keys from jsonb_object_keys(p_expected) as key;
  if v_keys is distinct from v_expected_keys then
    raise exception 'Expected and desired document keys must match' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(p_docs) as d
    where (d.key not in ('main', 'state') and d.key !~ '^log-[0-9]{4}q[1-4]$') or jsonb_typeof(d.value) <> 'object')
    or exists (select 1 from jsonb_each(p_expected) as d where jsonb_typeof(d.value) not in ('object', 'null')) then
    raise exception 'Invalid account document' using errcode = '22023';
  end if;

  -- All writers lock the same extant account, so absent keys cannot race each other.
  -- Account deletion locks this row too. A stale JWT cannot recreate a deleted account's records.
  perform 1 from auth.users where id = v_user for no key update;
  if not found then raise exception 'Account unavailable' using errcode = '42501'; end if;
  perform iron_atlas_private.require_cloud(v_user, p_generation);
  -- Row locks order this commit against the remaining owner-scoped DELETE/wipe path.
  perform 1 from public.app_state where user_id = v_user and key = any(v_keys) order by key for update;
  if exists (
    select 1 from jsonb_each(p_expected) as e
    left join public.app_state as a on a.user_id = v_user and a.key = e.key
    where (e.value = 'null'::jsonb and a.key is not null)
       or (e.value <> 'null'::jsonb and (a.key is null or a.data is distinct from e.value))
  ) then return jsonb_build_object('applied', false); end if;

  insert into public.app_state (user_id, key, data, updated_at)
    select v_user, key, value, now() from jsonb_each(p_docs)
  on conflict (user_id, key) do update set data = excluded.data, updated_at = excluded.updated_at;
  return jsonb_build_object('applied', true);
end $$;
revoke all on function public.commit_app_state(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.commit_app_state(jsonb, jsonb, uuid) to authenticated;

create or replace function public.wipe_app_state(p_generation uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from auth.users where id = auth.uid() for no key update;
  perform iron_atlas_private.require_cloud(auth.uid(), p_generation);
  delete from public.app_state where user_id = auth.uid();
end $$;
revoke all on function public.wipe_app_state(uuid) from public, anon;
grant execute on function public.wipe_app_state(uuid) to authenticated;

-- 2. Progress photos. A private bucket with one folder per person; nobody can read anyone else's folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('progress-photos', 'progress-photos', false, 1048576, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Serialize photo writes with account deletion, including requests using an unexpired JWT after deletion.
create schema if not exists iron_atlas_private;
revoke all on schema iron_atlas_private from public, anon, authenticated;
grant usage on schema iron_atlas_private to authenticated;
create or replace function iron_atlas_private.photo_owner_exists() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from auth.users where id = (select auth.uid()) for share;
  return found;
end $$;
revoke all on function iron_atlas_private.photo_owner_exists() from public, anon;
grant execute on function iron_atlas_private.photo_owner_exists() to authenticated;
create or replace function iron_atlas_private.photo_write_allowed(p_name text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not iron_atlas_private.photo_owner_exists() then return false; end if;
  return exists (select 1 from public.cloud_consent where user_id = auth.uid() and enabled
    and not cleanup_pending and version = '2026-11-02'
    and split_part(p_name, '/', 1) = user_id::text and split_part(p_name, '/', 2) = generation::text)
    and not exists (select 1 from public.photo_removal_intents where user_id = auth.uid() and p_name = any(names));
end $$;
revoke all on function iron_atlas_private.photo_write_allowed(text) from public, anon;
grant execute on function iron_atlas_private.photo_write_allowed(text) to authenticated;

drop policy if exists "Read own photos" on storage.objects;
drop policy if exists "Upload own photos" on storage.objects;
drop policy if exists "Replace own photos" on storage.objects;
drop policy if exists "Delete own photos" on storage.objects;
create policy "Read own photos" on storage.objects for select to authenticated
  using (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select iron_atlas_private.photo_owner_exists())
    and (storage.allow_any_operation(array['object.list', 'object.list_v2', 'object.delete', 'object.delete_many'])
      or ((select iron_atlas_private.cloud_readable(auth.uid()))
        and storage.allow_any_operation(array['object.get_authenticated', 'object.get_authenticated_info',
          'object.head_authenticated_info', 'object.upload', 'object.upload_update']))));
create policy "Upload own photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'progress-photos' and iron_atlas_private.photo_write_allowed(name)
    and storage.allow_any_operation(array['object.upload', 'object.upload_update']));
create policy "Replace own photos" on storage.objects for update to authenticated
  using (bucket_id = 'progress-photos' and iron_atlas_private.photo_write_allowed(name)
    and storage.allow_any_operation(array['object.upload', 'object.upload_update']))
  with check (bucket_id = 'progress-photos' and iron_atlas_private.photo_write_allowed(name)
    and storage.allow_any_operation(array['object.upload', 'object.upload_update']));
-- Photo removal uses the generation-bound Edge route, never direct owner-only DELETE.
-- It removes exact existing names through Storage HTTP after this authorization snapshot.
drop function if exists public.authorize_photo_removal(uuid, text[]);
create or replace function public.authorize_photo_removal(p_generation uuid, p_purpose text, p_names text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.cloud_consent; removal public.photo_removal_intents; selected_names text[];
begin
  perform 1 from auth.users where id = auth.uid() for no key update;
  perform iron_atlas_private.require_generation(auth.uid(), p_generation);
  select * into c from public.cloud_consent where user_id = auth.uid();
  if p_purpose is null or p_purpose not in ('photo', 'withdrawal', 'account', 'resume') then
    raise exception 'Invalid photo removal purpose';
  end if;
  if p_purpose = 'photo' and not coalesce(c.enabled and not c.cleanup_pending and c.version = '2026-11-02', false) then
    raise exception 'Cloud consent phase changed' using errcode = '42501';
  end if;
  if p_purpose = 'withdrawal' and not coalesce(c.cleanup_pending and c.withdrawn_at is not null, false) then
    raise exception 'Begin cloud removal first' using errcode = '42501';
  end if;
  if p_names is null or cardinality(p_names) > 100 or exists
    (select 1 from unnest(p_names) n where n is null or length(n) > 1024 or n not like auth.uid()::text || '/%') then
    raise exception 'Invalid photo removal request';
  end if;
  select * into removal from public.photo_removal_intents where user_id = auth.uid()
    and generation is not distinct from p_generation and completed_at is null order by created_at, id limit 1;
  if found then return jsonb_build_object('operation', removal.id, 'names', removal.names); end if;
  if p_purpose = 'resume' then return jsonb_build_object('operation', null, 'names', '[]'::jsonb); end if;
  select array_agg(name order by name) into selected_names from storage.objects
    where bucket_id = 'progress-photos' and name = any(p_names) and name like auth.uid()::text || '/%';
  if selected_names is null then return jsonb_build_object('operation', null, 'names', '[]'::jsonb); end if;
  insert into public.photo_removal_intents(user_id, generation, purpose, names)
    values (auth.uid(), p_generation, p_purpose, selected_names) returning * into removal;
  return jsonb_build_object('operation', removal.id, 'names', removal.names);
end $$;
revoke all on function public.authorize_photo_removal(uuid, text, text[]) from public, anon;
grant execute on function public.authorize_photo_removal(uuid, text, text[]) to authenticated;

create or replace function public.complete_photo_removal(p_actor uuid, p_operation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare removal public.photo_removal_intents;
begin
  perform 1 from auth.users where id = p_actor for no key update;
  select * into removal from public.photo_removal_intents where user_id = p_actor and id = p_operation;
  if not found or removal.completed_at is not null then return; end if;
  if exists (select 1 from storage.objects where bucket_id = 'progress-photos' and name = any(removal.names)) then
    raise exception 'Photo removal is incomplete';
  end if;
  update public.photo_removal_intents set completed_at = clock_timestamp() where id = p_operation;
end $$;
revoke all on function public.complete_photo_removal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_photo_removal(uuid, uuid) to service_role;

-- 3. Delete account from inside the app (the App Store and Google Play both require this).
--    The app removes the person's photos through the storage API first, then calls this.
drop function if exists public.delete_my_account();
drop function if exists public.delete_my_account(uuid);
create or replace function public.delete_my_account(p_generation uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare erasure_project text;
begin
  perform iron_atlas_private.moderation_lock();
  perform 1 from auth.users where id = auth.uid() for update;
  if not found then
    raise exception 'Not signed in';
  end if;
  perform iron_atlas_private.require_generation(auth.uid(), p_generation);
  if exists (select 1 from storage.objects where bucket_id = 'progress-photos' and name like auth.uid()::text || '/%') then
    raise exception 'Progress photos still need to be removed. Please retry deleting your account.';
  end if;
  select project_id into erasure_project from public.account_erasure_settings where singleton and enabled;
  if erasure_project is not null then
    insert into public.account_erasure_jobs(customer_id, project_id) values (auth.uid()::text, erasure_project)
      on conflict (project_id, customer_id) do nothing;
  end if;
  delete from public.app_state where user_id = auth.uid();
  delete from auth.users where id = auth.uid();
  return jsonb_build_object('deleted', true, 'subscription_erasure_queued', erasure_project is not null);
end;
$$;
revoke all on function public.delete_my_account(uuid) from public, anon;
grant execute on function public.delete_my_account(uuid) to authenticated;

-- Cross-user content controls. These private records contain identity/reference metadata,
-- never copies of training content. Account deletion cascades the controls and receipts.
create table if not exists iron_atlas_private.publishing_controls (
  user_id uuid primary key references auth.users(id) on delete cascade,
  suspended boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
create table if not exists iron_atlas_private.user_blocks (
  blocker_id uuid references auth.users(id) on delete cascade,
  blocked_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key (blocker_id, blocked_id), check (blocker_id <> blocked_id)
);
create table if not exists iron_atlas_private.content_receipts (
  receiver_id uuid references auth.users(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('shared_plan', 'assigned_plan', 'peer')),
  reference text not null,
  primary key (receiver_id, kind, reference)
);
create table if not exists iron_atlas_private.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users(id) on delete set null,
  subject_id uuid references auth.users(id) on delete set null,
  kind text check (kind in ('shared_plan', 'assigned_plan', 'peer')),
  reference text,
  reason text not null check (reason in ('abuse', 'hate', 'sexual', 'violence', 'spam', 'other')),
  status text not null default 'open' check (status in ('open', 'dismissed', 'removed', 'suspended', 'account_deleted')),
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz
);
create index if not exists content_reports_open on iron_atlas_private.content_reports(created_at) where status = 'open';
create table if not exists iron_atlas_private.report_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  attempts integer not null
);
alter table iron_atlas_private.publishing_controls enable row level security;
alter table iron_atlas_private.user_blocks enable row level security;
alter table iron_atlas_private.content_receipts enable row level security;
alter table iron_atlas_private.content_reports enable row level security;
alter table iron_atlas_private.report_limits enable row level security;
revoke all on iron_atlas_private.publishing_controls, iron_atlas_private.user_blocks,
  iron_atlas_private.content_receipts, iron_atlas_private.content_reports,
  iron_atlas_private.report_limits from public, anon, authenticated, service_role;

-- A single short transaction lock orders publication and moderation changes. It is
-- acquired before Auth/consent row locks by the cross-user write entry points.
create or replace function iron_atlas_private.moderation_lock() returns void
language sql volatile set search_path = '' as $$ select pg_catalog.pg_advisory_xact_lock(77219001); $$;

-- Baseline English text filter. Reports and human review handle context and other
-- languages. Keep the legacy-file client precheck aligned with this normalization.
create or replace function iron_atlas_private.shared_text_allowed(p_value jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(regexp_replace(lower(translate(translate(p_value::text,
    chr(8203) || chr(8204) || chr(8205) || chr(65279), ''), '@013457$', 'aoieasts')),
    '[^a-z]+', ' ', 'g') !~
    '(^| )(fuck[a-z]*|motherfuck[a-z]*|shit|shitty|shithead[a-z]*|bullshit|cunt[a-z]*|nigger[a-z]*|faggot[a-z]*|porn|pornography|kill yourself|i will kill you|rape you|child porn)( |$)', false);
$$;
create or replace function iron_atlas_private.peers_blocked(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from iron_atlas_private.user_blocks
    where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a));
$$;
create or replace function iron_atlas_private.content_visible(p_author uuid, p_viewer uuid, p_value jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users where id = p_author)
    and iron_atlas_private.shared_text_allowed(p_value)
    and not exists (select 1 from iron_atlas_private.publishing_controls
      where user_id in (p_author, p_viewer) and suspended)
    and not iron_atlas_private.peers_blocked(p_author, p_viewer);
$$;
create or replace function iron_atlas_private.require_publication(p_author uuid, p_value jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform iron_atlas_private.moderation_lock();
  if not exists (select 1 from auth.users where id = p_author) then
    raise exception 'Account unavailable' using errcode = '42501';
  end if;
  if exists (select 1 from iron_atlas_private.publishing_controls where user_id = p_author and suspended) then
    raise exception 'Sharing is suspended for this account. Contact Iron Atlas support.';
  end if;
  if not iron_atlas_private.shared_text_allowed(p_value) then
    raise exception 'This text cannot be shared. Edit the name, notes or other text and try again.';
  end if;
end $$;
create or replace function iron_atlas_private.scrub_closed_report() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.subject_id is not null and new.subject_id is null and new.status = 'open' then
    new.status := 'account_deleted';
  end if;
  if new.status <> 'open' then
    new.reporter_id := null; new.subject_id := null; new.kind := null; new.reference := null;
    new.resolved_at := coalesce(new.resolved_at, clock_timestamp());
  end if;
  return new;
end $$;
drop trigger if exists scrub_closed_report on iron_atlas_private.content_reports;
create trigger scrub_closed_report before update on iron_atlas_private.content_reports
  for each row execute function iron_atlas_private.scrub_closed_report();
revoke all on function iron_atlas_private.moderation_lock(), iron_atlas_private.shared_text_allowed(jsonb),
  iron_atlas_private.peers_blocked(uuid, uuid), iron_atlas_private.content_visible(uuid, uuid, jsonb),
  iron_atlas_private.require_publication(uuid, jsonb), iron_atlas_private.scrub_closed_report()
  from public, anon, authenticated, service_role;

-- 4. Shared plans (Plans > Share). A trainer or friend shares a plan as a six-character code.
--    Only the person who shared a plan can write it; anyone can fetch one plan if they know its code,
--    but nobody can list or browse the codes.
create table if not exists public.shared_plans (
  code       text primary key check (code ~ '^[A-Z0-9]{6}$'),
  plan       jsonb not null check (octet_length(plan::text) < 20000),
  owner      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.shared_plans enable row level security;
alter table public.shared_plans add column if not exists consent_generation uuid;
alter table public.shared_plans add column if not exists sharing_notice_version text;
alter table public.shared_plans add column if not exists sharing_acknowledged_at timestamptz;
alter table public.shared_plans add column if not exists moderation_id uuid not null default gen_random_uuid();
create unique index if not exists shared_plans_moderation_id on public.shared_plans(moderation_id);
create or replace function iron_atlas_private.stamp_plan_sharing() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform iron_atlas_private.require_publication(new.owner, new.plan);
  if tg_op = 'INSERT' then
    new.moderation_id := gen_random_uuid();
    if new.sharing_notice_version is distinct from '2026-11-02' then
      raise exception 'Acknowledge the current plan sharing notice before publishing';
    end if;
    new.sharing_acknowledged_at := clock_timestamp();
  else
    new.moderation_id := old.moderation_id;
  end if;
  return new;
end $$;
revoke all on function iron_atlas_private.stamp_plan_sharing() from public, anon, authenticated;
drop trigger if exists stamp_plan_sharing on public.shared_plans;
create trigger stamp_plan_sharing before insert or update on public.shared_plans
  for each row execute function iron_atlas_private.stamp_plan_sharing();
revoke all on public.shared_plans from public, anon, authenticated;
grant select, insert on public.shared_plans to authenticated;
drop policy if exists "Share own plans" on public.shared_plans;
drop policy if exists "See own plans" on public.shared_plans;
drop policy if exists "Remove own plans" on public.shared_plans;
create policy "Share own plans"  on public.shared_plans for insert to authenticated
  with check ((select auth.uid()) = owner and iron_atlas_private.shared_plan_allowed(consent_generation)
    and sharing_notice_version = '2026-11-02' and sharing_acknowledged_at is not null);
create policy "See own plans"    on public.shared_plans for select to authenticated using ((select auth.uid()) = owner and iron_atlas_private.cloud_readable(owner));
create policy "Remove own plans" on public.shared_plans for delete to authenticated using ((select auth.uid()) = owner);

create or replace function public.get_shared_plan(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare item public.shared_plans;
begin
  if auth.uid() is not null and not exists (select 1 from auth.users where id = auth.uid()) then
    raise exception 'Account unavailable' using errcode = '42501';
  end if;
  select p.* into item from public.shared_plans p join public.cloud_consent c on c.user_id = p.owner
    and c.generation = p.consent_generation and c.enabled and not c.cleanup_pending and c.version = '2026-11-02'
  where p.code = upper(p_code) and p.sharing_notice_version = '2026-11-02'
    and p.sharing_acknowledged_at is not null
    and iron_atlas_private.content_visible(p.owner, auth.uid(), p.plan) limit 1;
  if not found then return null; end if;
  if auth.uid() is not null then
    insert into iron_atlas_private.content_receipts(receiver_id, author_id, kind, reference)
      values (auth.uid(), item.owner, 'shared_plan', item.moderation_id::text) on conflict do nothing;
  end if;
  return item.plan || jsonb_build_object('_source', jsonb_build_object(
    'kind', 'shared_plan', 'reference', item.moderation_id::text, 'author', item.owner));
end;
$$;
revoke all on function public.get_shared_plan(text) from public;
grant execute on function public.get_shared_plan(text) to anon, authenticated;

-- 5. Iron Atlas Coach. A personal trainer gets a six-character code; clients who enter it share their
--    training summary (workouts, records, weekly balance; never photos or measurements) and receive
--    plans. The tables are closed to direct access; the app only uses the functions below, which
--    check who is asking.
create table if not exists public.coaches (
  id         uuid primary key references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  code       text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  created_at timestamptz not null default now()
);
create table if not exists public.coach_clients (
  client_id   uuid primary key references auth.users (id) on delete cascade,   -- one trainer per client
  coach_id    uuid not null references public.coaches (id) on delete cascade,
  client_name text not null default '' check (char_length(client_name) <= 60),
  joined_at   timestamptz not null default now()
);
create index if not exists coach_clients_coach on public.coach_clients (coach_id);
create table if not exists public.client_summaries (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  summary    jsonb not null check (octet_length(summary::text) < 100000),
  updated_at timestamptz not null default now()
);
alter table public.coach_clients add column if not exists consent_generation uuid;
alter table public.coach_clients add column if not exists sharing_notice_version text;
alter table public.coach_clients add column if not exists sharing_acknowledged_at timestamptz;
create table if not exists public.assigned_plans (
  id         bigint generated always as identity primary key,
  coach_id   uuid not null references public.coaches (id) on delete cascade,
  client_id  uuid not null references auth.users (id) on delete cascade,
  plan       jsonb not null check (octet_length(plan::text) < 20000),
  created_at timestamptz not null default now()
);
alter table public.coaches enable row level security;
alter table public.coach_clients enable row level security;
alter table public.client_summaries enable row level security;
alter table public.assigned_plans enable row level security;
revoke all on public.coaches, public.coach_clients, public.client_summaries, public.assigned_plans from public, anon, authenticated;
revoke all on sequence public.assigned_plans_id_seq from public, anon, authenticated;
create index if not exists assigned_plans_client on public.assigned_plans (client_id);

create or replace function iron_atlas_private.check_cross_user_content() returns trigger
language plpgsql security definer set search_path = '' as $$
declare peer uuid;
begin
  if tg_table_name = 'coaches' then
    perform iron_atlas_private.require_publication(new.id, to_jsonb(new.name));
  elsif tg_table_name = 'coach_clients' then
    perform iron_atlas_private.require_publication(new.client_id, to_jsonb(new.client_name));
    if not iron_atlas_private.content_visible(new.coach_id, new.client_id,
      (select to_jsonb(name) from public.coaches where id = new.coach_id)) then
      raise exception 'This connection is unavailable.';
    end if;
    insert into iron_atlas_private.content_receipts(receiver_id, author_id, kind, reference) values
      (new.client_id, new.coach_id, 'peer', new.coach_id::text),
      (new.coach_id, new.client_id, 'peer', new.client_id::text) on conflict do nothing;
  elsif tg_table_name = 'assigned_plans' then
    perform iron_atlas_private.require_publication(new.coach_id, new.plan);
    if not iron_atlas_private.content_visible(new.coach_id, new.client_id,
      (select to_jsonb(name) from public.coaches where id = new.coach_id)) then
      raise exception 'This connection is unavailable.';
    end if;
    insert into iron_atlas_private.content_receipts(receiver_id, author_id, kind, reference)
      values (new.client_id, new.coach_id, 'assigned_plan', new.id::text) on conflict do nothing;
  elsif tg_table_name = 'client_summaries' then
    perform iron_atlas_private.require_publication(new.user_id, new.summary);
    select coach_id into peer from public.coach_clients where client_id = new.user_id;
    if peer is not null and not iron_atlas_private.content_visible(new.user_id, peer, new.summary) then
      raise exception 'This connection is unavailable.';
    end if;
  end if;
  return new;
end $$;
revoke all on function iron_atlas_private.check_cross_user_content() from public, anon, authenticated, service_role;
drop trigger if exists check_cross_user_content on public.coaches;
create trigger check_cross_user_content before insert or update on public.coaches
  for each row execute function iron_atlas_private.check_cross_user_content();
drop trigger if exists check_cross_user_content on public.coach_clients;
create trigger check_cross_user_content before insert or update on public.coach_clients
  for each row execute function iron_atlas_private.check_cross_user_content();
drop trigger if exists check_cross_user_content on public.assigned_plans;
create trigger check_cross_user_content before insert or update on public.assigned_plans
  for each row execute function iron_atlas_private.check_cross_user_content();
drop trigger if exists check_cross_user_content on public.client_summaries;
create trigger check_cross_user_content before insert or update on public.client_summaries
  for each row execute function iron_atlas_private.check_cross_user_content();
-- Backfill only source identities so previously queued/delivered content remains reportable.
insert into iron_atlas_private.content_receipts(receiver_id, author_id, kind, reference)
  select client_id, coach_id, 'assigned_plan', id::text from public.assigned_plans on conflict do nothing;
insert into iron_atlas_private.content_receipts(receiver_id, author_id, kind, reference)
  select client_id, coach_id, 'peer', coach_id::text from public.coach_clients on conflict do nothing;
insert into iron_atlas_private.content_receipts(receiver_id, author_id, kind, reference)
  select coach_id, client_id, 'peer', client_id::text from public.coach_clients on conflict do nothing;
create table if not exists public.coach_request_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  attempts integer not null
);
alter table public.coach_request_limits enable row level security;
revoke all on public.coach_request_limits from public, anon, authenticated;

create or replace function public.coach_request_allowed(p_actor uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.coach_request_limits as r (user_id, started_at, attempts) values (p_actor, now(), 1)
  on conflict (user_id) do update set
    started_at = case when r.started_at <= now() - interval '1 minute' then now() else r.started_at end,
    attempts = case when r.started_at <= now() - interval '1 minute' then 1 else r.attempts + 1 end
    where r.started_at <= now() - interval '1 minute' or r.attempts < 20;
  return found;
end $$;
revoke all on function public.coach_request_allowed(uuid) from public, anon, authenticated;
grant execute on function public.coach_request_allowed(uuid) to service_role;

-- Remove the old public RPC signatures, including any grants retained by an upgraded installation.
drop function if exists public.coach_setup(text), public.coach_clients(), public.coach_assign(uuid, jsonb), public.coach_join(text, text);
drop function if exists public.coach_join_checked(uuid, uuid, text, text), public.coach_assign_checked(uuid, uuid, jsonb),
  public.summary_put(jsonb), public.assigned_take(), public.assigned_pending(), public.assigned_ack(text[]),
  public.coach_leave(), public.coach_remove(uuid);
drop function if exists public.coach_join_checked(uuid, uuid, text, text, uuid);

-- Only the coach-access Edge Function supplies the verified actor after checking the store subscription.
create or replace function public.coach_setup_checked(p_actor uuid, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_alpha constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; i int;
begin
  perform iron_atlas_private.moderation_lock();
  perform 1 from auth.users where id = p_actor for update;
  if not found then raise exception 'Account unavailable'; end if;
  select code into v_code from public.coaches where id = p_actor;
  if v_code is null then
    loop
      v_code := '';
      for i in 1..6 loop v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1); end loop;
      insert into public.coaches (id, name, code) values (p_actor, left(trim(p_name), 60), v_code)
        on conflict (code) do nothing;
      exit when found;
    end loop;
  else
    update public.coaches set name = left(trim(p_name), 60) where id = p_actor;
  end if;
  return jsonb_build_object('code', v_code, 'name', left(trim(p_name), 60));
end $$;

create or replace function public.coach_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'trainer', (select jsonb_build_object('name', c.name, 'code', c.code) from public.coaches c where c.id = auth.uid()),
    'coach', (select jsonb_build_object('id', c.id, 'name', c.name, 'since', l.joined_at) from public.coach_clients l join public.coaches c on c.id = l.coach_id
      join public.cloud_consent s on s.user_id = l.client_id and s.generation = l.consent_generation
      where l.client_id = auth.uid() and s.enabled and not s.cleanup_pending and s.version = '2026-11-02'
        and l.sharing_notice_version = '2026-11-02' and l.sharing_acknowledged_at is not null
        and iron_atlas_private.content_visible(c.id, auth.uid(), to_jsonb(c.name))));
$$;

create or replace function public.coach_join_target(p_code text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.coaches where code = upper(trim(p_code))
    and iron_atlas_private.content_visible(id, null, to_jsonb(name));
$$;

create or replace function public.coach_join_checked(p_actor uuid, p_trainer uuid, p_code text, p_name text, p_generation uuid, p_sharing_version text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text; v_previous uuid; v_acknowledged boolean;
begin
  perform iron_atlas_private.moderation_lock();
  if p_sharing_version is distinct from '2026-11-02' then
    raise exception 'Acknowledge the current trainer sharing notice before connecting';
  end if;
  if p_trainer = p_actor then raise exception 'That is your own trainer code'; end if;
  perform iron_atlas_private.require_publication(p_actor, to_jsonb(coalesce(p_name, '')));
  perform 1 from auth.users where id = p_actor for update;
  if not found then raise exception 'Account unavailable'; end if;
  perform iron_atlas_private.require_cloud(p_actor, p_generation);
  select name into v_name from public.coaches where id = p_trainer and code = upper(trim(p_code)) for update;
  if not found then raise exception 'No trainer has that code'; end if;
  if not iron_atlas_private.content_visible(p_trainer, p_actor, to_jsonb(v_name)) then
    raise exception 'This connection is unavailable.';
  end if;
  select coach_id, sharing_notice_version = '2026-11-02' and sharing_acknowledged_at is not null
    into v_previous, v_acknowledged from public.coach_clients where client_id = p_actor;
  if v_previous = p_trainer then
    if not coalesce(v_acknowledged, false) then
      update public.coach_clients set sharing_notice_version = p_sharing_version,
        sharing_acknowledged_at = clock_timestamp(), consent_generation = p_generation where client_id = p_actor;
    end if;
    return jsonb_build_object('name', v_name);
  end if;
  if v_previous is not null then
    if coalesce(v_acknowledged, false) then raise exception 'Disconnect from your current trainer before joining another'; end if;
    -- An inactive legacy connection can be replaced only by this explicit new sharing choice.
    delete from public.coach_clients where client_id = p_actor;
    delete from public.client_summaries where user_id = p_actor;
    delete from public.assigned_plans where client_id = p_actor;
  end if;
  if (select count(*) from public.coach_clients where coach_id = p_trainer) >= 500 then raise exception 'That trainer has no space for new clients'; end if;
  insert into public.coach_clients (client_id, coach_id, client_name, consent_generation, sharing_notice_version, sharing_acknowledged_at)
    values (p_actor, p_trainer, left(coalesce(trim(p_name), ''), 60), p_generation, p_sharing_version, clock_timestamp());
  return jsonb_build_object('name', v_name);
end $$;

create or replace function public.coach_leave(p_generation uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from auth.users where id = auth.uid() for no key update;
  perform iron_atlas_private.require_generation(auth.uid(), p_generation);
  delete from public.coach_clients where client_id = auth.uid();
  delete from public.client_summaries where user_id = auth.uid();
  delete from public.assigned_plans where client_id = auth.uid();
end;
$$;

create or replace function public.coach_clients_checked(p_actor uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', l.client_id, 'name', l.client_name, 'joined', l.joined_at, 'generation', l.consent_generation, 'summary', s.summary, 'updated', s.updated_at) order by l.joined_at), '[]'::jsonb)
  from public.coach_clients l left join public.client_summaries s on s.user_id = l.client_id
  join public.cloud_consent c on c.user_id = l.client_id and c.generation = l.consent_generation
  where l.coach_id = p_actor and c.enabled and not c.cleanup_pending and c.version = '2026-11-02'
    and l.sharing_notice_version = '2026-11-02' and l.sharing_acknowledged_at is not null
    and iron_atlas_private.content_visible(l.client_id, p_actor, to_jsonb(l.client_name))
    and (s.summary is null or iron_atlas_private.shared_text_allowed(s.summary));
$$;

create or replace function public.coach_remove(p_client uuid, p_generation uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from auth.users where id = p_client for no key update;
  perform iron_atlas_private.require_generation(p_client, p_generation);
  perform 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client for update;
  delete from public.assigned_plans where coach_id = auth.uid() and client_id = p_client;
  delete from public.client_summaries where user_id = p_client and exists (select 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client);
  delete from public.coach_clients where coach_id = auth.uid() and client_id = p_client;
end;
$$;

create or replace function public.coach_assign_checked(p_actor uuid, p_client uuid, p_plan jsonb, p_generation uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform iron_atlas_private.moderation_lock();
  perform 1 from auth.users where id = p_client for no key update;
  perform iron_atlas_private.require_cloud(p_client, p_generation);
  perform 1 from public.coach_clients where coach_id = p_actor and client_id = p_client and consent_generation = p_generation
    and sharing_notice_version = '2026-11-02' and sharing_acknowledged_at is not null for update;
  if not found then raise exception 'That person is not your client'; end if;
  if (select count(*) from public.assigned_plans where client_id = p_client) >= 20 then raise exception 'Your client has 20 plans waiting. They will collect them next time they open the app.'; end if;
  insert into public.assigned_plans (coach_id, client_id, plan) values (p_actor, p_client, p_plan);
end $$;

create or replace function public.summary_put(p_summary jsonb, p_generation uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform iron_atlas_private.moderation_lock();
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  perform iron_atlas_private.require_cloud(auth.uid(), p_generation);
  perform 1 from public.coach_clients where client_id = auth.uid() and consent_generation = p_generation
    and sharing_notice_version = '2026-11-02' and sharing_acknowledged_at is not null for share;
  if not found then return; end if;
  insert into public.client_summaries (user_id, summary, updated_at) values (auth.uid(), p_summary, now())
    on conflict (user_id) do update set summary = excluded.summary, updated_at = now();
end $$;

-- New clients read without consuming the queue, then acknowledge individual persisted IDs.
-- The pre-consent delivery and mutation signatures are deliberately removed.
create or replace function public.assigned_pending(p_generation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform iron_atlas_private.require_cloud(auth.uid(), p_generation);
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id::text, 'recipient', a.client_id, 'author', a.coach_id, 'plan', a.plan, 'coach', c.name, 'at', a.created_at)
    order by a.created_at, a.id), '[]'::jsonb) into result
  from public.assigned_plans a join public.coaches c on c.id = a.coach_id
  where a.client_id = auth.uid()
    and iron_atlas_private.content_visible(a.coach_id, auth.uid(), a.plan)
    and iron_atlas_private.shared_text_allowed(to_jsonb(c.name));
  return result;
end;
$$;

create or replace function public.assigned_ack(p_ids text[], p_generation uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform iron_atlas_private.require_cloud(auth.uid(), p_generation);
  delete from public.assigned_plans where client_id = auth.uid() and id::text = any(p_ids) and cardinality(p_ids) <= 20;
end;
$$;
revoke all on function public.assigned_pending(uuid), public.assigned_ack(text[], uuid) from public, anon;
grant execute on function public.assigned_pending(uuid), public.assigned_ack(text[], uuid) to authenticated;

revoke all on function public.coach_status(), public.coach_leave(uuid), public.coach_remove(uuid, uuid), public.summary_put(jsonb, uuid) from public, anon;
grant execute on function public.coach_status(), public.coach_leave(uuid), public.coach_remove(uuid, uuid), public.summary_put(jsonb, uuid) to authenticated;

revoke all on function public.coach_setup_checked(uuid, text), public.coach_join_target(text), public.coach_join_checked(uuid, uuid, text, text, uuid, text),
  public.coach_clients_checked(uuid), public.coach_assign_checked(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.coach_setup_checked(uuid, text), public.coach_join_target(text), public.coach_join_checked(uuid, uuid, text, text, uuid, text),
  public.coach_clients_checked(uuid), public.coach_assign_checked(uuid, uuid, jsonb, uuid) to service_role;

-- Relationship teardown keeps only the identity receipts needed to report an earlier
-- delivery. It never deletes the device's own saved plan or account documents.
create or replace function iron_atlas_private.detach_peers(p_user uuid, p_peer uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into iron_atlas_private.content_receipts(receiver_id, author_id, kind, reference)
    select client_id, coach_id, 'peer', coach_id::text from public.coach_clients
    where (client_id = p_user and (p_peer is null or coach_id = p_peer))
       or (coach_id = p_user and (p_peer is null or client_id = p_peer)) on conflict do nothing;
  insert into iron_atlas_private.content_receipts(receiver_id, author_id, kind, reference)
    select coach_id, client_id, 'peer', client_id::text from public.coach_clients
    where (client_id = p_user and (p_peer is null or coach_id = p_peer))
       or (coach_id = p_user and (p_peer is null or client_id = p_peer)) on conflict do nothing;
  delete from public.assigned_plans
    where (client_id = p_user and (p_peer is null or coach_id = p_peer))
       or (coach_id = p_user and (p_peer is null or client_id = p_peer));
  delete from public.client_summaries where user_id in (select client_id from public.coach_clients
    where (client_id = p_user and (p_peer is null or coach_id = p_peer))
       or (coach_id = p_user and (p_peer is null or client_id = p_peer)));
  delete from public.coach_clients
    where (client_id = p_user and (p_peer is null or coach_id = p_peer))
       or (coach_id = p_user and (p_peer is null or client_id = p_peer));
end $$;
revoke all on function iron_atlas_private.detach_peers(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.block_peer(p_peer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform iron_atlas_private.moderation_lock();
  perform 1 from auth.users where id = auth.uid() for share;
  if not found then raise exception 'Account unavailable' using errcode = '42501'; end if;
  if p_peer is null or p_peer = auth.uid() then raise exception 'Choose another account to block.'; end if;
  if exists (select 1 from auth.users where id = p_peer) then
    insert into iron_atlas_private.user_blocks(blocker_id, blocked_id) values (auth.uid(), p_peer) on conflict do nothing;
    perform iron_atlas_private.detach_peers(auth.uid(), p_peer);
  end if;
  return jsonb_build_object('blocked', true);
end $$;
create or replace function public.unblock_peer(p_peer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform iron_atlas_private.moderation_lock();
  if not exists (select 1 from auth.users where id = auth.uid()) then
    raise exception 'Account unavailable' using errcode = '42501';
  end if;
  delete from iron_atlas_private.user_blocks where blocker_id = auth.uid() and blocked_id = p_peer;
  return jsonb_build_object('blocked', false);
end $$;
create or replace function public.blocked_peers() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if not exists (select 1 from auth.users where id = auth.uid()) then
    raise exception 'Account unavailable' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', blocked_id, 'blocked_at', created_at) order by created_at), '[]'::jsonb)
    into result from iron_atlas_private.user_blocks where blocker_id = auth.uid();
  return result;
end $$;

create or replace function public.report_content(p_kind text, p_reference text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare subject uuid; report_id uuid;
begin
  perform iron_atlas_private.moderation_lock();
  perform 1 from auth.users where id = auth.uid() for share;
  if not found then raise exception 'Account unavailable' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('shared_plan', 'assigned_plan', 'peer')
    or p_reason is null or p_reason not in ('abuse', 'hate', 'sexual', 'violence', 'spam', 'other')
    or p_reference is null or length(p_reference) not between 1 and 128 then
    raise exception 'Choose the content and a report reason.';
  end if;
  select author_id into subject from iron_atlas_private.content_receipts
    where receiver_id = auth.uid() and kind = p_kind and reference = p_reference;
  if subject is null and p_kind = 'shared_plan' then
    select owner into subject from public.shared_plans where moderation_id::text = p_reference
      and iron_atlas_private.content_visible(owner, auth.uid(), plan)
      and iron_atlas_private.cloud_enabled(owner);
  elsif subject is null and p_kind = 'assigned_plan' then
    select coach_id into subject from public.assigned_plans where id::text = p_reference and client_id = auth.uid();
  elsif subject is null and p_kind = 'peer' then
    select author_id into subject from iron_atlas_private.content_receipts
      where receiver_id = auth.uid() and author_id::text = p_reference limit 1;
    if subject is null then
      select case when client_id = auth.uid() then coach_id else client_id end into subject from public.coach_clients
        where (client_id = auth.uid() and coach_id::text = p_reference)
           or (coach_id = auth.uid() and client_id::text = p_reference);
    end if;
  end if;
  if subject is null or subject = auth.uid() then raise exception 'This content is unavailable for reporting. Contact support if you need help.'; end if;
  select id into report_id from iron_atlas_private.content_reports where reporter_id = auth.uid()
    and kind = p_kind and reference = p_reference and status = 'open' limit 1;
  if report_id is not null then return jsonb_build_object('id', report_id, 'status', 'open'); end if;
  insert into iron_atlas_private.report_limits as r(user_id, started_at, attempts) values (auth.uid(), clock_timestamp(), 1)
    on conflict (user_id) do update set
      started_at = case when r.started_at <= clock_timestamp() - interval '1 hour' then clock_timestamp() else r.started_at end,
      attempts = case when r.started_at <= clock_timestamp() - interval '1 hour' then 1 else r.attempts + 1 end
    where r.started_at <= clock_timestamp() - interval '1 hour' or r.attempts < 10;
  if not found then raise exception 'Too many reports. Try again later or contact Iron Atlas support.'; end if;
  insert into iron_atlas_private.content_reports(reporter_id, subject_id, kind, reference, reason)
    values (auth.uid(), subject, p_kind, p_reference, p_reason) returning id into report_id;
  return jsonb_build_object('id', report_id, 'status', 'open');
end $$;
revoke all on function public.block_peer(uuid), public.unblock_peer(uuid), public.blocked_peers(),
  public.report_content(text, text, text) from public, anon;
grant execute on function public.block_peer(uuid), public.unblock_peer(uuid), public.blocked_peers(),
  public.report_content(text, text, text) to authenticated;

-- Owner operations are service-only. Live content is returned for review, never
-- copied into reports. Closing a case immediately removes its raw identifiers.
create or replace function public.moderation_list_reports(p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Choose a limit between 1 and 100.'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('content',
    case r.kind
      when 'shared_plan' then (select plan from public.shared_plans where moderation_id::text = r.reference and owner = r.subject_id)
      when 'assigned_plan' then (select plan from public.assigned_plans where id::text = r.reference and coach_id = r.subject_id)
      when 'peer' then jsonb_build_object(
        'trainer_name', (select name from public.coaches where id = r.subject_id),
        'client_name', (select client_name from public.coach_clients where client_id = r.subject_id and coach_id = r.reporter_id),
        'summary', (select s.summary from public.client_summaries s join public.coach_clients l on l.client_id = s.user_id
          where l.client_id = r.subject_id and l.coach_id = r.reporter_id))
    end) order by r.created_at), '[]'::jsonb) into result
  from (select * from iron_atlas_private.content_reports where status = 'open' order by created_at, id limit p_limit) r;
  return result;
end $$;
create or replace function public.moderation_set_publishing_suspended(p_user uuid, p_suspended boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform iron_atlas_private.moderation_lock();
  if p_suspended is null or not exists (select 1 from auth.users where id = p_user) then
    raise exception 'Choose an existing account and suspension state.';
  end if;
  insert into iron_atlas_private.publishing_controls(user_id, suspended) values (p_user, p_suspended)
    on conflict (user_id) do update set suspended = excluded.suspended, updated_at = clock_timestamp();
  if p_suspended then
    perform iron_atlas_private.detach_peers(p_user);
    delete from public.shared_plans where owner = p_user;
  end if;
  return jsonb_build_object('suspended', p_suspended);
end $$;
create or replace function public.moderation_resolve_report(p_id uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare item iron_atlas_private.content_reports; outcome text;
begin
  perform iron_atlas_private.moderation_lock();
  if p_action is null or p_action not in ('dismiss', 'remove', 'suspend') then raise exception 'Choose dismiss, remove or suspend.'; end if;
  select * into item from iron_atlas_private.content_reports where id = p_id for update;
  if not found then raise exception 'Report unavailable.'; end if;
  if item.status <> 'open' then return jsonb_build_object('id', item.id, 'status', item.status); end if;
  if p_action = 'suspend' then
    perform public.moderation_set_publishing_suspended(item.subject_id, true);
    outcome := 'suspended';
  elsif p_action = 'remove' then
    if item.kind = 'shared_plan' then
      delete from public.shared_plans where moderation_id::text = item.reference and owner = item.subject_id;
    elsif item.kind = 'assigned_plan' then
      delete from public.assigned_plans where id::text = item.reference and coach_id = item.subject_id;
    else raise exception 'Use suspend for an abusive account, or dismiss this report.'; end if;
    outcome := 'removed';
  else outcome := 'dismissed'; end if;
  update iron_atlas_private.content_reports set status = outcome where id = item.id;
  return jsonb_build_object('id', item.id, 'status', outcome);
end $$;
revoke all on function public.moderation_list_reports(integer), public.moderation_set_publishing_suspended(uuid, boolean),
  public.moderation_resolve_report(uuid, text) from public, anon, authenticated;
grant execute on function public.moderation_list_reports(integer), public.moderation_set_publishing_suspended(uuid, boolean),
  public.moderation_resolve_report(uuid, text) to service_role;

create or replace function public.begin_cloud_withdrawal(p_expected_generation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.cloud_consent;
begin
  perform 1 from auth.users where id = auth.uid() for no key update;
  if not found then raise exception 'Account unavailable' using errcode = '42501'; end if;
  select * into c from public.cloud_consent where user_id = auth.uid();
  if p_expected_generation is distinct from c.generation then raise exception 'Consent changed. Refresh consent status.'; end if;
  -- A completed withdrawal is an idempotent no-op. A new grant always has a new generation.
  if c.withdrawn_at is not null and not c.cleanup_pending then return public.cloud_consent_status(); end if;
  if c.withdrawn_at is null then
    if exists (select 1 from public.photo_removal_intents where user_id = auth.uid() and completed_at is null) then
      raise exception 'Photo removal is in progress. Resume it before turning off backup.';
    end if;
    insert into public.cloud_consent(user_id, generation, version, enabled, cleanup_pending, withdrawn_at)
      values (auth.uid(), coalesce(c.generation, gen_random_uuid()), '2026-11-02', false, true, clock_timestamp())
    on conflict (user_id) do update set enabled = false, cleanup_pending = true, withdrawn_at = excluded.withdrawn_at;
    insert into public.cloud_consent_receipts(user_id, generation, version, action)
      select user_id, generation, version, 'withdraw' from public.cloud_consent where user_id = auth.uid();
  end if;
  -- Revoke personal sharing immediately. Keep only the owner's frozen document/photo copy for recovery.
  delete from public.coach_clients where client_id = auth.uid();
  delete from public.client_summaries where user_id = auth.uid();
  delete from public.assigned_plans where client_id = auth.uid();
  delete from public.shared_plans where owner = auth.uid();
  return public.cloud_consent_status();
end $$;

create or replace function public.finish_cloud_withdrawal(p_generation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.cloud_consent;
begin
  perform 1 from auth.users where id = auth.uid() for no key update;
  if not found then raise exception 'Account unavailable' using errcode = '42501'; end if;
  select * into c from public.cloud_consent where user_id = auth.uid();
  if c.generation is null or p_generation is distinct from c.generation or c.enabled then
    raise exception 'Consent changed. Refresh consent status.';
  end if;
  if not c.cleanup_pending then return public.cloud_consent_status(); end if;
  if c.withdrawn_at is null then raise exception 'Begin cloud removal first'; end if;
  if exists (select 1 from public.photo_removal_intents where user_id = auth.uid() and completed_at is null) then
    raise exception 'Photo removal is in progress. Resume it before finishing.';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'progress-photos' and name like auth.uid()::text || '/%') then
    raise exception 'Progress photos still need to be removed. Please retry cloud removal.';
  end if;
  delete from public.app_state where user_id = auth.uid();
  delete from public.photo_removal_intents where user_id = auth.uid();
  update public.cloud_consent set cleanup_pending = false where user_id = auth.uid();
  insert into public.cloud_consent_receipts(user_id, generation, version, action)
    values (auth.uid(), c.generation, c.version, 'cleanup');
  return public.cloud_consent_status();
end $$;
revoke all on function public.begin_cloud_withdrawal(uuid), public.finish_cloud_withdrawal(uuid) from public, anon;
grant execute on function public.begin_cloud_withdrawal(uuid), public.finish_cloud_withdrawal(uuid) to authenticated;

-- Preserve legacy content for removal/recovery, without treating old use as consent.
-- No grant/withdraw receipt is invented by this upgrade. A fresh grant requires cleanup first.
insert into public.cloud_consent(user_id, generation, version, enabled, cleanup_pending)
select u.id, gen_random_uuid(), '2026-11-02', false, true from auth.users u
where exists (select 1 from public.app_state where user_id = u.id)
   or exists (select 1 from public.shared_plans where owner = u.id)
   or exists (select 1 from public.coach_clients where client_id = u.id)
   or exists (select 1 from public.client_summaries where user_id = u.id)
   or exists (select 1 from public.assigned_plans where client_id = u.id)
   or exists (select 1 from storage.objects where bucket_id = 'progress-photos' and name like u.id::text || '/%')
on conflict (user_id) do nothing;
commit;
