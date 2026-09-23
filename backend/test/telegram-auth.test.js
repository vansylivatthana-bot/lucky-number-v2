import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateTelegramInitData } from '../src/telegram-auth.js';

function signedInitData(botToken, authDate = 2_000_000_000) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAE-test',
    user: JSON.stringify({ id: 1774450602, first_name: 'Book & Win', username: 'tester' })
  });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

test('accepts valid Telegram initData', () => {
  const token = '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI';
  const result = validateTelegramInitData(signedInitData(token), token, { nowSeconds: 2_000_000_010, maxAgeSeconds: 60 });
  assert.equal(result.telegramId, '1774450602');
  assert.equal(result.firstName, 'Book & Win');
});

test('rejects tampered Telegram initData', () => {
  const token = '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI';
  const initData = signedInitData(token).replace('1774450602', '1774450603');
  assert.throws(() => validateTelegramInitData(initData, token, { nowSeconds: 2_000_000_010 }), /TELEGRAM_SIGNATURE_INVALID/);
});

test('rejects expired Telegram initData', () => {
  const token = '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI';
  assert.throws(() => validateTelegramInitData(signedInitData(token, 100), token, { nowSeconds: 200, maxAgeSeconds: 60 }), /EXPIRED/);
});

