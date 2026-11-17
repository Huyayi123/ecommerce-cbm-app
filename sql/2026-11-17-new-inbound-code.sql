begin;

create sequence if not exists public.new_inbound_code_seq
  as integer minvalue 1 maxvalue 99999 no cycle;

create unique index if not exists purchase_records_new_inbound_code_uidx
  on public.purchase_records (lower(sku))
  where lower(sku) ~ '^new[0-9]{5}$' and coalesce(logistics_source_record_id, '') = '';

create or replace function public.assign_new_inbound_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if lower(old.sku) ~ '^new[0-9]{5}$' then
      new.sku := old.sku;
      return new;
    end if;
  end if;

  if new.sku <> ('new' || replace(new.id, '-', '')) then
    if lower(new.sku) ~ '^new[0-9]{5}$'
       and coalesce(new.logistics_source_record_id, '') = '' then
      raise exception 'New inbound codes must be assigned automatically';
    end if;
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.id, 0));

  select p.sku into new.sku
  from public.purchase_records p
  where p.id = new.id and lower(p.sku) ~ '^new[0-9]{5}$';

  if not found then
    loop
      new.sku := 'new' || lpad(nextval('public.new_inbound_code_seq')::text, 5, '0');
      exit when not exists (
        select 1 from public.purchase_records p where lower(p.sku) = new.sku
      );
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists purchase_records_assign_new_inbound_code on public.purchase_records;
create trigger purchase_records_assign_new_inbound_code
before insert or update of sku on public.purchase_records
for each row execute function public.assign_new_inbound_code();

commit;
