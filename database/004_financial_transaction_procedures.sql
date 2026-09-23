-- Lucky Number V2 — transaction procedures for migration 003.
-- Run only after 003 in an isolated test database. Every caller must use a
-- fresh UUID idempotency key for every business action.

begin;

create or replace function public.fund_affiliate_advance_reserve_v3(
  p_amount numeric,
  p_idempotency_key uuid,
  p_actor_telegram_id text,
  p_external_reference text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id uuid;
begin
  if p_amount <= 0 then raise exception 'AMOUNT_INVALID'; end if;

  select id into v_transaction_id
  from public.financial_transactions_v3
  where idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object('transactionId', v_transaction_id, 'idempotent', true);
  end if;

  insert into public.financial_transactions_v3(
    idempotency_key, transaction_type, external_reference, initiated_by, metadata
  ) values (
    p_idempotency_key, 'OPENING_BALANCE', p_external_reference, p_actor_telegram_id,
    jsonb_build_object('purpose', 'affiliate_advance_reserve')
  ) returning id into v_transaction_id;

  insert into public.financial_entries_v3(
    transaction_id, account_code, direction, amount, reference_type
  ) values
    (v_transaction_id, 'CUSTODY_ASSET', 'DEBIT', round(p_amount, 2), 'affiliate_advance_reserve'),
    (v_transaction_id, 'AFFILIATE_ADVANCE_RESERVE', 'CREDIT', round(p_amount, 2), 'affiliate_advance_reserve');

  insert into public.admin_audit_log_v3(actor_telegram_id, action, target_type, target_id, reason)
  values (p_actor_telegram_id, 'FUND_AFFILIATE_ADVANCE_RESERVE', 'financial_transaction', v_transaction_id::text, 'verified custody funding');

  return jsonb_build_object('transactionId', v_transaction_id, 'idempotent', false);
end;
$$;

create or replace function public.purchase_monthly_ticket_v3(
  p_telegram_id text,
  p_ticket_number text,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period public.monthly_sales_periods_v3%rowtype;
  v_round public.monthly_draw_rounds_v3%rowtype;
  v_user_balance numeric(18,2);
  v_balance_after numeric(18,2);
  v_referrer_id text;
  v_ticket_id uuid;
  v_transaction_id uuid;
  v_standard_amount numeric(18,2);
  v_jackpot_amount numeric(18,2);
  v_operating_amount numeric(18,2);
  v_affiliate_available numeric(18,2) := 0;
  v_affiliate_pending numeric(18,2) := 0;
begin
  if p_telegram_id !~ '^\d{5,20}$' then raise exception 'TELEGRAM_ID_INVALID'; end if;
  if p_ticket_number !~ '^\d{5}$' then raise exception 'TICKET_NUMBER_INVALID'; end if;

  select t.id
  into v_ticket_id
  from public.financial_transactions_v3 ft
  join public.draw_tickets_v3 t on t.purchase_transaction_id = ft.id
  where ft.idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object('ticketId', v_ticket_id, 'idempotent', true);
  end if;

  select p.*
  into v_period
  from public.monthly_sales_periods_v3 p
  join public.monthly_draw_rounds_v3 r on r.id = p.draw_round_id
  where p.status = 'OPEN'
    and r.status = 'OPEN'
    and now() >= p.opens_at
    and now() < p.closes_at
  order by p.calendar_month desc
  limit 1
  for update of p, r;

  if not found then raise exception 'SALES_CLOSED'; end if;

  select * into v_round
  from public.monthly_draw_rounds_v3
  where id = v_period.draw_round_id
  for update;

  select wallet_balance, referrer_id
  into v_user_balance, v_referrer_id
  from public.users_v2
  where telegram_id = p_telegram_id
  for update;

  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_user_balance < v_round.ticket_price then raise exception 'INSUFFICIENT_BALANCE'; end if;

  if v_referrer_id is not null then
    select telegram_id into v_referrer_id
    from public.users_v2
    where telegram_id = v_referrer_id
      and telegram_id <> p_telegram_id;

    if found then
      v_affiliate_available := round(v_round.ticket_price * 0.02, 2);
      v_affiliate_pending := round(v_round.ticket_price * 0.03, 2);
    else
      v_referrer_id := null;
    end if;
  end if;

  v_standard_amount := round(v_round.ticket_price * 0.72, 2);
  v_jackpot_amount := round(v_round.ticket_price * 0.08, 2);
  v_operating_amount := v_round.ticket_price - v_standard_amount - v_jackpot_amount
    - v_affiliate_available - v_affiliate_pending;

  if v_standard_amount + v_jackpot_amount + v_operating_amount
    + v_affiliate_available + v_affiliate_pending <> v_round.ticket_price then
    raise exception 'ALLOCATION_NOT_BALANCED';
  end if;

  insert into public.financial_transactions_v3(
    idempotency_key, transaction_type, initiated_by, metadata
  ) values (
    p_idempotency_key, 'TICKET_PURCHASE', p_telegram_id,
    jsonb_build_object('roundId', v_round.id, 'salesPeriodId', v_period.id)
  ) returning id into v_transaction_id;

  update public.users_v2
  set wallet_balance = wallet_balance - v_round.ticket_price,
      updated_at = now()
  where telegram_id = p_telegram_id
  returning wallet_balance into v_balance_after;

  insert into public.draw_tickets_v3(
    draw_round_id, sales_period_id, owner_telegram_id, ticket_number, price_paid, purchase_transaction_id
  ) values (
    v_round.id, v_period.id, p_telegram_id, p_ticket_number, v_round.ticket_price, v_transaction_id
  ) returning id into v_ticket_id;

  insert into public.ticket_financial_allocations_v3(
    ticket_id, standard_prize_amount, jackpot_amount, operating_amount,
    affiliate_available_amount, affiliate_pending_amount
  ) values (
    v_ticket_id, v_standard_amount, v_jackpot_amount, v_operating_amount,
    v_affiliate_available, v_affiliate_pending
  );

  insert into public.financial_entries_v3(
    transaction_id, account_code, user_telegram_id, draw_round_id,
    direction, amount, reference_type, reference_id
  ) values
    (v_transaction_id, 'USER_WALLET', p_telegram_id, v_round.id, 'DEBIT', v_round.ticket_price, 'ticket', v_ticket_id),
    (v_transaction_id, 'STANDARD_PRIZE_POOL', null, v_round.id, 'CREDIT', v_standard_amount, 'ticket', v_ticket_id),
    (v_transaction_id, 'JACKPOT_RESERVE', null, v_round.id, 'CREDIT', v_jackpot_amount, 'ticket', v_ticket_id),
    (v_transaction_id, 'OPERATING_REVENUE', null, v_round.id, 'CREDIT', v_operating_amount, 'ticket', v_ticket_id);

  if v_referrer_id is not null then
    insert into public.financial_entries_v3(
      transaction_id, account_code, user_telegram_id, draw_round_id,
      direction, amount, reference_type, reference_id
    ) values (
      v_transaction_id, 'AFFILIATE_PENDING', v_referrer_id, v_round.id,
      'CREDIT', v_affiliate_available + v_affiliate_pending, 'ticket', v_ticket_id
    );

    insert into public.affiliate_rewards_v3(
      ticket_id, referrer_telegram_id, available_amount, pending_amount
    ) values (
      v_ticket_id, v_referrer_id, v_affiliate_available, v_affiliate_pending
    );
  end if;

  insert into public.wallet_ledger_v2(
    telegram_id, amount, balance_after, entry_type, reference_type, reference_id, created_by
  ) values (
    p_telegram_id, -v_round.ticket_price, v_balance_after, 'TICKET_PURCHASE', 'draw_ticket_v3',
    v_ticket_id::text, p_telegram_id
  );

  insert into public.admin_audit_log_v3(actor_telegram_id, action, target_type, target_id, reason, metadata)
  values (
    p_telegram_id, 'PURCHASE_TICKET', 'draw_ticket', v_ticket_id::text, 'customer purchase',
    jsonb_build_object('transactionId', v_transaction_id, 'roundId', v_round.id)
  );

  return jsonb_build_object(
    'ticketId', v_ticket_id,
    'transactionId', v_transaction_id,
    'roundId', v_round.id,
    'balance', v_balance_after,
    'idempotent', false
  );
exception
  when unique_violation then raise exception 'TICKET_ALREADY_SOLD';
end;
$$;

create or replace function public.release_affiliate_available_v3(
  p_reward_id uuid,
  p_idempotency_key uuid,
  p_actor_telegram_id text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reward public.affiliate_rewards_v3%rowtype;
  v_ticket public.draw_tickets_v3%rowtype;
  v_transaction_id uuid;
  v_balance_after numeric(18,2);
  v_reserve_balance numeric(18,2);
  v_open_exposure numeric(18,2);
begin
  if coalesce(length(trim(p_reason)), 0) < 8 then raise exception 'APPROVAL_REASON_REQUIRED'; end if;

  select id into v_transaction_id
  from public.financial_transactions_v3
  where idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('transactionId', v_transaction_id, 'idempotent', true); end if;

  select * into v_reward
  from public.affiliate_rewards_v3
  where id = p_reward_id
  for update;
  if not found then raise exception 'AFFILIATE_REWARD_NOT_FOUND'; end if;
  if v_reward.available_status <> 'PENDING' then raise exception 'AFFILIATE_AVAILABLE_NOT_PENDING'; end if;

  select * into v_ticket from public.draw_tickets_v3 where id = v_reward.ticket_id for update;
  if v_ticket.state not in ('ACTIVE', 'LOCKED') then raise exception 'TICKET_NOT_ELIGIBLE'; end if;

  select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)
  into v_reserve_balance
  from public.financial_entries_v3
  where account_code = 'AFFILIATE_ADVANCE_RESERVE';

  select coalesce(sum(ar.available_amount), 0)
  into v_open_exposure
  from public.affiliate_rewards_v3 ar
  join public.draw_tickets_v3 t on t.id = ar.ticket_id
  where ar.available_status = 'AVAILABLE'
    and t.state in ('ACTIVE', 'LOCKED');

  if v_reserve_balance < v_open_exposure + v_reward.available_amount then
    raise exception 'AFFILIATE_ADVANCE_RESERVE_INSUFFICIENT';
  end if;

  insert into public.financial_transactions_v3(
    idempotency_key, transaction_type, initiated_by, metadata
  ) values (
    p_idempotency_key, 'AFFILIATE_AVAILABLE', p_actor_telegram_id,
    jsonb_build_object('rewardId', p_reward_id, 'reason', p_reason)
  ) returning id into v_transaction_id;

  update public.users_v2
  set wallet_balance = wallet_balance + v_reward.available_amount,
      updated_at = now()
  where telegram_id = v_reward.referrer_telegram_id
  returning wallet_balance into v_balance_after;

  insert into public.financial_entries_v3(
    transaction_id, account_code, user_telegram_id, draw_round_id,
    direction, amount, reference_type, reference_id
  ) values
    (v_transaction_id, 'AFFILIATE_PENDING', v_reward.referrer_telegram_id, v_ticket.draw_round_id,
      'DEBIT', v_reward.available_amount, 'affiliate_reward', v_reward.id),
    (v_transaction_id, 'USER_WALLET', v_reward.referrer_telegram_id, v_ticket.draw_round_id,
      'CREDIT', v_reward.available_amount, 'affiliate_reward', v_reward.id);

  update public.affiliate_rewards_v3
  set available_status = 'AVAILABLE',
      available_transaction_id = v_transaction_id,
      available_at = now()
  where id = p_reward_id;

  insert into public.wallet_ledger_v2(
    telegram_id, amount, balance_after, entry_type, reference_type, reference_id, created_by
  ) values (
    v_reward.referrer_telegram_id, v_reward.available_amount, v_balance_after,
    'REFERRAL_COMMISSION', 'affiliate_reward_v3', v_reward.id::text, p_actor_telegram_id
  );

  insert into public.admin_audit_log_v3(actor_telegram_id, action, target_type, target_id, reason)
  values (p_actor_telegram_id, 'RELEASE_AFFILIATE_AVAILABLE', 'affiliate_reward', p_reward_id::text, p_reason);

  return jsonb_build_object('transactionId', v_transaction_id, 'idempotent', false);
end;
$$;

create or replace function public.settle_affiliate_pending_v3(
  p_reward_id uuid,
  p_idempotency_key uuid,
  p_actor_telegram_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reward public.affiliate_rewards_v3%rowtype;
  v_ticket public.draw_tickets_v3%rowtype;
  v_round public.monthly_draw_rounds_v3%rowtype;
  v_transaction_id uuid;
  v_balance_after numeric(18,2);
begin
  select id into v_transaction_id
  from public.financial_transactions_v3 where idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('transactionId', v_transaction_id, 'idempotent', true); end if;

  select * into v_reward from public.affiliate_rewards_v3 where id = p_reward_id for update;
  if not found then raise exception 'AFFILIATE_REWARD_NOT_FOUND'; end if;
  if v_reward.pending_status <> 'PENDING' then raise exception 'AFFILIATE_PENDING_NOT_PENDING'; end if;

  select * into v_ticket from public.draw_tickets_v3 where id = v_reward.ticket_id for update;
  select * into v_round from public.monthly_draw_rounds_v3 where id = v_ticket.draw_round_id for update;
  if v_round.status <> 'SETTLED' then raise exception 'ROUND_NOT_SETTLED'; end if;

  insert into public.financial_transactions_v3(
    idempotency_key, transaction_type, initiated_by, metadata
  ) values (
    p_idempotency_key, 'AFFILIATE_SETTLED', p_actor_telegram_id,
    jsonb_build_object('rewardId', p_reward_id, 'roundId', v_round.id)
  ) returning id into v_transaction_id;

  update public.users_v2
  set wallet_balance = wallet_balance + v_reward.pending_amount,
      updated_at = now()
  where telegram_id = v_reward.referrer_telegram_id
  returning wallet_balance into v_balance_after;

  insert into public.financial_entries_v3(
    transaction_id, account_code, user_telegram_id, draw_round_id,
    direction, amount, reference_type, reference_id
  ) values
    (v_transaction_id, 'AFFILIATE_PENDING', v_reward.referrer_telegram_id, v_round.id,
      'DEBIT', v_reward.pending_amount, 'affiliate_reward', v_reward.id),
    (v_transaction_id, 'USER_WALLET', v_reward.referrer_telegram_id, v_round.id,
      'CREDIT', v_reward.pending_amount, 'affiliate_reward', v_reward.id);

  update public.affiliate_rewards_v3
  set pending_status = 'AVAILABLE',
      pending_transaction_id = v_transaction_id,
      settled_at = now()
  where id = p_reward_id;

  insert into public.wallet_ledger_v2(
    telegram_id, amount, balance_after, entry_type, reference_type, reference_id, created_by
  ) values (
    v_reward.referrer_telegram_id, v_reward.pending_amount, v_balance_after,
    'REFERRAL_COMMISSION', 'affiliate_reward_v3', v_reward.id::text, p_actor_telegram_id
  );

  insert into public.admin_audit_log_v3(actor_telegram_id, action, target_type, target_id, reason)
  values (p_actor_telegram_id, 'SETTLE_AFFILIATE_PENDING', 'affiliate_reward', p_reward_id::text, 'round settled');

  return jsonb_build_object('transactionId', v_transaction_id, 'idempotent', false);
end;
$$;

create or replace function public.complete_rollover_refund_v3(
  p_ticket_id uuid,
  p_idempotency_key uuid,
  p_actor_telegram_id text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.draw_tickets_v3%rowtype;
  v_round public.monthly_draw_rounds_v3%rowtype;
  v_allocation public.ticket_financial_allocations_v3%rowtype;
  v_reward public.affiliate_rewards_v3%rowtype;
  v_transaction_id uuid;
  v_balance_after numeric(18,2);
  v_affiliate_pending_reversal numeric(18,2) := 0;
  v_affiliate_reserve_reversal numeric(18,2) := 0;
  v_has_reward boolean := false;
begin
  if coalesce(length(trim(p_reason)), 0) < 8 then raise exception 'REFUND_REASON_REQUIRED'; end if;

  select id into v_transaction_id
  from public.financial_transactions_v3 where idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('transactionId', v_transaction_id, 'idempotent', true); end if;

  select * into v_ticket from public.draw_tickets_v3 where id = p_ticket_id for update;
  if not found then raise exception 'TICKET_NOT_FOUND'; end if;
  if v_ticket.state <> 'ACTIVE' then raise exception 'TICKET_NOT_REFUNDABLE'; end if;

  select * into v_round from public.monthly_draw_rounds_v3 where id = v_ticket.draw_round_id for update;
  if not (v_round.status = 'ROLLED_OVER' and v_round.rollover_count >= 3) then
    raise exception 'ROLLOVER_REFUND_NOT_ELIGIBLE';
  end if;

  select * into v_allocation from public.ticket_financial_allocations_v3 where ticket_id = p_ticket_id;
  if not found then raise exception 'TICKET_ALLOCATION_NOT_FOUND'; end if;

  select * into v_reward from public.affiliate_rewards_v3 where ticket_id = p_ticket_id for update;
  if found then
    v_has_reward := true;
    if v_reward.available_status = 'AVAILABLE' then
      v_affiliate_reserve_reversal := v_reward.available_amount;
    else
      v_affiliate_pending_reversal := v_affiliate_pending_reversal + v_reward.available_amount;
    end if;

    if v_reward.pending_status = 'PENDING' then
      v_affiliate_pending_reversal := v_affiliate_pending_reversal + v_reward.pending_amount;
    end if;
  end if;

  if v_allocation.standard_prize_amount + v_allocation.jackpot_amount
    + v_allocation.operating_amount + v_affiliate_pending_reversal
    + v_affiliate_reserve_reversal <> v_ticket.price_paid then
    raise exception 'REFUND_ALLOCATION_NOT_BALANCED';
  end if;

  insert into public.financial_transactions_v3(
    idempotency_key, transaction_type, initiated_by, metadata
  ) values (
    p_idempotency_key, 'REFUND', p_actor_telegram_id,
    jsonb_build_object('ticketId', p_ticket_id, 'reason', p_reason)
  ) returning id into v_transaction_id;

  update public.users_v2
  set wallet_balance = wallet_balance + v_ticket.price_paid,
      updated_at = now()
  where telegram_id = v_ticket.owner_telegram_id
  returning wallet_balance into v_balance_after;

  insert into public.financial_entries_v3(
    transaction_id, account_code, user_telegram_id, draw_round_id,
    direction, amount, reference_type, reference_id
  ) values
    (v_transaction_id, 'STANDARD_PRIZE_POOL', null, v_round.id, 'DEBIT',
      v_allocation.standard_prize_amount, 'ticket_refund', p_ticket_id),
    (v_transaction_id, 'JACKPOT_RESERVE', null, v_round.id, 'DEBIT',
      v_allocation.jackpot_amount, 'ticket_refund', p_ticket_id),
    (v_transaction_id, 'OPERATING_REVENUE', null, v_round.id, 'DEBIT',
      v_allocation.operating_amount, 'ticket_refund', p_ticket_id),
    (v_transaction_id, 'USER_WALLET', v_ticket.owner_telegram_id, v_round.id, 'CREDIT',
      v_ticket.price_paid, 'ticket_refund', p_ticket_id);

  if v_affiliate_pending_reversal > 0 then
    insert into public.financial_entries_v3(
      transaction_id, account_code, user_telegram_id, draw_round_id,
      direction, amount, reference_type, reference_id
    ) values (
      v_transaction_id, 'AFFILIATE_PENDING', v_reward.referrer_telegram_id, v_round.id, 'DEBIT',
      v_affiliate_pending_reversal, 'ticket_refund', p_ticket_id
    );
  end if;

  if v_affiliate_reserve_reversal > 0 then
    insert into public.financial_entries_v3(
      transaction_id, account_code, draw_round_id,
      direction, amount, reference_type, reference_id
    ) values (
      v_transaction_id, 'AFFILIATE_ADVANCE_RESERVE', v_round.id, 'DEBIT',
      v_affiliate_reserve_reversal, 'ticket_refund', p_ticket_id
    );
  end if;

  update public.draw_tickets_v3 set state = 'REFUNDED' where id = p_ticket_id;

  if v_has_reward then
    update public.affiliate_rewards_v3
    set available_status = case when available_status = 'PENDING' then 'CANCELLED' else available_status end,
        pending_status = case when pending_status = 'PENDING' then 'CANCELLED' else pending_status end
    where id = v_reward.id;
  end if;

  insert into public.refund_requests_v3(
    ticket_id, requested_by, status, reason_code, refund_transaction_id, resolved_at, resolved_by
  ) values (
    p_ticket_id, v_ticket.owner_telegram_id, 'COMPLETED', 'THREE_MONTH_ROLLOVER',
    v_transaction_id, now(), p_actor_telegram_id
  ) on conflict (ticket_id) do update
    set status = 'COMPLETED',
        refund_transaction_id = excluded.refund_transaction_id,
        resolved_at = excluded.resolved_at,
        resolved_by = excluded.resolved_by;

  insert into public.wallet_ledger_v2(
    telegram_id, amount, balance_after, entry_type, reference_type, reference_id, created_by
  ) values (
    v_ticket.owner_telegram_id, v_ticket.price_paid, v_balance_after,
    'ADJUSTMENT', 'ticket_refund_v3', p_ticket_id::text, p_actor_telegram_id
  );

  insert into public.admin_audit_log_v3(actor_telegram_id, action, target_type, target_id, reason)
  values (p_actor_telegram_id, 'COMPLETE_ROLLOVER_REFUND', 'draw_ticket', p_ticket_id::text, p_reason);

  return jsonb_build_object('transactionId', v_transaction_id, 'idempotent', false);
end;
$$;

revoke all on function public.fund_affiliate_advance_reserve_v3(numeric,uuid,text,text) from public, anon, authenticated;
revoke all on function public.purchase_monthly_ticket_v3(text,text,uuid) from public, anon, authenticated;
revoke all on function public.release_affiliate_available_v3(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.settle_affiliate_pending_v3(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.complete_rollover_refund_v3(uuid,uuid,text,text) from public, anon, authenticated;

grant execute on function public.fund_affiliate_advance_reserve_v3(numeric,uuid,text,text) to service_role;
grant execute on function public.purchase_monthly_ticket_v3(text,text,uuid) to service_role;
grant execute on function public.release_affiliate_available_v3(uuid,uuid,text,text) to service_role;
grant execute on function public.settle_affiliate_pending_v3(uuid,uuid,text) to service_role;
grant execute on function public.complete_rollover_refund_v3(uuid,uuid,text,text) to service_role;

commit;
