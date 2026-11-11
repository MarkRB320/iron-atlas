-- Read-only. Run on the explicitly selected Iron Atlas project before the consent upgrade.
-- Every prerequisite must be true. Review any unexpected policy before applying the full SQL.
select
  current_database() as database_name,
  to_regclass('auth.users') is not null as auth_users_present,
  to_regclass('storage.objects') is not null as storage_objects_present,
  to_regprocedure('auth.uid()') is not null as auth_uid_present,
  to_regprocedure('storage.foldername(text)') is not null as storage_foldername_present,
  to_regprocedure('storage.allow_any_operation(text[])') is not null as storage_operations_present,
  exists(select 1 from pg_roles where rolname = 'anon') as anon_present,
  exists(select 1 from pg_roles where rolname = 'authenticated') as authenticated_present,
  exists(select 1 from pg_roles where rolname = 'service_role') as service_role_present;

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check,
  case
    when schemaname = 'public' and tablename = 'app_state' then
      policyname in ('Read own records', 'Add own records', 'Change own records', 'Delete own records')
    when schemaname = 'public' and tablename = 'shared_plans' then
      policyname in ('Share own plans', 'See own plans', 'Remove own plans')
    when schemaname = 'storage' and tablename = 'objects' then
      policyname in ('Read own photos', 'Upload own photos', 'Replace own photos', 'Delete own photos')
    else false
  end as expected_iron_atlas_policy
from pg_policies
where (schemaname = 'storage' and tablename = 'objects')
   or (schemaname = 'public' and tablename in
     ('app_state', 'shared_plans', 'cloud_consent', 'cloud_consent_receipts', 'coaches',
      'coach_clients', 'client_summaries', 'assigned_plans', 'coach_request_limits', 'photo_removal_intents',
      'account_erasure_settings', 'account_erasure_jobs'))
order by schemaname, tablename, policyname;

select p.oid::regprocedure::text as function_name,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'storage' and p.proname in ('foldername', 'allow_any_operation');
