-- Lucky Number V2 — TEST policy: close the active sales period at 23:55
-- on the final calendar day of its sales month in Asia/Bangkok (ICT).
--
-- Run after 003, 005 and 009. This does NOT lock, draw, settle, pay, refund,
-- or create a new round. The scheduler/backend can only call the existing
-- close procedure after the stored closes_at timestamp has passed.

begin;

with active_periods as (
  select
    p.id,
    make_timestamptz(
      extract(year from p.calendar_month)::integer,
      extract(month from p.calendar_month)::integer,
      extract(day from (p.calendar_month + interval '1 month - 1 day'))::integer,
      23, 55, 0, 'Asia/Bangkok'
    ) as policy_close_at
  from public.monthly_sales_periods_v3 p
  join public.monthly_draw_rounds_v3 r on r.id = p.draw_round_id
  where p.status = 'OPEN' and r.status = 'OPEN'
)
update public.monthly_sales_periods_v3 p
set closes_at = a.policy_close_at
from active_periods a
where p.id = a.id
  and a.policy_close_at > p.opens_at;

insert into public.admin_audit_log_v3(actor_telegram_id, action, target_type, target_id, reason, metadata)
select
  null,
  'SET_MONTH_END_SALES_CLOSE_POLICY',
  'monthly_sales_period',
  p.id::text,
  'close at 23:55 ICT on final calendar day of sales month',
  jsonb_build_object('timezone', 'Asia/Bangkok', 'closeHour', '23:55', 'closesAt', p.closes_at)
from public.monthly_sales_periods_v3 p
join public.monthly_draw_rounds_v3 r on r.id = p.draw_round_id
where p.status = 'OPEN' and r.status = 'OPEN';

commit;
