-- Lucky Number V2 — monthly draws and double-entry financial ledger.
-- Migration 003. Additive only: it does not modify legacy tables or the V2
-- weekly prototype tables. Do not run in production until migration 004
-- transaction procedures and acceptance tests have passed.
--
-- Security model:
--   * Browser clients have no table policies and no direct writes.
--   * Only service-role backend procedures may post financial transactions.
--   * Financial entries are append-only and every transaction must balance.
--   * Ledger money uses numeric(18,6) USDT units. The app may round only for
--     display; stored ledger and prize amounts retain six decimal places so
--     the P1/P2/P3 split reconciles exactly.

begin;

create extension if not exists pgcrypto;

-- Migration 001 initially created V2 balances with two decimal places. The
-- new ledger must retain USDT precision before any V3 transaction is posted.
alter table public.users_v2
  alter column wallet_balance type numeric(18,6);
alter table public.wallet_ledger_v2
  alter column amount type numeric(18,6),
  alter column balance_after type numeric(18,6);

-- A monthly sales period may roll into the same underlying draw round.
create table if not exists public.monthly_draw_rounds_v3 (
  id uuid primary key default gen_random_uuid(),
  round_code text not null unique check (round_code ~ '^DR-[0-9]{4}-[0-9]{2}-[0-9]{3}$'),
  rules_version text not null default '1.0',
  status text not null check (status in (
    'DRAFT', 'OPEN', 'CLOSED', 'ROLLED_OVER', 'LOCKED',
    'DRAW_DELAYED', 'DRAWN', 'SETTLED', 'CANCELLED'
  )),
  ticket_price numeric(18,6) not null default 5.00 check (ticket_price > 0),
  min_eligible_tickets integer not null default 144 check (min_eligible_tickets >= 27),
  min_distinct_accounts integer not null default 27 check (min_distinct_accounts >= 27),
  opened_at timestamptz not null,
  locked_at timestamptz null,
  drawn_at timestamptz null,
  settled_at timestamptz null,
  rollover_count integer not null default 0 check (rollover_count >= 0),
  created_at timestamptz not null default now(),
  created_by text not null
);

create table if not exists public.monthly_sales_periods_v3 (
  id uuid primary key default gen_random_uuid(),
  draw_round_id uuid not null references public.monthly_draw_rounds_v3(id),
  calendar_month date not null,
  opens_at timestamptz not null,
  closes_at timestamptz not null check (closes_at > opens_at),
  status text not null check (status in ('SCHEDULED', 'OPEN', 'CLOSED', 'ROLLED_OVER', 'CANCELLED')),
  created_at timestamptz not null default now(),
  unique (calendar_month),
  check (calendar_month = date_trunc('month', calendar_month)::date)
);

create index if not exists monthly_sales_periods_v3_round_idx
  on public.monthly_sales_periods_v3(draw_round_id, calendar_month);

-- Separate system account balances by purpose. User wallet liabilities are
-- represented by account_code USER_WALLET plus user_telegram_id in entries.
create table if not exists public.financial_accounts_v3 (
  account_code text primary key check (account_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  account_name text not null,
  account_type text not null check (account_type in ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'EQUITY')),
  is_system boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.financial_accounts_v3(account_code, account_name, account_type) values
  ('CUSTODY_ASSET', 'Safeguarded cash or USDT custody', 'ASSET'),
  ('USER_WALLET', 'User wallet liability', 'LIABILITY'),
  ('STANDARD_PRIZE_POOL', 'Standard draw prize pool liability', 'LIABILITY'),
  ('JACKPOT_RESERVE', 'Six-month jackpot reserve liability', 'LIABILITY'),
  ('AFFILIATE_PENDING', 'Pending affiliate liability', 'LIABILITY'),
  ('AFFILIATE_ADVANCE_RESERVE', 'Operator-funded reserve for released affiliate refund exposure', 'EQUITY'),
  ('OPERATING_REVENUE', 'Operating and contingency revenue', 'REVENUE')
on conflict (account_code) do nothing;

create table if not exists public.financial_transactions_v3 (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  transaction_type text not null check (transaction_type in (
    'OPENING_BALANCE', 'TOPUP_CONFIRMED', 'TICKET_PURCHASE',
    'AFFILIATE_AVAILABLE', 'AFFILIATE_SETTLED', 'PRIZE_PAYOUT',
    'JACKPOT_PAYOUT', 'REFUND', 'WITHDRAWAL_REQUESTED',
    'WITHDRAWAL_COMPLETED', 'CORRECTION', 'REVERSAL'
  )),
  status text not null default 'POSTED' check (status = 'POSTED'),
  external_reference text null,
  initiated_by text null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.financial_entries_v3 (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.financial_transactions_v3(id),
  account_code text not null references public.financial_accounts_v3(account_code),
  user_telegram_id text null references public.users_v2(telegram_id),
  draw_round_id uuid null references public.monthly_draw_rounds_v3(id),
  direction text not null check (direction in ('DEBIT', 'CREDIT')),
  amount numeric(18,6) not null check (amount > 0),
  reference_type text not null,
  reference_id uuid null,
  created_at timestamptz not null default now()
);

create index if not exists financial_entries_v3_tx_idx
  on public.financial_entries_v3(transaction_id);
create index if not exists financial_entries_v3_user_idx
  on public.financial_entries_v3(user_telegram_id, created_at desc)
  where user_telegram_id is not null;
create index if not exists financial_entries_v3_round_idx
  on public.financial_entries_v3(draw_round_id, created_at)
  where draw_round_id is not null;

-- Each committed financial transaction must have at least two entries and
-- total debits equal total credits. The constraint is deferred so procedures
-- can insert all entries in one PostgreSQL transaction.
create or replace function public.assert_financial_transaction_balanced_v3()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_transaction_id uuid := coalesce(new.transaction_id, old.transaction_id);
  v_debits numeric(18,6);
  v_credits numeric(18,6);
  v_entry_count integer;
begin
  select
    coalesce(sum(case when direction = 'DEBIT' then amount else 0 end), 0),
    coalesce(sum(case when direction = 'CREDIT' then amount else 0 end), 0),
    count(*)
  into v_debits, v_credits, v_entry_count
  from public.financial_entries_v3
  where transaction_id = v_transaction_id;

  if v_entry_count < 2 or v_debits <> v_credits then
    raise exception 'FINANCIAL_TRANSACTION_NOT_BALANCED';
  end if;
  return null;
end;
$$;

drop trigger if exists financial_entries_v3_balanced on public.financial_entries_v3;
create constraint trigger financial_entries_v3_balanced
after insert or update or delete on public.financial_entries_v3
deferrable initially deferred
for each row execute function public.assert_financial_transaction_balanced_v3();

-- Ledger rows cannot be edited or removed. Corrections require a new balanced
-- CORRECTION or REVERSAL transaction that references the original entry.
create or replace function public.reject_ledger_mutation_v3()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'FINANCIAL_LEDGER_APPEND_ONLY';
end;
$$;

drop trigger if exists financial_transactions_v3_immutable on public.financial_transactions_v3;
create trigger financial_transactions_v3_immutable
before update or delete on public.financial_transactions_v3
for each row execute function public.reject_ledger_mutation_v3();

drop trigger if exists financial_entries_v3_immutable on public.financial_entries_v3;
create trigger financial_entries_v3_immutable
before update or delete on public.financial_entries_v3
for each row execute function public.reject_ledger_mutation_v3();

-- Tickets belong to one underlying draw round even if multiple calendar-month
-- sales periods roll into it. This preserves ticket uniqueness during rollover.
create table if not exists public.draw_tickets_v3 (
  id uuid primary key default gen_random_uuid(),
  draw_round_id uuid not null references public.monthly_draw_rounds_v3(id),
  sales_period_id uuid not null references public.monthly_sales_periods_v3(id),
  owner_telegram_id text not null references public.users_v2(telegram_id),
  ticket_number text not null check (ticket_number ~ '^\d{5}$'),
  price_paid numeric(18,6) not null check (price_paid > 0),
  purchase_transaction_id uuid not null unique references public.financial_transactions_v3(id),
  state text not null default 'ACTIVE' check (state in (
    'ACTIVE', 'LOCKED', 'REFUND_REQUESTED', 'REFUNDED', 'VOIDED', 'WINNER'
  )),
  -- Counts failed scheduled closings witnessed by this particular ticket.
  -- This prevents a ticket bought after earlier rollovers from refunding early.
  rollover_count_observed integer not null default 0 check (rollover_count_observed >= 0),
  booked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(draw_round_id, ticket_number)
);

create index if not exists draw_tickets_v3_owner_idx
  on public.draw_tickets_v3(owner_telegram_id, draw_round_id, booked_at desc);
create index if not exists draw_tickets_v3_round_active_idx
  on public.draw_tickets_v3(draw_round_id, owner_telegram_id)
  where state in ('ACTIVE', 'LOCKED');

-- A per-round opaque participant ID lets the public verify that winners are
-- distinct accounts without exposing Telegram IDs. The backend returns this
-- value on a user's ticket receipt and in the public draw proof.
create table if not exists public.draw_participants_v3 (
  draw_round_id uuid not null references public.monthly_draw_rounds_v3(id),
  owner_telegram_id text not null references public.users_v2(telegram_id),
  public_participant_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  primary key (draw_round_id, owner_telegram_id),
  unique (draw_round_id, public_participant_id)
);

-- These records are created exactly when a round is locked. They are the
-- publishable canonical list used to reproduce the snapshot hash.
create table if not exists public.draw_ticket_snapshot_items_v3 (
  draw_round_id uuid not null references public.monthly_draw_rounds_v3(id),
  ticket_id uuid not null references public.draw_tickets_v3(id),
  ticket_number text not null check (ticket_number ~ '^\d{5}$'),
  public_participant_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (draw_round_id, ticket_id),
  unique (draw_round_id, ticket_number)
);

-- Store the allocation actually used at sale time. Refunds and payouts must
-- use these recorded values rather than recomputing from a later rules version.
create table if not exists public.ticket_financial_allocations_v3 (
  ticket_id uuid primary key references public.draw_tickets_v3(id),
  standard_prize_amount numeric(18,6) not null check (standard_prize_amount >= 0),
  jackpot_amount numeric(18,6) not null check (jackpot_amount >= 0),
  operating_amount numeric(18,6) not null check (operating_amount >= 0),
  affiliate_available_amount numeric(18,6) not null check (affiliate_available_amount >= 0),
  affiliate_pending_amount numeric(18,6) not null check (affiliate_pending_amount >= 0),
  created_at timestamptz not null default now(),
  check (
    standard_prize_amount + jackpot_amount + operating_amount +
    affiliate_available_amount + affiliate_pending_amount > 0
  )
);

-- Single-level affiliate entitlement. The first component can be released
-- after payment settlement, while the second remains locked until draw settle.
create table if not exists public.affiliate_rewards_v3 (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null unique references public.draw_tickets_v3(id),
  referrer_telegram_id text not null references public.users_v2(telegram_id),
  available_amount numeric(18,6) not null default 0.10 check (available_amount >= 0),
  pending_amount numeric(18,6) not null default 0.15 check (pending_amount >= 0),
  available_status text not null default 'PENDING' check (available_status in ('PENDING', 'AVAILABLE', 'CANCELLED')),
  pending_status text not null default 'PENDING' check (pending_status in ('PENDING', 'AVAILABLE', 'CANCELLED')),
  available_transaction_id uuid null unique references public.financial_transactions_v3(id),
  pending_transaction_id uuid null unique references public.financial_transactions_v3(id),
  created_at timestamptz not null default now(),
  available_at timestamptz null,
  settled_at timestamptz null,
  check (available_amount + pending_amount = 0.25)
);

create index if not exists affiliate_rewards_v3_referrer_idx
  on public.affiliate_rewards_v3(referrer_telegram_id, pending_status, created_at desc);

create table if not exists public.refund_requests_v3 (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null unique references public.draw_tickets_v3(id),
  requested_by text not null references public.users_v2(telegram_id),
  status text not null default 'REQUESTED' check (status in ('REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED')),
  reason_code text not null check (reason_code in ('THREE_MONTH_ROLLOVER', 'OPERATOR_CANCELLATION')),
  refund_transaction_id uuid null unique references public.financial_transactions_v3(id),
  requested_at timestamptz not null default now(),
  resolved_at timestamptz null,
  resolved_by text null
);

-- The confidential preimage is kept in server secret management until the
-- reveal; only its commitment is stored before the draw.
create table if not exists public.draw_proofs_v3 (
  id uuid primary key default gen_random_uuid(),
  draw_round_id uuid not null unique references public.monthly_draw_rounds_v3(id),
  ticket_snapshot_hash text null check (ticket_snapshot_hash is null or ticket_snapshot_hash ~ '^[a-f0-9]{64}$'),
  server_secret_commitment text null check (server_secret_commitment is null or server_secret_commitment ~ '^[a-f0-9]{64}$'),
  public_entropy_source text null,
  public_entropy_reference text null,
  public_entropy_value text null,
  revealed_server_secret text null,
  derived_seed_hash text null check (derived_seed_hash is null or derived_seed_hash ~ '^[a-f0-9]{64}$'),
  algorithm_version text not null default 'draw-v1',
  committed_at timestamptz null,
  revealed_at timestamptz null,
  published_at timestamptz null
);

create table if not exists public.draw_winners_v3 (
  id uuid primary key default gen_random_uuid(),
  draw_round_id uuid not null references public.monthly_draw_rounds_v3(id),
  ticket_id uuid not null unique references public.draw_tickets_v3(id),
  owner_telegram_id text not null references public.users_v2(telegram_id),
  prize_tier text not null check (prize_tier in ('P1', 'P2', 'P3')),
  rank_in_tier integer not null check (rank_in_tier > 0),
  amount numeric(18,6) not null check (amount > 0),
  payout_transaction_id uuid null unique references public.financial_transactions_v3(id),
  selected_at timestamptz not null default now(),
  paid_at timestamptz null,
  unique(draw_round_id, owner_telegram_id),
  unique(draw_round_id, prize_tier, rank_in_tier)
);

create table if not exists public.jackpot_cycles_v3 (
  id uuid primary key default gen_random_uuid(),
  cycle_code text not null unique check (cycle_code ~ '^JP-[0-9]{4}-H[12]$'),
  opens_at timestamptz not null,
  closes_at timestamptz not null check (closes_at > opens_at),
  status text not null check (status in ('OPEN', 'LOCKED', 'DRAWN', 'SETTLED', 'ROLLED_OVER')),
  created_at timestamptz not null default now()
);

create table if not exists public.jackpot_entries_v3 (
  id uuid primary key default gen_random_uuid(),
  jackpot_cycle_id uuid not null references public.jackpot_cycles_v3(id),
  user_telegram_id text not null references public.users_v2(telegram_id),
  sales_period_id uuid not null references public.monthly_sales_periods_v3(id),
  qualifying_ticket_id uuid not null references public.draw_tickets_v3(id),
  created_at timestamptz not null default now(),
  unique(jackpot_cycle_id, user_telegram_id, sales_period_id)
);

create index if not exists jackpot_entries_v3_eligibility_idx
  on public.jackpot_entries_v3(jackpot_cycle_id, user_telegram_id);

create table if not exists public.admin_audit_log_v3 (
  id uuid primary key default gen_random_uuid(),
  actor_telegram_id text null,
  action text not null,
  target_type text not null,
  target_id text null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.monthly_draw_rounds_v3 enable row level security;
alter table public.monthly_sales_periods_v3 enable row level security;
alter table public.financial_accounts_v3 enable row level security;
alter table public.financial_transactions_v3 enable row level security;
alter table public.financial_entries_v3 enable row level security;
alter table public.draw_tickets_v3 enable row level security;
alter table public.draw_participants_v3 enable row level security;
alter table public.draw_ticket_snapshot_items_v3 enable row level security;
alter table public.ticket_financial_allocations_v3 enable row level security;
alter table public.affiliate_rewards_v3 enable row level security;
alter table public.refund_requests_v3 enable row level security;
alter table public.draw_proofs_v3 enable row level security;
alter table public.draw_winners_v3 enable row level security;
alter table public.jackpot_cycles_v3 enable row level security;
alter table public.jackpot_entries_v3 enable row level security;
alter table public.admin_audit_log_v3 enable row level security;

-- Deliberately no anon/authenticated policies. Procedure grants are added in
-- the next migration only after transaction procedures are tested.
commit;
