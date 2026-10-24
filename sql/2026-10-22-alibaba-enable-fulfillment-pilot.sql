-- Enable the reviewed MANUAL FIVE-RECORD pilot only.
-- This file does not start a run, dispatch HTTP, enable cron or edit purchases.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
do $$ begin
  if to_regprocedure('public.alibaba_approved_fulfillment_context(text,integer)') is null
    or to_regprocedure('public.alibaba_courier_retry_blocked(text,integer)') is null
    or strpos(pg_get_functiondef('public.claim_alibaba_sync_v2(uuid)'::regprocedure),'fulfillmentProtocol')=0
    or strpos(pg_get_functiondef('public.alibaba_sync_policy_v2(uuid)'::regprocedure),'fulfillmentProtocol')=0 then
    raise exception 'Install the reviewed batch fulfillment protocol first';
  end if;
  perform 1 from public.alibaba_sync_control where id for update;
  if not found then raise exception 'Recovery control row missing';end if;
  if exists(select 1 from public.alibaba_sync_control where auto_enabled) then
    raise exception 'Automatic sync must remain paused';
  end if;
  if exists(select 1 from cron.job where active and jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery')) then
    raise exception 'Both Alibaba cron jobs must remain paused';
  end if;
  if exists(select 1 from public.alibaba_sync_runs where state='running') then
    raise exception 'Review the existing unfinished run before starting another pilot';
  end if;
  update public.alibaba_sync_control set manual_enabled=true,auto_enabled=false,record_limit=5 where id;
end $$;
select jsonb_build_object('manualEnabled',manual_enabled,'autoEnabled',auto_enabled,
  'recordLimit',record_limit,'fulfillmentProtocol',1,
  'cron',(select jsonb_agg(jsonb_build_object('name',jobname,'active',active)) from cron.job
    where jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery'))
) as fulfillment_pilot_control from public.alibaba_sync_control where id;
commit;
