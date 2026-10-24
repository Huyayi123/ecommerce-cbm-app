-- Administrator UID explicitly supplied by the user.
-- Run ONLY AFTER the reviewed logistics foundation migration has succeeded.
-- This grants logistics administration; it does not change public.profiles.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
declare
  v_admin_id constant uuid := 'd32f1446-c579-44ec-8a07-d6d888688bc0';
begin
  if to_regclass('public.alibaba_logistics_users') is null then
    raise exception 'Run and verify the reviewed logistics foundation migration first';
  end if;
  if not exists (select 1 from auth.users where id = v_admin_id and deleted_at is null) then
    raise exception 'The approved administrator UID is not an active auth user in this project';
  end if;

  insert into public.alibaba_logistics_users(user_id,logistics_role,buyer_name,account_code,enabled)
  values (v_admin_id,'admin',null,null,true)
  on conflict (user_id) do nothing;

  -- Never silently change or reactivate an existing conflicting grant.
  if not exists (
    select 1 from public.alibaba_logistics_users
    where user_id = v_admin_id and logistics_role in ('owner','admin') and enabled
  ) then
    raise exception 'Existing logistics membership conflicts; review before changing it';
  end if;
end
$$;

commit;

select user_id, logistics_role, enabled
from public.alibaba_logistics_users
where user_id = 'd32f1446-c579-44ec-8a07-d6d888688bc0'::uuid;
