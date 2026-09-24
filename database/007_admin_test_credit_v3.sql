-- Admin-only test credit with an immutable, balanced financial transaction.
-- The caller must supply a UUID idempotency key; retrying the same action
-- returns the original result and never credits the wallet a second time.

begin;

create or replace function public.credit_test_wallet_v3(
  p_actor_telegram_id text,
  p_target_telegram_id text,
  p_amount numeric,
  p_idempotency_key uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id uuid;
  v_balance_after numeric(18,6);
  v_amount numeric(18,6);
begin
  if p_actor_telegram_id !~ '^\d{5,20}$' or p_target_telegram_id !~ '^\d{5,20}$' then
    raise exception 'TELEGRAM_ID_INVALID';
  end if;
  if p_actor_telegram_id <> p_target_telegram_id then
    raise exception 'TEST_CREDIT_SELF_ONLY';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 8 then
    raise exception 'TEST_CREDIT_REASON_REQUIRED';
  end if;

  v_amount := round(p_amount, 6);
  if v_amount <= 0 or v_amount > 50 then
    raise exception 'TEST_CREDIT_AMOUNT_INVALID';
  end if;

  insert into public.financial_transactions_v3(
    idempotency_key, transaction_type, initiated_by, metadata
  ) values (
    p_idempotency_key, 'TOPUP_CONFIRMED', p_actor_telegram_id,
    jsonb_build_object('testOnly', true, 'targetTelegramId', p_target_telegram_id, 'amount', v_amount, 'reason', trim(p_reason))
  ) on conflict (idempotency_key) do nothing
  returning id into v_transaction_id;

  if v_transaction_id is null then
    select id into v_transaction_id
    from public.financial_transactions_v3
    where idempotency_key = p_idempotency_key;
    select wallet_balance into v_balance_after
    from public.users_v2
    where telegram_id = p_target_telegram_id;
    if not found then raise exception 'USER_NOT_FOUND'; end if;
    return jsonb_build_object(
      'transactionId', v_transaction_id,
      'telegramId', p_target_telegram_id,
      'balance', v_balance_after,
      'amount', v_amount,
      'idempotent', true
    );
  end if;

  -- Lock the account after winning the idempotency key. This makes the
  -- balance update and its audit records one database transaction.
  perform 1 from public.users_v2
  where telegram_id = p_target_telegram_id
  for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  update public.users_v2
  set wallet_balance = wallet_balance + v_amount, updated_at = now()
  where telegram_id = p_target_telegram_id
  returning wallet_balance into v_balance_after;

  insert into public.financial_entries_v3(
    transaction_id, account_code, user_telegram_id, direction, amount, reference_type, reference_id
  ) values
    (v_transaction_id, 'CUSTODY_ASSET', null, 'DEBIT', v_amount, 'test_wallet_credit', v_transaction_id),
    (v_transaction_id, 'USER_WALLET', p_target_telegram_id, 'CREDIT', v_amount, 'test_wallet_credit', v_transaction_id);

  insert into public.wallet_ledger_v2(
    telegram_id, amount, balance_after, entry_type, reference_type, reference_id, created_by
  ) values (
    p_target_telegram_id, v_amount, v_balance_after, 'TOPUP', 'test_wallet_credit_v3',
    v_transaction_id::text, p_actor_telegram_id
  );

  insert into public.admin_audit_log_v3(actor_telegram_id, action, target_type, target_id, reason, metadata)
  values (
    p_actor_telegram_id, 'CREDIT_TEST_WALLET', 'user', p_target_telegram_id, trim(p_reason),
    jsonb_build_object('transactionId', v_transaction_id, 'amount', v_amount)
  );

  return jsonb_build_object(
    'transactionId', v_transaction_id,
    'telegramId', p_target_telegram_id,
    'balance', v_balance_after,
    'amount', v_amount,
    'idempotent', false
  );
end;
$$;

revoke all on function public.credit_test_wallet_v3(text,text,numeric,uuid,text)
  from public, anon, authenticated;
grant execute on function public.credit_test_wallet_v3(text,text,numeric,uuid,text)
  to service_role;

commit;
