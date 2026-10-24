-- One EXPLAIN result for manual pilot, future automatic eligibility and pending lookup.
-- Plans only: no ANALYZE, actual synchronization, HTTP or business writes.
begin read only;
set local lock_timeout='2s';
set local statement_timeout='8s';
explain (format text,costs true)
(select 'manual_pilot'::text as phase,l.purchase_record_id as record_id,l.version
from public.alibaba_purchase_links l
join public.purchase_records p on p.id=l.purchase_record_id
join public.alibaba_purchase_access a on a.purchase_record_id=l.purchase_record_id and a.account_code=l.account_code
join public.alibaba_logistics_users u on u.user_id=a.user_id and u.account_code=a.account_code and u.enabled
join auth.users au on au.id=u.user_id and au.deleted_at is null
left join public.purchase_logistics_summaries s on s.purchase_record_id=l.purchase_record_id and s.link_version=l.version
where cardinality(l.order_ids)>0 and cardinality(l.order_ids)<=3
  and p.pool_status in ('submitted_to_pool','haichuan_warehouse','sent_to_inventory') and p.status<>'cancelled'
  and p.assigned_buyer_name=u.buyer_name and lower(trim(p.assigned_buyer_email))=lower(trim(au.email))
order by l.purchase_record_id limit 5)
union all
(select 'automatic_eligibility'::text as phase,l.purchase_record_id as record_id,l.version
from public.alibaba_purchase_links l
join public.purchase_records p on p.id=l.purchase_record_id
join public.alibaba_purchase_access a on a.purchase_record_id=l.purchase_record_id and a.account_code=l.account_code
join public.alibaba_logistics_users u on u.user_id=a.user_id and u.account_code=a.account_code and u.enabled
join auth.users au on au.id=u.user_id and au.deleted_at is null
left join public.purchase_logistics_summaries s on s.purchase_record_id=l.purchase_record_id and s.link_version=l.version
where cardinality(l.order_ids)>0 and cardinality(l.order_ids)<=3
  and p.pool_status in ('submitted_to_pool','haichuan_warehouse','sent_to_inventory') and p.status<>'cancelled'
  and p.assigned_buyer_name=u.buyer_name and lower(trim(p.assigned_buyer_email))=lower(trim(au.email))
  and coalesce(s.status,'unknown') not in ('signed','returned_signed')
order by l.purchase_record_id)
union all
(select 'pending_queue'::text as phase,record_id,link_version as version from public.alibaba_sync_jobs
where run_id=(select id from public.alibaba_sync_runs where state='running' limit 1)
  and state='pending' order by record_id limit 1);
commit;
