-- User-approved buyer UID bindings, including the corrected Sun Jie UID.
-- Run in the EXISTING Supabase project's SQL Editor as its trusted administrator.
-- Only independent logistics membership is changed. No purchase assignment,
-- token, profiles role, order link, stock, or warehouse data is changed.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create temporary table approved_alibaba_buyers (
  user_id uuid primary key,
  buyer_name text unique not null,
  account_code text not null check (account_code in ('A','B'))
) on commit drop;

insert into approved_alibaba_buyers values
  ('79ca5914-1d53-47f9-8f93-09fa8999d948','彭志红','B'),
  ('9401d015-9de4-4e4e-89a4-257c1e8d7028','孙杰','A'),
  ('dc0a3563-ca3c-423e-85de-63c90a60b15f','章瀚成','A'),
  ('401b6471-2dd2-4286-a214-4a92d69db48c','李靖阳','A'),
  ('551990ad-5e8c-45ee-b800-22ca655f2d69','伍菊开','A'),
  ('2e2587c4-d558-4ea9-a541-5f93ad168e70','梁潘','A'),
  ('b44d2bc8-f306-4970-b8c2-5445cc0988ed','黄柏钧','A');

do $$
declare
  v_problem text;
begin
  if to_regclass('public.alibaba_logistics_users') is null
    or to_regclass('public.alibaba_buyer_accounts') is null then
    raise exception 'Run the reviewed logistics foundation migration first';
  end if;

  -- Serialize this short membership change against other grants.
  lock table public.alibaba_logistics_users in share row exclusive mode;

  select string_agg(a.buyer_name, ', ') into v_problem
  from pg_temp.approved_alibaba_buyers a
  where not exists (select 1 from auth.users u where u.id = a.user_id and u.deleted_at is null);
  if v_problem is not null then
    raise exception 'UID not found or deleted in this Supabase project: %', v_problem;
  end if;

  select string_agg(a.buyer_name, ', ') into v_problem
  from pg_temp.approved_alibaba_buyers a
  where not exists (select 1 from public.alibaba_buyer_accounts b
    where b.buyer_name = a.buyer_name and b.account_code = a.account_code);
  if v_problem is not null then
    raise exception 'Buyer/account mapping does not match the reviewed foundation: %', v_problem;
  end if;

  select string_agg(a.buyer_name, ', ') into v_problem
  from pg_temp.approved_alibaba_buyers a
  join public.alibaba_logistics_users u on u.user_id = a.user_id
  where not u.enabled or u.logistics_role not in ('owner','admin','buyer')
    or (u.buyer_name is not null and
      (u.buyer_name is distinct from a.buyer_name or u.account_code is distinct from a.account_code))
    or (u.buyer_name is null and u.logistics_role not in ('owner','admin'));
  if v_problem is not null then
    raise exception 'Existing membership conflicts; nothing was changed: %', v_problem;
  end if;

  select string_agg(a.buyer_name, ', ') into v_problem
  from pg_temp.approved_alibaba_buyers a
  join public.alibaba_logistics_users u on u.buyer_name = a.buyer_name and u.user_id <> a.user_id;
  if v_problem is not null then
    raise exception 'Buyer name is already bound to another UID; review first: %', v_problem;
  end if;

  insert into public.alibaba_logistics_users(user_id,logistics_role,buyer_name,account_code,enabled)
  select user_id,'buyer',buyer_name,account_code,true from pg_temp.approved_alibaba_buyers
  on conflict(user_id) do nothing;

  -- Preserve existing owner/admin roles and enabled flags. Only add their
  -- approved buyer identity if they have no buyer binding yet.
  update public.alibaba_logistics_users u
  set buyer_name = a.buyer_name, account_code = a.account_code
  from pg_temp.approved_alibaba_buyers a
  where u.user_id = a.user_id and u.buyer_name is null
    and u.logistics_role in ('owner','admin') and u.enabled;

  if (select count(*) from public.alibaba_logistics_users u
    join pg_temp.approved_alibaba_buyers a on u.user_id = a.user_id
      and u.buyer_name = a.buyer_name and u.account_code = a.account_code
    where u.enabled and u.logistics_role in ('owner','admin','buyer')) <> 7 then
    raise exception 'Binding verification failed; transaction rolled back';
  end if;
end
$$;

select u.buyer_name as "姓名", u.user_id as "User UID",
  case u.account_code when 'A' then '辉尚666' when 'B' then 'tb58287621' end as "1688账号",
  u.logistics_role, u.enabled
from public.alibaba_logistics_users u
join pg_temp.approved_alibaba_buyers a on a.user_id = u.user_id
order by u.account_code,u.buyer_name;

commit;
