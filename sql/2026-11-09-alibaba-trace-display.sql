begin;
set local lock_timeout = '3s';

alter table public.purchase_logistics_summaries add column if not exists trace_events jsonb;

create or replace function public.project_alibaba_trace_events()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.trace_events := jsonb_path_query_array(new.evidence, '$.shipments[*].latestEvent');
  return new;
end;
$$;

drop trigger if exists alibaba_trace_display on public.purchase_logistics_summaries;
create trigger alibaba_trace_display before insert or update of evidence
on public.purchase_logistics_summaries for each row execute function public.project_alibaba_trace_events();

grant select (trace_events) on public.purchase_logistics_summaries to authenticated;
commit;
