-- Trace-priority compatibility: preserve rawStatus; derive signature counts/times from effectiveStatus when present.
-- Run while manual/automatic sync and both cron jobs remain disabled. No backfill or dispatch.
-- Incremental, rerunnable migration in the EXISTING project.
-- No purchase writes, historical backfill, network calls or scheduler changes.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$ begin
  if exists(select 1 from public.alibaba_sync_control where manual_enabled or auto_enabled)
    or exists(select 1 from cron.job where active and jobname in ('alibaba-logistics-every-two-hours','alibaba-logistics-worker-recovery')) then
    raise exception 'Pause Alibaba manual/automatic synchronization and both cron jobs before installation';
  end if;
end $$;

alter table public.purchase_logistics_summaries
  add column if not exists signed_at timestamptz,
  add column if not exists latest_trace_at timestamptz;

create or replace function public.alibaba_trace_timestamp(p_value text)
returns timestamptz language plpgsql immutable strict set search_path='' as $$
declare v_time timestamptz;
begin
  if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then return null; end if;
  v_time := p_value::timestamptz;
  if to_char(v_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> p_value then return null; end if;
  return v_time;
exception when invalid_datetime_format or datetime_field_overflow then return null;
end $$;

create or replace function public.derive_alibaba_summary_times()
returns trigger language plpgsql set search_path='' as $$
declare
  v_item jsonb; v_old jsonb; v_items jsonb := '[]'::jsonb;
  v_signed timestamptz; v_trace timestamptz; v_last_signed timestamptz; v_last_trace timestamptz;
  v_count integer := 0; v_signed_count integer := 0; v_timed_signed_count integer := 0;
begin
  new.signed_at := null;
  new.latest_trace_at := null;
  if jsonb_typeof(new.evidence->'shipments') is distinct from 'array' then return new; end if;
  if jsonb_array_length(new.evidence->'shipments') > 600 then raise exception 'Too many logistics shipments'; end if;
  for v_item in select value from jsonb_array_elements(new.evidence->'shipments') loop
    v_count := v_count + 1;
    v_signed := public.alibaba_trace_timestamp(v_item->>'signedAt');
    v_trace := public.alibaba_trace_timestamp(v_item->>'latestTraceAt');
    if v_signed < '2000-01-01T00:00:00Z'::timestamptz or v_signed > now()+interval '5 minutes' then v_signed := null; end if;
    if v_trace < '2000-01-01T00:00:00Z'::timestamptz or v_trace > now()+interval '5 minutes' then v_trace := null; end if;
    if v_item->>'signedAtSource' is null or v_item->>'signedAtSource' not in ('action_SIGN','explicit_signed_text') then v_signed := null; end if;
    -- Preserve confirmed historical times only for the same linked order and
    -- logistics ID. Never carry them across a changed association/version.
    if tg_op = 'UPDATE' and old.link_version = new.link_version
      and jsonb_typeof(old.evidence->'shipments') = 'array' then
      select value into v_old from jsonb_array_elements(old.evidence->'shipments')
      where value->>'orderId' = v_item->>'orderId' and value->>'logisticsId' = v_item->>'logisticsId' limit 1;
      if v_signed is null and coalesce(v_item->>'effectiveStatus',v_item->>'rawStatus') = 'SIGN' and coalesce(v_old->>'effectiveStatus',v_old->>'rawStatus') = 'SIGN'
        and v_old->>'signedAtSource' in ('action_SIGN','explicit_signed_text') then
        v_signed := public.alibaba_trace_timestamp(v_old->>'signedAt');
        v_item := jsonb_set(v_item, '{signedAtSource}', v_old->'signedAtSource');
      end if;
      v_trace := greatest(v_trace, public.alibaba_trace_timestamp(v_old->>'latestTraceAt'));
    end if;
    if coalesce(v_item->>'effectiveStatus',v_item->>'rawStatus') = 'SIGN' then
      v_signed_count := v_signed_count + 1;
      if v_signed is not null then
        v_timed_signed_count := v_timed_signed_count + 1;
        v_last_signed := greatest(v_last_signed, v_signed);
      end if;
    else v_signed := null;
    end if;
    v_last_trace := greatest(v_last_trace, v_trace);
    v_items := v_items || jsonb_build_array(v_item || jsonb_build_object(
      'signedAt', case when v_signed is null then null else to_char(v_signed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'latestTraceAt', case when v_trace is null then null else to_char(v_trace at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end));
  end loop;
  if new.status in ('signed','returned_signed','partial_signed') and v_signed_count > 0
    and (v_signed_count < v_count or v_timed_signed_count = v_signed_count) then
    new.signed_at := v_last_signed;
  end if;
  new.latest_trace_at := v_last_trace;
  new.evidence := new.evidence || jsonb_build_object('shipments',v_items,
    'signed_at', case when new.signed_at is null then null else to_char(new.signed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'latest_trace_at', case when new.latest_trace_at is null then null else to_char(new.latest_trace_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end);
  return new;
end $$;

drop trigger if exists alibaba_summary_times on public.purchase_logistics_summaries;
create trigger alibaba_summary_times before insert or update of evidence, link_version, status
on public.purchase_logistics_summaries for each row execute function public.derive_alibaba_summary_times();

revoke all on function public.alibaba_trace_timestamp(text), public.derive_alibaba_summary_times() from public,anon,authenticated;
grant execute on function public.alibaba_trace_timestamp(text), public.derive_alibaba_summary_times() to service_role;
grant select (signed_at,latest_trace_at) on public.purchase_logistics_summaries to authenticated;
commit;

-- Verify column access only; this does not read business rows.
select column_name, data_type
from information_schema.columns
where table_schema='public' and table_name='purchase_logistics_summaries'
  and column_name in ('signed_at','latest_trace_at') order by column_name;

select jsonb_build_object('tracePrioritySupported',
  strpos(pg_get_functiondef('public.derive_alibaba_summary_times()'::regprocedure),'effectiveStatus')>0,
  'manualEnabled',(select manual_enabled from public.alibaba_sync_control where id),
  'autoEnabled',(select auto_enabled from public.alibaba_sync_control where id)) as trace_status_installation;
