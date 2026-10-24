-- Optional order ID drafts; no 1688 API calls before purchase pool submission.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create or replace function public.read_alibaba_self_target(p_actor uuid,p_record_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_member public.alibaba_logistics_users%rowtype;
  v_record public.purchase_records%rowtype;
  v_link public.alibaba_purchase_links%rowtype;
  v_email text;
begin
  select * into v_member from public.alibaba_logistics_users where user_id=p_actor and enabled
    and logistics_role in ('owner','admin','buyer') for share;
  if not found or v_member.buyer_name is null then raise exception 'Buyer binding required' using errcode='42501'; end if;
  select email into v_email from auth.users where id=p_actor and deleted_at is null;
  select * into v_record from public.purchase_records where id=p_record_id for share;
  if not found or v_email is null or v_record.assigned_buyer_name is distinct from v_member.buyer_name
    or lower(trim(coalesce(v_record.assigned_buyer_email,''))) <> lower(trim(v_email)) then
    raise exception 'Purchase is not assigned to the bound buyer' using errcode='42501';
  end if;
  if exists(select 1 from public.alibaba_purchase_access where purchase_record_id=p_record_id
    and (user_id<>p_actor or account_code<>v_member.account_code)) then
    raise exception 'Existing assignment conflicts' using errcode='42501';
  end if;
  select * into v_link from public.alibaba_purchase_links where purchase_record_id=p_record_id;
  if v_link.account_code is not null and v_link.account_code<>v_member.account_code then
    raise exception 'Existing account conflicts' using errcode='42501';
  end if;
  return jsonb_build_object('user_id',p_actor,'buyer_name',v_member.buyer_name,'account_code',v_member.account_code,
    'pool_status',v_record.pool_status,'version',coalesce(v_link.version,0));
end
$$;
revoke all on function public.read_alibaba_self_target(uuid,text) from public,anon,authenticated;
grant execute on function public.read_alibaba_self_target(uuid,text) to service_role;

create or replace function public.save_alibaba_order_draft(p_actor uuid,p_record_id text,p_order_ids text[],p_expected_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_target jsonb; v_link public.alibaba_purchase_links%rowtype; v_version integer;
begin
  if p_order_ids is null or cardinality(p_order_ids)>3 or p_expected_version is null or p_expected_version<0
    or exists(select 1 from unnest(p_order_ids) x where x is null or x !~ '^[1-9][0-9]{0,29}$') then
    raise exception 'Invalid input';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('alibaba:'||p_record_id,0));
  v_target:=public.read_alibaba_self_target(p_actor,p_record_id);
  select * into v_link from public.alibaba_purchase_links where purchase_record_id=p_record_id for update;
  if coalesce(v_link.version,0)<>p_expected_version then raise exception 'Link changed' using errcode='40001'; end if;
  if v_link.order_ids is not distinct from p_order_ids then
    return jsonb_build_object('version',v_link.version);
  end if;
  if cardinality(p_order_ids)=0 and v_link.version is null then return jsonb_build_object('version',0); end if;
  insert into public.alibaba_purchase_access(purchase_record_id,user_id,account_code,approved_by)
    values(p_record_id,p_actor,v_target->>'account_code',p_actor) on conflict(purchase_record_id) do nothing;
  v_version:=coalesce(v_link.version,0)+1;
  insert into public.alibaba_purchase_links(purchase_record_id,account_code,order_ids,version,verification_status,updated_by)
    values(p_record_id,v_target->>'account_code',p_order_ids,v_version,'pending',p_actor)
  on conflict(purchase_record_id) do update set order_ids=excluded.order_ids,version=excluded.version,
    verification_status='pending',updated_by=p_actor,updated_at=now();
  -- Old snapshots are retained for audit, but their link version cannot be displayed as current.
  return jsonb_build_object('version',v_version);
end $$;
revoke all on function public.save_alibaba_order_draft(uuid,text,text[],integer) from public,anon,authenticated;
grant execute on function public.save_alibaba_order_draft(uuid,text,text[],integer) to service_role;

commit;
