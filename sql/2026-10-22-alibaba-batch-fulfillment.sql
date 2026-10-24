-- Install only in the existing project, while all Alibaba synchronization is paused.
-- No dispatch, cron changes, control changes, historical backfill or purchase writes.
begin;
set local lock_timeout='3s';
set local statement_timeout='20s';
do $$ begin
  if exists(select 1 from public.alibaba_sync_control where manual_enabled or auto_enabled)
    or exists(select 1 from cron.job where active and jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery')) then
    raise exception 'Pause Alibaba sync and both cron jobs before installation';
  end if;
  if exists(select 1 from public.alibaba_sync_runs where state='running') then
    raise exception 'Review unfinished Alibaba runs before installing';
  end if;
  if to_regprocedure('public.commit_alibaba_fulfillment_pilot(uuid,text,integer,jsonb,timestamp with time zone)') is null
    or strpos(pg_get_functiondef('public.derive_alibaba_summary_times()'::regprocedure),'effectiveStatus')=0
    or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='alibaba_sync_jobs' and column_name='failure_code') then
    raise exception 'Install the trace-status, no-courier and failure-category migrations first';
  end if;
end $$;

-- Only service-written, approved evidence for the exact current link may supply
-- context. Stale version, changed order IDs or an unrecognized source yield NULL.
create or replace function public.alibaba_approved_fulfillment_context(p_record text,p_version integer)
returns text language sql stable security definer set search_path='' as $$
  select s.status from public.alibaba_purchase_links l
  join public.purchase_logistics_summaries s on s.purchase_record_id=l.purchase_record_id and s.link_version=l.version
  where l.purchase_record_id=p_record and l.version=p_version and cardinality(l.order_ids)=1
    and s.status in ('awaiting_shipment','buyer_pickup')
    and s.evidence->'fulfillment'->>'type'=s.status
    and s.evidence->'fulfillment'->>'source'='user_confirmed_pilot_and_api_no_logistics'
    and s.evidence->'queried_order_ids'=to_jsonb(l.order_ids)
$$;
revoke all on function public.alibaba_approved_fulfillment_context(text,integer) from public,anon,authenticated,service_role;

create index if not exists alibaba_sync_latest_failure_idx on public.alibaba_sync_jobs(record_id,link_version,attempted_at desc nulls last,run_id desc) where state='failed';
create or replace function public.alibaba_courier_retry_blocked(p_record text,p_version integer)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select not j.retryable from public.alibaba_sync_jobs j
    join public.purchase_logistics_summaries s on s.purchase_record_id=j.record_id and s.link_version=j.link_version
    where j.record_id=p_record and j.link_version=p_version and j.state='failed' and s.sync_error='query_failed'
    order by j.attempted_at desc nulls last,j.run_id desc limit 1),false)
$$;
revoke all on function public.alibaba_courier_retry_blocked(text,integer) from public,anon,authenticated,service_role;

create or replace function public.start_alibaba_sync(p_actor uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_run uuid; v_role text; v_limit integer;
begin
  -- NULL is reserved for the private SQL cron job. HTTP callers cannot select it.
  if p_actor is not null then
    select logistics_role into v_role from public.alibaba_logistics_users
    where user_id=p_actor and enabled and logistics_role in ('owner','admin','buyer');
    if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  end if;
  if not public.alibaba_sync_mode_enabled(p_actor) then raise exception 'Sync paused' using errcode='55000'; end if;
  select record_limit into v_limit from public.alibaba_sync_control where id;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('alibaba-sync-run',0)) then
    raise exception 'Sync busy' using errcode='55P03';
  end if;
  select id into v_run from public.alibaba_sync_runs where state='running';
  if v_run is not null then
    if exists(select 1 from public.alibaba_sync_runs where id=v_run and
      (record_limit is distinct from v_limit or actor_id is distinct from p_actor or actor_role is distinct from v_role)) then
      raise exception 'Existing run uses another synchronization scope' using errcode='55P03';
    end if;
    -- Buyers may not inspect another user's run; owner/admin/cron can reuse it.
    if p_actor is not null and v_role='buyer' and not exists(select 1 from public.alibaba_sync_runs where id=v_run and actor_id=p_actor) then
      raise exception 'Another synchronization is running' using errcode='55P03';
    end if;
    perform public.dispatch_alibaba_sync(v_run);
    return jsonb_build_object('protocol',2,'runId',v_run,'state',(select state from public.alibaba_sync_runs where id=v_run),'recordLimit',(select record_limit from public.alibaba_sync_runs where id=v_run));
  end if;
  insert into public.alibaba_sync_runs(actor_id,record_limit,actor_role) values(p_actor,v_limit,v_role) returning id into v_run;
  insert into public.alibaba_sync_jobs(run_id,record_id,link_version)
  select v_run,l.purchase_record_id,l.version
  from public.alibaba_purchase_links l
  join public.purchase_records p on p.id=l.purchase_record_id
  join public.alibaba_purchase_access a on a.purchase_record_id=l.purchase_record_id and a.account_code=l.account_code
  join public.alibaba_logistics_users u on u.user_id=a.user_id and u.account_code=a.account_code and u.enabled
  join auth.users au on au.id=u.user_id and au.deleted_at is null
  left join public.purchase_logistics_summaries s on s.purchase_record_id=l.purchase_record_id and s.link_version=l.version
  where cardinality(l.order_ids)>0 and cardinality(l.order_ids)<=3
    and p.pool_status in ('submitted_to_pool','haichuan_warehouse','sent_to_inventory') and p.status<>'cancelled'
    and p.assigned_buyer_name=u.buyer_name and lower(trim(p.assigned_buyer_email))=lower(trim(au.email))
    and (p_actor is null or v_role in ('owner','admin') or a.user_id=p_actor)
    and public.alibaba_approved_fulfillment_context(l.purchase_record_id,l.version) is distinct from 'buyer_pickup'
    and (p_actor is not null or not public.alibaba_courier_retry_blocked(l.purchase_record_id,l.version))
    -- Manual refresh includes signed courier records, but not confirmed self-pickup.
    -- Cron stops querying current signed snapshots; failed/unknown records retry.
    and (p_actor is not null or (not (coalesce(s.status,'unknown') in ('signed','returned_signed') and s.signed_at is not null)
      ))
  order by l.purchase_record_id limit v_limit;
  perform public.dispatch_alibaba_sync(v_run);
  return jsonb_build_object('protocol',2,'runId',v_run,'state',(select state from public.alibaba_sync_runs where id=v_run),'recordLimit',v_limit);
end $$;

create or replace function public.claim_alibaba_sync(p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_run uuid; v_actor uuid; v_items jsonb;
begin
  perform 1 from public.alibaba_sync_control where id and (manual_enabled or auto_enabled) for share;
  if not found then raise exception 'Sync paused' using errcode='55000'; end if;
  select id,actor_id into v_run,v_actor from public.alibaba_sync_runs where token=p_token and state='running' and lease_until>now() for update;
  if not found then raise exception 'Invalid worker token' using errcode='42501'; end if;
  if not public.alibaba_sync_mode_enabled(v_actor) then raise exception 'Sync paused' using errcode='55000'; end if;
  update public.alibaba_sync_runs set token=null,active_claim=p_token,dispatch_failures=0,stop_reason=null,lease_until=now()+interval '5 minutes' where id=v_run;
  with selected as (select record_id from public.alibaba_sync_jobs where run_id=v_run and state='pending' order by record_id limit 1 for update skip locked),
  claimed as (update public.alibaba_sync_jobs j set state='processing',attempts=attempts+1,attempted_at=now()
    from selected x where j.run_id=v_run and j.record_id=x.record_id returning j.*)
  select coalesce(jsonb_agg(jsonb_build_object('recordId',c.record_id,'version',c.link_version,'attemptedAt',c.attempted_at,
    'account',l.account_code,'orderIds',l.order_ids,'valid',
      l.version=c.link_version and p.pool_status in ('submitted_to_pool','haichuan_warehouse','sent_to_inventory')
      and p.status<>'cancelled' and u.enabled and u.account_code=l.account_code and au.deleted_at is null
      and u.buyer_name=p.assigned_buyer_name and lower(trim(au.email))=lower(trim(p.assigned_buyer_email))
      and (v_actor is null or exists(select 1 from public.alibaba_logistics_users actor
        where actor.user_id=v_actor and actor.enabled and (actor.logistics_role in ('owner','admin') or (actor.logistics_role='buyer' and a.user_id=v_actor))))
      and ((select actor_id from public.alibaba_sync_runs where id=v_run) is not null or not exists(
        select 1 from public.purchase_logistics_summaries ss where ss.purchase_record_id=c.record_id and ss.link_version=l.version and ss.status in ('signed','returned_signed') and ss.signed_at is not null)))),'[]'::jsonb)
  into v_items from claimed c
  left join public.alibaba_purchase_links l on l.purchase_record_id=c.record_id
  left join public.purchase_records p on p.id=c.record_id
  left join public.alibaba_purchase_access a on a.purchase_record_id=c.record_id
  left join public.alibaba_logistics_users u on u.user_id=a.user_id
  left join auth.users au on au.id=u.user_id;
  return jsonb_build_object('protocol',2,'runId',v_run,'claimId',p_token,'items',v_items);
end $$;

create or replace function public.finish_alibaba_sync_item(p_run uuid,p_record text,p_version integer,p_snapshot jsonb,p_failed boolean)
returns void language plpgsql security definer set search_path='' as $$
declare v_job public.alibaba_sync_jobs%rowtype; v_account text; v_actor uuid;
begin
  select * into v_job from public.alibaba_sync_jobs where run_id=p_run and record_id=p_record and state='processing' for update;
  if not found then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('alibaba:'||p_record,0));
  select actor_id into v_actor from public.alibaba_sync_runs where id=p_run;
  select l.account_code into v_account from public.alibaba_purchase_links l
  join public.purchase_records p on p.id=l.purchase_record_id
  join public.alibaba_purchase_access a on a.purchase_record_id=l.purchase_record_id and a.account_code=l.account_code
  join public.alibaba_logistics_users u on u.user_id=a.user_id and u.account_code=a.account_code and u.enabled
  join auth.users au on au.id=u.user_id and au.deleted_at is null
  where l.purchase_record_id=p_record and l.version=p_version and v_job.link_version=p_version
    and p.pool_status in ('submitted_to_pool','haichuan_warehouse','sent_to_inventory') and p.status<>'cancelled'
    and (v_actor is null or exists(select 1 from public.alibaba_logistics_users actor where actor.user_id=v_actor and actor.enabled
      and (actor.logistics_role in ('owner','admin') or (actor.logistics_role='buyer' and a.user_id=v_actor))))
    and p.assigned_buyer_name=u.buyer_name and lower(trim(p.assigned_buyer_email))=lower(trim(au.email))
    and not exists(select 1 from public.purchase_logistics_summaries s where s.purchase_record_id=p_record and s.last_attempt_at>v_job.attempted_at)
    and (v_actor is not null or not exists(select 1 from public.purchase_logistics_summaries s where s.purchase_record_id=p_record and s.link_version=p_version and s.status in ('signed','returned_signed') and s.signed_at is not null))
    and public.alibaba_approved_fulfillment_context(p_record,p_version) is distinct from 'buyer_pickup'
    and (v_actor is not null or not public.alibaba_courier_retry_blocked(p_record,p_version))
  for share of l,p,u;
  if not found then
    update public.alibaba_sync_jobs set state='skipped' where run_id=p_run and record_id=p_record;return;
  end if;
  if p_failed then
    -- Only attempt/error metadata changes. Success data and link version stay intact.
    insert into public.purchase_logistics_summaries(purchase_record_id,link_version,last_attempt_at,sync_error)
    values(p_record,p_version,v_job.attempted_at,'query_failed')
    on conflict(purchase_record_id) do update set last_attempt_at=excluded.last_attempt_at,sync_error='query_failed';
  else
    if p_snapshot is null or p_snapshot->>'mapping_version' is distinct from 'buyer-logistics-status-v1'
      or coalesce((p_snapshot->>'coverage_confirmed')::boolean,true)
      or coalesce(p_snapshot->>'status','') not in ('unknown','unaccepted','accepted','logistics_cancelled','pickup_failed','sign_exception','in_transit','mixed','partial_signed','returned_signed','awaiting_shipment','buyer_pickup')
      or jsonb_typeof(p_snapshot->'evidence'->'shipments') is distinct from 'array'
      or (p_snapshot->>'shipment_count')::integer<>jsonb_array_length(p_snapshot->'evidence'->'shipments')
      or length(p_snapshot->>'detail')>500 then raise exception 'Invalid snapshot'; end if;
    if p_snapshot->>'status' in ('awaiting_shipment','buyer_pickup') and (
      public.alibaba_approved_fulfillment_context(p_record,p_version) is distinct from p_snapshot->>'status'
      or p_snapshot->'evidence'->'fulfillment'->>'type' is distinct from p_snapshot->>'status'
      or p_snapshot->'evidence'->'fulfillment'->>'source' is distinct from 'user_confirmed_pilot_and_api_no_logistics'
      or p_snapshot->'evidence'->'queried_order_ids' is distinct from (select to_jsonb(order_ids) from public.alibaba_purchase_links where purchase_record_id=p_record)
      or coalesce((p_snapshot->>'signed_count')::integer,-1)<>0
      or p_snapshot->'evidence'->>'signed_at' is not null) then
      raise exception 'Unapproved fulfillment context' using errcode='22023';
    end if;
    insert into public.purchase_logistics_summaries(purchase_record_id,link_version,status,shipment_count,signed_count,unknown_count,exception_count,
      coverage_confirmed,last_success_at,last_attempt_at,sync_error,detail,mapping_version,evidence)
    values(p_record,p_version,p_snapshot->>'status',(p_snapshot->>'shipment_count')::integer,(p_snapshot->>'signed_count')::integer,
      (p_snapshot->>'unknown_count')::integer,(p_snapshot->>'exception_count')::integer,false,now(),v_job.attempted_at,null,
      p_snapshot->>'detail',p_snapshot->>'mapping_version',p_snapshot->'evidence')
    on conflict(purchase_record_id) do update set link_version=excluded.link_version,status=excluded.status,shipment_count=excluded.shipment_count,
      signed_count=excluded.signed_count,unknown_count=excluded.unknown_count,exception_count=excluded.exception_count,
      coverage_confirmed=false,last_success_at=excluded.last_success_at,last_attempt_at=excluded.last_attempt_at,sync_error=null,
      detail=excluded.detail,mapping_version=excluded.mapping_version,evidence=excluded.evidence;
  end if;
  select actor_id into v_actor from public.alibaba_sync_runs where id=p_run;
  insert into public.alibaba_logistics_audit(actor_id,purchase_record_id,action,account_code,link_version)
  values(v_actor,p_record,case when p_failed then 'refresh_failed' else 'refresh' end,v_account,p_version);
  update public.alibaba_sync_jobs set state=case when p_failed then 'failed' else 'success' end where run_id=p_run and record_id=p_record;
end $$;

create or replace function public.alibaba_sync_policy_v2(p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare v_result jsonb; begin
  if not exists(select 1 from public.alibaba_logistics_users where user_id=p_actor and enabled and logistics_role in ('owner','admin','buyer')) then
    raise exception 'Forbidden' using errcode='42501';
  end if;
  select jsonb_build_object('protocol',2,'manualEnabled',manual_enabled,'autoEnabled',auto_enabled,'recordLimit',record_limit,'workerSize',1,'fulfillmentProtocol',1)
    into v_result from public.alibaba_sync_control where id;
  return v_result;
end $$;

create or replace function public.claim_alibaba_sync_v2(p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_batch jsonb;v_item jsonb;v_items jsonb:='[]'::jsonb;v_context text;v_auto boolean;
begin
  v_batch:=public.claim_alibaba_sync(p_token);
  select actor_id is null into v_auto from public.alibaba_sync_runs where id=(v_batch->>'runId')::uuid;
  for v_item in select value from jsonb_array_elements(v_batch->'items') loop
    v_context:=public.alibaba_approved_fulfillment_context(v_item->>'recordId',(v_item->>'version')::integer);
    v_items:=v_items||jsonb_build_array(v_item||jsonb_build_object('fulfillmentContext',v_context,
      'valid',coalesce((v_item->>'valid')::boolean,false) and v_context is distinct from 'buyer_pickup'
        and (not v_auto or not public.alibaba_courier_retry_blocked(v_item->>'recordId',(v_item->>'version')::integer))));
  end loop;
  return v_batch||jsonb_build_object('fulfillmentProtocol',1,'items',v_items);
end $$;

revoke all on function public.start_alibaba_sync(uuid),public.claim_alibaba_sync(uuid),
  public.finish_alibaba_sync_item(uuid,text,integer,jsonb,boolean) from public,anon,authenticated,service_role;
revoke all on function public.claim_alibaba_sync_v2(uuid),public.alibaba_sync_policy_v2(uuid) from public,anon,authenticated;
grant execute on function public.claim_alibaba_sync_v2(uuid),public.alibaba_sync_policy_v2(uuid) to service_role;
commit;

select jsonb_build_object('fulfillmentProtocol',
  case when strpos(pg_get_functiondef('public.claim_alibaba_sync_v2(uuid)'::regprocedure),'fulfillmentProtocol')>0 then 1 else 0 end,
  'manualEnabled',(select manual_enabled from public.alibaba_sync_control where id),
  'autoEnabled',(select auto_enabled from public.alibaba_sync_control where id),
  'recordLimit',(select record_limit from public.alibaba_sync_control where id),
  'cron',(select jsonb_agg(jsonb_build_object('name',jobname,'active',active)) from cron.job
    where jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery'))
) as batch_fulfillment_installation;
