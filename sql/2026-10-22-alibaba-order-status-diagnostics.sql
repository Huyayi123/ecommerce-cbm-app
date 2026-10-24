-- Pause the pilot, then inspect only the reported order's sanitized status evidence.
-- No deletion, snapshot correction, HTTP dispatch or purchase changes.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
update public.alibaba_sync_control set manual_enabled=false,auto_enabled=false where id;
select cron.alter_job(jobid,active:=false) from cron.job
where jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery');
commit;

select jsonb_build_object(
  'checkedAt',now(),
  'control',(select jsonb_build_object('manualEnabled',manual_enabled,
    'autoEnabled',auto_enabled,'recordLimit',record_limit)
    from public.alibaba_sync_control where id),
  'reportedOrder','5127377259011018519',
  'matches',(select jsonb_agg(jsonb_build_object(
    'recordId',l.purchase_record_id,'account',l.account_code,
    'orderIds',l.order_ids,'linkVersion',l.version,
    'summaryVersion',s.link_version,'status',s.status,
    'shipmentCount',s.shipment_count,'signedCount',s.signed_count,
    'coverageConfirmed',s.coverage_confirmed,'mappingVersion',s.mapping_version,
    'lastSuccessAt',s.last_success_at,'lastAttemptAt',s.last_attempt_at,
    'syncError',s.sync_error,'signedAt',s.signed_at,'latestTraceAt',s.latest_trace_at,
    'queriedOrderIds',s.evidence->'queried_order_ids',
    'shipments',(select jsonb_agg(jsonb_build_object(
      'orderId',e->>'orderId','rawStatus',e->>'rawStatus',
      'signedAt',e->>'signedAt','signedAtSource',e->>'signedAtSource',
      'latestTraceAt',e->>'latestTraceAt'))
      from jsonb_array_elements(case when jsonb_typeof(s.evidence->'shipments')='array'
        then s.evidence->'shipments' else '[]'::jsonb end) e)
    )) from public.alibaba_purchase_links l
    left join public.purchase_logistics_summaries s on s.purchase_record_id=l.purchase_record_id
    where '5127377259011018519'=any(l.order_ids)),
  'latestRuns',(select jsonb_agg(x.report) from (
    select jsonb_build_object('id',r.id,'state',r.state,'createdAt',r.created_at,
      'finishedAt',r.finished_at,'leaseUntil',r.lease_until,'stopReason',r.stop_reason,
      'jobs',(select jsonb_agg(jsonb_build_object('state',j.state,'attempts',j.attempts))
        from public.alibaba_sync_jobs j where j.run_id=r.id)) as report
    from public.alibaba_sync_runs r order by r.created_at desc limit 2
  ) x)
) as order_status_diagnostics;
