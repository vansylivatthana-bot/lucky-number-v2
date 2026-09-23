const tg = window.Telegram?.WebApp;
const apiBaseUrl = window.LUCKY_CONFIG?.API_BASE_URL?.replace(/\/$/, '');
const state = { loading: false, purchaseIdempotencyKey: null, roundOpen: false };

const el = (id) => document.getElementById(id);
const money = (value) => `${Number(value || 0).toFixed(2)} USDT`;

function setMessage(text, success = false) {
  el('message').textContent = text;
  el('message').style.color = success ? '#16803c' : '#b42318';
}

function authHeaders() {
  return { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg?.initData || '' };
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP_${response.status}`);
  return body;
}

async function load() {
  if (!apiBaseUrl || apiBaseUrl.includes('YOUR-BACKEND')) {
    return setMessage('ຍັງບໍ່ໄດ້ຕັ້ງຄ່າ API_BASE_URL');
  }
  if (!tg?.initData) {
    return setMessage('ກະລຸນາເປີດແອັບນີ້ຈາກປຸ່ມໃນ Telegram Bot.');
  }

  tg.ready();
  tg.expand();
  try {
    const data = await api('/api/me');
    render(data);
  } catch (error) {
    setMessage(error.message === 'TELEGRAM_INIT_DATA_EXPIRED' ? 'Session ໝົດອາຍຸ—ປິດແລ້ວເປີດແອັບຄືນໃໝ່.' : `ດຶງຂໍ້ມູນບໍ່ສຳເລັດ: ${error.message}`);
  }
}

function render(data) {
  el('welcome').textContent = `ສະບາຍດີ, ${data.user.firstName || 'ລູກຄ້າ'}!`;
  el('balance').textContent = Number(data.user.balance).toFixed(2);
  el('prize1').textContent = money(data.prizes.prize1);
  el('prize2').textContent = money(data.prizes.prize2Each);
  el('prize3').textContent = money(data.prizes.prize3Each);
  el('friendsCount').textContent = data.friendsCount;
  el('roundInfo').textContent = data.round
    ? `ງວດ ${data.round.code} · ${data.round.status} · ປີ້ລະ ${money(data.round.ticketPrice)}`
    : 'ຍັງບໍ່ມີງວດທີ່ເປີດ';
  state.roundOpen = data.round?.status === 'OPEN';
  el('buyButton').disabled = state.loading || !state.roundOpen;
  el('tickets').innerHTML = data.tickets.length
    ? data.tickets.map(({ ticket_number }) => `<span class="ticket">${escapeHtml(ticket_number)}</span>`).join('')
    : '<span>ຍັງບໍ່ມີຕົວເລກ</span>';
}

async function purchase() {
  if (state.loading) return;
  if (!confirm('ຢືນຢັນຊື້ປີ້ສຸ່ມລາຄາ 5 USDT? ເຊີບເວີຈະອອກເລກໃຫ້.')) return;

  state.loading = true;
  state.purchaseIdempotencyKey ||= createIdempotencyKey();
  el('buyButton').disabled = true;
  setMessage('ກຳລັງດຳເນີນການ…', true);
  try {
    const data = await api('/api/tickets/purchase', {
      method: 'POST',
      headers: { 'Idempotency-Key': state.purchaseIdempotencyKey },
      body: JSON.stringify({})
    });
    setMessage(`ຊື້ ${data.purchase.ticketNumber} ສຳເລັດ!`, true);
    state.purchaseIdempotencyKey = null;
    tg?.HapticFeedback?.notificationOccurred('success');
    await load();
  } catch (error) {
    const messages = {
      INSUFFICIENT_BALANCE: 'ຍອດເງິນບໍ່ພຽງພໍ.',
      SALES_CLOSED: 'ປິດຮັບຊື້ສຳລັບງວດນີ້ແລ້ວ.'
    };
    if (messages[error.message]) state.purchaseIdempotencyKey = null;
    setMessage(messages[error.message] || `ຊື້ບໍ່ສຳເລັດ: ${error.message}`);
    tg?.HapticFeedback?.notificationOccurred('error');
  } finally {
    state.loading = false;
    el('buyButton').disabled = !state.roundOpen;
  }
}

function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

el('buyButton').addEventListener('click', purchase);
void load();
