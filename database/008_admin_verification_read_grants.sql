-- Read-only grants needed by the server-side TEST admin ledger verification.
-- The browser has no database key; only the backend service-role client uses
-- these grants after verified Telegram admin authentication.

begin;

grant select on table public.wallet_ledger_v2 to service_role;
grant select on table public.financial_entries_v3 to service_role;
grant select on table public.draw_tickets_v3 to service_role;

commit;
