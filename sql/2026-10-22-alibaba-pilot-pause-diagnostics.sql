-- Pause first; preserve runs, job states, snapshots and business data for diagnosis.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
update public.alibaba_sync_control set manual_enabled=false,auto_enabled=false where id;
select cron.alter_job(jobid,active:=false) from cron.job
where jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery');
commit;

-- Do not return worker tokens, claims, order IDs, raw remarks or contact details.
select jsonb_build_object(
  'checkedAt',now(),
  'control',(select jsonb_build_object('manualEnabled',manual_enabled,
    'autoEnabled',auto_enabled,'recordLimit',record_limit)
    from public.alibaba_sync_control where id),
  'runs',(select jsonb_agg(x.report) from (
    select jsonb_build_object('id',r.id,'state',r.state,'createdAt',r.created_at,
      'finishedAt',r.finished_at,'leaseUntil',r.lease_until,
      'leaseExpired',r.lease_until<now(),'dispatchFailures',r.dispatch_failures,
      'stopReason',r.stop_reason,'recordLimit',r.record_limit,
      'hasDispatchToken',r.token is not null,'hasActiveClaim',r.active_claim is not null,
      'jobs',(select jsonb_agg(jsonb_build_object('state',j.state,
        'attempts',j.attempts,'attemptedAt',j.attempted_at))
        from public.alibaba_sync_jobs j where j.run_id=r.id)) as report
    from public.alibaba_sync_runs r order by r.created_at desc limit 3
  ) x),
  'workerResponses',(select jsonb_agg(x.report) from (
    select jsonb_build_object('at',created,'status',status_code,'timedOut',timed_out,
      'error',case when content ~ '^\s*\{' then
        substring(content from '"error"\s*:\s*"([A-Z0-9_]{1,80})"') end,
      'databaseCode',case when content ~ '^\s*\{' then
        substring(content from '"databaseCode"\s*:\s*"([A-Z0-9]{5,10})"') end) as report
    from net._http_response
    where created>now()-interval '2 hours'
      and (content like '%SYNC_%' or content like '%"ok":true%' or timed_out)
    order by created desc limit 12
  ) x)
) as pilot_diagnostics;
