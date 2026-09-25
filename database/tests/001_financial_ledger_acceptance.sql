-- Lucky Number V2 — isolated database acceptance tests.
-- Preconditions:
--   1. Run migrations 001, 003, and 004 in a NON-PRODUCTION Supabase project.
--   2. Execute this full file in one SQL Editor session.
-- Expected result: no ERROR. The final ROLLBACK leaves no test data behind.

begin;

-- Test identities are deliberately isolated from real Telegram users.
insert into public.users_v2(telegram_id, wallet_balance, referrer_id, first_name)
values
  ('9000000011', 5.00, '9000000010', 'Ledger Buyer 1'),
  ('9000000012', 5.00, '9000000010', 'Ledger Buyer 2'),
  ('9000000013', 0.00, null, 'Ledger Insufficient'),
  ('9000000010', 0.00, null, 'Ledger Referrer')
on conflict (telegram_id) do update
  set wallet_balance = excluded.wallet_balance,
      referrer_id = excluded.referrer_id,
      first_name = excluded.first_name,
      updated_at = now();

insert into public.monthly_draw_rounds_v3(
  id, round_code, status, opened_at, created_by
) values (
  '00000000-0000-4000-8000-000000000101',
  'DR-2099-01-001',
  'OPEN',
  now() - interval '1 hour',
  'test-suite'
);

insert into public.monthly_sales_periods_v3(
  id, draw_round_id, calendar_month, opens_at, closes_at, status
) values (
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000101',
  date_trunc('month', now())::date,
  now() - interval '1 hour',
  now() + interval '1 hour',
  'OPEN'
);

-- Affiliate Advance Reserve must be funded before any 2% affiliate release.
select public.fund_affiliate_advance_reserve_v3(
  0.10,
  '00000000-0000-4000-8000-000000000201',
  '9000000010',
  'test-reserve-funding'
);

-- 1. Successful purchase: buyer is debited, a ticket and balanced ledger
-- entries are created, and an affiliate reward is pending.
select public.purchase_monthly_ticket_v3(
  '9000000011', '12345', '00000000-0000-4000-8000-000000000301'
);

do $$
declare
  v_ticket_count integer;
  v_balance numeric;
  v_debits numeric;
  v_credits numeric;
begin
  select count(*) into v_ticket_count
  from public.draw_tickets_v3
  where owner_telegram_id = '9000000011' and ticket_number = '12345';
  if v_ticket_count <> 1 then raise exception 'TEST_PURCHASE_TICKET_COUNT_FAILED'; end if;

  select wallet_balance into v_balance from public.users_v2 where telegram_id = '9000000011';
  if v_balance <> 0.00 then raise exception 'TEST_PURCHASE_BALANCE_FAILED'; end if;

  select
    sum(case when fe.direction = 'DEBIT' then fe.amount else 0 end),
    sum(case when fe.direction = 'CREDIT' then fe.amount else 0 end)
  into v_debits, v_credits
  from public.financial_entries_v3 fe
  join public.financial_transactions_v3 ft on ft.id = fe.transaction_id
  where ft.idempotency_key = '00000000-0000-4000-8000-000000000301';

  if v_debits <> 5.00 or v_credits <> 5.00 then
    raise exception 'TEST_PURCHASE_LEDGER_NOT_BALANCED';
  end if;
end;
$$;

-- 2. Retrying the same idempotency key must not create a second ticket/debit.
select public.purchase_monthly_ticket_v3(
  '9000000011', '12345', '00000000-0000-4000-8000-000000000301'
);

do $$
begin
  if (select count(*) from public.draw_tickets_v3 where owner_telegram_id = '9000000011') <> 1 then
    raise exception 'TEST_IDEMPOTENCY_FAILED';
  end if;
end;
$$;

-- 3. The same ticket number with a new key must be rejected.
do $$
begin
  begin
    perform public.purchase_monthly_ticket_v3(
      '9000000012', '12345', '00000000-0000-4000-8000-000000000302'
    );
    raise exception 'TEST_DUPLICATE_TICKET_NOT_REJECTED';
  exception
    when others then
      if position('TICKET_ALREADY_SOLD' in sqlerrm) = 0 then raise; end if;
  end;
end;
$$;

-- 4. Insufficient balance must be rejected without issuing a ticket.
do $$
begin
  begin
    perform public.purchase_monthly_ticket_v3(
      '9000000013', '54321', '00000000-0000-4000-8000-000000000303'
    );
    raise exception 'TEST_INSUFFICIENT_BALANCE_NOT_REJECTED';
  exception
    when others then
      if position('INSUFFICIENT_BALANCE' in sqlerrm) = 0 then raise; end if;
  end;
end;
$$;

-- 5. Release the 2% available affiliate component. The 0.10 reserve is now
-- fully committed to Buyer 1's active ticket.
select public.release_affiliate_available_v3(
  (select ar.id from public.affiliate_rewards_v3 ar
   join public.draw_tickets_v3 t on t.id = ar.ticket_id
   where t.owner_telegram_id = '9000000011'),
  '00000000-0000-4000-8000-000000000401',
  '9000000010',
  'payment settled and fraud checks passed'
);

do $$
begin
  if (select wallet_balance from public.users_v2 where telegram_id = '9000000010') <> 0.10 then
    raise exception 'TEST_AFFILIATE_AVAILABLE_BALANCE_FAILED';
  end if;
end;
$$;

-- 6. A second affiliate release must fail when the funded reserve cannot cover
-- all still-active released 2% exposure.
select public.purchase_monthly_ticket_v3(
  '9000000012', '12346', '00000000-0000-4000-8000-000000000304'
);

do $$
declare v_reward_id uuid;
begin
  select ar.id into v_reward_id
  from public.affiliate_rewards_v3 ar
  join public.draw_tickets_v3 t on t.id = ar.ticket_id
  where t.owner_telegram_id = '9000000012';

  begin
    perform public.release_affiliate_available_v3(
      v_reward_id,
      '00000000-0000-4000-8000-000000000402',
      '9000000010',
      'payment settled and fraud checks passed'
    );
    raise exception 'TEST_RESERVE_EXHAUSTION_NOT_REJECTED';
  exception
    when others then
      if position('AFFILIATE_ADVANCE_RESERVE_INSUFFICIENT' in sqlerrm) = 0 then raise; end if;
  end;
end;
$$;

-- 7. An eligible three-rollover refund returns the entire ticket price to the
-- buyer. The released 2% is absorbed by the operator-funded reserve; it is not
-- deducted from the buyer's refund.
-- The refund procedure intentionally checks the ticket's own observed rollover
-- count, rather than the round-wide count, so tickets bought later cannot
-- refund early.  The close-period procedure increments this field in production;
-- this fixture sets it directly to exercise the refund settlement path.
update public.monthly_draw_rounds_v3
set status = 'ROLLED_OVER', rollover_count = 3
where id = '00000000-0000-4000-8000-000000000101';

update public.draw_tickets_v3
set rollover_count_observed = 3
where owner_telegram_id = '9000000011';

select public.complete_rollover_refund_v3(
  (select id from public.draw_tickets_v3 where owner_telegram_id = '9000000011'),
  '00000000-0000-4000-8000-000000000501',
  '9000000010',
  'three consecutive monthly rollovers'
);

do $$
declare v_buyer_balance numeric;
        v_ticket_state text;
        v_pending_status text;
begin
  select wallet_balance into v_buyer_balance from public.users_v2 where telegram_id = '9000000011';
  select state into v_ticket_state from public.draw_tickets_v3 where owner_telegram_id = '9000000011';
  select pending_status into v_pending_status
  from public.affiliate_rewards_v3 ar
  join public.draw_tickets_v3 t on t.id = ar.ticket_id
  where t.owner_telegram_id = '9000000011';

  if v_buyer_balance <> 5.00 then raise exception 'TEST_REFUND_FULL_VALUE_FAILED'; end if;
  if v_ticket_state <> 'REFUNDED' then raise exception 'TEST_REFUND_TICKET_STATE_FAILED'; end if;
  if v_pending_status <> 'CANCELLED' then raise exception 'TEST_REFUND_PENDING_AFFILIATE_FAILED'; end if;
end;
$$;

-- Force all deferred double-entry constraints to run before rollback.
set constraints all immediate;
rollback;
