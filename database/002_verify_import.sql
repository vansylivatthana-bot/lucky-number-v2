-- Read-only verification. Every check should return PASS before deploying V2.
select
  'users_imported' as check_name,
  case when (select count(*) from public.users_v2) >= (select count(*) from public.users) then 'PASS' else 'FAIL' end as result,
  (select count(*) from public.users) as legacy_count,
  (select count(*) from public.users_v2) as v2_count;

select
  'balance_total_preserved' as check_name,
  case when
    (select coalesce(sum(wallet_balance),0) from public.users_v2) =
    (select coalesce(sum(wallet_balance),0) from public.users)
  then 'PASS' else 'FAIL' end as result,
  (select coalesce(sum(wallet_balance),0) from public.users) as legacy_total,
  (select coalesce(sum(wallet_balance),0) from public.users_v2) as v2_total;

select
  'tickets_imported' as check_name,
  case when (select count(*) from public.tickets_v2 where legacy_source) <= (select count(*) from public.tickets) then 'PASS' else 'FAIL' end as result,
  (select count(*) from public.tickets) as legacy_count,
  (select count(*) from public.tickets_v2 where legacy_source) as v2_count,
  'A lower V2 count means duplicate ticket numbers existed in the same legacy week and need manual review.' as note;

select telegram_id, wallet_balance, referrer_id
from public.users_v2
order by wallet_balance desc, telegram_id
limit 20;

