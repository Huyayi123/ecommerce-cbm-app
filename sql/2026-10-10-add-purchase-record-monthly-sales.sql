alter table public.purchase_records
add column if not exists monthly_sales numeric;
