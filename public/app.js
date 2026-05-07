/* global io */

const socket = io();

// Elements
const connPill = document.getElementById('connPill');
const userPill = document.getElementById('userPill');

const lobbyView = document.getElementById('lobbyView');
const roomView = document.getElementById('roomView');

const nicknameInput = document.getElementById('nicknameInput');
const roomNameInput = document.getElementById('roomNameInput');
const createRoomBtn = document.getElementById('createRoomBtn');
const refreshRoomsBtn = document.getElementById('refreshRoomsBtn');
const joinRoomIdInput = document.getElementById('joinRoomIdInput');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const roomListEl = document.getElementById('roomList');

const backToLobbyBtn = document.getElementById('backToLobbyBtn');
const startHandBtn = document.getElementById('startHandBtn');
const copyRoomIdBtn = document.getElementById('copyRoomIdBtn');
const roomTitle = document.getElementById('roomTitle');
const roomSub = document.getElementById('roomSub');

const seatsEl = document.getElementById('seats');
const boardEl = document.getElementById('board');
const potLabel = document.getElementById('potLabel');
const stageLabel = document.getElementById('stageLabel');
const turnTimerEl = document.getElementById('turnTimer');
const turnTimerLabelEl = document.getElementById('turnTimerLabel');
const turnTimerBarEl = document.getElementById('turnTimerBar');
const turnTimerValueEl = document.getElementById('turnTimerValue');
const potsEl = document.getElementById('pots');
const logEl = document.getElementById('log');

const youMeta = document.getElementById('youMeta');
const youHand = document.getElementById('youHand');

const btnRow = document.getElementById('btnRow');

const toCallEl = document.getElementById('toCall');
const currentBetEl = document.getElementById('currentBet');
const youChipsEl = document.getElementById('youChips');

const betBox = document.getElementById('betBox');
const raiseToInput = document.getElementById('raiseToInput');
const raiseToRange = document.getElementById('raiseToRange');

const toastEl = document.getElementById('toast');

// State
let myNickname = localStorage.getItem('poker:nickname') || '';
let currentRoomId = '';
let currentRoomName = '';
let mySeatIndex = -1;
let lastState = null;
let turnTicker = null;
let boardDealTimers = [];
let youDealTimers = [];
let lastCommunityKey = '';
let lastYouHandKey = '';

nicknameInput.value = myNickname;

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

function setConnected(ok) {
  connPill.textContent = ok ? '已连接' : '连接中…';
  connPill.style.borderColor = ok ? 'rgba(34,197,94,.45)' : 'rgba(255,255,255,.14)';
}

function ensureNickname() {
  const v = String(nicknameInput.value || '').trim();
  if (!v) {
    showToast('请先输入昵称');
    nicknameInput.focus();
    return null;
  }
  myNickname = v.slice(0, 16);
  localStorage.setItem('poker:nickname', myNickname);
  userPill.textContent = myNickname;
  return myNickname;
}

function clearDealTimers(timerStore) {
  for (const timerId of timerStore) clearTimeout(timerId);
  timerStore.length = 0;
}

function resetDealAnimationState() {
  clearDealTimers(boardDealTimers);
  clearDealTimers(youDealTimers);
  lastCommunityKey = '';
  lastYouHandKey = '';
  lastState = null;
}

function switchToLobby() {
  currentRoomId = '';
  currentRoomName = '';
  mySeatIndex = -1;
  lastState = null;
  resetDealAnimationState();
  stopTurnTicker();
  updateTurnTimerDisplay(null);

  lobbyView.style.display = '';
  roomView.style.display = 'none';

  socket.emit('lobby:join');
}

function switchToRoom() {
  lobbyView.style.display = 'none';
  roomView.style.display = '';
}

function stageText(stage) {
  const map = {
    waiting: '等待开始',
    preflop: '翻牌前',
    flop: '翻牌',
    turn: '转牌',
    river: '河牌',
    showdown: '摊牌',
    hand_over: '本手结束',
  };
  return map[stage] || stage;
}

function cardColor(suit) {
  return suit === 'H' || suit === 'D' ? 'red' : 'black';
}

function suitSymbol(s) {
  if (s === 'S') return '♠';
  if (s === 'H') return '♥';
  if (s === 'D') return '♦';
  return '♣';
}

function rankLabel(r) {
  if (r <= 10) return String(r);
  if (r === 11) return 'J';
  if (r === 12) return 'Q';
  if (r === 13) return 'K';
  return 'A';
}

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '';
  return `${value.toFixed(1)}%`;
}

function formatCountdown(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function getPlayableCount(state) {
  return (state.players || []).filter((player) => player && player.chips > 0).length;
}

function getTurnPlayer(state) {
  if (!state || state.turnIndex < 0) return null;
  return state.players && state.players[state.turnIndex] ? state.players[state.turnIndex] : null;
}

function getTurnRemainingMs(state, now = Date.now()) {
  if (!state || !state.turnDeadlineAt) return 0;
  return Math.max(0, state.turnDeadlineAt - now);
}

function getTimeoutFallbackAction(state) {
  const turnPlayer = getTurnPlayer(state);
  if (!turnPlayer) return '弃牌';
  const toCall = Math.max(0, (state.currentBet || 0) - (turnPlayer.betInRound || 0));
  return toCall === 0 ? '过牌' : '弃牌';
}

function renderCard(card) {
  const el = document.createElement('div');
  if (!card || card.hidden) {
    el.className = 'cardFace cardFace--hidden';
    el.innerHTML = `<div class="r">&nbsp;</div><div class="mid">🂠</div><div class="s">&nbsp;</div>`;
    return el;
  }

  const suit = suitSymbol(card.suit);
  const rank = rankLabel(card.rank);
  const colorCls = cardColor(card.suit);
  el.className = `cardFace ${colorCls}`;
  el.innerHTML = `<div class="r">${rank}</div><div class="mid">${suit}</div><div class="s">${suit}</div>`;
  return el;
}

function cardSignature(card) {
  if (!card) return 'empty';
  if (card.hidden) return 'hidden';
  return `${card.rank || ''}${card.suit || ''}`;
}

function cardsSignature(cards) {
  return (cards || []).map(cardSignature).join('|');
}

function getSharedCardPrefixLength(previousCards, nextCards) {
  const prev = previousCards || [];
  const next = nextCards || [];
  const limit = Math.min(prev.length, next.length);
  let index = 0;
  while (index < limit && cardSignature(prev[index]) === cardSignature(next[index])) {
    index += 1;
  }
  return index;
}

function hasVisibleHoleCards(cards) {
  return Array.isArray(cards) && cards.length > 0 && cards.every((card) => card && !card.hidden);
}

function appendCardWithDealAnimation(container, card, index, animate, timerStore) {
  const cardEl = renderCard(card);
  if (animate) {
    cardEl.classList.add('card--deal-enter');
    timerStore.push(setTimeout(() => {
      requestAnimationFrame(() => cardEl.classList.remove('card--deal-enter'));
    }, index * 150));
  }
  container.appendChild(cardEl);
}

function renderBoard(community) {
  const cards = community || [];
  const previousCards = lastState && Array.isArray(lastState.community) ? lastState.community : [];
  const nextKey = cardsSignature(cards);
  const prefixLength = getSharedCardPrefixLength(previousCards, cards);
  const shouldAnimate = nextKey !== lastCommunityKey;

  clearDealTimers(boardDealTimers);
  boardEl.innerHTML = '';

  cards.forEach((card, index) => {
    const animate = shouldAnimate && index >= prefixLength && !card.hidden;
    appendCardWithDealAnimation(boardEl, card, index - prefixLength, animate, boardDealTimers);
  });

  for (let index = cards.length; index < 5; index++) {
    const placeholder = document.createElement('div');
    placeholder.className = 'cardFace';
    placeholder.style.opacity = '0.22';
    placeholder.innerHTML = `<div class="r">&nbsp;</div><div class="mid">+</div><div class="s">&nbsp;</div>`;
    boardEl.appendChild(placeholder);
  }

  lastCommunityKey = nextKey;
}

function seatPositions(maxPlayers) {
  const map6 = [
    { left: '10%', top: '66%' },
    { left: '10%', top: '30%' },
    { left: '38%', top: '12%' },
    { left: '62%', top: '12%' },
    { left: '90%', top: '30%' },
    { left: '90%', top: '66%' },
  ];
  const positions = [];
  for (let index = 0; index < maxPlayers; index++) {
    positions.push(map6[index] || { left: '50%', top: '50%' });
  }
  return positions;
}

function statusBadge(status) {
  if (status === 'active') return { text: '行动中', cls: '' };
  if (status === 'folded') return { text: '弃牌', cls: 'badge--folded' };
  if (status === 'allin') return { text: '全押', cls: 'badge--allin' };
  if (status === 'waiting') return { text: '等待', cls: 'badge--waiting' };
  if (status === 'out') return { text: '出局', cls: 'badge--folded' };
  return { text: status, cls: '' };
}

function renderSeats(state) {
  seatsEl.innerHTML = '';
  const maxPlayers = state.maxPlayers || 6;
  const positions = seatPositions(maxPlayers);

  for (let index = 0; index < maxPlayers; index++) {
    const player = state.players[index];

    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.style.left = positions[index].left;
    seat.style.top = positions[index].top;
    seat.style.transform = 'translate(-50%, -50%)';

    const isTurnSeat = index === state.turnIndex && state.status === 'in_hand';
    if (isTurnSeat) seat.classList.add('seat--turn');
    if (index === mySeatIndex) seat.classList.add('seat--you');

    if (!player) {
      seat.innerHTML = `
        <div class="seat__top">
          <div class="seat__name muted">空座位 #${index + 1}</div>
          <div class="seat__chips">—</div>
        </div>
        <div class="seat__badges">
          <span class="badge">可加入</span>
        </div>
      `;
      seatsEl.appendChild(seat);
      continue;
    }

    const badges = [];
    if (index === state.dealerIndex) badges.push('<span class="badge badge--dealer">庄</span>');
    if (index === state.sbIndex) badges.push('<span class="badge badge--sb">SB</span>');
    if (index === state.bbIndex) badges.push('<span class="badge badge--bb">BB</span>');

    const badge = statusBadge(player.status);
    badges.push(`<span class="badge ${badge.cls}">${badge.text}</span>`);

    const nonFoldedCount = (state.players || []).filter(p => p && (p.status === 'active' || p.status === 'allin')).length;
    const winRateLine = (nonFoldedCount === 2 && (state.community || []).length >= 3 && Number.isFinite(player.winRate))
      ? `<div class="seat__equity">实时胜率 ${formatPercent(player.winRate)}</div>`
      : '';
    const timerLine = isTurnSeat && state.turnDeadlineAt
      ? '<div class="seat__timer" data-turn-seat-timer>30.0s / 自动弃牌</div>'
      : '';

    seat.innerHTML = `
      <div class="seat__top">
        <div class="seat__name">${escapeHtml(player.nickname)}</div>
        <div class="seat__chips">筹码 ${player.chips}</div>
      </div>
      <div class="seat__bet">本轮下注：${player.betInRound || 0}</div>
      ${winRateLine}
      ${timerLine}
      <div class="seat__badges">${badges.join('')}</div>
    `;

    if (hasVisibleHoleCards(player.hole)) {
      const holeEl = document.createElement('div');
      holeEl.className = 'seat__hole';
      player.hole.forEach((card) => {
        holeEl.appendChild(renderCard(card));
      });
      seat.appendChild(holeEl);
    }

    seatsEl.appendChild(seat);
  }
}

function renderPots(state) {
  potsEl.innerHTML = '';
  const pots = state.showPots ? (state.pots || []) : [];
  if (!pots.length) {
    potsEl.style.display = 'none';
    return;
  }

  potsEl.style.display = '';
  for (const pot of pots) {
    const item = document.createElement('div');
    item.className = 'potItem';
    const eligible = pot.eligibleNicknames && pot.eligibleNicknames.length
      ? pot.eligibleNicknames.map((name) => escapeHtml(name)).join(' / ')
      : '当前无人可争夺';

    item.innerHTML = `
      <div class="potItem__top">
        <span class="potItem__label">${escapeHtml(pot.label || '彩池')}</span>
        <span class="potItem__amount">${pot.amount}</span>
      </div>
      <div class="potItem__players">参与玩家：${eligible}</div>
    `;
    potsEl.appendChild(item);
  }
}

function renderYou(state) {
  if (!state.you) {
    youMeta.textContent = '—';
    clearDealTimers(youDealTimers);
    youHand.innerHTML = '';
    lastYouHandKey = '';
    return;
  }

  const me = state.players[state.you.seatIndex];
  const hand = me && Array.isArray(me.hole) ? me.hole : [];
  const nonFoldedCount = (state.players || []).filter(p => p && (p.status === 'active' || p.status === 'allin')).length;
  const showWinRate = nonFoldedCount === 2 && (state.community || []).length >= 3;
  const winRateText = (showWinRate && Number.isFinite(state.you.winRate)) ? ` · 胜率 ${formatPercent(state.you.winRate)}` : '';
  const nextHandKey = cardsSignature(hand);
  const previousHand = lastState && lastState.players && lastState.players[state.you.seatIndex]
    ? lastState.players[state.you.seatIndex].hole || []
    : [];
  const prefixLength = getSharedCardPrefixLength(previousHand, hand);
  const shouldAnimate = hand.length > 0 && nextHandKey !== lastYouHandKey;

  youMeta.textContent = `座位 #${state.you.seatIndex + 1} · 状态 ${state.you.status} · 需跟注 ${state.you.toCall}${winRateText}`;

  clearDealTimers(youDealTimers);
  youHand.innerHTML = '';
  hand.forEach((card, index) => {
    const animate = shouldAnimate && index >= prefixLength && !card.hidden;
    appendCardWithDealAnimation(youHand, card, index - prefixLength, animate, youDealTimers);
  });

  lastYouHandKey = nextHandKey;
}

function renderLog(state) {
  const lines = (state.actionLog || []).slice(-20);
  logEl.innerHTML = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'logLine';
    const time = new Date(line.ts).toLocaleTimeString();
    div.textContent = `[${time}] ${line.text}`;
    logEl.appendChild(div);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function renderTopLabels(state) {
  potLabel.textContent = `总底池 ${state.pot || 0}`;
  stageLabel.textContent = stageText(state.stage);

  const statusText = state.status === 'in_hand' ? `进行中 · 手牌 #${state.handId}` : `等待中 · 手牌 #${state.handId}`;
  roomSub.textContent = `${statusText} · 小盲/大盲 ${state.smallBlind}/${state.bigBlind} · 房主满 2 人即可开始`;
}

function updateTurnTimerDisplay(state = lastState) {
  if (!state || state.status !== 'in_hand' || !state.turnDeadlineAt || state.turnIndex < 0) {
    turnTimerEl.style.display = 'none';
    turnTimerLabelEl.textContent = '行动倒计时';
    turnTimerBarEl.style.width = '0%';
    turnTimerValueEl.textContent = '—';
    return;
  }

  const turnPlayer = getTurnPlayer(state);
  const remainingMs = getTurnRemainingMs(state);
  const durationMs = state.turnDurationMs || 30000;
  const ratio = durationMs > 0 ? clamp(remainingMs / durationMs, 0, 1) : 0;
  const fallbackAction = getTimeoutFallbackAction(state);

  turnTimerEl.style.display = '';
  turnTimerLabelEl.textContent = turnPlayer ? `${turnPlayer.nickname} 行动倒计时` : '行动倒计时';
  turnTimerBarEl.style.width = `${ratio * 100}%`;
  turnTimerValueEl.textContent = `${formatCountdown(remainingMs)} · 超时自动${fallbackAction}`;

  const seatTimers = seatsEl.querySelectorAll('[data-turn-seat-timer]');
  seatTimers.forEach((element) => {
    element.textContent = `${formatCountdown(remainingMs)} / 自动${fallbackAction}`;
  });
}

function stopTurnTicker() {
  if (turnTicker) {
    clearInterval(turnTicker);
    turnTicker = null;
  }
}

function syncTurnTicker(state) {
  stopTurnTicker();
  updateTurnTimerDisplay(state);
  if (!state || state.status !== 'in_hand' || !state.turnDeadlineAt || state.turnIndex < 0) return;

  turnTicker = setInterval(() => {
    updateTurnTimerDisplay(lastState);
  }, 100);
}

function renderActions(state) {
  const you = state.you;
  toCallEl.textContent = you ? String(you.toCall) : '0';
  currentBetEl.textContent = String(state.currentBet || 0);
  youChipsEl.textContent = you ? String(you.chips) : '0';

  btnRow.innerHTML = '';
  betBox.style.display = 'none';

  const playableCount = getPlayableCount(state);
  const canStartHand = state.isHost && state.status !== 'in_hand' && playableCount >= 2;
  startHandBtn.disabled = !canStartHand;
  if (!state.isHost) {
    startHandBtn.textContent = '等待房主开始';
  } else if (state.status === 'in_hand') {
    startHandBtn.textContent = '牌局进行中';
  } else if (playableCount < 2) {
    startHandBtn.textContent = '至少 2 人可开局';
  } else {
    startHandBtn.textContent = '开始一手（2人即可）';
  }

  if (!you || !you.canAct) {
    const note = document.createElement('div');
    note.className = 'muted';
    if (state.status === 'in_hand') {
      const turnPlayer = getTurnPlayer(state);
      if (turnPlayer) {
        note.textContent = `等待 ${turnPlayer.nickname} 行动…`;
      } else {
        // turnIndex === -1: all-in showdown，自动逐步发牌中
        const nonFolded = (state.players || []).filter(p => p && (p.status === 'active' || p.status === 'allin'));
        const allAllin = nonFolded.length >= 2 && nonFolded.every(p => p.status === 'allin');
        note.textContent = allAllin ? '🃏 All-in 摊牌中，自动发牌…' : '等待其他玩家行动…';
      }
    } else if (state.isHost && playableCount < 2) {
      note.textContent = '至少 2 名有筹码玩家即可开始。';
    } else {
      note.textContent = '等待房主开始…（满 2 人即可）';
    }
    btnRow.appendChild(note);
    return;
  }

  for (const action of (state.actions || [])) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    if (action.type === 'fold') btn.style.borderColor = 'rgba(239,68,68,.45)';
    if (action.type === 'allin') btn.style.borderColor = 'rgba(245,158,11,.55)';
    if (action.type === 'bet' || action.type === 'raise') btn.classList.add('btn--primary');

    btn.textContent = action.label;

    btn.addEventListener('click', () => {
      if (action.type === 'bet' || action.type === 'raise') {
        const raiseTo = Number(raiseToInput.value);
        socket.emit('game:action', { type: action.type, amount: raiseTo });
      } else {
        socket.emit('game:action', { type: action.type });
      }
    });

    btnRow.appendChild(btn);
  }

  const raiseAction = (state.actions || []).find((item) => item.type === 'raise') || (state.actions || []).find((item) => item.type === 'bet');
  if (raiseAction) {
    betBox.style.display = '';

    const maxTo = (state.you.betInRound || 0) + state.you.chips;
    const minTo = raiseAction.min || 0;

    raiseToInput.min = String(minTo);
    raiseToInput.max = String(maxTo);
    raiseToInput.value = String(Math.min(Math.max(minTo, state.currentBet + state.lastRaiseSize), maxTo));

    raiseToRange.min = String(minTo);
    raiseToRange.max = String(maxTo);
    raiseToRange.value = raiseToInput.value;

    raiseToRange.oninput = () => {
      raiseToInput.value = raiseToRange.value;
    };
    raiseToInput.oninput = () => {
      const value = clamp(Number(raiseToInput.value), minTo, maxTo);
      raiseToInput.value = String(value);
      raiseToRange.value = String(value);
    };
  }
}

function renderState(state) {
  roomTitle.textContent = `${state.roomName || currentRoomName} · ${state.roomId || currentRoomId}`;

  renderTopLabels(state);
  renderBoard(state.community || []);
  renderPots(state);
  renderSeats(state);
  renderYou(state);
  renderLog(state);
  renderActions(state);
  syncTurnTicker(state);
  lastState = state;
}

function renderRoomList(rooms) {
  roomListEl.innerHTML = '';
  if (!rooms || rooms.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '暂无房间，快创建一个吧。';
    roomListEl.appendChild(empty);
    return;
  }

  for (const room of rooms) {
    const item = document.createElement('div');
    item.className = 'roomItem';
    item.innerHTML = `
      <div class="roomItem__meta">
        <div class="roomItem__name">${escapeHtml(room.name)}</div>
        <div class="roomItem__sub">房间ID ${room.id} · ${room.players}/${room.maxPlayers} · ${escapeHtml(room.status)}</div>
      </div>
      <button class="btn btn--primary">加入</button>
    `;

    item.querySelector('button').addEventListener('click', () => {
      const nickname = ensureNickname();
      if (!nickname) return;
      socket.emit('room:join', { nickname, roomId: room.id });
    });

    roomListEl.appendChild(item);
  }
}

// Events
socket.on('connect', () => {
  setConnected(true);
  socket.emit('lobby:join');
  if (myNickname) userPill.textContent = myNickname;
});

socket.on('disconnect', () => {
  setConnected(false);
});

socket.on('error:toast', ({ message }) => {
  showToast(message || '发生错误');
});

socket.on('lobby:roomList', (rooms) => {
  renderRoomList(rooms);
});

socket.on('room:joined', (info) => {
  currentRoomId = info.roomId;
  mySeatIndex = info.seatIndex;
  currentRoomName = info.roomName;
  resetDealAnimationState();
  switchToRoom();
  showToast(info.isHost ? '你是房主，满 2 人即可开始' : '已加入房间');
});

socket.on('room:state', (state) => {
  renderState(state);
});

// UI actions
createRoomBtn.addEventListener('click', () => {
  const nickname = ensureNickname();
  if (!nickname) return;

  const roomName = String(roomNameInput.value || '').trim();
  if (!roomName) {
    showToast('请输入房间名');
    roomNameInput.focus();
    return;
  }

  socket.emit('room:create', { nickname, roomName });
});

refreshRoomsBtn.addEventListener('click', () => {
  socket.emit('lobby:join');
});

joinRoomBtn.addEventListener('click', () => {
  const nickname = ensureNickname();
  if (!nickname) return;
  const roomId = String(joinRoomIdInput.value || '').trim();
  if (!roomId) {
    showToast('请输入房间ID');
    joinRoomIdInput.focus();
    return;
  }
  socket.emit('room:join', { nickname, roomId });
});

backToLobbyBtn.addEventListener('click', () => {
  socket.emit('room:leave');
  switchToLobby();
});

copyRoomIdBtn.addEventListener('click', () => {
  if (!currentRoomId) return;
  navigator.clipboard.writeText(currentRoomId).then(() => {
    showToast(`房间ID已复制：${currentRoomId}`);
  }).catch(() => {
    showToast(`房间ID：${currentRoomId}`);
  });
});

startHandBtn.addEventListener('click', () => {
  if (startHandBtn.disabled) return;
  socket.emit('game:start');
});

// Boot
switchToLobby();
