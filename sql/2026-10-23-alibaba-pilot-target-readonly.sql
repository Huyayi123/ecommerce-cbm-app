-- Read only. Inspect latest five-record run and the reported SKU/order.
-- No raw trace text, contacts, names, addresses, tokens or worker capabilities.
begin transaction read only;
set local statement_timeout='8s';
with latest as (
 select id,state,created_at,finished_at,stop_reason
 from public.alibaba_sync_runs where record_limit=5
 order by created_at desc,id desc limit 1
), targets as (
 select p.id,p.sku from public.purchase_records p
 where p.sku='9902306307429'
    or exists(select 1 from public.alibaba_purchase_links l
              where l.purchase_record_id=p.id and l.order_ids @> array['5127371247091045347'::text])
 order by p.id limit 21
)
select jsonb_build_object(
 'latestRun',(select to_jsonb(r) from latest r),
 'jobs',(select coalesce(jsonb_agg(jsonb_build_object(
   'recordId',j.record_id,'state',j.state,'attemptedAt',j.attempted_at,
   'failureCode',j.failure_code,'retryable',j.retryable
 ) order by j.record_id),'[]'::jsonb)
 from public.alibaba_sync_jobs j where j.run_id=(select id from latest)),
 'targets',(select coalesce(jsonb_agg(jsonb_build_object(
   'recordId',p.id,'sku',p.sku,'account',l.account_code,'orderIds',l.order_ids,
   'linkVersion',l.version,'includedInLatestRun',j.record_id is not null,
   'jobState',j.state,'jobVersion',j.link_version,'attemptedAt',j.attempted_at,
   'failureCode',j.failure_code,'summaryStatus',s.status,
   'summaryCurrent',s.link_version=l.version,'lastAttemptAt',s.last_attempt_at,
   'lastSuccessAt',s.last_success_at,'signedAt',s.signed_at,
   'latestTraceAt',s.latest_trace_at,'syncError',s.sync_error,
   'logisticsIds',(select coalesce(jsonb_agg(x->>'logisticsId'),'[]'::jsonb)
     from jsonb_array_elements(case when jsonb_typeof(s.evidence->'shipments')='array'
       then s.evidence->'shipments' else '[]'::jsonb end) x)
 ) order by p.id),'[]'::jsonb)
 from targets p
 left join public.alibaba_purchase_links l on l.purchase_record_id=p.id
 left join public.purchase_logistics_summaries s on s.purchase_record_id=p.id
 left join public.alibaba_sync_jobs j on j.record_id=p.id and j.run_id=(select id from latest))
) as pilot_target_check;
commit;
