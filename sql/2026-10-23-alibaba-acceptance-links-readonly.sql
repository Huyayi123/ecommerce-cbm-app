-- Run in the existing production Supabase SQL Editor,  using its database role.
-- Read only: two exact orders, no credentials, contacts or trace text.
-- The SQL Editor role differs from the website user's role. A single match
-- here alongside zero visible website matches requires a separate RLS check.
with targets(order_id) as (
  values ('5127876109006072034'::text), ('5127778440001026842'::text)
)
select t.order_id,
       count(l.purchase_record_id)::integer as matching_link_count,
       coalesce(jsonb_agg(jsonb_build_object(
         'recordId', l.purchase_record_id,
         'account', l.account_code,
         'linkVersion', l.version,
         'linkedOrderCount', cardinality(l.order_ids),
         'purchaseExists', exists (
           select 1 from public.purchase_records p where p.id=l.purchase_record_id
         ),
         'enabledBuyerAccessCount', (
           select count(*) from public.alibaba_purchase_access a
           join public.alibaba_logistics_users u on u.user_id=a.user_id
           where a.purchase_record_id=l.purchase_record_id
             and a.account_code=l.account_code
             and u.account_code=a.account_code and u.enabled
         ),
         'summaryStatus', s.status,
         'summaryCurrent', s.link_version=l.version
       ) order by l.purchase_record_id)
       filter (where l.purchase_record_id is not null), '[]'::jsonb) as matches
from targets t
left join public.alibaba_purchase_links l on l.order_ids @> array[t.order_id]
left join public.purchase_logistics_summaries s on s.purchase_record_id=l.purchase_record_id
group by t.order_id
order by t.order_id;
