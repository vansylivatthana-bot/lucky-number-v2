# Lucky Number V2 — Supabase TEST Runbook

Use this runbook only with a newly created, isolated Supabase project named for
testing (for example `lucky-number-v2-test`). Never run these steps in the
legacy project or a production project.

## Before running SQL

1. Confirm the dashboard URL shows the TEST project name.
2. Do not copy any existing production users, balances, tickets, bot token,
   service-role key, or wallet credentials into this project.
3. Open **SQL Editor** and create a new query for each file below.
4. Run the files in exactly the stated order. Stop at the first error and keep
   the full error text for investigation; do not skip ahead.

## Migration order for an empty TEST project

1. `001_v2_schema_and_import.sql`
2. `003_monthly_rounds_and_financial_ledger.sql`
3. `004_financial_transaction_procedures.sql`
4. `005_verifiable_draw_and_payouts.sql`

`001` detects whether legacy `users` and `tickets` tables exist. In a clean
TEST project it creates the V2 compatibility tables but imports nothing.

Do **not** run `002_verify_import.sql` in a clean TEST project. That script is
only for a controlled legacy-data import because it queries the old `users`
and `tickets` tables.

## Acceptance-test order

Run each test in a fresh SQL Editor query after all four migrations succeed:

1. `tests/001_financial_ledger_acceptance.sql`
2. `tests/002_verifiable_draw_acceptance.sql`

Both scripts start a transaction and end with `ROLLBACK`; they must leave no
test users, tickets, balances, or financial entries behind. A successful run
returns without an SQL error. Any `TEST_...` or `...NOT_BALANCED` error is a
failure and blocks all deployment work.

## Required evidence before proceeding

Capture only these non-secret results:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'monthly_draw_rounds_v3', 'draw_tickets_v3', 'financial_transactions_v3',
    'financial_entries_v3', 'draw_proofs_v3', 'draw_winners_v3'
  )
order by table_name;

select count(*) as test_data_left_behind
from public.financial_transactions_v3;
```

The first query must return six table names. The second must return `0` after
the acceptance tests, because both tests roll back.

Never paste a database password, service-role key, bot token, or project API
key into chat, GitHub, screenshots, or this repository.
