-- Re-enable only the existing five-record pilot; no HTTP dispatch here.
-- Keep the completed success/failure and resume pending records on button click.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
do $$
declare v_run public.alibaba_sync_runs%rowtype;
begin
  perform 1 from public.alibaba_sync_control where id and not auto_enabled
    and record_limit=5 for update;
  if not found then raise exception 'Unexpected synchronization policy'; end if;
  if exists(select 1 from cron.job where active and jobname in
    ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery')) then
    raise exception 'Logistics cron must remain paused';
  end if;
  select * into v_run from public.alibaba_sync_runs
    where id='c5a5522b-0116-429e-a54c-c24b55d81cb2' for update;
  if not found or v_run.state<>'running' or v_run.record_limit is distinct from 5
    or v_run.actor_id is null or v_run.lease_until>now() then
    raise exception 'Pilot run is not ready for reviewed resumption';
  end if;
  if (select count(*) from public.alibaba_sync_jobs where run_id=v_run.id)<>5
    or exists(select 1 from public.alibaba_sync_jobs where run_id=v_run.id and state='processing') then
    raise exception 'Unexpected pilot queue; inspect before resuming';
  end if;
  update public.alibaba_sync_control set manual_enabled=true,auto_enabled=false where id;
end $$;
select jsonb_build_object('manualEnabled',manual_enabled,'autoEnabled',auto_enabled,
  'recordLimit',record_limit,'runId','c5a5522b-0116-429e-a54c-c24b55d81cb2',
  'startsOnButtonClick',true) as pilot_resume_control
from public.alibaba_sync_control where id;
commit;
