alter table public.purchase_records
add column if not exists manual_total_carton_count numeric;

alter table public.purchase_records
add column if not exists manual_purchase_total_quantity numeric;

alter table public.purchase_records
add column if not exists manual_total_amount numeric;

alter table public.purchase_records
add column if not exists manual_total_cbm numeric;

alter table public.purchase_records
add column if not exists manual_is_mixed boolean;
