-- Incremental migration AFTER foundation/admin initialization.
-- Service-only RPCs. No existing purchase/profile/business data is updated.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table public.alibaba_logistics_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  purchase_record_id text not null,
  action text not null check (action in ('link_and_sync','refresh','refresh_failed')),
  account_code text not null check (account_code in ('A','B')),
  link_version integer not null,
  created_at timestamptz not null default now()
);
alter table public.alibaba_logistics_audit enable row level security;
revoke all on public.alibaba_logistics_audit from public,anon,authenticated;
grant all on public.alibaba_logistics_audit to service_role;
grant usage,select on sequence public.alibaba_logistics_audit_id_seq to service_role;

create function public.commit_alibaba_purchase_snapshot(
  p_actor uuid, p_record_id text, p_buyer_user_id uuid, p_buyer_name text, p_account_code text,
  p_order_ids text[], p_expected_version integer, p_snapshot jsonb, p_attempted_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_member public.alibaba_logistics_users%rowtype;
  v_access public.alibaba_purchase_access%rowtype;
  v_link public.alibaba_purchase_links%rowtype;
  v_version integer;
  v_changed boolean;
begin
  perform 1 from public.alibaba_logistics_users where user_id = p_actor and enabled
    and logistics_role in ('owner','admin') for share;
  if not found then raise exception 'Forbidden' using errcode = '42501'; end if;
  if p_order_ids is null or cardinality(p_order_ids) not between 1 and 30
    or p_expected_version is null or p_expected_version < 0 or p_attempted_at is null
    or p_attempted_at > now() + interval '5 minutes' or exists (
      select 1 from unnest(p_order_ids) x where x is null or x !~ '^[1-9][0-9]{0,29}$'
    ) then raise exception 'Invalid input'; end if;
  if not exists (select 1 from public.alibaba_buyer_accounts where buyer_name = p_buyer_name and account_code = p_account_code)
    or not exists (select 1 from auth.users where id = p_buyer_user_id and deleted_at is null)
    or not exists (select 1 from public.purchase_records where id = p_record_id) then
    raise exception 'Unrecognized buyer or purchase record';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object'
    or coalesce((p_snapshot->>'coverage_confirmed')::boolean,true)
    or coalesce(p_snapshot->>'status','') not in ('unknown','unaccepted','accepted','logistics_cancelled','pickup_failed','sign_exception','in_transit','mixed','partial_signed','returned_signed')
    or length(coalesce(p_snapshot->>'detail','')) > 500
    or p_snapshot->>'mapping_version' is distinct from 'buyer-logistics-status-v1'
    or jsonb_typeof(p_snapshot->'evidence'->'shipments') is distinct from 'array'
    or (p_snapshot->>'shipment_count')::integer <> jsonb_array_length(p_snapshot->'evidence'->'shipments') then
    raise exception 'Invalid snapshot';
  end if;
  -- Only logistics namespace lock: no updates to old purchase records.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('alibaba:' || p_record_id,0));
  select * into v_link from public.alibaba_purchase_links where purchase_record_id = p_record_id for update;
  if coalesce(v_link.version,0) <> p_expected_version then raise exception 'Link changed' using errcode = '40001'; end if;
  if v_link.account_code is not null and v_link.account_code <> p_account_code then raise exception 'Account cannot change'; end if;
  if exists (select 1 from public.purchase_logistics_summaries where purchase_record_id = p_record_id and last_attempt_at > p_attempted_at) then
    raise exception 'Newer synchronization exists' using errcode = '40001';
  end if;
  -- Fixed UUIDs are explicitly approved by an independently-authorized admin.
  insert into public.alibaba_logistics_users(user_id,logistics_role,buyer_name,account_code)
  values(p_buyer_user_id,'buyer',p_buyer_name,p_account_code) on conflict(user_id) do nothing;
  select * into v_member from public.alibaba_logistics_users where user_id = p_buyer_user_id for update;
  if not v_member.enabled or v_member.logistics_role not in ('owner','admin','buyer')
    or (v_member.buyer_name is not null and (v_member.buyer_name <> p_buyer_name or v_member.account_code <> p_account_code)) then
    raise exception 'Existing membership conflicts';
  end if;
  -- Add a buyer binding to the administrator without downgrading their role.
  if v_member.buyer_name is null then
    update public.alibaba_logistics_users set buyer_name = p_buyer_name,account_code = p_account_code where user_id = p_buyer_user_id;
  end if;
  insert into public.alibaba_purchase_access(purchase_record_id,user_id,account_code,approved_by)
  values(p_record_id,p_buyer_user_id,p_account_code,p_actor) on conflict(purchase_record_id) do nothing;
  select * into v_access from public.alibaba_purchase_access where purchase_record_id = p_record_id for update;
  if v_access.user_id <> p_buyer_user_id or v_access.account_code <> p_account_code then raise exception 'Existing assignment conflicts'; end if;
  v_changed := v_link.version is null or v_link.order_ids is distinct from p_order_ids;
  v_version := case when v_link.version is null then 1 when v_changed then v_link.version + 1 else v_link.version end;
  insert into public.alibaba_purchase_links(purchase_record_id,account_code,order_ids,version,verification_status,updated_by)
  values(p_record_id,p_account_code,p_order_ids,v_version,'verified',p_actor)
  on conflict(purchase_record_id) do update set order_ids = excluded.order_ids,version = excluded.version,
    verification_status = 'verified', updated_by = p_actor,updated_at = now();
  insert into public.purchase_logistics_summaries(
    purchase_record_id,link_version,status,shipment_count,signed_count,unknown_count,exception_count,
    coverage_confirmed,last_success_at,last_attempt_at,sync_error,detail,mapping_version,evidence
  ) values(p_record_id,v_version,p_snapshot->>'status',(p_snapshot->>'shipment_count')::integer,
    (p_snapshot->>'signed_count')::integer,(p_snapshot->>'unknown_count')::integer,(p_snapshot->>'exception_count')::integer,
    false,now(),p_attempted_at,null,p_snapshot->>'detail',p_snapshot->>'mapping_version',p_snapshot->'evidence')
  on conflict(purchase_record_id) do update set link_version = excluded.link_version,status = excluded.status,
    shipment_count = excluded.shipment_count,signed_count = excluded.signed_count,unknown_count = excluded.unknown_count,
    exception_count = excluded.exception_count,coverage_confirmed = false,last_success_at = excluded.last_success_at,
    last_attempt_at = excluded.last_attempt_at,sync_error = null,detail = excluded.detail,
    mapping_version = excluded.mapping_version,evidence = excluded.evidence;
  insert into public.alibaba_logistics_audit(actor_id,purchase_record_id,action,account_code,link_version)
  values(p_actor,p_record_id,case when v_changed then 'link_and_sync' else 'refresh' end,p_account_code,v_version);
  return jsonb_build_object('purchase_record_id',p_record_id,'account_code',p_account_code,'version',v_version,
    'status',p_snapshot->>'status','detail',p_snapshot->>'detail','last_success_at',now());
end
$$;

create function public.read_alibaba_refresh_target(p_actor uuid,p_record_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if not exists(select 1 from public.alibaba_logistics_users where user_id = p_actor and enabled and logistics_role in ('owner','admin')) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  select jsonb_build_object('account_code',l.account_code,'order_ids',l.order_ids,'version',l.version,'user_id',a.user_id,'buyer_name',u.buyer_name)
  into v_result from public.alibaba_purchase_links l
  join public.alibaba_purchase_access a on a.purchase_record_id = l.purchase_record_id and a.account_code = l.account_code
  join public.alibaba_logistics_users u on u.user_id = a.user_id and u.account_code = a.account_code and u.enabled
  where l.purchase_record_id = p_record_id;
  return v_result;
end
$$;

create function public.fail_alibaba_purchase_refresh(p_actor uuid,p_record_id text,p_expected_version integer,p_attempted_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_account text;
begin
  perform 1 from public.alibaba_logistics_users where user_id = p_actor and enabled and logistics_role in ('owner','admin') for share;
  if not found then raise exception 'Forbidden' using errcode = '42501'; end if;
  if p_attempted_at is null or p_attempted_at > now() + interval '5 minutes' then raise exception 'Invalid attempt time'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('alibaba:' || p_record_id,0));
  select account_code into v_account from public.alibaba_purchase_links where purchase_record_id = p_record_id and version = p_expected_version for update;
  if not found then raise exception 'Link changed' using errcode = '40001'; end if;
  if exists(select 1 from public.purchase_logistics_summaries where purchase_record_id = p_record_id and last_attempt_at > p_attempted_at) then
    raise exception 'Newer synchronization exists' using errcode = '40001';
  end if;
  insert into public.purchase_logistics_summaries(purchase_record_id,link_version,last_attempt_at,sync_error)
  values(p_record_id,p_expected_version,p_attempted_at,'query_failed')
  on conflict(purchase_record_id) do update set last_attempt_at = excluded.last_attempt_at,sync_error = 'query_failed';
  insert into public.alibaba_logistics_audit(actor_id,purchase_record_id,action,account_code,link_version)
  values(p_actor,p_record_id,'refresh_failed',v_account,p_expected_version);
  return jsonb_build_object('recorded',true);
end
$$;

revoke all on function public.commit_alibaba_purchase_snapshot(uuid,text,uuid,text,text,text[],integer,jsonb,timestamptz) from public,anon,authenticated;
revoke all on function public.read_alibaba_refresh_target(uuid,text) from public,anon,authenticated;
revoke all on function public.fail_alibaba_purchase_refresh(uuid,text,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.commit_alibaba_purchase_snapshot(uuid,text,uuid,text,text,text[],integer,jsonb,timestamptz) to service_role;
grant execute on function public.read_alibaba_refresh_target(uuid,text) to service_role;
grant execute on function public.fail_alibaba_purchase_refresh(uuid,text,integer,timestamptz) to service_role;
commit;
