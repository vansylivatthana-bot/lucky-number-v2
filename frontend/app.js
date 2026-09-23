const tg = window.Telegram?.WebApp;
const apiBaseUrl = window.LUCKY_CONFIG?.API_BASE_URL?.replace(/\/$/, '');
const state = { loading: false };

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
  el('tickets').innerHTML = data.tickets.length
    ? data.tickets.map(({ ticket_number }) => `<span class="ticket">${escapeHtml(ticket_number)}</span>`).join('')
    : '<span>ຍັງບໍ່ມີຕົວເລກ</span>';
}

async function purchase() {
  if (state.loading) return;
  const ticketNumber = el('ticketNumber').value.trim();
  if (!/^\d{5}$/.test(ticketNumber)) return setMessage('ກະລຸນາປ້ອນໝາຍເລກ 5 ຫຼັກ.');
  if (!confirm(`ຢືນຢັນຊື້ໝາຍເລກ ${ticketNumber} ລາຄາ 5 USDT?`)) return;

  state.loading = true;
  el('buyButton').disabled = true;
  setMessage('ກຳລັງດຳເນີນການ…', true);
  try {
    const data = await api('/api/tickets/purchase', { method: 'POST', body: JSON.stringify({ ticketNumber }) });
    setMessage(`ຊື້ ${data.purchase.ticketNumber} ສຳເລັດ!`, true);
    tg?.HapticFeedback?.notificationOccurred('success');
    await load();
  } catch (error) {
    const messages = {
      INSUFFICIENT_BALANCE: 'ຍອດເງິນບໍ່ພຽງພໍ.',
      TICKET_ALREADY_SOLD: 'ຕົວເລກນີ້ຖືກຊື້ແລ້ວ.',
      SALES_CLOSED: 'ປິດຮັບຊື້ສຳລັບອາທິດນີ້ແລ້ວ.'
    };
    setMessage(messages[error.message] || `ຊື້ບໍ່ສຳເລັດ: ${error.message}`);
    tg?.HapticFeedback?.notificationOccurred('error');
  } finally {
    state.loading = false;
    el('buyButton').disabled = false;
  }
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

el('ticketNumber').addEventListener('input', (event) => {
  event.target.value = event.target.value.replace(/\D/g, '').slice(0, 5);
});
el('buyButton').addEventListener('click', purchase);
void load();

