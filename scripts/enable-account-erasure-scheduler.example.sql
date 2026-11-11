-- Copy and replace every REPLACE_WITH_REVENUECAT_PROJECT_ID with your own project identifier.
-- Apply after the worker's authenticated smoke test returns HTTP 200.
begin;

do $$ begin
  if 'REPLACE_WITH_REVENUECAT_PROJECT_ID' like 'REPLACE_%' then
    raise exception 'Replace the project placeholder before applying this template';
  end if;
end $$;
do $$
begin
  if exists (select 1 from public.account_erasure_settings where project_id is not null and project_id <> 'REPLACE_WITH_REVENUECAT_PROJECT_ID') then
    raise exception 'Unexpected RevenueCat project in erasure settings';
  end if;
  if exists (select 1 from cron.job where jobname = 'iron-atlas-account-erasure'
    and command <> 'select iron_atlas_private.run_account_erasure_worker();') then
    raise exception 'Unexpected existing erasure scheduler';
  end if;
end $$;
insert into public.account_erasure_settings(singleton, enabled, project_id)
values (true, true, 'REPLACE_WITH_REVENUECAT_PROJECT_ID')
on conflict (singleton) do update set enabled = true, project_id = excluded.project_id;
select cron.schedule('iron-atlas-account-erasure', '*/5 * * * *',
  'select iron_atlas_private.run_account_erasure_worker();');
commit;
select jobid, jobname, schedule, active from cron.job where jobname = 'iron-atlas-account-erasure';
