-- Ticket purchases already execute through a server-only function.
-- This grants that backend role only the ledger access required by the
-- deferred balance-validation trigger and purchase procedure.
grant select, insert on table public.financial_entries_v3 to service_role;
