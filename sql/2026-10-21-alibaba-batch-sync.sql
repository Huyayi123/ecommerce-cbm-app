-- Install once in the existing Supabase SQL Editor.
-- Uses Supabase Cron, not a paid Vercel cron plan. No API keys are embedded.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table public.alibaba_sync_runs (
  id uuid primary key default gen_random_uuid(), actor_id uuid references auth.users(id),
  state text not null default 'running' check(state in ('running','complete')),
  token uuid, lease_until timestamptz, created_at timestamptz not null default now(), finished_at timestamptz
);
create unique index alibaba_sync_single_run on public.alibaba_sync_runs(state) where state='running';
create table public.alibaba_sync_jobs (
  run_id uuid not null references public.alibaba_sync_runs(id) on delete cascade,
  record_id text not null, link_version integer not null,
  state text not null default 'pending' check(state in ('pending','processing','success','failed','skipped')),
  attempts integer not null default 0, attempted_at timestamptz,
  primary key(run_id,record_id)
);
alter table public.alibaba_sync_runs enable row level security;
alter table public.alibaba_sync_jobs enable row level security;
revoke all on public.alibaba_sync_runs,public.alibaba_sync_jobs from public,anon,authenticated;
grant all on public.alibaba_sync_runs,public.alibaba_sync_jobs to service_role;

create function public.dispatch_alibaba_sync(p_run uuid) returns void
language plpgsql security definer set search_path='' as $$
declare v_run public.alibaba_sync_runs%rowtype; v_token uuid;
begin
  select * into v_run from public.alibaba_sync_runs where id=p_run and state='running' for update;
  if not found or v_run.lease_until>now() then return; end if;
  -- A worker lost during a request can be recovered without losing its last snapshot.
  update public.alibaba_sync_jobs set state=case when attempts>=3 then 'failed' else 'pending' end
  where run_id=p_run and state='processing';
  if not exists(select 1 from public.alibaba_sync_jobs where run_id=p_run and state='pending') then
    update public.alibaba_sync_runs set state='complete',token=null,finished_at=now(),lease_until=null where id=p_run;
    return;
  end if;
  v_token:=gen_random_uuid();
  update public.alibaba_sync_runs set token=v_token,lease_until=now()+interval '5 minutes' where id=p_run;
  perform net.http_post(url:='https://app.huishangtrade.com/api/alibaba-sync',
    headers:='{"Content-Type":"application/json"}'::jsonb,
    body:=jsonb_build_object('workerToken',v_token),timeout_milliseconds:=240000);
end $$;

create function public.start_alibaba_sync(p_actor uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_run uuid; v_role text;
begin
  -- NULL is reserved for the private SQL cron job. HTTP callers cannot select it.
  if p_actor is not null then
    select logistics_role into v_role from public.alibaba_logistics_users
    where user_id=p_actor and enabled and logistics_role in ('owner','admin','buyer');
    if not found then raise exception 'Forbidden' using errcode='42501'; end if;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('alibaba-sync-run',0));
  select id into v_run from public.alibaba_sync_runs where state='running';
  if v_run is not null then
    -- Buyers may not inspect another user's run; owner/admin/cron can reuse it.
    if p_actor is not null and v_role='buyer' and not exists(select 1 from public.alibaba_sync_runs where id=v_run and actor_id=p_actor) then
      raise exception 'Another synchronization is running' using errcode='55P03';
    end if;
    perform public.dispatch_alibaba_sync(v_run);
    return jsonb_build_object('runId',v_run,'state','running');
  end if;
  insert into public.alibaba_sync_runs(actor_id) values(p_actor) returning id into v_run;
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
      ));
  perform public.dispatch_alibaba_sync(v_run);
  return jsonb_build_object('runId',v_run,'state',(select state from public.alibaba_sync_runs where id=v_run));
end $$;

create function public.claim_alibaba_sync(p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_run uuid; v_items jsonb;
begin
  select id into v_run from public.alibaba_sync_runs where token=p_token and state='running' and lease_until>now() for update;
  if not found then raise exception 'Invalid worker token' using errcode='42501'; end if;
  update public.alibaba_sync_runs set token=null,lease_until=now()+interval '5 minutes' where id=v_run;
  with selected as (select record_id from public.alibaba_sync_jobs where run_id=v_run and state='pending' order by record_id limit 3 for update skip locked),
  claimed as (update public.alibaba_sync_jobs j set state='processing',attempts=attempts+1,attempted_at=now()
    from selected x where j.run_id=v_run and j.record_id=x.record_id returning j.*)
  select coalesce(jsonb_agg(jsonb_build_object('recordId',c.record_id,'version',c.link_version,'attemptedAt',c.attempted_at,
    'account',l.account_code,'orderIds',l.order_ids,'valid',
      l.version=c.link_version and p.pool_status in ('submitted_to_pool','haichuan_warehouse','sent_to_inventory')
      and p.status<>'cancelled' and u.enabled and u.account_code=l.account_code and au.deleted_at is null
      and u.buyer_name=p.assigned_buyer_name and lower(trim(au.email))=lower(trim(p.assigned_buyer_email))
      and ((select actor_id from public.alibaba_sync_runs where id=v_run) is not null or not exists(
        select 1 from public.purchase_logistics_summaries ss where ss.purchase_record_id=c.record_id and ss.link_version=l.version and ss.status in ('signed','returned_signed'))))),'[]'::jsonb)
  into v_items from claimed c
  left join public.alibaba_purchase_links l on l.purchase_record_id=c.record_id
  left join public.purchase_records p on p.id=c.record_id
  left join public.alibaba_purchase_access a on a.purchase_record_id=c.record_id
  left join public.alibaba_logistics_users u on u.user_id=a.user_id
  left join auth.users au on au.id=u.user_id;
  return jsonb_build_object('runId',v_run,'items',v_items);
end $$;

create function public.finish_alibaba_sync_item(p_run uuid,p_record text,p_version integer,p_snapshot jsonb,p_failed boolean)
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

create function public.continue_alibaba_sync(p_run uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  update public.alibaba_sync_runs set lease_until=null where id=p_run and state='running';
  perform public.dispatch_alibaba_sync(p_run);
end $$;

create function public.alibaba_sync_progress(p_actor uuid,p_run uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_role text; v_result jsonb;
begin
  select logistics_role into v_role from public.alibaba_logistics_users where user_id=p_actor and enabled;
  if v_role is null or not exists(select 1 from public.alibaba_sync_runs where id=p_run and
    (v_role in ('owner','admin') or (v_role='buyer' and actor_id=p_actor))) then raise exception 'Forbidden' using errcode='42501'; end if;
  select jsonb_build_object('state',r.state,'total',count(j.record_id),'success',count(*) filter(where j.state='success'),
    'failed',count(*) filter(where j.state='failed'),'skipped',count(*) filter(where j.state='skipped')) into v_result
  from public.alibaba_sync_runs r left join public.alibaba_sync_jobs j on j.run_id=r.id where r.id=p_run group by r.id;
  return v_result;
end $$;

create function public.recover_alibaba_sync() returns void
language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  for v_id in select id from public.alibaba_sync_runs where state='running' and lease_until<now() loop
    perform public.dispatch_alibaba_sync(v_id);
  end loop;
end $$;

revoke all on function public.dispatch_alibaba_sync(uuid),public.start_alibaba_sync(uuid),public.claim_alibaba_sync(uuid),
  public.finish_alibaba_sync_item(uuid,text,integer,jsonb,boolean),public.continue_alibaba_sync(uuid),
  public.alibaba_sync_progress(uuid,uuid),public.recover_alibaba_sync() from public,anon,authenticated;
grant execute on function public.start_alibaba_sync(uuid),public.claim_alibaba_sync(uuid),
  public.finish_alibaba_sync_item(uuid,text,integer,jsonb,boolean),public.continue_alibaba_sync(uuid),
  public.alibaba_sync_progress(uuid,uuid) to service_role;

select cron.schedule('alibaba-logistics-every-two-hours','0 */2 * * *',$job$select public.start_alibaba_sync(null);$job$);
-- No network/1688 request unless a previously started worker needs recovery.
select cron.schedule('alibaba-logistics-worker-recovery','*/5 * * * *',$job$select public.recover_alibaba_sync();$job$);
commit;

select jobname,schedule,active from cron.job where jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery');
