let telegram = null;
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
  confirmBuy: document.querySelector('#confirm-buy'),
  adminPanel: document.querySelector('#admin-panel'),
  adminUsers: document.querySelector('#admin-users'),
  adminTickets: document.querySelector('#admin-tickets'),
  adminSales: document.querySelector('#admin-sales'),
  adminRound: document.querySelector('#admin-round'),
  verifyLedger: document.querySelector('#verify-ledger'),
  verificationStatus: document.querySelector('#verification-status'),
  verificationDetail: document.querySelector('#verification-detail'),
  checkDrawReadiness: document.querySelector('#check-draw-readiness'),
  drawReadinessStatus: document.querySelector('#draw-readiness-status'),
  drawReadinessDetail: document.querySelector('#draw-readiness-detail'),
  adminCredit: document.querySelector('#admin-credit'),
  adminMessage: document.querySelector('#admin-message'),
  creditDialog: document.querySelector('#credit-dialog'),
  confirmCredit: document.querySelector('#confirm-credit')
};

let profile;
let purchasing = false;
let crediting = false;
let verifyingLedger = false;
let checkingDrawReadiness = false;

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

function setAdminMessage(text, isError = false) {
  elements.adminMessage.textContent = text;
  elements.adminMessage.classList.toggle('error', isError);
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
  elements.adminPanel.classList.toggle('hidden', !data.isAdmin);
  elements.adminCredit.disabled = crediting;
  elements.verifyLedger.disabled = verifyingLedger;
  elements.checkDrawReadiness.disabled = checkingDrawReadiness;

  const canBuy = round?.status === 'OPEN' && Number(data.user.balance) >= Number(round.ticketPrice);
  elements.buy.disabled = !canBuy || purchasing;
  elements.buy.textContent = canBuy ? `ຮັບເລກສຸ່ມ — ${formatMoney(round.ticketPrice)}` : 'ຍັງຊື້ບໍ່ໄດ້';
}

async function creditTestWallet() {
  if (crediting) return;
  crediting = true;
  elements.adminCredit.disabled = true;
  elements.confirmCredit.disabled = true;
  setAdminMessage('ກຳລັງເພີ່ມຍອດທົດສອບ…');
  try {
    const result = await api('/api/admin/test-credit', {
      method: 'POST',
      headers: { 'Idempotency-Key': makeIdempotencyKey() }
    });
    setAdminMessage(`ເພີ່ມສຳເລັດ ${formatMoney(result.credit.amount)}. ຍອດໃໝ່: ${formatMoney(result.credit.balance)}.`);
    telegram.HapticFeedback?.notificationOccurred('success');
    await load();
  } catch (error) {
    setAdminMessage(explainError(error.message), true);
    telegram.HapticFeedback?.notificationOccurred('error');
  } finally {
    crediting = false;
    elements.confirmCredit.disabled = false;
    if (profile) render(profile);
  }
}

async function loadAdminOverview() {
  try {
    const data = await api('/api/admin/overview');
    elements.adminUsers.textContent = String(data.usersCount);
    elements.adminTickets.textContent = String(data.round?.ticketCount || 0);
    elements.adminSales.textContent = formatMoney(data.round?.grossSales || 0);
    elements.adminRound.textContent = data.round
      ? `${data.round.code} · ${statusText(data.round.status)}`
      : 'ບໍ່ມີງວດສຳລັບຄວບຄຸມ.';
  } catch {
    elements.adminRound.textContent = 'ບໍ່ສາມາດໂຫຼດພາບລວມ admin ໄດ້.';
  }
}

function renderLedgerVerification(verification) {
  const passed = Boolean(verification?.passed);
  elements.verificationStatus.textContent = passed
    ? 'ບັນຊີການຊື້ສົມດຸນ — PASS'
    : 'ບັນຊີການຊື້ຍັງບໍ່ຜ່ານ — ກວດສອບ';
  elements.verificationStatus.classList.toggle('error', !passed);
  elements.verificationDetail.textContent = verification?.roundCode
    ? `${verification.roundCode}: ${verification.balancedTicketTransactions}/${verification.ticketTransactions} transaction ສົມດຸນ · ${verification.ticketCount} tickets · ${formatMoney(verification.grossSales)} · wallet ຂອງທ່ານ ${verification.walletEntryCount} ລາຍການ.`
    : 'ບໍ່ມີງວດສຳລັບກວດບັນຊີ.';
}

async function verifyLedger() {
  if (verifyingLedger) return;
  verifyingLedger = true;
  elements.verifyLedger.disabled = true;
  elements.verificationStatus.textContent = 'ກຳລັງກວດບັນຊີ…';
  elements.verificationStatus.classList.remove('error');
  try {
    const data = await api('/api/admin/ledger-verification');
    renderLedgerVerification(data.verification);
    telegram.HapticFeedback?.notificationOccurred(data.verification.passed ? 'success' : 'warning');
  } catch (error) {
    elements.verificationStatus.textContent = explainError(error.message);
    elements.verificationStatus.classList.add('error');
  } finally {
    verifyingLedger = false;
    if (profile) render(profile);
  }
}

function renderDrawReadiness(readiness) {
  if (!readiness?.roundCode) {
    elements.drawReadinessStatus.textContent = 'ບໍ່ມີງວດສຳລັບກວດ.';
    elements.drawReadinessStatus.classList.add('error');
    elements.drawReadinessDetail.textContent = '';
    return;
  }

  const eligible = Boolean(readiness.eligible);
  elements.drawReadinessStatus.textContent = eligible
    ? 'ພ້ອມສຳລັບລັອກຮອບ ແລະ ຈັບລາງວັນ'
    : 'ຍັງບໍ່ຄົບເກນ — ຖ້າປິດຈະ rollover';
  elements.drawReadinessStatus.classList.toggle('error', !eligible);
  elements.drawReadinessDetail.textContent = `${readiness.roundCode}: ${readiness.ticketCount}/${readiness.minTickets} tickets · ${readiness.accountCount}/${readiness.minAccounts} ບັນຊີ · ສະຖານະ ${statusText(readiness.status)}.`;
}

async function checkDrawReadiness() {
  if (checkingDrawReadiness) return;
  checkingDrawReadiness = true;
  elements.checkDrawReadiness.disabled = true;
  elements.drawReadinessStatus.textContent = 'ກຳລັງກວດເງື່ອນໄຂຈັບລາງວັນ…';
  elements.drawReadinessStatus.classList.remove('error');
  try {
    const data = await api('/api/admin/draw-readiness');
    renderDrawReadiness(data.readiness);
    telegram.HapticFeedback?.notificationOccurred(data.readiness.eligible ? 'success' : 'warning');
  } catch (error) {
    elements.drawReadinessStatus.textContent = explainError(error.message);
    elements.drawReadinessStatus.classList.add('error');
  } finally {
    checkingDrawReadiness = false;
    if (profile) render(profile);
  }
}

function explainError(errorCode) {
  const messages = {
    INSUFFICIENT_BALANCE: 'ຍອດເງິນບໍ່ພຽງພໍ.',
    SALES_CLOSED: 'ງວດນີ້ປິດການຂາຍແລ້ວ.',
    TELEGRAM_INIT_DATA_EXPIRED: 'ເຊດຊັນໝົດອາຍຸ. ກະລຸນາປິດແລ້ວເປີດແອັບຈາກ Telegram ອີກຄັ້ງ.',
    TELEGRAM_INIT_DATA_MISSING: 'ຕ້ອງເປີດແອັບຜ່ານ Telegram.',
    PURCHASE_FAILED: 'ຊື້ບໍ່ສຳເລັດຊົ່ວຄາວ. ກະລຸນາລອງໃໝ່.',
    LEDGER_VERIFICATION_UNAVAILABLE: 'ກວດບັນຊີບໍ່ສຳເລັດຊົ່ວຄາວ.',
    DRAW_READINESS_UNAVAILABLE: 'ກວດເງື່ອນໄຂຮອບບໍ່ສຳເລັດຊົ່ວຄາວ.'
  };
  return messages[errorCode] || 'ເກີດຂໍ້ຜິດພາດ. ກະລຸນາລອງໃໝ່.';
}

async function load() {
  try {
    setMessage('');
    const data = await api('/api/me');
    render(data);
    if (data.isAdmin) {
      await Promise.all([loadAdminOverview(), verifyLedger(), checkDrawReadiness()]);
    }
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

async function purchase() {
  if (purchasing) return;
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
    // load() renders while `purchasing` is still true. Render once more after
    // clearing it so a rejected purchase never leaves the buy button disabled.
    if (profile) render(profile);
  }
}

elements.confirmBuy.addEventListener('click', () => {
  if (elements.dialog.open) elements.dialog.close();
  purchase();
});

elements.adminCredit.addEventListener('click', () => {
  if (profile?.isAdmin) elements.creditDialog.showModal();
});

elements.confirmCredit.addEventListener('click', () => {
  if (elements.creditDialog.open) elements.creditDialog.close();
  creditTestWallet();
});

elements.verifyLedger.addEventListener('click', verifyLedger);
elements.checkDrawReadiness.addEventListener('click', checkDrawReadiness);

function boot() {
  telegram = window.Telegram?.WebApp || null;

  // Tell Telegram that the Mini App is ready before reading initData.
  telegram?.ready?.();
  telegram?.expand?.();

  // Give the Telegram client one event-loop turn to attach launch data.
  window.setTimeout(() => {
    if (!String(telegram?.initData || '').trim()) {
      elements.outside.classList.remove('hidden');
      elements.greeting.textContent = telegram
        ? 'ບໍ່ໄດ້ຮັບການຢືນຢັນຈາກ Telegram'
        : 'ບໍ່ພົບ Telegram Mini App';
      return;
    }

    elements.app.classList.remove('hidden');
    load();
  }, 100);
}

boot();
