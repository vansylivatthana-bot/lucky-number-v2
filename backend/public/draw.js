const roomElements = {
  round: document.querySelector('#room-round'),
  status: document.querySelector('#room-status'),
  message: document.querySelector('#room-message'),
  tickets: document.querySelector('#room-tickets'),
  accounts: document.querySelector('#room-accounts'),
  commitment: document.querySelector('#commitment-state'),
  details: document.querySelector('#proof-details'),
  winnerCard: document.querySelector('#winner-card'),
  winnerSummary: document.querySelector('#winner-summary'),
  winnerList: document.querySelector('#winner-list'),
  proofLink: document.querySelector('#proof-link')
};

function statusLabel(status) {
  return ({ OPEN: 'ເປີດຂາຍ', CLOSED: 'ປິດການຂາຍ', LOCKED: 'ລັອກບັນຊີແລ້ວ', SETTLED: 'ຈັບແລະຈ່າຍລາງວັນແລ້ວ', ROLLED_OVER: 'ຍ້າຍໄປຮອບຕໍ່ໄປ' })[status] || status;
}

function shortHash(value) {
  return value ? `${value.slice(0, 12)}…${value.slice(-12)}` : '—';
}

function addProofRow(label, value) {
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = value;
  roomElements.details.append(term, detail);
}

async function loadRoom() {
  try {
    const response = await fetch('/api/draws/latest/room');
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'DRAW_ROOM_UNAVAILABLE');
    const room = data.room;
    roomElements.round.textContent = room.roundCode;
    roomElements.status.textContent = statusLabel(room.status);
    roomElements.tickets.textContent = `${room.ticketCount}/${room.minTickets}`;
    roomElements.accounts.textContent = `${room.accountCount}/${room.minAccounts}`;
    roomElements.message.textContent = room.status === 'OPEN'
      ? 'ກຳລັງຮັບບັດ. ຜົນການສຸ່ມຍັງບໍ່ຖືກກຳນົດ.'
      : room.status === 'LOCKED'
        ? 'ບັນຊີໄດ້ຖືກລັອກ. ບໍ່ສາມາດເພີ່ມ ຫຼື ແກ້ໄຂ tickets ໄດ້.'
        : 'ໜ້ານີ້ອັບເດດອັດຕະໂນມັດທຸກ 5 ວິນາທີ.';
    roomElements.details.replaceChildren();
    if (room.proof) {
      roomElements.commitment.textContent = room.status === 'SETTLED'
        ? 'Proof ການສຸ່ມຖືກເຜີຍແຜ່ແລ້ວ'
        : 'Commitment ຖືກບັນທຶກແລ້ວ — ກຳລັງລໍຖ້າຈັບລາງວັນ';
      addProofRow('Snapshot hash', shortHash(room.proof.snapshotHash));
      addProofRow('Secret commitment', shortHash(room.proof.serverSecretCommitment));
      addProofRow('Algorithm', room.proof.algorithmVersion);
    } else {
      roomElements.commitment.textContent = 'ຍັງບໍ່ໄດ້ lock ບັນຊີ tickets.';
    }
    if (room.proofUrl) await loadWinners(room.proofUrl);
  } catch (error) {
    roomElements.status.textContent = 'ບໍ່ສາມາດໂຫຼດ Draw Room ໄດ້.';
    roomElements.message.textContent = error.message;
  }
}

async function loadWinners(proofUrl) {
  const response = await fetch(proofUrl);
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'DRAW_PROOF_UNAVAILABLE');
  roomElements.winnerCard.classList.remove('hidden');
  roomElements.winnerSummary.textContent = `ມີ ${data.winners.length} ຜູ້ຊະນະ · ລາງວັນຖືກບັນທຶກແລ້ວ.`;
  roomElements.winnerList.replaceChildren();
  for (const winner of data.winners) {
    const row = document.createElement('li');
    const label = document.createElement('strong');
    const value = document.createElement('span');
    label.textContent = `${winner.tier} · ${winner.ticketNumber}`;
    value.textContent = `${Number(winner.amount).toFixed(2)} USDT`;
    row.append(label, value);
    roomElements.winnerList.append(row);
  }
  roomElements.proofLink.href = proofUrl;
}

void loadRoom();
window.setInterval(() => void loadRoom(), 5000);
