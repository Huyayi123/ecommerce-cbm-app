-- Supplementary READ ONLY check: one SELECT, no business rows or credentials.
-- RLS alone cannot establish whether role/email and assignment fields are protected.
with triggers as (
  select n.nspname as schema_name, c.relname as table_name, t.tgname,
    pg_catalog.pg_get_triggerdef(t.oid) as definition,
    pg_catalog.pg_get_functiondef(t.tgfoid) as handler_definition
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and n.nspname = 'public' and c.relname in ('profiles','purchase_records')
), grants as (
  select grantee, table_name, privilege_type
  from information_schema.table_privileges
  where table_schema = 'public' and table_name in ('profiles','purchase_records')
    and grantee in ('anon','authenticated','PUBLIC')
), column_grants as (
  select grantee, table_name, column_name, privilege_type
  from information_schema.column_privileges
  where table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')
    and ((table_name = 'profiles' and column_name in ('id','role','email','buyer_name'))
      or (table_name = 'purchase_records' and column_name in ('id','assigned_buyer_email','assigned_buyer_name')))
), helpers as (
  select p.proname, pg_catalog.pg_get_functiondef(p.oid) as definition
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('current_role','is_admin','is_editor') and p.prokind = 'f'
), ddl_handlers as (
  select e.evtname, pg_catalog.pg_get_functiondef(e.evtfoid) as definition
  from pg_catalog.pg_event_trigger e where e.evtenabled <> 'D' and e.evtevent = 'ddl_command_end'
)
select jsonb_pretty(jsonb_build_object(
  'triggers', coalesce((select jsonb_agg(to_jsonb(x) order by table_name,tgname) from triggers x),'[]'::jsonb),
  'table_grants', coalesce((select jsonb_agg(to_jsonb(x) order by table_name,grantee,privilege_type) from grants x),'[]'::jsonb),
  'column_grants', coalesce((select jsonb_agg(to_jsonb(x) order by table_name,column_name,grantee,privilege_type) from column_grants x),'[]'::jsonb),
  'role_helpers', coalesce((select jsonb_agg(to_jsonb(x) order by proname) from helpers x),'[]'::jsonb),
  'ddl_handlers', coalesce((select jsonb_agg(to_jsonb(x) order by evtname) from ddl_handlers x),'[]'::jsonb)
)) as report;
