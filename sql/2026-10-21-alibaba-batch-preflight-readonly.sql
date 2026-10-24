-- Read-only recovery preflight in the EXISTING project. One result row.
-- No task starts, updates, network calls or purchase-record scans.
begin read only;
set local lock_timeout='2s';
set local statement_timeout='8s';
select jsonb_pretty(jsonb_build_object(
  'cron', (select jsonb_agg(jsonb_build_object('name',jobname,'schedule',schedule,'active',active))
    from cron.job where jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery')),
  'running', (select jsonb_agg(to_jsonb(r)) from
    (select id,state,created_at,lease_until from public.alibaba_sync_runs where state='running' limit 1) r),
  'tables', (select jsonb_agg(jsonb_build_object('name',c.relname,'estimated_rows',c.reltuples::bigint,
    'total_size',pg_size_pretty(pg_total_relation_size(c.oid))))
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    and c.relname in ('purchase_records','alibaba_purchase_links','alibaba_sync_runs','alibaba_sync_jobs')),
  'indexes', (select jsonb_agg(jsonb_build_object('table',tablename,'name',indexname,'definition',indexdef))
    from pg_indexes where schemaname='public' and tablename in ('alibaba_sync_runs','alibaba_sync_jobs'))
)) as recovery_preflight;
commit;
