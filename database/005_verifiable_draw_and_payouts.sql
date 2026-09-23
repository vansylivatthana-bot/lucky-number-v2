-- Lucky Number V2 — verifiable monthly draw, winners and payout procedures.
-- Run only after migrations 001, 003 and 004 in an isolated test database.
--
-- The visible wheel is presentation only. Winner selection is deterministic
-- from the locked ticket snapshot, the pre-committed server secret and a
-- declared public entropy value. No browser role can execute these functions.

begin;

create or replace function public.close_monthly_sales_period_v3(
  p_sales_period_id uuid,
  p_actor_telegram_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period public.monthly_sales_periods_v3%rowtype;
  v_round public.monthly_draw_rounds_v3%rowtype;
begin
  select * into v_period
  from public.monthly_sales_periods_v3
  where id = p_sales_period_id
  for update;
  if not found then raise exception 'SALES_PERIOD_NOT_FOUND'; end if;
  if v_period.status = 'CLOSED' then
    return jsonb_build_object('salesPeriodId', v_period.id, 'idempotent', true);
  end if;
  if v_period.status <> 'OPEN' or now() < v_period.closes_at then
    raise exception 'SALES_PERIOD_NOT_READY_TO_CLOSE';
  end if;

  select * into v_round
  from public.monthly_draw_rounds_v3
  where id = v_period.draw_round_id
  for update;
  if v_round.status <> 'OPEN' then raise exception 'ROUND_NOT_OPEN'; end if;

  update public.monthly_sales_periods_v3 set status = 'CLOSED' where id = v_period.id;
  update public.monthly_draw_rounds_v3 set status = 'CLOSED' where id = v_round.id;

  insert into public.admin_audit_log_v3(actor_telegram_id, action, target_type, target_id, reason)
  values (p_actor_telegram_id, 'CLOSE_MONTHLY_SALES_PERIOD', 'monthly_sales_period', v_period.id::text, 'scheduled monthly close');

  return jsonb_build_object('salesPeriodId', v_period.id, 'roundId', v_round.id, 'idempotent', false);
end;
$$;

create or replace function public.open_rollover_sales_period_v3(
  p_round_id uuid,
  p_calendar_month date,
  p_opens_at timestamptz,
  p_closes_at timestamptz,
  p_actor_telegram_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.monthly_draw_rounds_v3%rowtype;
  v_period_id uuid;
begin
  if p_calendar_month <> date_trunc('month', p_calendar_month)::date then
    raise exception 'CALENDAR_MONTH_INVALID';
  end if;
  if p_closes_at <= p_opens_at or now() < p_opens_at or now() >= p_closes_at then
    raise exception 'ROLLOVER_SALES_WINDOW_INVALID';
  end if;

  select * into v_round from public.monthly_draw_rounds_v3 where id = p_round_id for update;
  if not found then raise exception 'ROUND_NOT_FOUND'; end if;
  if v_round.status <> 'ROLLED_OVER' then raise exception 'ROUND_NOT_ROLLED_OVER'; end if;

  if exists (
    select 1 from public.monthly_sales_periods_v3
    where calendar_month = p_calendar_month
  ) then raise exception 'CALENDAR_MONTH_ALREADY_EXISTS'; end if;

  update public.monthly_sales_periods_v3
  set status = 'ROLLED_OVER'
  where draw_round_id = p_round_id and status = 'CLOSED';

  insert into public.monthly_sales_periods_v3(
    draw_round_id, calendar_month, opens_at, closes_at, status
  ) values (
    p_round_id, p_calendar_month, p_opens_at, p_closes_at, 'OPEN'
  ) returning id into v_period_id;

  update public.monthly_draw_rounds_v3 set status = 'OPEN' where id = p_round_id;

  insert into public.admin_audit_log_v3(actor_telegram_id, action, target_type, target_id, reason)
  values (p_actor_telegram_id, 'OPEN_ROLLOVER_SALES_PERIOD', 'monthly_draw_round', p_round_id::text, 'minimum participation not met');

  return jsonb_build_object('salesPeriodId', v_period_id, 'roundId', p_round_id);
end;
$$;

create or replace function public.lock_monthly_draw_round_v3(
  p_round_id uuid,
  p_server_secret_commitment text,
  p_actor_telegram_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.monthly_draw_rounds_v3%rowtype;
  v_ticket_count integer;
  v_account_count integer;
  v_snapshot_count integer;
  v_snapshot text;
  v_snapshot_hash text;
begin
  if p_server_secret_commitment !~ '^[a-f0-9]{64}$' then
    raise exception 'SERVER_SECRET_COMMITMENT_INVALID';
  end if;

  select * into v_round from public.monthly_draw_rounds_v3 where id = p_round_id for update;
  if not found then raise exception 'ROUND_NOT_FOUND'; end if;
  if v_round.status = 'LOCKED' then
    return jsonb_build_object('roundId', p_round_id, 'status', 'LOCKED', 'idempotent', true);
  end if;
  if v_round.status <> 'CLOSED' then raise exception 'ROUND_NOT_READY_TO_LOCK'; end if;

  select count(*), count(distinct owner_telegram_id)
  into v_ticket_count, v_account_count
  from public.draw_tickets_v3
  where draw_round_id = p_round_id and state = 'ACTIVE';

  if v_ticket_count < v_round.min_eligible_tickets
     or v_account_count < v_round.min_distinct_accounts then
    update public.draw_tickets_v3
    set rollover_count_observed = rollover_count_observed + 1
    where draw_round_id = p_round_id and state = 'ACTIVE';

    update public.monthly_draw_rounds_v3
    set status = 'ROLLED_OVER', rollover_count = rollover_count + 1
    where id = p_round_id;

    insert into public.admin_audit_log_v3(actor_telegram_id, action, target_type, target_id, reason, metadata)
    values (
      p_actor_telegram_id, 'ROLL_OVER_MONTHLY_DRAW', 'monthly_draw_round', p_round_id::text,
      'minimum eligible tickets or distinct accounts not met',
      jsonb_build_object('eligibleTickets', v_ticket_count, 'distinctAccounts', v_account_count)
    );

    return jsonb_build_object(
      'roundId', p_round_id, 'status', 'ROLLED_OVER',
      'eligibleTickets', v_ticket_count, 'distinctAccounts', v_account_count
    );
  end if;

  insert into public.draw_ticket_snapshot_items_v3(
    draw_round_id, ticket_id, ticket_number, public_participant_id
  )
  select t.draw_round_id, t.id, t.ticket_number, p.public_participant_id
  from public.draw_tickets_v3 t
  join public.draw_participants_v3 p
    on p.draw_round_id = t.draw_round_id and p.owner_telegram_id = t.owner_telegram_id
  where t.draw_round_id = p_round_id and t.state = 'ACTIVE';

  select string_agg(
    ticket_id::text || '|' || ticket_number || '|' || public_participant_id::text,
    E'\n' order by ticket_id
  ) into v_snapshot
  from public.draw_ticket_snapshot_items_v3
  where draw_round_id = p_round_id;
  select count(*) into v_snapshot_count
  from public.draw_ticket_snapshot_items_v3
  where draw_round_id = p_round_id;
  if v_snapshot_count <> v_ticket_count then
    raise exception 'DRAW_SNAPSHOT_PARTICIPANT_MAPPING_INCOMPLETE';
  end if;
  v_snapshot_hash := encode(digest(coalesce(v_snapshot, ''), 'sha256'), 'hex');

  insert into public.draw_proofs_v3(
    draw_round_id, ticket_snapshot_hash, server_secret_commitment, algorithm_version, committed_at
  ) values (
    p_round_id, v_snapshot_hash, p_server_secret_commitment, 'draw-v1', now()
  );

  update public.draw_tickets_v3
  set state = 'LOCKED'
  where draw_round_id = p_round_id and state = 'ACTIVE';
  update public.monthly_draw_rounds_v3
  set status = 'LOCKED', locked_at = now()
  where id = p_round_id;

  insert into public.admin_audit_log_v3(actor_telegram_id, action, target_type, target_id, reason, metadata)
  values (
    p_actor_telegram_id, 'LOCK_MONTHLY_DRAW', 'monthly_draw_round', p_round_id::text,
    'eligible ticket snapshot committed',
    jsonb_build_object('eligibleTickets', v_ticket_count, 'distinctAccounts', v_account_count, 'snapshotHash', v_snapshot_hash)
  );

  return jsonb_build_object(
    'roundId', p_round_id, 'status', 'LOCKED', 'eligibleTickets', v_ticket_count,
    'distinctAccounts', v_account_count, 'ticketSnapshotHash', v_snapshot_hash, 'idempotent', false
  );
end;
$$;

create or replace function public.execute_verifiable_draw_and_settle_v3(
  p_round_id uuid,
  p_revealed_server_secret text,
  p_public_entropy_source text,
  p_public_entropy_reference text,
  p_public_entropy_value text,
  p_actor_telegram_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.monthly_draw_rounds_v3%rowtype;
  v_proof public.draw_proofs_v3%rowtype;
  v_commitment text;
  v_seed_hash text;
  v_pool numeric(18,6);
  v_p1_amount numeric(18,6);
  v_p2_total numeric(18,6);
  v_p2_base numeric(18,6);
  v_p3_total numeric(18,6);
  v_p3_base numeric(18,6);
  v_winner record;
  v_payout_transaction_id uuid;
  v_balance_after numeric(18,6);
  v_winner_count integer;
begin
  if p_public_entropy_source <> 'NIST_BEACON_V2' then
    raise exception 'PUBLIC_ENTROPY_SOURCE_INVALID';
  end if;
  if coalesce(length(trim(p_public_entropy_reference)), 0) < 8
     or coalesce(length(trim(p_public_entropy_value)), 0) < 16 then
    raise exception 'PUBLIC_ENTROPY_NOT_VERIFIABLE';
  end if;

  select * into v_round from public.monthly_draw_rounds_v3 where id = p_round_id for update;
  if not found then raise exception 'ROUND_NOT_FOUND'; end if;
  if v_round.status = 'SETTLED' then
    select count(*) into v_winner_count from public.draw_winners_v3 where draw_round_id = p_round_id;
    return jsonb_build_object('roundId', p_round_id, 'status', 'SETTLED', 'winnerCount', v_winner_count, 'idempotent', true);
  end if;
  if v_round.status <> 'LOCKED' then raise exception 'ROUND_NOT_LOCKED'; end if;

  select * into v_proof from public.draw_proofs_v3 where draw_round_id = p_round_id for update;
  if not found then raise exception 'DRAW_PROOF_NOT_FOUND'; end if;
  v_commitment := encode(digest(p_revealed_server_secret, 'sha256'), 'hex');
  if v_commitment <> v_proof.server_secret_commitment then
    raise exception 'SERVER_SECRET_COMMITMENT_MISMATCH';
  end if;
  v_seed_hash := encode(digest(
    p_revealed_server_secret || '|' || p_public_entropy_value || '|' || v_proof.ticket_snapshot_hash,
    'sha256'
  ), 'hex');

  select coalesce(sum(a.standard_prize_amount), 0)
  into v_pool
  from public.ticket_financial_allocations_v3 a
  join public.draw_tickets_v3 t on t.id = a.ticket_id
  where t.draw_round_id = p_round_id and t.state = 'LOCKED';
  if v_pool <= 0 then raise exception 'STANDARD_PRIZE_POOL_EMPTY'; end if;

  v_p1_amount := round(v_pool / 3, 6);
  v_p2_total := round(v_pool * 2 / 9, 6);
  v_p2_base := round(v_p2_total / 3, 6);
  v_p3_total := v_pool - v_p1_amount - v_p2_total;
  v_p3_base := round(v_p3_total / 23, 6);

  with ticket_hashes as (
    select t.id, t.owner_telegram_id,
      encode(digest(v_seed_hash || '|' || t.id::text, 'sha256'), 'hex') as ticket_sort_key
    from public.draw_tickets_v3 t
    where t.draw_round_id = p_round_id and t.state = 'LOCKED'
  ), per_account as (
    select *, row_number() over (partition by owner_telegram_id order by ticket_sort_key, id) as account_ticket_rank
    from ticket_hashes
  ), selected as (
    select id, owner_telegram_id,
      row_number() over (order by ticket_sort_key, id) as winner_rank
    from per_account
    where account_ticket_rank = 1
  )
  insert into public.draw_winners_v3(
    draw_round_id, ticket_id, owner_telegram_id, prize_tier, rank_in_tier, amount
  )
  select
    p_round_id,
    id,
    owner_telegram_id,
    case when winner_rank = 1 then 'P1' when winner_rank <= 4 then 'P2' else 'P3' end,
    case when winner_rank = 1 then 1 when winner_rank <= 4 then winner_rank - 1 else winner_rank - 4 end,
    case
      when winner_rank = 1 then v_p1_amount
      when winner_rank between 2 and 3 then v_p2_base
      when winner_rank = 4 then v_p2_total - (v_p2_base * 2)
      when winner_rank between 5 and 26 then v_p3_base
      when winner_rank = 27 then v_p3_total - (v_p3_base * 22)
    end
  from selected
  where winner_rank <= 27;

  select count(*) into v_winner_count from public.draw_winners_v3 where draw_round_id = p_round_id;
  if v_winner_count <> 27 then raise exception 'WINNER_ACCOUNT_COUNT_INVALID'; end if;
  if (select sum(amount) from public.draw_winners_v3 where draw_round_id = p_round_id) <> v_pool then
    raise exception 'PRIZE_ALLOCATION_NOT_BALANCED';
  end if;

  for v_winner in
    select * from public.draw_winners_v3
    where draw_round_id = p_round_id and payout_transaction_id is null
    order by case prize_tier when 'P1' then 1 when 'P2' then 2 else 3 end, rank_in_tier
  loop
    insert into public.financial_transactions_v3(
      idempotency_key, transaction_type, initiated_by, metadata
    ) values (
      gen_random_uuid(), 'PRIZE_PAYOUT', p_actor_telegram_id,
      jsonb_build_object('roundId', p_round_id, 'winnerId', v_winner.id, 'tier', v_winner.prize_tier)
    ) returning id into v_payout_transaction_id;

    update public.users_v2
    set wallet_balance = wallet_balance + v_winner.amount, updated_at = now()
    where telegram_id = v_winner.owner_telegram_id
    returning wallet_balance into v_balance_after;
    if not found then raise exception 'WINNER_USER_NOT_FOUND'; end if;

    insert into public.financial_entries_v3(
      transaction_id, account_code, user_telegram_id, draw_round_id,
      direction, amount, reference_type, reference_id
    ) values
      (v_payout_transaction_id, 'STANDARD_PRIZE_POOL', null, p_round_id,
        'DEBIT', v_winner.amount, 'draw_winner', v_winner.id),
      (v_payout_transaction_id, 'USER_WALLET', v_winner.owner_telegram_id, p_round_id,
        'CREDIT', v_winner.amount, 'draw_winner', v_winner.id);

    update public.draw_winners_v3
    set payout_transaction_id = v_payout_transaction_id, paid_at = now()
    where id = v_winner.id;
    update public.draw_tickets_v3 set state = 'WINNER' where id = v_winner.ticket_id;

    insert into public.wallet_ledger_v2(
      telegram_id, amount, balance_after, entry_type, reference_type, reference_id, created_by
    ) values (
      v_winner.owner_telegram_id, v_winner.amount, v_balance_after,
      'PRIZE', 'draw_winner_v3', v_winner.id::text, p_actor_telegram_id
    );
  end loop;

  update public.draw_proofs_v3
  set public_entropy_source = p_public_entropy_source,
      public_entropy_reference = p_public_entropy_reference,
      public_entropy_value = p_public_entropy_value,
      revealed_server_secret = p_revealed_server_secret,
      derived_seed_hash = v_seed_hash,
      revealed_at = now(),
      published_at = now()
  where draw_round_id = p_round_id;

  update public.monthly_draw_rounds_v3
  set status = 'SETTLED', drawn_at = now(), settled_at = now()
  where id = p_round_id;

  insert into public.admin_audit_log_v3(actor_telegram_id, action, target_type, target_id, reason, metadata)
  values (
    p_actor_telegram_id, 'EXECUTE_VERIFIABLE_DRAW_AND_SETTLE', 'monthly_draw_round', p_round_id::text,
    'server commitment and public entropy verified',
    jsonb_build_object('winnerCount', v_winner_count, 'prizePool', v_pool, 'derivedSeedHash', v_seed_hash)
  );

  return jsonb_build_object(
    'roundId', p_round_id, 'status', 'SETTLED', 'winnerCount', v_winner_count,
    'prizePool', v_pool, 'derivedSeedHash', v_seed_hash, 'idempotent', false
  );
end;
$$;

-- Once a commitment is published, the snapshot, commitment and algorithm can
-- never be changed. The revealed proof may be written exactly once.
create or replace function public.enforce_draw_proof_immutability_v3()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then raise exception 'DRAW_PROOF_APPEND_ONLY'; end if;
  if old.committed_at is not null and (
    new.ticket_snapshot_hash is distinct from old.ticket_snapshot_hash or
    new.server_secret_commitment is distinct from old.server_secret_commitment or
    new.algorithm_version is distinct from old.algorithm_version
  ) then raise exception 'DRAW_PROOF_COMMITMENT_IMMUTABLE'; end if;
  if old.revealed_at is not null and (
    new.public_entropy_source is distinct from old.public_entropy_source or
    new.public_entropy_reference is distinct from old.public_entropy_reference or
    new.public_entropy_value is distinct from old.public_entropy_value or
    new.revealed_server_secret is distinct from old.revealed_server_secret or
    new.derived_seed_hash is distinct from old.derived_seed_hash or
    new.revealed_at is distinct from old.revealed_at
  ) then raise exception 'DRAW_PROOF_REVEAL_IMMUTABLE'; end if;
  return new;
end;
$$;

drop trigger if exists draw_proofs_v3_immutable on public.draw_proofs_v3;
create trigger draw_proofs_v3_immutable
before update or delete on public.draw_proofs_v3
for each row execute function public.enforce_draw_proof_immutability_v3();

create or replace function public.enforce_draw_winner_immutability_v3()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then raise exception 'DRAW_WINNER_APPEND_ONLY'; end if;
  if old.payout_transaction_id is not null or old.paid_at is not null then
    raise exception 'DRAW_WINNER_PAID_IMMUTABLE';
  end if;
  if new.draw_round_id is distinct from old.draw_round_id
     or new.ticket_id is distinct from old.ticket_id
     or new.owner_telegram_id is distinct from old.owner_telegram_id
     or new.prize_tier is distinct from old.prize_tier
     or new.rank_in_tier is distinct from old.rank_in_tier
     or new.amount is distinct from old.amount then
    raise exception 'DRAW_WINNER_SELECTION_IMMUTABLE';
  end if;
  return new;
end;
$$;

drop trigger if exists draw_winners_v3_immutable on public.draw_winners_v3;
create trigger draw_winners_v3_immutable
before update or delete on public.draw_winners_v3
for each row execute function public.enforce_draw_winner_immutability_v3();

create or replace function public.reject_draw_snapshot_mutation_v3()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'DRAW_SNAPSHOT_APPEND_ONLY';
end;
$$;

drop trigger if exists draw_ticket_snapshot_items_v3_immutable on public.draw_ticket_snapshot_items_v3;
create trigger draw_ticket_snapshot_items_v3_immutable
before update or delete on public.draw_ticket_snapshot_items_v3
for each row execute function public.reject_draw_snapshot_mutation_v3();

revoke all on function public.close_monthly_sales_period_v3(uuid,text) from public, anon, authenticated;
revoke all on function public.open_rollover_sales_period_v3(uuid,date,timestamptz,timestamptz,text) from public, anon, authenticated;
revoke all on function public.lock_monthly_draw_round_v3(uuid,text,text) from public, anon, authenticated;
revoke all on function public.execute_verifiable_draw_and_settle_v3(uuid,text,text,text,text,text) from public, anon, authenticated;

grant execute on function public.close_monthly_sales_period_v3(uuid,text) to service_role;
grant execute on function public.open_rollover_sales_period_v3(uuid,date,timestamptz,timestamptz,text) to service_role;
grant execute on function public.lock_monthly_draw_round_v3(uuid,text,text) to service_role;
grant execute on function public.execute_verifiable_draw_and_settle_v3(uuid,text,text,text,text,text) to service_role;

commit;
