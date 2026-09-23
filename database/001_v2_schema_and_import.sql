-- Lucky Number V2: non-destructive schema and legacy import.
-- Run once in Supabase SQL Editor after taking a database backup.

begin;

create table if not exists public.users_v2 (
  telegram_id text primary key check (telegram_id ~ '^\d{5,20}$'),
  wallet_balance numeric(18,2) not null default 0 check (wallet_balance >= 0),
  referrer_id text null,
  first_name text null,
  username text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_v2_referrer_fk foreign key (referrer_id)
    references public.users_v2(telegram_id) deferrable initially deferred,
  constraint users_v2_no_self_referral check (referrer_id is null or referrer_id <> telegram_id)
);

create table if not exists public.tickets_v2 (
  id bigint generated always as identity primary key,
  ticket_number text not null check (ticket_number ~ '^\d{5}$'),
  owner_telegram_id text not null references public.users_v2(telegram_id),
  week_start date not null,
  booked_at timestamptz not null default now(),
  legacy_source boolean not null default false,
  unique (week_start, ticket_number)
);

create index if not exists tickets_v2_owner_week_idx
  on public.tickets_v2(owner_telegram_id, week_start desc);

create table if not exists public.wallet_ledger_v2 (
  id bigint generated always as identity primary key,
  telegram_id text not null references public.users_v2(telegram_id),
  amount numeric(18,2) not null check (amount <> 0),
  balance_after numeric(18,2) not null check (balance_after >= 0),
  entry_type text not null check (entry_type in ('MIGRATION','TOPUP','TICKET_PURCHASE','REFERRAL_COMMISSION','PRIZE','ADJUSTMENT')),
  reference_type text null,
  reference_id text null,
  created_by text null,
  created_at timestamptz not null default now()
);

create index if not exists wallet_ledger_v2_user_created_idx
  on public.wallet_ledger_v2(telegram_id, created_at desc);

create table if not exists public.draws_v2 (
  id bigint generated always as identity primary key,
  week_start date not null unique,
  winning_number text not null check (winning_number ~ '^\d{5}$'),
  created_by text not null,
  created_at timestamptz not null default now()
);

-- Preserve users and balances only when this database contains the old
-- system's tables. A clean staging database deliberately has no such tables.
do $$
begin
  if to_regclass('public.users') is not null then
    insert into public.users_v2 (telegram_id, wallet_balance, referrer_id)
    select
      u.telegram_id::text,
      greatest(coalesce(u.wallet_balance, 0)::numeric, 0),
      null
    from public.users u
    where u.telegram_id is not null
    on conflict (telegram_id) do nothing;

    -- Restore only valid referral relationships; orphan/self references are left null.
    update public.users_v2 target
    set referrer_id = legacy.referrer_id::text
    from public.users legacy
    join public.users_v2 referrer on referrer.telegram_id = legacy.referrer_id::text
    where target.telegram_id = legacy.telegram_id::text
      and legacy.referrer_id is not null
      and legacy.referrer_id::text <> legacy.telegram_id::text
      and target.referrer_id is null;
  end if;
end;
$$;

-- Add a migration ledger entry exactly once for each imported non-zero balance.
insert into public.wallet_ledger_v2
  (telegram_id, amount, balance_after, entry_type, reference_type, reference_id, created_by)
select
  u.telegram_id,
  u.wallet_balance,
  u.wallet_balance,
  'MIGRATION',
  'legacy_users',
  u.telegram_id,
  'migration-v2'
from public.users_v2 u
where u.wallet_balance <> 0
  and not exists (
  select 1 from public.wallet_ledger_v2 l
  where l.telegram_id = u.telegram_id
    and l.entry_type = 'MIGRATION'
    and l.reference_id = u.telegram_id
);

-- Preserve legacy tickets only when the legacy table exists.
do $$
begin
  if to_regclass('public.tickets') is not null then
    insert into public.tickets_v2
      (ticket_number, owner_telegram_id, week_start, booked_at, legacy_source)
    select
      lpad(t.ticket_number::text, 5, '0'),
      t.owner_telegram_id::text,
      date_trunc('week', t."Date_book"::date)::date,
      (t."Date_book"::text || ' ' || coalesce(t."Time_book"::text, '00:00:00') || '+07')::timestamptz,
      true
    from public.tickets t
    join public.users_v2 u on u.telegram_id = t.owner_telegram_id::text
    where t.ticket_number is not null
      and t."Date_book" is not null
      and lpad(t.ticket_number::text, 5, '0') ~ '^\d{5}$'
    on conflict (week_start, ticket_number) do nothing;
  end if;
end;
$$;

alter table public.users_v2 enable row level security;
alter table public.tickets_v2 enable row level security;
alter table public.wallet_ledger_v2 enable row level security;
alter table public.draws_v2 enable row level security;

-- No browser policies are created. Only the backend service-role key may access V2 data.

create or replace function public.purchase_ticket_v2(
  p_telegram_id text,
  p_ticket_number text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now_local timestamp := timezone('Asia/Vientiane', now());
  v_week_start date := date_trunc('week', v_now_local)::date;
  v_price constant numeric(18,2) := 5.00;
  v_commission constant numeric(18,2) := 0.50;
  v_balance numeric(18,2);
  v_referrer_id text;
  v_referrer_balance numeric(18,2);
  v_ticket_id bigint;
begin
  if p_ticket_number !~ '^\d{5}$' then raise exception 'TICKET_NUMBER_INVALID'; end if;
  if extract(isodow from v_now_local) = 7 and v_now_local::time >= time '12:00' then
    raise exception 'SALES_CLOSED';
  end if;

  select wallet_balance, referrer_id into v_balance, v_referrer_id
  from public.users_v2
  where telegram_id = p_telegram_id
  for update;

  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_balance < v_price then raise exception 'INSUFFICIENT_BALANCE'; end if;
  if exists (select 1 from public.tickets_v2 where week_start = v_week_start and ticket_number = p_ticket_number) then
    raise exception 'TICKET_ALREADY_SOLD';
  end if;

  update public.users_v2
  set wallet_balance = wallet_balance - v_price, updated_at = now()
  where telegram_id = p_telegram_id
  returning wallet_balance into v_balance;

  insert into public.tickets_v2(ticket_number, owner_telegram_id, week_start)
  values (p_ticket_number, p_telegram_id, v_week_start)
  returning id into v_ticket_id;

  insert into public.wallet_ledger_v2
    (telegram_id, amount, balance_after, entry_type, reference_type, reference_id, created_by)
  values
    (p_telegram_id, -v_price, v_balance, 'TICKET_PURCHASE', 'ticket', v_ticket_id::text, p_telegram_id);

  if v_referrer_id is not null then
    update public.users_v2
    set wallet_balance = wallet_balance + v_commission, updated_at = now()
    where telegram_id = v_referrer_id
    returning wallet_balance into v_referrer_balance;

    if found then
      insert into public.wallet_ledger_v2
        (telegram_id, amount, balance_after, entry_type, reference_type, reference_id, created_by)
      values
        (v_referrer_id, v_commission, v_referrer_balance, 'REFERRAL_COMMISSION', 'ticket', v_ticket_id::text, p_telegram_id);
    end if;
  end if;

  return jsonb_build_object(
    'ticketId', v_ticket_id,
    'ticketNumber', p_ticket_number,
    'weekStart', v_week_start,
    'balance', v_balance
  );
exception
  when unique_violation then raise exception 'TICKET_ALREADY_SOLD';
end;
$$;

create or replace function public.topup_wallet_v2(
  p_admin_telegram_id text,
  p_target_telegram_id text,
  p_amount numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric(18,2);
begin
  if p_amount <= 0 or p_amount > 1000000 then raise exception 'AMOUNT_INVALID'; end if;
  update public.users_v2
  set wallet_balance = wallet_balance + round(p_amount, 2), updated_at = now()
  where telegram_id = p_target_telegram_id
  returning wallet_balance into v_balance;
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  insert into public.wallet_ledger_v2
    (telegram_id, amount, balance_after, entry_type, reference_type, reference_id, created_by)
  values
    (p_target_telegram_id, round(p_amount, 2), v_balance, 'TOPUP', 'admin_topup', gen_random_uuid()::text, p_admin_telegram_id);

  return jsonb_build_object('telegramId', p_target_telegram_id, 'balance', v_balance);
end;
$$;

create or replace function public.record_draw_v2(
  p_admin_telegram_id text,
  p_winning_number text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week_start date := date_trunc('week', timezone('Asia/Vientiane', now()))::date;
  v_winners jsonb;
begin
  if p_winning_number !~ '^\d{5}$' then raise exception 'TICKET_NUMBER_INVALID'; end if;
  insert into public.draws_v2(week_start, winning_number, created_by)
  values (v_week_start, p_winning_number, p_admin_telegram_id)
  on conflict (week_start) do update
    set winning_number = excluded.winning_number,
        created_by = excluded.created_by,
        created_at = now();

  select coalesce(jsonb_agg(jsonb_build_object('telegram_id', owner_telegram_id)), '[]'::jsonb)
  into v_winners
  from public.tickets_v2
  where week_start = v_week_start and ticket_number = p_winning_number;

  return jsonb_build_object('winning_number', p_winning_number, 'winner_count', jsonb_array_length(v_winners), 'winners', v_winners);
end;
$$;

revoke all on function public.purchase_ticket_v2(text,text) from public, anon, authenticated;
revoke all on function public.topup_wallet_v2(text,text,numeric) from public, anon, authenticated;
revoke all on function public.record_draw_v2(text,text) from public, anon, authenticated;
grant execute on function public.purchase_ticket_v2(text,text) to service_role;
grant execute on function public.topup_wallet_v2(text,text,numeric) to service_role;
grant execute on function public.record_draw_v2(text,text) to service_role;

commit;
