# Production cutover checklist

- [ ] Legacy `users` and `tickets` exported
- [ ] Previously exposed Telegram token revoked
- [ ] Supabase service-role key rotated
- [ ] Migration 001 completed without error
- [ ] Migration verification checks pass
- [ ] New backend `/health/live` returns HTTP 200
- [ ] New backend `/health/ready` returns HTTP 200
- [ ] Log says `telegram.webhook.ready`
- [ ] Frontend opens only inside Telegram
- [ ] Imported user balance matches legacy balance
- [ ] Test purchase is atomic and ledger-backed
- [ ] Duplicate purchase leaves balance unchanged
- [ ] Referral commission verified
- [ ] Admin top-up access verified
- [ ] Draw command verified
- [ ] Old deployment retained for rollback until acceptance is complete

