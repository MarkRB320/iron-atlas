-- Copy and replace every REPLACE_WITH_SUPABASE_PROJECT_REF with your own project identifier.
-- Run only on the dedicated Iron Atlas project after deploying the erasure schema.
-- Each scheduled invocation uses an expiring token that authorizes one bounded drain.
begin;

do $$ begin
  if 'REPLACE_WITH_SUPABASE_PROJECT_REF' like 'REPLACE_%' then
    raise exception 'Replace the project placeholder before applying this template';
  end if;
end $$;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto with schema extensions;

create or replace function iron_atlas_private.run_account_erasure_worker()
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare worker_token text; request_id bigint;
begin
  worker_token := encode(extensions.gen_random_bytes(32), 'hex');
  delete from iron_atlas_private.account_erasure_invocations where expires_at <= clock_timestamp();
  insert into iron_atlas_private.account_erasure_invocations(token_hash, expires_at)
    values (encode(extensions.digest(worker_token, 'sha256'), 'hex'), clock_timestamp() + interval '120 seconds');
  select net.http_post(
    url := 'https://REPLACE_WITH_SUPABASE_PROJECT_REF.supabase.co/functions/v1/account-erasure',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || worker_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end $$;
revoke all on function iron_atlas_private.run_account_erasure_worker() from public, anon, authenticated, service_role;
commit;
select 'One-use scheduler prepared' as result;
