begin;

create table public.new_product_launches (
  id uuid primary key default gen_random_uuid(),
  sku text not null check (sku ~ '^[0-9]+$'),
  product_name text not null check (length(trim(product_name)) > 0),
  image_path text not null,
  live_store text not null check (live_store in ('Bestby','Arfast','Aicom','MegaValue','KeepFit','Lifon','PatPaw')),
  shipping_mark text,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  version integer not null default 1,
  status text not null default 'pending_arrival',
  received_by_id text,
  received_by_name text,
  received_at timestamptz,
  unique (sku, live_store),
  check (
    (status = 'pending_arrival' and received_at is null and received_by_id is null and received_by_name is null)
    or (status = 'received' and received_at is not null and received_by_id is not null and received_by_name is not null)
  )
);

create table public.new_product_launch_history (
  id bigint generated always as identity primary key,
  launch_id uuid not null references public.new_product_launches(id),
  action text not null,
  actor uuid not null,
  reason text not null,
  before_change jsonb not null,
  after_change jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.new_product_launches enable row level security;
alter table public.new_product_launch_history enable row level security;
revoke all on public.new_product_launches, public.new_product_launch_history from anon, authenticated;
grant select on public.new_product_launches, public.new_product_launch_history to authenticated;
grant insert (sku, product_name, image_path, live_store, shipping_mark) on public.new_product_launches to authenticated;
grant select on public.new_product_launches to service_role;

create policy launch_read on public.new_product_launches for select to authenticated using (public.is_editor());
create policy launch_create on public.new_product_launches for insert to authenticated with check (
  public.is_editor() and split_part(image_path, '/', 1) = auth.uid()::text
  and exists (select 1 from storage.objects where bucket_id = 'new-product-launch' and name = image_path)
);
create policy launch_history_read on public.new_product_launch_history for select to authenticated using (
  exists (select 1 from public.new_product_launches l where l.id = launch_id and (l.created_by = auth.uid() or public.is_admin()))
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('new-product-launch', 'new-product-launch', false, 5242880, array['image/jpeg','image/png','image/webp']);
create policy launch_image_read on storage.objects for select to authenticated using (
  bucket_id = 'new-product-launch' and public.is_editor()
);
create policy launch_image_create on storage.objects for insert to authenticated with check (
  bucket_id = 'new-product-launch' and public.is_editor() and split_part(name, '/', 1) = auth.uid()::text
);

create function public.correct_new_product_launch(
  p_id uuid, p_version integer, p_action text, p_sku text, p_reason text,
  p_name text default null, p_store text default null, p_mark text default null, p_image text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  previous public.new_product_launches;
  updated public.new_product_launches;
begin
  select * into strict previous from public.new_product_launches where id = p_id for update;
  if not coalesce(public.is_editor() and (previous.created_by = auth.uid() or public.is_admin()), false) then
    raise exception '没有权限修改该新品' using errcode = '42501';
  end if;
  if p_version is distinct from previous.version then raise exception '资料已更新，请刷新后重试'; end if;
  if nullif(trim(p_reason), '') is null then raise exception '请填写原因'; end if;
  if p_action = 'correct_sku' then
    update public.new_product_launches set sku = trim(p_sku), version = version + 1
    where id = p_id returning * into updated;
  elsif p_action = 'undo_receipt' and previous.status = 'received' then
    update public.new_product_launches
    set status = 'pending_arrival', received_by_id = null, received_by_name = null, received_at = null, version = version + 1
    where id = p_id returning * into updated;
  elsif p_action = 'edit_details' and previous.status = 'pending_arrival' then
    if p_image is distinct from previous.image_path and not exists (
      select 1 from storage.objects where bucket_id = 'new-product-launch' and name = p_image
      and split_part(name, '/', 1) = auth.uid()::text
    ) then raise exception '主图无效'; end if;
    update public.new_product_launches
    set product_name = trim(p_name), live_store = p_store, shipping_mark = nullif(trim(p_mark), ''),
        image_path = p_image, version = version + 1
    where id = p_id returning * into updated;
  else
    raise exception '当前状态不支持该操作';
  end if;
  insert into public.new_product_launch_history (launch_id, action, actor, reason, before_change, after_change)
  values (p_id, p_action, auth.uid(), trim(p_reason), to_jsonb(previous), to_jsonb(updated));
end;
$$;
revoke all on function public.correct_new_product_launch(uuid, integer, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.correct_new_product_launch(uuid, integer, text, text, text, text, text, text, text) to authenticated;

create function public.receive_new_product_launch(p_id uuid, p_version integer, p_employee_id text, p_employee_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  item public.new_product_launches;
begin
  select * into item from public.new_product_launches where id = p_id for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if item.version is distinct from p_version then return jsonb_build_object('result', 'version_conflict'); end if;
  if item.status = 'received' then return jsonb_build_object('result', 'already_received', 'item', to_jsonb(item)); end if;
  if nullif(trim(p_employee_id), '') is null or nullif(trim(p_employee_name), '') is null then
    raise exception 'Missing employee identity';
  end if;
  update public.new_product_launches
  set status = 'received', received_by_id = trim(p_employee_id), received_by_name = trim(p_employee_name), received_at = clock_timestamp()
  where id = p_id returning * into item;
  return jsonb_build_object('result', 'received', 'item', to_jsonb(item));
end;
$$;
revoke all on function public.receive_new_product_launch(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.receive_new_product_launch(uuid, integer, text, text) to service_role;

commit;
