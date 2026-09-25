-- Encrypted server-secret escrow for verifiable draws.
-- The plaintext secret never enters this table. The backend encrypts it with
-- a Render environment key before locking a draw, then decrypts it only when
-- settling the already-locked round.

begin;

create table if not exists public.draw_secret_escrow_v3 (
  draw_round_id uuid primary key references public.monthly_draw_rounds_v3(id),
  server_secret_commitment text not null check (server_secret_commitment ~ '^[a-f0-9]{64}$'),
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  created_at timestamptz not null default now()
);

alter table public.draw_secret_escrow_v3 enable row level security;

-- This wrapper prevents a crash between commitment and secret storage. Either
-- the round stays CLOSED, rolls over, or becomes LOCKED with its encrypted
-- secret committed in the same transaction.
create or replace function public.lock_monthly_draw_round_with_escrow_v3(
  p_round_id uuid,
  p_server_secret_commitment text,
  p_ciphertext text,
  p_iv text,
  p_auth_tag text,
  p_actor_telegram_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.monthly_draw_rounds_v3%rowtype;
  v_existing public.draw_secret_escrow_v3%rowtype;
  v_result jsonb;
begin
  if p_server_secret_commitment !~ '^[a-f0-9]{64}$' then
    raise exception 'SERVER_SECRET_COMMITMENT_INVALID';
  end if;
  if coalesce(length(p_ciphertext), 0) < 24
     or coalesce(length(p_iv), 0) < 12
     or coalesce(length(p_auth_tag), 0) < 16 then
    raise exception 'DRAW_SECRET_ESCROW_INVALID';
  end if;

  select * into v_round
  from public.monthly_draw_rounds_v3
  where id = p_round_id
  for update;
  if not found then raise exception 'ROUND_NOT_FOUND'; end if;

  if v_round.status = 'LOCKED' then
    select * into v_existing
    from public.draw_secret_escrow_v3
    where draw_round_id = p_round_id;
    if not found then raise exception 'DRAW_SECRET_ESCROW_MISSING'; end if;
    if v_existing.server_secret_commitment <> p_server_secret_commitment then
      raise exception 'DRAW_SECRET_COMMITMENT_MISMATCH';
    end if;
    return jsonb_build_object('roundId', p_round_id, 'status', 'LOCKED', 'idempotent', true);
  end if;

  if v_round.status <> 'CLOSED' then raise exception 'ROUND_NOT_READY_TO_LOCK'; end if;

  v_result := public.lock_monthly_draw_round_v3(
    p_round_id, p_server_secret_commitment, p_actor_telegram_id
  );

  if v_result->>'status' = 'LOCKED' then
    insert into public.draw_secret_escrow_v3(
      draw_round_id, server_secret_commitment, ciphertext, iv, auth_tag
    ) values (
      p_round_id, p_server_secret_commitment, p_ciphertext, p_iv, p_auth_tag
    );
  end if;

  return v_result;
end;
$$;

revoke all on table public.draw_secret_escrow_v3 from public, anon, authenticated;
grant select on table public.draw_secret_escrow_v3 to service_role;
revoke all on function public.lock_monthly_draw_round_with_escrow_v3(uuid,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.lock_monthly_draw_round_with_escrow_v3(uuid,text,text,text,text,text)
  to service_role;

commit;
