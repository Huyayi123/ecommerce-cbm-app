-- Existing project only. Two exact, confirmed pilots. No backfill or dispatch.
begin;
set local lock_timeout='3s';
set local statement_timeout='15s';
do $$ begin
  if exists(select 1 from public.alibaba_sync_control where manual_enabled or auto_enabled)
    or exists(select 1 from cron.job where active and jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery')) then
    raise exception 'Pause Alibaba sync and both cron jobs before installation';
  end if;
end $$;

alter table public.purchase_logistics_summaries drop constraint if exists purchase_logistics_summaries_status_check;
alter table public.purchase_logistics_summaries add constraint purchase_logistics_summaries_status_check check(status in (
  'unknown','awaiting_shipment','shipped','in_transit','signed','cancelled','partial',
  'unaccepted','accepted','logistics_cancelled','pickup_failed','sign_exception','mixed','partial_signed','returned_signed','buyer_pickup'));

create or replace function public.commit_alibaba_fulfillment_pilot(p_actor uuid,p_record_id text,p_expected_version integer,p_snapshot jsonb,p_attempted_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_target jsonb;v_status text;v_order text;v_result jsonb;
begin
  -- Existing RPC independently requires an enabled owner/admin.
  v_target:=public.read_alibaba_refresh_target(p_actor,p_record_id);
  if v_target is null or v_target->>'account_code'<>'A' or p_expected_version is distinct from 1
    or (v_target->>'version')::integer is distinct from p_expected_version then
    raise exception 'Pilot association changed' using errcode='40001';
  end if;
  if p_record_id='aa66308b-46d0-4928-86ca-b8441c2caa61' then
    v_status:='awaiting_shipment';v_order:='5127554054006090539';
  elsif p_record_id='ab6fdb15-1d16-4e9b-8838-1f4f38851c58' then
    v_status:='buyer_pickup';v_order:='5127881617007009337';
  else raise exception 'Not a fulfillment pilot' using errcode='42501';end if;
  if v_target->'order_ids' is distinct from jsonb_build_array(v_order)
    or p_snapshot->>'status' is distinct from v_status
    or p_snapshot->'evidence'->'fulfillment'->>'type' is distinct from v_status
    or p_snapshot->'evidence'->'fulfillment'->>'source' is distinct from 'user_confirmed_pilot_and_api_no_logistics'
    or p_snapshot->'evidence'->'queried_order_ids' is distinct from jsonb_build_array(v_order)
    or coalesce((p_snapshot->>'signed_count')::integer,-1)<>0
    or p_snapshot->'evidence'->>'signed_at' is not null then
    raise exception 'Invalid fulfillment evidence' using errcode='22023';
  end if;
  -- Reuse all existing ownership, pool, buyer, version, freshness and audit checks.
  -- The legacy RPC accepts unknown; promote to the validated pilot state within
  -- the same transaction and advisory lock. No permissions on old RPCs expand.
  v_result:=public.commit_alibaba_purchase_snapshot(p_actor,p_record_id,(v_target->>'user_id')::uuid,
    v_target->>'buyer_name','A',array[v_order],p_expected_version,
    jsonb_set(p_snapshot,'{status}','"unknown"'::jsonb),p_attempted_at);
  update public.purchase_logistics_summaries set status=v_status
    where purchase_record_id=p_record_id and link_version=p_expected_version;
  return v_result||jsonb_build_object('status',v_status);
end $$;
revoke all on function public.commit_alibaba_fulfillment_pilot(uuid,text,integer,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.commit_alibaba_fulfillment_pilot(uuid,text,integer,jsonb,timestamptz) to service_role;
commit;
select jsonb_build_object('installed',to_regprocedure('public.commit_alibaba_fulfillment_pilot(uuid,text,integer,jsonb,timestamp with time zone)') is not null,
  'manualEnabled',(select manual_enabled from public.alibaba_sync_control where id),
  'autoEnabled',(select auto_enabled from public.alibaba_sync_control where id)) as no_courier_installation;
