-- DRAFT: do not execute until preflight results and backup/recovery are reviewed.
-- Does not alter purchase, inventory, logistics or warehouse tables/policies.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- Fail closed on schema drift or previous installations. Do not silently reuse
-- same-name production objects or replace existing functions/policies.
do $$
begin
  if to_regclass('public.purchase_records') is null then
    raise exception 'Required existing tables are missing; do not run the main supabase.sql as a workaround';
  end if;
  if exists (
    select 1 from (values
      ('purchase_records','id','text')
    ) expected(table_name,column_name,data_type)
    where not exists (
      select 1 from information_schema.columns actual where actual.table_schema = 'public'
      and actual.table_name = expected.table_name and actual.column_name = expected.column_name
      and actual.data_type = expected.data_type
    )
  ) then raise exception 'Existing schema differs from reviewed requirements'; end if;
  if to_regclass('public.alibaba_buyer_accounts') is not null
    or to_regclass('public.alibaba_purchase_links') is not null
    or to_regclass('public.purchase_logistics_summaries') is not null
    or to_regclass('public.alibaba_logistics_users') is not null
    or to_regclass('public.alibaba_purchase_access') is not null
    or exists (
      select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('can_read_alibaba_purchase','save_alibaba_purchase_link')
    ) then raise exception '1688 objects already exist; stop and review before retrying'; end if;
end
$$;

create table public.alibaba_buyer_accounts (
  buyer_name text primary key,
  account_code text not null check (account_code in ('A', 'B')),
  unique (buyer_name, account_code)
);
insert into public.alibaba_buyer_accounts values
  ('孙杰','A'),('章瀚成','A'),('李靖阳','A'),('伍菊开','A'),('梁潘','A'),('黄柏钧','A'),
  ('胡雅怡','B'),('彭志红','B');

-- Provision only via trusted SQL/service role after verifying auth.users IDs.
-- Deliberately empty: nobody gains access based on mutable profiles fields.
create table public.alibaba_logistics_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  logistics_role text not null check (logistics_role in ('owner','admin','buyer','viewer')),
  buyer_name text,
  account_code text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (buyer_name, account_code) references public.alibaba_buyer_accounts(buyer_name, account_code),
  check ((buyer_name is null) = (account_code is null)),
  check (logistics_role in ('owner','admin') or buyer_name is not null),
  unique (user_id,account_code)
);

-- Approved separately; never import or update automatically from assigned email.
create table public.alibaba_purchase_access (
  purchase_record_id text primary key references public.purchase_records(id) on delete cascade,
  user_id uuid not null,
  account_code text not null check (account_code in ('A','B')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz not null default now(),
  foreign key (user_id,account_code) references public.alibaba_logistics_users(user_id,account_code) on delete cascade
);
create index alibaba_purchase_access_user_idx on public.alibaba_purchase_access(user_id);

create table public.alibaba_purchase_links (
  purchase_record_id text primary key references public.purchase_records(id) on delete cascade,
  account_code text not null check (account_code in ('A','B')),
  order_ids text[] not null default '{}',
  version integer not null default 1 check (version > 0),
  verification_status text not null default 'pending' check (verification_status in ('pending','verified','failed')),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (cardinality(order_ids) <= 30)
);

create table public.purchase_logistics_summaries (
  purchase_record_id text primary key references public.alibaba_purchase_links(purchase_record_id) on delete cascade,
  link_version integer not null,
  status text not null default 'unknown' check (status in (
    'unknown','awaiting_shipment','shipped','in_transit','signed','cancelled','partial',
    'unaccepted','accepted','logistics_cancelled','pickup_failed','sign_exception','mixed','partial_signed','returned_signed'
  )),
  shipment_count integer not null default 0 check (shipment_count >= 0),
  signed_count integer not null default 0 check (signed_count >= 0 and signed_count <= shipment_count),
  unknown_count integer not null default 0 check (unknown_count >= 0 and unknown_count <= shipment_count),
  exception_count integer not null default 0 check (exception_count >= 0 and exception_count <= shipment_count),
  coverage_confirmed boolean not null default false,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  sync_error text,
  detail text,
  mapping_version text,
  evidence jsonb not null default '{}'::jsonb,
  check (status <> 'signed' or (coverage_confirmed and shipment_count > 0 and signed_count = shipment_count and unknown_count = 0 and exception_count = 0))
);

alter table public.alibaba_buyer_accounts enable row level security;
alter table public.alibaba_logistics_users enable row level security;
alter table public.alibaba_purchase_access enable row level security;
alter table public.alibaba_purchase_links enable row level security;
alter table public.purchase_logistics_summaries enable row level security;
revoke all on public.alibaba_buyer_accounts, public.alibaba_purchase_links, public.purchase_logistics_summaries from public, anon, authenticated;
revoke all on public.alibaba_logistics_users, public.alibaba_purchase_access from public, anon, authenticated;
grant select (user_id,logistics_role,buyer_name,account_code,enabled) on public.alibaba_logistics_users to authenticated;
grant select (purchase_record_id,user_id,account_code) on public.alibaba_purchase_access to authenticated;
grant select (purchase_record_id,account_code,order_ids,version,verification_status) on public.alibaba_purchase_links to authenticated;
grant select (purchase_record_id,link_version,status,last_success_at,sync_error,detail) on public.purchase_logistics_summaries to authenticated;
grant all on public.alibaba_buyer_accounts, public.alibaba_purchase_links, public.purchase_logistics_summaries to service_role;
grant all on public.alibaba_logistics_users, public.alibaba_purchase_access to service_role;

create policy alibaba_users_read_self on public.alibaba_logistics_users for select to authenticated
using (user_id = auth.uid());

create function public.can_read_alibaba_purchase(p_record_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.alibaba_logistics_users u
    where u.user_id = auth.uid() and u.enabled and (
      u.logistics_role in ('owner','admin')
      or exists (
        select 1 from public.alibaba_purchase_access a
        where a.purchase_record_id = p_record_id and a.user_id = u.user_id and a.account_code = u.account_code
      )
    )
  )
$$;
revoke all on function public.can_read_alibaba_purchase(text) from public;
grant execute on function public.can_read_alibaba_purchase(text) to authenticated;

create policy alibaba_access_read on public.alibaba_purchase_access for select to authenticated
using (public.can_read_alibaba_purchase(purchase_record_id));

create policy alibaba_links_read on public.alibaba_purchase_links for select to authenticated
using (public.can_read_alibaba_purchase(purchase_record_id));
create policy alibaba_summaries_read on public.purchase_logistics_summaries for select to authenticated
using (public.can_read_alibaba_purchase(purchase_record_id));

create function public.save_alibaba_purchase_link(p_record_id text, p_order_ids text[], p_expected_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_account text;
  v_saved public.alibaba_purchase_links%rowtype;
  v_user public.alibaba_logistics_users%rowtype;
  v_ids text[];
begin
  select * into v_user from public.alibaba_logistics_users where user_id = auth.uid() and enabled for share;
  v_role := v_user.logistics_role;
  if v_role is null or v_role not in ('owner','admin','buyer') then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  -- Serialize on the new approval row, never lock/update existing business rows.
  select a.account_code into v_account from public.alibaba_purchase_access a
  join public.alibaba_logistics_users target on target.user_id = a.user_id and target.account_code = a.account_code and target.enabled
  where a.purchase_record_id = p_record_id for update of a;
  if not found or not public.can_read_alibaba_purchase(p_record_id) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  if v_account is null then raise exception 'Order access has not been independently approved'; end if;
  if p_order_ids is null or cardinality(p_order_ids) > 30 or exists (
    select 1 from unnest(p_order_ids) x where x is null or x !~ '^[1-9][0-9]{0,29}$'
  ) then raise exception 'Invalid order IDs'; end if;
  select coalesce(array_agg(x order by first_position), '{}'::text[]) into v_ids from (
    select x, min(position) first_position from unnest(p_order_ids) with ordinality as a(x, position) group by x
  ) unique_ids;
  select * into v_saved from public.alibaba_purchase_links where purchase_record_id = p_record_id;
  if coalesce(v_saved.version,0) <> p_expected_version or p_expected_version is null then
    raise exception 'Link changed; reload before saving' using errcode = '40001';
  end if;
  if v_saved.account_code is not null and v_saved.account_code <> v_account then
    raise exception 'Account mismatch; existing account is immutable';
  end if;
  insert into public.alibaba_purchase_links(purchase_record_id,account_code,order_ids,updated_by)
  values (p_record_id,v_account,v_ids,auth.uid())
  on conflict (purchase_record_id) do update set
    order_ids = excluded.order_ids, version = public.alibaba_purchase_links.version + 1,
    verification_status = 'pending', updated_by = auth.uid(), updated_at = now();
  -- Keep old evidence, but its link_version will no longer match the edited link.
end
$$;
revoke all on function public.save_alibaba_purchase_link(text,text[],integer) from public;
grant execute on function public.save_alibaba_purchase_link(text,text[],integer) to authenticated;
commit;
