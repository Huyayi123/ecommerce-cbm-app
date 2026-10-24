-- Read-only, bounded pilot report. No credentials, claims, names or raw traces.
begin transaction read only;
set local statement_timeout='8s';
with latest as (
  select * from public.alibaba_sync_runs where record_limit=5 order by created_at desc,id desc limit 1
)
select jsonb_build_object(
  'manualEnabled',(select manual_enabled from public.alibaba_sync_control where id),
  'autoEnabled',(select auto_enabled from public.alibaba_sync_control where id),
  'recordLimit',(select record_limit from public.alibaba_sync_control where id),
  'cron',(select jsonb_agg(jsonb_build_object('name',jobname,'active',active)) from cron.job
    where jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery')),
  'run',(select jsonb_build_object('runId',r.id,'state',r.state,'createdAt',r.created_at,
    'finishedAt',r.finished_at,'durationSeconds',extract(epoch from coalesce(r.finished_at,now())-r.created_at),
    'stopReason',r.stop_reason,'jobs',(select jsonb_agg(jsonb_build_object(
      'recordId',j.record_id,'state',j.state,'attempts',j.attempts,'failureCode',j.failure_code,
      'retryable',j.retryable,'associationUnchanged',l.version=j.link_version,
      'summaryCurrent',s.link_version=j.link_version,'summaryStatus',s.status,
      'signedAt',s.signed_at,'latestTraceAt',s.latest_trace_at,'syncError',s.sync_error)
      order by j.record_id) from public.alibaba_sync_jobs j
      left join public.alibaba_purchase_links l on l.purchase_record_id=j.record_id
      left join public.purchase_logistics_summaries s on s.purchase_record_id=j.record_id
      where j.run_id=r.id)) from latest r)
) as fulfillment_pilot_result;
commit;
