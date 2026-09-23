export function normalizeTicketNumber(value) {
  const ticketNumber = String(value ?? '').trim();
  if (!/^\d{5}$/.test(ticketNumber)) throw new Error('TICKET_NUMBER_INVALID');
  return ticketNumber;
}

export function normalizePositiveAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    throw new Error('AMOUNT_INVALID');
  }
  return Math.round(amount * 100) / 100;
}

