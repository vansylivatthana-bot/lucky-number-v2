-- TEST PROJECT ONLY — do not apply to a production database.
-- Creates the initial OPEN monthly round and its sales period through one
-- validated, auditable operation. Do not insert round rows manually.

begin;

create or replace function public.open_test_monthly_round_v3(
  p_round_code text,
  p_calendar_month date,
  p_closes_at timestamptz,
  p_actor_telegram_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
  v_sales_period_id uuid;
  v_opens_at timestamptz := now() - interval '1 minute';
begin
  if p_round_code !~ '^DR-[0-9]{4}-[0-9]{2}-[0-9]{3}$' then
    raise exception 'TEST_ROUND_CODE_INVALID';
  end if;
  if p_calendar_month <> date_trunc('month', p_calendar_month)::date then
    raise exception 'TEST_CALENDAR_MONTH_INVALID';
  end if;
  if p_closes_at <= now() then
    raise exception 'TEST_SALES_CLOSE_MUST_BE_FUTURE';
  end if;
  if p_actor_telegram_id is null or length(trim(p_actor_telegram_id)) = 0 then
    raise exception 'TEST_ROUND_ACTOR_REQUIRED';
  end if;
  if exists (select 1 from public.monthly_draw_rounds_v3 where round_code = p_round_code) then
    raise exception 'TEST_ROUND_CODE_ALREADY_EXISTS';
  end if;
  if exists (select 1 from public.monthly_sales_periods_v3 where calendar_month = p_calendar_month) then
    raise exception 'TEST_SALES_PERIOD_ALREADY_EXISTS';
  end if;

  insert into public.monthly_draw_rounds_v3(
    round_code, rules_version, status, ticket_price,
    min_eligible_tickets, min_distinct_accounts, opened_at, created_by
  ) values (
    p_round_code, '1.0-test', 'OPEN', 5.00,
    144, 27, v_opens_at, p_actor_telegram_id
  ) returning id into v_round_id;

  insert into public.monthly_sales_periods_v3(
    draw_round_id, calendar_month, opens_at, closes_at, status
  ) values (
    v_round_id, p_calendar_month, v_opens_at, p_closes_at, 'OPEN'
  ) returning id into v_sales_period_id;

  insert into public.admin_audit_log_v3(
    actor_telegram_id, action, target_type, target_id, reason, metadata
  ) values (
    p_actor_telegram_id, 'OPEN_TEST_MONTHLY_ROUND', 'monthly_draw_round',
    v_round_id::text, 'test initial sales period',
    jsonb_build_object(
      'roundCode', p_round_code,
      'salesPeriodId', v_sales_period_id,
      'calendarMonth', p_calendar_month,
      'closesAt', p_closes_at
    )
  );

  return jsonb_build_object(
    'roundId', v_round_id,
    'salesPeriodId', v_sales_period_id,
    'roundCode', p_round_code,
    'status', 'OPEN'
  );
end;
$$;

revoke all on function public.open_test_monthly_round_v3(text,date,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.open_test_monthly_round_v3(text,date,timestamptz,text)
  to service_role;

commit;
