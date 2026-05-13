create extension if not exists pgcrypto;

do $$ begin
  create type public.app_role as enum ('admin', 'buyer', 'viewer');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.purchase_status as enum ('in_transit', 'arrived', 'cancelled');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role public.app_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sku_items (
  id text primary key,
  sku text,
  product_name text,
  english_name text,
  manufacturer_name text,
  shop_name text,
  buyer_name text,
  purchase_price numeric default 0,
  carton_length_cm numeric default 0,
  carton_width_cm numeric default 0,
  carton_height_cm numeric default 0,
  units_per_carton numeric default 0,
  total_quantity numeric default 0,
  total_cbm numeric default 0,
  manual_unit_cbm numeric default 0,
  cbm_source text default 'missing',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sku_items
add column if not exists purchase_price numeric default 0;

alter table public.sku_items
add column if not exists manual_unit_cbm numeric default 0;

alter table public.sku_items
add column if not exists cbm_source text default 'missing';

alter table public.sku_items
drop column if exists note;

alter table public.sku_items
alter column sku drop not null;

alter table public.sku_items
drop constraint if exists sku_items_sku_key;

create table if not exists public.purchase_records (
  id text primary key,
  manufacturer_name text,
  sku text not null,
  product_name text,
  shop_name text,
  buyer_name text,
  purchase_quantity numeric not null default 0,
  purchase_price numeric not null default 0,
  total_amount numeric not null default 0,
  purchase_date date,
  estimated_arrival_date date,
  status public.purchase_status not null default 'in_transit',
  total_cbm numeric not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.container_rows (
  id text primary key,
  row_number integer,
  sku text,
  product_name text,
  english_name text,
  manufacturer_name text,
  purchase_quantity numeric,
  raw jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.container_rows
add column if not exists product_name text;

alter table public.container_rows
add column if not exists english_name text;

alter table public.container_rows
add column if not exists manufacturer_name text;

create table if not exists public.sales_suggestions (
  id text primary key,
  sku text,
  product_name text,
  shop_name text,
  manufacturer_name text,
  buyer_name text,
  monthly_sales numeric default 0,
  stock_months numeric default 2,
  target_quantity numeric default 0,
  in_transit_quantity numeric default 0,
  suggested_quantity numeric default 0,
  units_per_carton numeric,
  estimated_cartons numeric,
  estimated_cbm numeric,
  messages text[] default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id text primary key,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text not null,
  actor_role public.app_role not null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  summary text not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, role)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'display_name', new.email, ''), 'viewer')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.current_role()
returns public.app_role
language sql
security definer
stable
as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_editor()
returns boolean
language sql
security definer
stable
as $$
  select public.current_role() in ('admin', 'buyer')
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
as $$
  select public.current_role() = 'admin'
$$;

alter table public.profiles enable row level security;
alter table public.sku_items enable row level security;
alter table public.purchase_records enable row level security;
alter table public.container_rows enable row level security;
alter table public.sales_suggestions enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "profiles select own or admin" on public.profiles;
create policy "profiles select own or admin" on public.profiles
for select to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles admin update" on public.profiles;
create policy "profiles admin update" on public.profiles
for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "shared select sku" on public.sku_items;
create policy "shared select sku" on public.sku_items for select to authenticated using (true);
drop policy if exists "editor insert sku" on public.sku_items;
create policy "editor insert sku" on public.sku_items for insert to authenticated with check (public.is_editor());
drop policy if exists "editor update sku" on public.sku_items;
create policy "editor update sku" on public.sku_items for update to authenticated using (public.is_editor()) with check (public.is_editor());
drop policy if exists "admin delete sku" on public.sku_items;
create policy "admin delete sku" on public.sku_items for delete to authenticated using (public.is_admin());

drop policy if exists "shared select purchase" on public.purchase_records;
create policy "shared select purchase" on public.purchase_records for select to authenticated using (true);
drop policy if exists "editor insert purchase" on public.purchase_records;
create policy "editor insert purchase" on public.purchase_records for insert to authenticated with check (public.is_editor());
drop policy if exists "editor update purchase" on public.purchase_records;
create policy "editor update purchase" on public.purchase_records for update to authenticated using (public.is_editor()) with check (public.is_editor());
drop policy if exists "admin delete purchase" on public.purchase_records;
create policy "admin delete purchase" on public.purchase_records for delete to authenticated using (public.is_admin());

drop policy if exists "shared select container" on public.container_rows;
create policy "shared select container" on public.container_rows for select to authenticated using (true);
drop policy if exists "editor insert container" on public.container_rows;
create policy "editor insert container" on public.container_rows for insert to authenticated with check (public.is_editor());
drop policy if exists "editor update container" on public.container_rows;
create policy "editor update container" on public.container_rows for update to authenticated using (public.is_editor()) with check (public.is_editor());
drop policy if exists "editor delete container" on public.container_rows;
create policy "editor delete container" on public.container_rows for delete to authenticated using (public.is_editor());

drop policy if exists "shared select suggestions" on public.sales_suggestions;
create policy "shared select suggestions" on public.sales_suggestions for select to authenticated using (true);
drop policy if exists "editor insert suggestions" on public.sales_suggestions;
create policy "editor insert suggestions" on public.sales_suggestions for insert to authenticated with check (public.is_editor());
drop policy if exists "editor delete suggestions" on public.sales_suggestions;
create policy "editor delete suggestions" on public.sales_suggestions for delete to authenticated using (public.is_editor());

drop policy if exists "shared select audit" on public.audit_logs;
create policy "shared select audit" on public.audit_logs for select to authenticated using (true);
drop policy if exists "editor insert audit" on public.audit_logs;
create policy "editor insert audit" on public.audit_logs for insert to authenticated with check (public.is_editor());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sku_items'
  ) then
    alter publication supabase_realtime add table public.sku_items;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'purchase_records'
  ) then
    alter publication supabase_realtime add table public.purchase_records;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'container_rows'
  ) then
    alter publication supabase_realtime add table public.container_rows;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'audit_logs'
  ) then
    alter publication supabase_realtime add table public.audit_logs;
  end if;
end $$;
