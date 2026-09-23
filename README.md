# Lucky Number V2

A clean rebuild of the Telegram Lucky Number system. V2 imports legacy users,
wallet balances, and tickets without modifying or deleting the legacy tables.

## What V2 fixes

- Verifies Telegram Web App `initData`; a user cannot impersonate another ID by
  changing `?userid=`.
- Purchases run in one PostgreSQL transaction. A failed ticket insert cannot
  deduct money without creating the ticket.
- Keeps an immutable wallet ledger for migration, top-ups, purchases, and
  referral commissions.
- Rejects duplicate numbers per weekly draw at database level.
- Uses structured, secret-safe errors instead of silently returning balance 0.
- Provides `/health/live` for Render and `/health/ready` for diagnostics.
- Tests the bot identity with `getMe` before setting the webhook.

## Repository layout

```text
backend/   Node.js API and Telegram webhook
frontend/  Telegram Mini App static site
database/  Non-destructive Supabase migration and verification SQL
```

## Safe deployment order

### 1. Rotate secrets

Create a fresh Telegram bot token and copy a fresh Supabase service-role key.
Never paste either into source files, chat, screenshots, or the frontend.

### 2. Back up Supabase

Export the legacy `users` and `tickets` tables before running any SQL.

### 3. Create V2 tables and import legacy data

In Supabase SQL Editor, run:

1. `database/001_v2_schema_and_import.sql`
2. `database/002_verify_import.sql`

Do not deploy until all verification checks are `PASS`. If the ticket count is
lower, inspect legacy duplicates before proceeding. The old `users` and
`tickets` tables remain unchanged.

### 4. Deploy the backend as a new Render Web Service

Create a new service, not an edit of the old backend.

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/health/live` |

Add the environment variables listed in `backend/.env.example`. Use
`SUPABASE_SERVICE_ROLE_KEY`, not the public anon key. Set:

- `PUBLIC_BACKEND_URL` to the new backend URL.
- `FRONTEND_URL` to the new static-site URL.
- `ADMIN_TELEGRAM_ID` to the authorized administrator.
- `TELEGRAM_WEBHOOK_SECRET` to a new random value of at least 32 characters
  containing only letters, numbers, `_`, or `-`. It is not the bot token.

The first successful startup log must contain:

```text
"event":"server.started"
"event":"telegram.webhook.ready"
```

If it contains `telegram.webhook.failed`, do not continue to production.

### 5. Deploy the frontend as a new Render Static Site

Before deploying, edit `frontend/config.js` and replace only
`https://YOUR-BACKEND.onrender.com` with the new backend URL.

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Build command | leave empty |
| Publish directory | `.` |

Then update the backend `FRONTEND_URL` to the final static-site URL and redeploy
the backend once.

### 6. Configure Telegram

In BotFather, set the menu button URL to the new frontend URL. Send `/start` to
the bot and open the Mini App from its button. V2 deliberately does not support
the insecure `?userid=` browser shortcut.

### 7. Acceptance test

Use a test Telegram account and verify in this order:

1. `/start` creates or updates the correct `users_v2` row.
2. The Mini App shows the imported balance.
3. Buying one number reduces the balance by exactly 5.00.
4. Exactly one `tickets_v2` row and one purchase ledger row are created.
5. Buying the same number again returns `TICKET_ALREADY_SOLD` without changing
   any balance.
6. A referred purchase credits exactly 0.50 to the referrer and writes a ledger
   entry.
7. `/topup ID AMOUNT` works only for `ADMIN_TELEGRAM_ID`.
8. `/draw 12345` records one weekly draw and notifies matching owners.

Only after these checks pass should the old bot menu be switched permanently.

## Local checks

```bash
npm test
node --check backend/src/server.js
```
