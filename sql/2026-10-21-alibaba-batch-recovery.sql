-- Incremental recovery only. Existing project; original foundation/batch/time SQL must exist.
-- Installs DISABLED policy. Never starts HTTP, enables cron, deletes data or edits purchase records.
begin;
set local lock_timeout='3s';
set local statement_timeout='20s';
do $$begin
  if exists(select 1 from cron.job where active and jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery')) then
    raise exception 'Pause the two Alibaba cron jobs before installing recovery';
  end if;
end $$;
create table if not exists public.alibaba_sync_control (
  id boolean primary key default true check(id),
  manual_enabled boolean not null default false,
  auto_enabled boolean not null default false,
  record_limit integer default 5 check(record_limit is null or record_limit between 1 and 5),
  check(not auto_enabled or record_limit is null)
);
insert into public.alibaba_sync_control(id) values(true) on conflict(id) do nothing;
do $$begin
  if exists(select 1 from public.alibaba_sync_control where manual_enabled or auto_enabled) then
    raise exception 'Disable database sync controls before reinstalling recovery';
  end if;
end $$;
alter table public.alibaba_sync_control enable row level security;
revoke all on public.alibaba_sync_control from public,anon,authenticated,service_role;
alter table public.alibaba_sync_runs
  add column if not exists active_claim uuid,
  add column if not exists dispatch_failures integer not null default 0 check(dispatch_failures>=0),
  add column if not exists record_limit integer,
  add column if not exists actor_role text,
  add column if not exists stop_reason text;
create index if not exists alibaba_sync_pending_idx on public.alibaba_sync_jobs(run_id,record_id) where state='pending';
create index if not exists alibaba_sync_processing_idx on public.alibaba_sync_jobs(run_id) where state='processing';

-- Close ONLY the known expired incident run. Successful jobs and snapshots stay intact.
do $$declare v_run uuid; begin
  select id into v_run from public.alibaba_sync_runs
  where id='7f9e5a3d-3707-46dc-8471-7fca49dc91e3' and state='running'
    and coalesce(lease_until,created_at+interval '5 minutes')<now() for update;
  if found then
    update public.alibaba_sync_jobs set state='skipped' where run_id=v_run and state in ('pending','processing');
    update public.alibaba_sync_runs set state='complete',token=null,active_claim=null,lease_until=null,
      finished_at=now(),stop_reason='INCIDENT_CANCELLED' where id=v_run;
  end if;
end $$;

create or replace function public.alibaba_sync_mode_enabled(p_actor uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_policy public.alibaba_sync_control%rowtype; begin
  select * into v_policy from public.alibaba_sync_control where id for share;
  return coalesce(case when p_actor is null then v_policy.auto_enabled and v_policy.record_limit is null else v_policy.manual_enabled end,false);
end $$;

-- All worker paths lock policy before run/job rows, including during pause.
create or replace function public.dispatch_alibaba_sync(p_run uuid) returns void
language plpgsql security definer set search_path='' as $$
declare v_run public.alibaba_sync_runs%rowtype; v_token uuid; begin
  perform 1 from public.alibaba_sync_control where id and (manual_enabled or auto_enabled) for share;
  if not found then return; end if;
  select * into v_run from public.alibaba_sync_runs where id=p_run and state='running' for update;
  if not found or not public.alibaba_sync_mode_enabled(v_run.actor_id) or v_run.lease_until>now() then return; end if;
  update public.alibaba_sync_jobs set state=case when attempts>=3 then 'failed' else 'pending' end
    where run_id=p_run and state='processing';
  if v_run.dispatch_failures>=3 then
    update public.alibaba_sync_jobs set state='failed' where run_id=p_run and state in ('pending','processing');
    update public.alibaba_sync_runs set state='complete',token=null,active_claim=null,lease_until=null,
      finished_at=now(),stop_reason='DISPATCH_UNCLAIMED' where id=p_run;
    return;
  end if;
  if not exists(select 1 from public.alibaba_sync_jobs where run_id=p_run and state='pending') then
    update public.alibaba_sync_runs set state='complete',token=null,active_claim=null,lease_until=null,finished_at=now() where id=p_run;
    return;
  end if;
  v_token:=gen_random_uuid();
  update public.alibaba_sync_runs set token=v_token,active_claim=null,dispatch_failures=dispatch_failures+1,
    lease_until=now()+interval '5 minutes' where id=p_run;
  begin
    perform net.http_post(url:='https://app.huishangtrade.com/api/alibaba-sync',headers:='{"Content-Type":"application/json"}'::jsonb,
      body:=jsonb_build_object('workerToken',v_token),timeout_milliseconds:=120000);
  exception when others then
    update public.alibaba_sync_runs set stop_reason='DISPATCH_QUEUE_ERROR' where id=p_run;
  end;
end $$;

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
    -- Manual refresh includes all authorized submitted records, including signed.
    -- Cron stops querying current signed snapshots; failed/unknown records retry.
    and (p_actor is not null or (coalesce(s.status,'unknown') not in ('signed','returned_signed')
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
        select 1 from public.purchase_logistics_summaries ss where ss.purchase_record_id=c.record_id and ss.link_version=l.version and ss.status in ('signed','returned_signed'))))),'[]'::jsonb)
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
    and (v_actor is not null or not exists(select 1 from public.purchase_logistics_summaries s where s.purchase_record_id=p_record and s.link_version=p_version and s.status in ('signed','returned_signed')))
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
      or coalesce(p_snapshot->>'status','') not in ('unknown','unaccepted','accepted','logistics_cancelled','pickup_failed','sign_exception','in_transit','mixed','partial_signed','returned_signed')
      or jsonb_typeof(p_snapshot->'evidence'->'shipments') is distinct from 'array'
      or (p_snapshot->>'shipment_count')::integer<>jsonb_array_length(p_snapshot->'evidence'->'shipments')
      or length(p_snapshot->>'detail')>500 then raise exception 'Invalid snapshot'; end if;
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


create or replace function public.alibaba_sync_progress(p_actor uuid,p_run uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_role text; v_result jsonb;
begin
  select logistics_role into v_role from public.alibaba_logistics_users where user_id=p_actor and enabled;
  if v_role is null or not exists(select 1 from public.alibaba_sync_runs where id=p_run and
    (v_role in ('owner','admin') or (v_role='buyer' and actor_id=p_actor))) then raise exception 'Forbidden' using errcode='42501'; end if;
  select jsonb_build_object('protocol',2,'recordLimit',r.record_limit,'stopReason',r.stop_reason,'state',r.state,'total',count(j.record_id),'success',count(*) filter(where j.state='success'),
    'failed',count(*) filter(where j.state='failed'),'skipped',count(*) filter(where j.state='skipped')) into v_result
  from public.alibaba_sync_runs r left join public.alibaba_sync_jobs j on j.run_id=r.id where r.id=p_run group by r.id;
  return v_result;
end $$;


create or replace function public.continue_alibaba_sync(p_run uuid) returns void
language plpgsql security definer set search_path='' as $$begin
  if exists(select 1 from public.alibaba_sync_jobs where run_id=p_run and state='processing') then
    raise exception 'Worker still processing' using errcode='55P03';
  end if;
  update public.alibaba_sync_runs set lease_until=null,active_claim=null,token=null where id=p_run and state='running';
  perform public.dispatch_alibaba_sync(p_run);
end $$;

create or replace function public.recover_alibaba_sync() returns void
language plpgsql security definer set search_path='' as $$declare v_id uuid; begin
  perform 1 from public.alibaba_sync_control where id and (manual_enabled or auto_enabled) for share;
  if not found then return; end if;
  for v_id in select id from public.alibaba_sync_runs where state='running' and (lease_until is null or lease_until<now()) limit 1 loop
    perform public.dispatch_alibaba_sync(v_id);
  end loop;
end $$;

create or replace function public.alibaba_sync_policy_v2(p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare v_result jsonb; begin
  if not exists(select 1 from public.alibaba_logistics_users where user_id=p_actor and enabled and logistics_role in ('owner','admin','buyer')) then
    raise exception 'Forbidden' using errcode='42501';
  end if;
  select jsonb_build_object('protocol',2,'manualEnabled',manual_enabled,'autoEnabled',auto_enabled,'recordLimit',record_limit,'workerSize',1)
    into v_result from public.alibaba_sync_control where id;
  return v_result;
end $$;

create or replace function public.assert_alibaba_claim_v2(p_run uuid,p_claim uuid) returns void
language plpgsql security definer set search_path='' as $$declare v_run public.alibaba_sync_runs%rowtype; begin
  perform 1 from public.alibaba_sync_control where id and (manual_enabled or auto_enabled) for share;
  if not found then raise exception 'Sync paused' using errcode='55000'; end if;
  select * into v_run from public.alibaba_sync_runs where id=p_run for update;
  if not found or v_run.state<>'running' or v_run.active_claim is distinct from p_claim or p_claim is null or v_run.lease_until is null or v_run.lease_until<=now() then
    raise exception 'Stale claim' using errcode='42501';
  end if;
  if not public.alibaba_sync_mode_enabled(v_run.actor_id) then raise exception 'Sync paused' using errcode='55000'; end if;
end $$;

create or replace function public.start_alibaba_sync_v2(p_actor uuid,p_expected_limit integer default 5) returns jsonb
language plpgsql security definer set search_path='' as $$declare v_limit integer; begin
  select record_limit into v_limit from public.alibaba_sync_control where id for share;
  if v_limit is distinct from p_expected_limit then raise exception 'Sync mode changed' using errcode='22023'; end if;
  return public.start_alibaba_sync(p_actor);
end $$;
create or replace function public.claim_alibaba_sync_v2(p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin return public.claim_alibaba_sync(p_token); end $$;
create or replace function public.finish_alibaba_sync_item_v2(p_run uuid,p_record text,p_version integer,p_snapshot jsonb,p_failed boolean,p_claim uuid)
returns void language plpgsql security definer set search_path='' as $$begin
  perform public.assert_alibaba_claim_v2(p_run,p_claim);
  perform public.finish_alibaba_sync_item(p_run,p_record,p_version,p_snapshot,p_failed);
end $$;
create or replace function public.continue_alibaba_sync_v2(p_run uuid,p_claim uuid) returns void
language plpgsql security definer set search_path='' as $$begin
  perform public.assert_alibaba_claim_v2(p_run,p_claim);
  perform public.continue_alibaba_sync(p_run);
end $$;
create or replace function public.alibaba_sync_progress_v2(p_actor uuid,p_run uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin return public.alibaba_sync_progress(p_actor,p_run); end $$;

revoke all on function public.start_alibaba_sync(uuid),public.claim_alibaba_sync(uuid),public.finish_alibaba_sync_item(uuid,text,integer,jsonb,boolean),
  public.continue_alibaba_sync(uuid),public.alibaba_sync_progress(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.dispatch_alibaba_sync(uuid),public.recover_alibaba_sync(),public.alibaba_sync_mode_enabled(uuid),public.assert_alibaba_claim_v2(uuid,uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.alibaba_sync_policy_v2(uuid),public.start_alibaba_sync_v2(uuid,integer),public.claim_alibaba_sync_v2(uuid),
  public.finish_alibaba_sync_item_v2(uuid,text,integer,jsonb,boolean,uuid),public.continue_alibaba_sync_v2(uuid,uuid),public.alibaba_sync_progress_v2(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.alibaba_sync_policy_v2(uuid),public.start_alibaba_sync_v2(uuid,integer),public.claim_alibaba_sync_v2(uuid),
  public.finish_alibaba_sync_item_v2(uuid,text,integer,jsonb,boolean,uuid),public.continue_alibaba_sync_v2(uuid,uuid),public.alibaba_sync_progress_v2(uuid,uuid) to service_role;
commit;

select jsonb_pretty(jsonb_build_object(
  'protocol',2,
  'control',(select jsonb_build_object('manualEnabled',manual_enabled,'autoEnabled',auto_enabled,'recordLimit',record_limit) from public.alibaba_sync_control where id),
  'incidentRun',(select jsonb_build_object('state',state,'stopReason',stop_reason,'finishedAt',finished_at) from public.alibaba_sync_runs where id='7f9e5a3d-3707-46dc-8471-7fca49dc91e3'),
  'cron',(select jsonb_agg(jsonb_build_object('name',jobname,'active',active)) from cron.job where jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery')),
  'indexes',(select jsonb_agg(indexname) from pg_indexes where schemaname='public' and indexname in ('alibaba_sync_pending_idx','alibaba_sync_processing_idx'))
)) as recovery_installation;
