import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePositiveAmount, normalizeTicketNumber } from '../src/validation.js';

test('keeps leading zeroes in five-digit ticket numbers', () => {
  assert.equal(normalizeTicketNumber('00123'), '00123');
});

test('rejects malformed ticket numbers', () => {
  for (const value of ['1234', '123456', '12a45', '', null]) {
    assert.throws(() => normalizeTicketNumber(value), /TICKET_NUMBER_INVALID/);
  }
});

test('normalizes a positive topup amount', () => {
  assert.equal(normalizePositiveAmount('10.129'), 10.13);
  assert.throws(() => normalizePositiveAmount(-1), /AMOUNT_INVALID/);
});

