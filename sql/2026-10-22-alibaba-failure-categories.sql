-- Existing project only. No dispatch, backfill, business edits or sync enablement.
begin;
set local lock_timeout='3s';
set local statement_timeout='15s';
do $$ begin
  if exists(select 1 from public.alibaba_sync_control where manual_enabled or auto_enabled)
    or exists(select 1 from cron.job where active and jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery')) then
    raise exception 'Pause Alibaba sync and both cron jobs before installation';
  end if;
end $$;

alter table public.alibaba_sync_jobs add column if not exists failure_code text,
  add column if not exists retryable boolean;

create or replace function public.finish_alibaba_sync_item_v2(p_run uuid,p_record text,p_version integer,p_snapshot jsonb,p_failed boolean,p_claim uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_code text;
begin
  perform public.assert_alibaba_claim_v2(p_run,p_claim);
  perform 1 from public.alibaba_sync_jobs where run_id=p_run and record_id=p_record and state='processing' for update;
  if not found then return; end if;
  perform public.finish_alibaba_sync_item(p_run,p_record,p_version,p_snapshot,p_failed);
  if p_failed then
    v_code:=case when p_snapshot->>'failure_code' in
      ('NETWORK','RATE_LIMIT','UPSTREAM','AUTHORIZATION','ORDER_OWNERSHIP','CONFIGURATION',
       'TRACE_UNAVAILABLE','RESPONSE_FORMAT','UPSTREAM_REJECTED','INVALID_TARGET','UNCLASSIFIED')
      then p_snapshot->>'failure_code' else 'UNCLASSIFIED' end;
    update public.alibaba_sync_jobs set failure_code=v_code,retryable=v_code in ('NETWORK','RATE_LIMIT')
      where run_id=p_run and record_id=p_record and state='failed';
  else
    update public.alibaba_sync_jobs set failure_code=null,retryable=null
      where run_id=p_run and record_id=p_record and state='success';
  end if;
end $$;
revoke all on function public.finish_alibaba_sync_item_v2(uuid,text,integer,jsonb,boolean,uuid) from public,anon,authenticated;
grant execute on function public.finish_alibaba_sync_item_v2(uuid,text,integer,jsonb,boolean,uuid) to service_role;
commit;

-- Historical NULL means not recorded, never a reconstructed diagnosis.
-- Only two latest runs, bounded pilot jobs; no tokens, claims, names or remarks.
with recent as (select id,created_at from public.alibaba_sync_runs order by created_at desc,id desc limit 2)
select jsonb_build_object(
  'installed',exists(select 1 from information_schema.columns where table_schema='public' and table_name='alibaba_sync_jobs' and column_name='failure_code'),
  'manualEnabled',(select manual_enabled from public.alibaba_sync_control where id),
  'autoEnabled',(select auto_enabled from public.alibaba_sync_control where id),
  'failedTargets',coalesce((select jsonb_agg(jsonb_build_object(
    'runId',j.run_id,'recordId',j.record_id,'linkVersion',j.link_version,
    'account',l.account_code,'orderIds',l.order_ids,
    'failureCode',coalesce(j.failure_code,'HISTORICAL_UNCLASSIFIED'),
    'retryable',j.retryable,'attemptedAt',j.attempted_at,
    'associationUnchanged',l.version=j.link_version))
    from recent r join public.alibaba_sync_jobs j on j.run_id=r.id
    left join public.alibaba_purchase_links l on l.purchase_record_id=j.record_id
    where j.state='failed'),'[]'::jsonb)
) as failure_diagnostics;
