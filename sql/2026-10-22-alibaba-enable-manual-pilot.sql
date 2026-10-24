-- Enable only the approved manual pilot. Does not start a run or enable cron.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '8s';
do $$
begin
  if exists(select 1 from cron.job where jobname in
    ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery') and active) then
    raise exception 'Pause logistics cron before enabling the manual pilot';
  end if;
  if exists(select 1 from public.alibaba_sync_runs where state='running') then
    raise exception 'A running logistics batch requires review first';
  end if;
  update public.alibaba_sync_control
    set manual_enabled=true, auto_enabled=false, record_limit=5
    where id=true;
  if not found then
    raise exception 'Recovery control row is missing';
  end if;
end $$;
select jsonb_build_object(
  'manualEnabled',manual_enabled,
  'autoEnabled',auto_enabled,
  'recordLimit',record_limit,
  'cron', (select jsonb_agg(jsonb_build_object('name',jobname,'active',active))
    from cron.job where jobname in
    ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery'))
) as manual_pilot_control
from public.alibaba_sync_control where id=true;
commit;
