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
  drawControlStatus: document.querySelector('#draw-control-status'),
  drawControlDetail: document.querySelector('#draw-control-detail'),
  lockDraw: document.querySelector('#lock-draw'),
  settleDraw: document.querySelector('#settle-draw'),
  lockDialog: document.querySelector('#lock-dialog'),
  lockConfirmationExample: document.querySelector('#lock-confirmation-example'),
  lockConfirmation: document.querySelector('#lock-confirmation'),
  confirmLock: document.querySelector('#confirm-lock'),
  settleDialog: document.querySelector('#settle-dialog'),
  entropyReference: document.querySelector('#entropy-reference'),
  entropyValue: document.querySelector('#entropy-value'),
  settleConfirmationExample: document.querySelector('#settle-confirmation-example'),
  settleConfirmation: document.querySelector('#settle-confirmation'),
  confirmSettle: document.querySelector('#confirm-settle'),
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
let changingDraw = false;
let drawReadiness = null;

function formatMoney(value) {
  return `${Number(value || 0).toFixed(2)} USDT`;
}

function statusText(status) {
  return ({ OPEN: 'ເປີດຂາຍ', CLOSED: 'ປິດການຂາຍ', LOCKED: 'ລັອກແລ້ວ', SETTLED: 'ສຳເລັດແລ້ວ', ROLLED_OVER: 'ຍ້າຍຮອບ' })[status] || status || '—';
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
  renderDrawControls();

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

function renderDrawControls() {
  const readiness = drawReadiness;
  const roundCode = readiness?.roundCode;
  const canLock = Boolean(roundCode && readiness.eligible && readiness.status === 'CLOSED' && !changingDraw);
  const canSettle = Boolean(roundCode && readiness.status === 'LOCKED' && !changingDraw);
  elements.lockDraw.disabled = !canLock;
  elements.settleDraw.disabled = !canSettle;
  if (!roundCode) {
    elements.drawControlStatus.textContent = 'ບໍ່ມີງວດສຳລັບຄວບຄຸມ.';
    elements.drawControlDetail.textContent = '';
    return;
  }
  if (readiness.status === 'LOCKED') {
    elements.drawControlStatus.textContent = 'ບັນຊີຖືກ Lock ແລ້ວ — ພ້ອມ Settle';
    elements.drawControlDetail.textContent = 'Public Draw Room ສະແດງ commitment ແລະ snapshot hash ແລ້ວ.';
  } else if (canLock) {
    elements.drawControlStatus.textContent = 'ພ້ອມ Lock ບັນຊີ Tickets';
    elements.drawControlDetail.textContent = 'ຫຼັງ Lock ແລ້ວ ຈະເພີ່ມ/ລຶບ tickets ບໍ່ໄດ້.';
  } else {
    elements.drawControlStatus.textContent = 'ຍັງບໍ່ພ້ອມສຳລັບ Lock/Settle';
    elements.drawControlDetail.textContent = `ຕ້ອງປິດການຂາຍ ແລະ ຄົບ ${readiness.minTickets} tickets / ${readiness.minAccounts} ບັນຊີ ກ່ອນ.`;
  }
  elements.drawControlStatus.classList.toggle('error', !canLock && !canSettle && readiness.status !== 'SETTLED');
}

async function checkDrawReadiness() {
  if (checkingDrawReadiness) return;
  checkingDrawReadiness = true;
  elements.checkDrawReadiness.disabled = true;
  elements.drawReadinessStatus.textContent = 'ກຳລັງກວດເງື່ອນໄຂຈັບລາງວັນ…';
  elements.drawReadinessStatus.classList.remove('error');
  try {
    const data = await api('/api/admin/draw-readiness');
    drawReadiness = data.readiness;
    renderDrawReadiness(data.readiness);
    renderDrawControls();
    telegram.HapticFeedback?.notificationOccurred(data.readiness.eligible ? 'success' : 'warning');
  } catch (error) {
    elements.drawReadinessStatus.textContent = explainError(error.message);
    elements.drawReadinessStatus.classList.add('error');
  } finally {
    checkingDrawReadiness = false;
    if (profile) render(profile);
  }
}

async function lockDraw() {
  if (!drawReadiness?.roundCode || changingDraw) return;
  changingDraw = true;
  renderDrawControls();
  try {
    const result = await api('/api/admin/draws/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roundCode: drawReadiness.roundCode, confirmation: elements.lockConfirmation.value.trim() })
    });
    setAdminMessage(`Lock ສຳເລັດ: ${result.lock.roundCode}. ເປີດ Public Draw Room ເພື່ອເບິ່ງ commitment.`);
    telegram.HapticFeedback?.notificationOccurred('success');
    await load();
  } catch (error) {
    setAdminMessage(explainError(error.message), true);
    telegram.HapticFeedback?.notificationOccurred('error');
  } finally {
    changingDraw = false;
    renderDrawControls();
  }
}

async function settleDraw() {
  if (!drawReadiness?.roundCode || changingDraw) return;
  changingDraw = true;
  renderDrawControls();
  try {
    const result = await api('/api/admin/draws/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roundCode: drawReadiness.roundCode,
        confirmation: elements.settleConfirmation.value.trim(),
        entropyReference: elements.entropyReference.value.trim(),
        entropyValue: elements.entropyValue.value.trim()
      })
    });
    setAdminMessage(`Settle ສຳເລັດ: ${result.settlement.winnerCount} ຜູ້ຊະນະ · ກວດຜົນໃນ Public Draw Room.`);
    telegram.HapticFeedback?.notificationOccurred('success');
    await load();
  } catch (error) {
    setAdminMessage(explainError(error.message), true);
    telegram.HapticFeedback?.notificationOccurred('error');
  } finally {
    changingDraw = false;
    renderDrawControls();
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
    DRAW_READINESS_UNAVAILABLE: 'ກວດເງື່ອນໄຂຮອບບໍ່ສຳເລັດຊົ່ວຄາວ.',
    DRAW_LOCK_CONFIRMATION_INVALID: 'ຄຳຢືນຢັນ Lock ບໍ່ຖືກຕ້ອງ.',
    DRAW_SETTLE_CONFIRMATION_INVALID: 'ຄຳຢືນຢັນ Settle ບໍ່ຖືກຕ້ອງ.',
    DRAW_SECRET_KEY_NOT_CONFIGURED: 'ຍັງບໍ່ໄດ້ຕັ້ງ DRAW_SECRET_ENCRYPTION_KEY ໃນ Render.',
    ROUND_NOT_READY_TO_LOCK: 'ຮອບນີ້ຍັງບໍ່ພ້ອມ Lock.',
    ROUND_NOT_LOCKED: 'ຕ້ອງ Lock ຮອບກ່ອນ Settle.',
    PUBLIC_ENTROPY_NOT_VERIFIABLE: 'NIST reference ຫຼື value ກວດຄືນບໍ່ໄດ້.'
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
elements.lockDraw.addEventListener('click', () => {
  if (!drawReadiness?.roundCode) return;
  elements.lockConfirmation.value = '';
  elements.lockConfirmationExample.textContent = `LOCK ${drawReadiness.roundCode}`;
  elements.lockDialog.showModal();
});
elements.confirmLock.addEventListener('click', () => {
  if (elements.lockDialog.open) elements.lockDialog.close();
  lockDraw();
});
elements.settleDraw.addEventListener('click', () => {
  if (!drawReadiness?.roundCode) return;
  elements.entropyReference.value = '';
  elements.entropyValue.value = '';
  elements.settleConfirmation.value = '';
  elements.settleConfirmationExample.textContent = `SETTLE ${drawReadiness.roundCode}`;
  elements.settleDialog.showModal();
});
elements.confirmSettle.addEventListener('click', () => {
  if (elements.settleDialog.open) elements.settleDialog.close();
  settleDraw();
});

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
