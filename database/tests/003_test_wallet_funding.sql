-- TEST PROJECT ONLY — do not apply to a production database.
-- Creates a controlled, auditable test-wallet credit. It records a complete
-- double-entry transaction; never update users_v2.wallet_balance directly.

begin;

create or replace function public.credit_test_wallet_v3(
  p_telegram_id text,
  p_amount numeric,
  p_idempotency_key uuid,
  p_actor_telegram_id text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id uuid;
  v_balance_after numeric(18,6);
begin
  if p_telegram_id is null or length(trim(p_telegram_id)) = 0 then
    raise exception 'TEST_CREDIT_USER_REQUIRED';
  end if;
  if p_actor_telegram_id is null or length(trim(p_actor_telegram_id)) = 0 then
    raise exception 'TEST_CREDIT_ACTOR_REQUIRED';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 25 then
    raise exception 'TEST_CREDIT_AMOUNT_INVALID';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 8 or left(trim(p_reason), 5) <> 'TEST:' then
    raise exception 'TEST_CREDIT_REASON_REQUIRED';
  end if;

  select id into v_transaction_id
  from public.financial_transactions_v3
  where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('transactionId', v_transaction_id, 'idempotent', true);
  end if;

  perform 1
  from public.users_v2
  where telegram_id = p_telegram_id
  for update;
  if not found then
    raise exception 'TEST_CREDIT_USER_NOT_FOUND';
  end if;

  insert into public.financial_transactions_v3(
    idempotency_key, transaction_type, external_reference, initiated_by, metadata
  ) values (
    p_idempotency_key,
    'TOPUP_CONFIRMED',
    'TEST-CREDIT:' || p_telegram_id,
    p_actor_telegram_id,
    jsonb_build_object(
      'environment', 'test',
      'purpose', 'test_wallet_credit',
      'reason', trim(p_reason)
    )
  ) returning id into v_transaction_id;

  update public.users_v2
  set wallet_balance = wallet_balance + round(p_amount, 6),
      updated_at = now()
  where telegram_id = p_telegram_id
  returning wallet_balance into v_balance_after;

  insert into public.financial_entries_v3(
    transaction_id, account_code, user_telegram_id, direction, amount,
    reference_type, reference_id
  ) values
    (v_transaction_id, 'CUSTODY_ASSET', null, 'DEBIT', round(p_amount, 6),
      'test_wallet_credit', v_transaction_id),
    (v_transaction_id, 'USER_WALLET', p_telegram_id, 'CREDIT', round(p_amount, 6),
      'test_wallet_credit', v_transaction_id);

  insert into public.wallet_ledger_v2(
    telegram_id, amount, balance_after, entry_type, reference_type, reference_id, created_by
  ) values (
    p_telegram_id, round(p_amount, 6), v_balance_after, 'TOPUP',
    'test_wallet_credit_v3', v_transaction_id::text, p_actor_telegram_id
  );

  insert into public.admin_audit_log_v3(
    actor_telegram_id, action, target_type, target_id, reason, metadata
  ) values (
    p_actor_telegram_id, 'TEST_WALLET_CREDIT', 'user', p_telegram_id, trim(p_reason),
    jsonb_build_object('transactionId', v_transaction_id, 'amount', round(p_amount, 6))
  );

  return jsonb_build_object(
    'transactionId', v_transaction_id,
    'balanceAfter', v_balance_after,
    'idempotent', false
  );
end;
$$;

revoke all on function public.credit_test_wallet_v3(text,numeric,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.credit_test_wallet_v3(text,numeric,uuid,text,text)
  to service_role;

commit;
