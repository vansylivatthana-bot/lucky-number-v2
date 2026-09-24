-- V2 backend database privileges
-- Apply after migrations 001-005. Keeps service_role access explicit while all
-- customer-facing roles remain blocked by RLS and function grants.

begin;

grant usage on schema public to service_role;

grant select, insert, update on table public.users_v2 to service_role;

grant select on table
  public.monthly_draw_rounds_v3,
  public.monthly_sales_periods_v3,
  public.draw_tickets_v3,
  public.draw_proofs_v3,
  public.draw_ticket_snapshot_items_v3,
  public.draw_winners_v3
to service_role;

commit;
