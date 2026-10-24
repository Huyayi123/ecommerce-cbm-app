-- Check only the six order numbers from the reported save-error screenshot.
-- SQL Editor, read only; no trace remarks, contacts, secrets or raw errors.
with targets(order_id) as (values
 ('5127546710096118043'::text),('5127877405326026842'::text),
 ('5127549302301026842'::text),('5127548834288081216'::text),
 ('5127371535290081216'::text),('5127818940309026842'::text)
)
select t.order_id,count(l.purchase_record_id)::integer as saved_link_count,
 coalesce(jsonb_agg(jsonb_build_object(
  'recordId',l.purchase_record_id,'account',l.account_code,'version',l.version,
  'summaryStatus',s.status,'summaryCurrent',s.link_version=l.version,
  'signedAt',s.signed_at,'latestTraceAt',s.latest_trace_at,
  'lastSuccessAt',s.last_success_at,'syncError',s.sync_error
 ) order by l.purchase_record_id) filter(where l.purchase_record_id is not null),'[]'::jsonb) as matches
from targets t
left join public.alibaba_purchase_links l on l.order_ids @> array[t.order_id]
left join public.purchase_logistics_summaries s on s.purchase_record_id=l.purchase_record_id
group by t.order_id order by t.order_id;
