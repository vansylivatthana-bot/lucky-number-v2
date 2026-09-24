const telegram = window.Telegram?.WebApp;
const elements = {
  app: document.querySelector('#app-content'),
  outside: document.querySelector('#outside-telegram'),
  greeting: document.querySelector('#greeting'),
  balance: document.querySelector('#balance'),
  friends: document.querySelector('#friends'),
  roundCode: document.querySelector('#round-code'),
  roundStatus: document.querySelector('#round-status'),
  roundPrice: document.querySelector('#round-price'),
  tickets: document.querySelector('#tickets'),
  noTickets: document.querySelector('#no-tickets'),
  buy: document.querySelector('#buy-button'),
  message: document.querySelector('#purchase-message'),
  dialog: document.querySelector('#confirm-dialog'),
  confirmText: document.querySelector('#confirm-text'),
  confirmBuy: document.querySelector('#confirm-buy')
};

let profile;
let purchasing = false;

function formatMoney(value) {
  return `${Number(value || 0).toFixed(2)} USDT`;
}

function statusText(status) {
  return status === 'OPEN' ? 'ເປີດຂາຍ' : status || '—';
}

function makeIdempotencyKey() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (letter) => {
    const random = Math.floor(Math.random() * 16);
    return (letter === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('X-Telegram-Init-Data', telegram.initData);
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || 'REQUEST_FAILED');
  return body;
}

function setMessage(text, isError = false) {
  elements.message.textContent = text;
  elements.message.classList.toggle('error', isError);
}

function render(data) {
  profile = data;
  elements.greeting.textContent = `ສະບາຍດີ ${data.user.firstName || ''}`.trim();
  elements.balance.textContent = formatMoney(data.user.balance);
  elements.friends.textContent = String(data.friendsCount || 0);
  const round = data.round;
  elements.roundCode.textContent = round?.code || 'ບໍ່ມີງວດເປີດ';
  elements.roundStatus.textContent = statusText(round?.status);
  elements.roundPrice.textContent = round ? `ລາຄາ 1 ເລກ: ${formatMoney(round.ticketPrice)}` : '';

  elements.tickets.replaceChildren();
  for (const ticket of data.tickets || []) {
    const row = document.createElement('li');
    row.innerHTML = `<strong>${ticket.ticket_number}</strong><span>${ticket.state}</span>`;
    elements.tickets.append(row);
  }
  elements.noTickets.hidden = Boolean(data.tickets?.length);

  const canBuy = round?.status === 'OPEN' && Number(data.user.balance) >= Number(round.ticketPrice);
  elements.buy.disabled = !canBuy || purchasing;
  elements.buy.textContent = canBuy ? `ຮັບເລກສຸ່ມ — ${formatMoney(round.ticketPrice)}` : 'ຍັງຊື້ບໍ່ໄດ້';
}

function explainError(errorCode) {
  const messages = {
    INSUFFICIENT_BALANCE: 'ຍອດເງິນບໍ່ພຽງພໍ.',
    SALES_CLOSED: 'ງວດນີ້ປິດການຂາຍແລ້ວ.',
    TELEGRAM_INIT_DATA_EXPIRED: 'ເຊດຊັນໝົດອາຍຸ. ກະລຸນາປິດແລ້ວເປີດແອັບຈາກ Telegram ອີກຄັ້ງ.',
    TELEGRAM_INIT_DATA_MISSING: 'ຕ້ອງເປີດແອັບຜ່ານ Telegram.',
    PURCHASE_FAILED: 'ຊື້ບໍ່ສຳເລັດຊົ່ວຄາວ. ກະລຸນາລອງໃໝ່.'
  };
  return messages[errorCode] || 'ເກີດຂໍ້ຜິດພາດ. ກະລຸນາລອງໃໝ່.';
}

async function load() {
  try {
    setMessage('');
    render(await api('/api/me'));
  } catch (error) {
    setMessage(explainError(error.message), true);
    elements.buy.disabled = true;
  }
}

elements.buy.addEventListener('click', () => {
  if (!profile?.round) return;
  elements.confirmText.textContent = `ຈະຫັກ ${formatMoney(profile.round.ticketPrice)} ຈາກຍອດທົດສອບຂອງທ່ານ. ລະບົບຈະສຸ່ມເລກບໍ່ຊ້ຳ.`;
  elements.dialog.showModal();
});

elements.dialog.addEventListener('close', async () => {
  if (elements.dialog.returnValue !== 'confirm' || purchasing) return;
  purchasing = true;
  elements.buy.disabled = true;
  elements.confirmBuy.disabled = true;
  setMessage('ກຳລັງຢືນຢັນການຊື້…');
  try {
    const result = await api('/api/tickets/purchase', {
      method: 'POST',
      headers: { 'Idempotency-Key': makeIdempotencyKey() }
    });
    setMessage(`ສຳເລັດ! ເລກຂອງທ່ານແມ່ນ ${result.purchase.ticketNumber}.`);
    telegram.HapticFeedback?.notificationOccurred('success');
    await load();
  } catch (error) {
    setMessage(explainError(error.message), true);
    telegram.HapticFeedback?.notificationOccurred('error');
    await load();
  } finally {
    purchasing = false;
    elements.confirmBuy.disabled = false;
  }
});

if (!telegram?.initData) {
  elements.outside.classList.remove('hidden');
  elements.greeting.textContent = 'ກະລຸນາເປີດຈາກ Telegram';
} else {
  telegram.ready();
  telegram.expand();
  elements.app.classList.remove('hidden');
  load();
}
