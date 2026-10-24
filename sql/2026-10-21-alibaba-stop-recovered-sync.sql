-- Emergency pause after the recovery migration. No purchase/snapshot deletion.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
update public.alibaba_sync_control set manual_enabled=false,auto_enabled=false where id;
select cron.alter_job(jobid,active:=false) from cron.job
where jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery');
commit;
select jsonb_build_object(
  'control',(select jsonb_build_object('manualEnabled',manual_enabled,'autoEnabled',auto_enabled) from public.alibaba_sync_control where id),
  'cron',(select jsonb_agg(jsonb_build_object('name',jobname,'active',active)) from cron.job
    where jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery'))
) as sync_pause_state;
