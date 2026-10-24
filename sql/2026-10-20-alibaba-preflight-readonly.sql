-- READ ONLY: one SELECT returns one row. No business records or credentials.
with required_columns(table_name, column_name, expected_type) as (
  values ('profiles','id','uuid'), ('profiles','email','text'),
    ('profiles','role',null::text), ('purchase_records','id','text'),
    ('purchase_records','assigned_buyer_email','text'),
    ('purchase_records','assigned_buyer_name','text')
), checked_columns as (
  select r.*, c.data_type as actual_type, c.udt_name,
    c.column_name is not null and (r.expected_type is null or c.data_type = r.expected_type) as ok
  from required_columns r left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = r.table_name and c.column_name = r.column_name
), relations as (
  select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as force_rls
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('profiles','purchase_records','purchase_pools')
), existing_tables as (
  select c.relname as existing_name, c.relkind
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in
    ('alibaba_buyer_accounts','alibaba_purchase_links','purchase_logistics_summaries')
), existing_functions as (
  select p.proname as existing_name, pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('can_read_alibaba_purchase','save_alibaba_purchase_link')
), policies as (
  select tablename, policyname, roles, cmd, qual, with_check from pg_catalog.pg_policies
  where schemaname = 'public' and tablename in ('profiles','purchase_records','purchase_pools')
), event_triggers as (
  select evtname, evtevent, evtenabled, evtfoid::regproc::text as handler from pg_catalog.pg_event_trigger
), keys as (
  select t.relname as table_name, con.conname, con.contype,
    pg_catalog.pg_get_constraintdef(con.oid) as definition
  from pg_catalog.pg_constraint con join pg_catalog.pg_class t on t.oid = con.conrelid
  join pg_catalog.pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public' and t.relname in ('profiles','purchase_records') and con.contype in ('p','u')
)
select
  case
    when exists (select 1 from checked_columns where not ok) then 'STOP: required columns missing or incompatible'
    when exists (select 1 from existing_tables) or exists (select 1 from existing_functions) then 'STOP: same-name objects already exist'
    else 'REVIEW: structural checks passed; inspect details before migration'
  end as check_result,
  jsonb_pretty(jsonb_build_object(
    'database', current_database(), 'executing_role', current_user,
    'columns', (select jsonb_agg(to_jsonb(x) order by table_name,column_name) from checked_columns x),
    'primary_unique_keys', coalesce((select jsonb_agg(to_jsonb(x) order by table_name,conname) from keys x),'[]'::jsonb),
    'rls', coalesce((select jsonb_agg(to_jsonb(x) order by table_name) from relations x),'[]'::jsonb),
    'policies', coalesce((select jsonb_agg(to_jsonb(x) order by tablename,policyname) from policies x),'[]'::jsonb),
    'existing_1688_tables', coalesce((select jsonb_agg(to_jsonb(x)) from existing_tables x),'[]'::jsonb),
    'existing_1688_functions', coalesce((select jsonb_agg(to_jsonb(x)) from existing_functions x),'[]'::jsonb),
    'event_triggers', coalesce((select jsonb_agg(to_jsonb(x) order by evtname) from event_triggers x),'[]'::jsonb),
    'note', 'Read only; no database changes. REVIEW is not approval to run migration.'
  )) as report;
