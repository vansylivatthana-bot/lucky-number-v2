-- Acceptance test: monthly draw locks 144 tickets from 27 accounts, picks
-- exactly 27 different accounts and pays the exact recorded prize pool.
--
-- Preconditions: run migrations 001, 003, 004 and 005 in an isolated
-- non-production database. This script rolls back everything it creates.

begin;

do $$
declare
  v_round_id uuid;
  v_period_id uuid;
  v_i integer;
  v_user_id text;
  v_secret text := 'draw-test-secret-not-for-production';
  v_commitment text;
  v_winners integer;
  v_distinct_winners integer;
  v_pool numeric(18,6);
  v_paid numeric(18,6);
  v_unbalanced integer;
begin
  for v_i in 1..27 loop
    v_user_id := (900000000 + v_i)::text;
    insert into public.users_v2(telegram_id, wallet_balance, first_name)
    values (v_user_id, 100.000000, 'Draw test ' || v_i)
    on conflict (telegram_id) do update
      set wallet_balance = excluded.wallet_balance,
          referrer_id = null;
  end loop;

  insert into public.monthly_draw_rounds_v3(
    round_code, rules_version, status, ticket_price, opened_at, created_by
  ) values (
    'DR-2099-01-001', '1.0', 'OPEN', 5.000000, now() - interval '2 days', 'acceptance-test'
  ) returning id into v_round_id;

  insert into public.monthly_sales_periods_v3(
    draw_round_id, calendar_month, opens_at, closes_at, status
  ) values (
    v_round_id, date '2099-01-01', now() - interval '2 days', now() + interval '1 day', 'OPEN'
  ) returning id into v_period_id;

  -- 144 unique ticket numbers; accounts 1..9 hold six tickets and the rest
  -- hold five, proving the one-prize-per-account selection rule.
  for v_i in 0..143 loop
    v_user_id := (900000001 + (v_i % 27))::text;
    perform public.purchase_monthly_ticket_v3(
      v_user_id,
      lpad(v_i::text, 5, '0'),
      gen_random_uuid()
    );
  end loop;

  update public.monthly_sales_periods_v3
  set closes_at = now() - interval '1 second'
  where id = v_period_id;
  perform public.close_monthly_sales_period_v3(v_period_id, 'acceptance-test');

  v_commitment := encode(digest(v_secret, 'sha256'), 'hex');
  perform public.lock_monthly_draw_round_v3(v_round_id, v_commitment, 'acceptance-test');
  perform public.execute_verifiable_draw_and_settle_v3(
    v_round_id,
    v_secret,
    'NIST_BEACON_V2',
    'https://beacon.nist.gov/beacon/2.0/pulse/acceptance-test',
    'a8c4f7b2e3d91c6f0a4b8e5d2c7f9a1b3e6d8c0f4a2b5d7e9c1f3a6b8d0e2f4',
    'acceptance-test'
  );

  select count(*), count(distinct owner_telegram_id), sum(amount)
  into v_winners, v_distinct_winners, v_paid
  from public.draw_winners_v3
  where draw_round_id = v_round_id;
  select sum(a.standard_prize_amount)
  into v_pool
  from public.ticket_financial_allocations_v3 a
  join public.draw_tickets_v3 t on t.id = a.ticket_id
  where t.draw_round_id = v_round_id;

  if v_winners <> 27 or v_distinct_winners <> 27 then
    raise exception 'TEST_WINNER_COUNT_OR_UNIQUENESS_FAILED';
  end if;
  if v_paid <> v_pool then raise exception 'TEST_PRIZE_POOL_RECONCILIATION_FAILED'; end if;
  if exists (
    select 1 from public.monthly_draw_rounds_v3
    where id = v_round_id and status <> 'SETTLED'
  ) then raise exception 'TEST_ROUND_NOT_SETTLED'; end if;

  select count(*) into v_unbalanced
  from (
    select transaction_id
    from public.financial_entries_v3
    group by transaction_id
    having sum(case when direction = 'DEBIT' then amount else -amount end) <> 0
  ) b;
  if v_unbalanced <> 0 then raise exception 'TEST_UNBALANCED_LEDGER'; end if;
end;
$$;

set constraints all immediate;
rollback;
