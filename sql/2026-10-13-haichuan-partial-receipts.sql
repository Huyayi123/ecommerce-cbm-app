begin;

create or replace function public.is_haichuan_logistics()
returns boolean
language sql
security definer
stable
set search_path = public
as $haichuan_member$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role::text = 'logistics'
      and logistics_provider_type = 'haichuan'
  )
$haichuan_member$;

alter table public.haichuan_inbound_items
  add column if not exists receipt_completion_type text,
  add column if not exists purchase_note text not null default '',
  add column if not exists completed_by uuid references auth.users(id) on delete set null,
  add column if not exists completed_at timestamptz;

alter table public.haichuan_inbound_items
  drop constraint if exists haichuan_inbound_items_receipt_completion_type_check;
alter table public.haichuan_inbound_items
  add constraint haichuan_inbound_items_receipt_completion_type_check
  check (receipt_completion_type is null or receipt_completion_type in ('matched', 'short', 'over'));

alter table public.haichuan_warehouse_lots
  add column if not exists purchase_note text not null default '',
  add column if not exists latest_logistics_note text not null default '';

create table if not exists public.haichuan_receipt_events (
  id text primary key,
  request_id text not null unique,
  inbound_item_id text references public.haichuan_inbound_items(id) on delete set null,
  warehouse_lot_id text references public.haichuan_warehouse_lots(id) on delete set null,
  receipt_type text not null check (receipt_type in ('partial', 'complete')),
  received_carton_count integer not null check (received_carton_count > 0),
  cumulative_received_carton_count integer not null check (cumulative_received_carton_count > 0),
  purchase_note_snapshot text not null default '',
  logistics_note text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists haichuan_receipt_events_inbound_created_idx
on public.haichuan_receipt_events (inbound_item_id, created_at desc);

alter table public.haichuan_receipt_events enable row level security;

drop policy if exists "haichuan receipt events select" on public.haichuan_receipt_events;
create policy "haichuan receipt events select" on public.haichuan_receipt_events
for select to authenticated using (
  public.is_admin() or public.is_haichuan_logistics()
);

drop policy if exists "haichuan inbound select" on public.haichuan_inbound_items;
create policy "haichuan inbound select" on public.haichuan_inbound_items
for select to authenticated using (public.is_admin() or public.is_haichuan_logistics());

drop policy if exists "haichuan warehouse select" on public.haichuan_warehouse_lots;
create policy "haichuan warehouse select" on public.haichuan_warehouse_lots
for select to authenticated using (public.is_admin() or public.is_haichuan_logistics());

drop policy if exists "haichuan loading batch select" on public.haichuan_loading_batches;
create policy "haichuan loading batch select" on public.haichuan_loading_batches
for select to authenticated using (public.is_admin() or public.is_haichuan_logistics());

drop policy if exists "haichuan loading item select" on public.haichuan_loading_items;
create policy "haichuan loading item select" on public.haichuan_loading_items
for select to authenticated using (
  exists (
    select 1 from public.haichuan_loading_batches b
    where b.id = batch_id
      and (public.is_admin() or public.is_haichuan_logistics())
  )
);

update public.haichuan_inbound_items i
set purchase_note = coalesce(p.note, '')
from public.purchase_records p
where p.id = i.purchase_record_id;

update public.haichuan_warehouse_lots l
set purchase_note = i.purchase_note
from public.haichuan_inbound_items i
where i.id = l.inbound_item_id;

create or replace function public.record_haichuan_receipt(
  p_inbound_id text,
  p_received_carton_count integer,
  p_receipt_type text,
  p_logistics_note text default '',
  p_request_id text default ''
)
returns text
language plpgsql
security definer
set search_path = public
as $record_receipt$
declare
  v_inbound public.haichuan_inbound_items%rowtype;
  v_lot public.haichuan_warehouse_lots%rowtype;
  v_lot_id text;
  v_event_id text;
  v_previous integer;
  v_cumulative integer;
  v_ratio numeric;
  v_target_quantity numeric;
  v_target_cbm numeric;
  v_quantity_delta numeric;
  v_cbm_delta numeric;
  v_details jsonb;
  v_completion text;
begin
  if p_received_carton_count is null or p_received_carton_count <= 0 then
    raise exception '本次入库件数必须大于 0';
  end if;
  if p_receipt_type not in ('partial', 'complete') then
    raise exception '入库类型无效';
  end if;
  if coalesce(trim(p_request_id), '') = '' then
    raise exception '入库请求编号不能为空';
  end if;

  select warehouse_lot_id into v_lot_id
  from public.haichuan_receipt_events
  where request_id = p_request_id;
  if found then return v_lot_id; end if;

  select * into v_inbound
  from public.haichuan_inbound_items
  where id = p_inbound_id
  for update;

  if not found then raise exception '待入仓记录不存在'; end if;
  select warehouse_lot_id into v_lot_id
  from public.haichuan_receipt_events
  where request_id = p_request_id;
  if found then return v_lot_id; end if;
  if v_inbound.status <> 'pending_receipt' then raise exception '该记录已完成入库，请刷新'; end if;
  if not (public.is_admin() or public.is_haichuan_logistics()) then
    raise exception '无权确认该入仓记录';
  end if;

  v_previous := coalesce(v_inbound.actual_received_carton_count, 0);
  v_cumulative := v_previous + p_received_carton_count;
  v_lot_id := 'hc-lot-' || v_inbound.id;
  v_event_id := 'hc-receipt-' || p_request_id;

  if p_receipt_type = 'complete' then
    v_ratio := 1;
  elsif v_inbound.declared_total_carton_count > 0 then
    v_ratio := least(1::numeric, v_cumulative::numeric / v_inbound.declared_total_carton_count);
  else
    v_ratio := 0;
  end if;
  v_target_quantity := round(v_inbound.purchase_total_quantity * v_ratio, 4);
  v_target_cbm := round(v_inbound.declared_total_cbm * v_ratio, 8);
  v_details := public.scale_haichuan_product_details(v_inbound.product_details, v_target_quantity);

  select * into v_lot
  from public.haichuan_warehouse_lots
  where inbound_item_id = v_inbound.id
  for update;

  if not found then
    insert into public.haichuan_warehouse_lots (
      id, inbound_item_id, purchase_record_id, logistics_user_id, logistics_email,
      internal_code, manufacturer_name, sku, product_name, english_name, image_url, shop_name, buyer_name,
      declared_carton_count, declared_units_per_carton, declared_tail_quantity,
      initial_carton_count, remaining_carton_count, reserved_carton_count,
      initial_product_quantity, remaining_product_quantity, initial_cbm, remaining_cbm, unit_cbm,
      product_details, has_packing_variance, status, purchase_note, latest_logistics_note
    ) values (
      v_lot_id, v_inbound.id, v_inbound.purchase_record_id, v_inbound.logistics_user_id, v_inbound.logistics_email,
      v_inbound.internal_code, v_inbound.manufacturer_name, v_inbound.sku, v_inbound.product_name,
      v_inbound.english_name, v_inbound.image_url, v_inbound.shop_name, v_inbound.buyer_name,
      v_inbound.declared_carton_count, v_inbound.declared_units_per_carton, v_inbound.declared_tail_quantity,
      p_received_carton_count, p_received_carton_count, 0,
      v_target_quantity, v_target_quantity, v_target_cbm, v_target_cbm, v_inbound.unit_cbm,
      v_details, false, 'available', v_inbound.purchase_note, coalesce(p_logistics_note, '')
    );
  else
    v_lot_id := v_lot.id;
    v_quantity_delta := greatest(0, v_target_quantity - v_lot.initial_product_quantity);
    v_cbm_delta := greatest(0, v_target_cbm - v_lot.initial_cbm);
    update public.haichuan_warehouse_lots
    set initial_carton_count = initial_carton_count + p_received_carton_count,
        remaining_carton_count = remaining_carton_count + p_received_carton_count,
        initial_product_quantity = initial_product_quantity + v_quantity_delta,
        remaining_product_quantity = remaining_product_quantity + v_quantity_delta,
        initial_cbm = initial_cbm + v_cbm_delta,
        remaining_cbm = remaining_cbm + v_cbm_delta,
        product_details = v_details,
        purchase_note = v_inbound.purchase_note,
        latest_logistics_note = coalesce(p_logistics_note, ''),
        status = public.haichuan_lot_status(remaining_carton_count + p_received_carton_count, reserved_carton_count),
        version = version + 1,
        updated_at = now()
    where id = v_lot.id;
  end if;

  if p_receipt_type = 'complete' then
    v_completion := case
      when v_cumulative < v_inbound.declared_total_carton_count then 'short'
      when v_cumulative > v_inbound.declared_total_carton_count then 'over'
      else 'matched'
    end;
  end if;

  update public.haichuan_inbound_items
  set actual_received_carton_count = v_cumulative,
      has_packing_variance = case when p_receipt_type = 'complete' then v_cumulative <> declared_total_carton_count else has_packing_variance end,
      status = case when p_receipt_type = 'complete' then 'received' else status end,
      receipt_completion_type = v_completion,
      received_by = auth.uid(),
      received_at = now(),
      completed_by = case when p_receipt_type = 'complete' then auth.uid() else completed_by end,
      completed_at = case when p_receipt_type = 'complete' then now() else completed_at end,
      updated_at = now()
  where id = v_inbound.id;

  insert into public.haichuan_receipt_events (
    id, request_id, inbound_item_id, warehouse_lot_id, receipt_type,
    received_carton_count, cumulative_received_carton_count,
    purchase_note_snapshot, logistics_note, created_by
  ) values (
    v_event_id, p_request_id, v_inbound.id, v_lot_id, p_receipt_type,
    p_received_carton_count, v_cumulative,
    v_inbound.purchase_note, coalesce(p_logistics_note, ''), auth.uid()
  );

  if p_receipt_type = 'complete' then
    update public.purchase_pools pp
    set records = coalesce((
      select jsonb_agg(entry.value order by entry.position)
      from jsonb_array_elements(coalesce(pp.records, '[]'::jsonb)) with ordinality as entry(value, position)
      where entry.value->>'id' is distinct from v_inbound.purchase_record_id
    ), '[]'::jsonb)
    where exists (
      select 1 from jsonb_array_elements(coalesce(pp.records, '[]'::jsonb)) as entry(value)
      where entry.value->>'id' = v_inbound.purchase_record_id
    );

    update public.purchase_records
    set pool_status = 'haichuan_warehouse', updated_at = now()
    where id = v_inbound.purchase_record_id and pool_status = 'submitted_to_pool';
  end if;

  return v_lot_id;
end;
$record_receipt$;

grant execute on function public.record_haichuan_receipt(text, integer, text, text, text) to authenticated;

create or replace function public.submit_haichuan_loading_batch(
  p_batch_id text,
  p_container_date date,
  p_note text,
  p_items jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := coalesce(auth.jwt() ->> 'email', '');
  v_item jsonb;
  v_lot public.haichuan_warehouse_lots%rowtype;
  v_requested integer;
  v_available integer;
  v_quantity numeric;
  v_cbm numeric;
  v_estimated boolean;
  v_existing_status text;
begin
  if coalesce(p_batch_id, '') = '' then raise exception '装柜批次编号不能为空'; end if;
  if p_container_date is null then raise exception '请填写装柜日期'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception '请选择需要装柜的库存'; end if;

  select status into v_existing_status from public.haichuan_loading_batches where id = p_batch_id for update;
  if v_existing_status in ('submitted', 'approved') then return p_batch_id; end if;

  insert into public.haichuan_loading_batches (
    id, container_date, logistics_user_id, logistics_email, status, created_by, submitted_at, note, created_at, updated_at
  ) values (
    p_batch_id, p_container_date, auth.uid(), v_email, 'draft', auth.uid(), null, coalesce(p_note, ''), now(), now()
  ) on conflict (id) do update set
    container_date = excluded.container_date,
    note = excluded.note,
    status = 'draft',
    rejection_reason = '',
    reviewed_by = null,
    reviewed_at = null,
    updated_at = now();

  delete from public.haichuan_loading_items where batch_id = p_batch_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_lot
    from public.haichuan_warehouse_lots
    where id = v_item->>'warehouseLotId'
    for update;
    if not found then raise exception '海川仓库记录不存在'; end if;
    if not (
      public.is_admin()
      or public.is_haichuan_logistics()
    ) then raise exception '无权操作该仓库记录'; end if;

    v_requested := floor(coalesce((v_item->>'requestedCartonCount')::numeric, 0));
    v_available := v_lot.remaining_carton_count - v_lot.reserved_carton_count;
    if v_requested <= 0 or v_requested > v_available then
      raise exception '装柜件数超过当前可用库存';
    end if;
    if jsonb_array_length(coalesce(v_lot.product_details, '[]'::jsonb)) > 1
       and v_requested <> v_lot.remaining_carton_count then
      raise exception '包含混装商品的海川库存必须整批装走或整批保留，不能部分拆分';
    end if;

    if v_requested = v_lot.remaining_carton_count then
      v_quantity := v_lot.remaining_product_quantity;
      v_cbm := v_lot.remaining_cbm;
      v_estimated := false;
    elsif v_lot.has_packing_variance then
      v_quantity := floor(v_lot.remaining_product_quantity * v_requested / nullif(v_lot.remaining_carton_count, 0));
      v_cbm := v_lot.remaining_cbm * v_requested / nullif(v_lot.remaining_carton_count, 0);
      v_estimated := true;
    else
      v_quantity := least(v_lot.remaining_product_quantity, v_requested * v_lot.declared_units_per_carton);
      v_cbm := v_quantity * v_lot.unit_cbm;
      v_estimated := false;
    end if;

    insert into public.haichuan_loading_items (
      id, batch_id, warehouse_lot_id, purchase_record_id, internal_code, sku, product_name,
      requested_carton_count, suggested_product_quantity, suggested_cbm, is_estimated, product_details,
      warehouse_version, note, created_at, updated_at
    ) values (
      p_batch_id || '-' || v_lot.id, p_batch_id, v_lot.id, v_lot.purchase_record_id,
      v_lot.internal_code, v_lot.sku, v_lot.product_name,
      v_requested, v_quantity, v_cbm, v_estimated, v_lot.product_details, v_lot.version,
      coalesce(v_item->>'note', ''), now(), now()
    );

    update public.haichuan_warehouse_lots
    set reserved_carton_count = reserved_carton_count + v_requested,
        status = public.haichuan_lot_status(remaining_carton_count, reserved_carton_count + v_requested),
        version = version + 1, updated_at = now()
    where id = v_lot.id;
  end loop;

  update public.haichuan_loading_batches
  set status = 'submitted', submitted_at = now(), updated_at = now()
  where id = p_batch_id;
  return p_batch_id;
end;
$$;

insert into public.haichuan_receipt_events (
  id, request_id, inbound_item_id, warehouse_lot_id, receipt_type,
  received_carton_count, cumulative_received_carton_count,
  purchase_note_snapshot, logistics_note, created_by, created_at
)
select
  'hc-receipt-migrated-' || i.id,
  'migrated-' || i.id,
  i.id,
  l.id,
  'complete',
  greatest(1, coalesce(i.actual_received_carton_count, l.initial_carton_count)),
  greatest(1, coalesce(i.actual_received_carton_count, l.initial_carton_count)),
  i.purchase_note,
  l.latest_logistics_note,
  i.received_by,
  coalesce(i.received_at, i.updated_at)
from public.haichuan_inbound_items i
join public.haichuan_warehouse_lots l on l.inbound_item_id = i.id
where i.status = 'received'
on conflict (request_id) do nothing;

update public.haichuan_inbound_items
set receipt_completion_type = case
  when coalesce(actual_received_carton_count, 0) < declared_total_carton_count then 'short'
  when coalesce(actual_received_carton_count, 0) > declared_total_carton_count then 'over'
  else 'matched'
end,
completed_by = coalesce(completed_by, received_by),
completed_at = coalesce(completed_at, received_at)
where status = 'received';

commit;
