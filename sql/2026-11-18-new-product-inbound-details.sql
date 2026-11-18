begin;

create table public.new_product_inbound_details (
  inbound_code text primary key check (inbound_code ~ '^new[0-9]{5}$'),
  official_sku text not null default '' check (official_sku ~ '^[0-9]*$'),
  live_store text not null default '' check (live_store in ('','Bestby','Arfast','Aicom','MegaValue','KeepFit','Lifon','PatPaw')),
  shipping_mark text not null default '',
  image_path text
);

alter table public.new_product_inbound_details enable row level security;
revoke all on public.new_product_inbound_details from anon, authenticated;
grant select, insert, update on public.new_product_inbound_details to authenticated;

create policy inbound_details_read on public.new_product_inbound_details
  for select to authenticated using (public.is_editor());

create policy inbound_details_write on public.new_product_inbound_details
  for all to authenticated using (public.is_editor()) with check (
    public.is_editor() and exists (
      select 1 from public.purchase_records p
      where lower(p.sku) = inbound_code
        and coalesce(p.logistics_source_record_id, '') = ''
        and p.pool_status in ('submitted_to_pool', 'sent_to_inventory')
        and p.status <> 'cancelled'
    )
  );

commit;
