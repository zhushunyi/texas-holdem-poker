const { nanoid } = require('nanoid');
const { buildDeck, shuffle } = require('./cards');
const { eval7, compareHand } = require('./handEval');
const { buildSidePots, hasAllInPlayer } = require('./sidePots');
const { calculateStageEquities } = require('./winRates');

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function nextIndex(from, maxPlayers) {
  return (from + 1) % maxPlayers;
}

function isActiveSeat(p) {
  return !!p && p.status !== 'out';
}

function isInHand(p) {
  return !!p && (p.status === 'active' || p.status === 'allin' || p.status === 'folded');
}

function isEligibleToAct(p) {
  return !!p && p.status === 'active' && p.chips > 0;
}

class PokerEngine {
  constructor({ roomId, maxPlayers = 6, startingChips = 2000, smallBlind = 10, bigBlind = 20 }) {
    this.roomId = roomId;
    this.maxPlayers = maxPlayers;
    this.startingChips = startingChips;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;

    this.players = Array.from({ length: maxPlayers }, () => null);

    this.status = 'waiting'; // waiting | in_hand
    this.stage = 'waiting'; // preflop|flop|turn|river|showdown|hand_over

    this.handId = 0;

    this.dealerIndex = -1;
    this.sbIndex = -1;
    this.bbIndex = -1;

    this.deck = [];
    this.community = [];

    this.pot = 0;
    this.currentBet = 0;
    this.lastRaiseSize = bigBlind;

    this.turnIndex = -1;

    this.actionLog = [];
    this._derivedStateCache = null;
    this.revealAllHoleCards = false;
    this.runoutPending = false; // all-in runout 逐步发牌标志
    this.gameOver = false;      // 游戏是否结束（某人破产淘汰到最后只剩1人）
    this.gameWinner = null;     // 游戏胜者昵称

    this._resetBettingRound();
  }

  _pushLog(text) {
    this.actionLog.push({ ts: Date.now(), text });
    if (this.actionLog.length > 40) this.actionLog.shift();
  }

  getPlayerCount() {
    return this.players.filter(Boolean).length;
  }

  getAnySocketId() {
    const p = this.players.find(Boolean);
    return p ? p.socketId : '';
  }

  addPlayer({ socketId, nickname }) {
    const seatIndex = this.players.findIndex((p) => p === null);
    if (seatIndex === -1) throw new Error('房间已满');

    const playerId = nanoid(10);
    const player = {
      id: playerId,
      socketId,
      nickname,
      seatIndex,
      chips: this.startingChips,
      status: 'waiting', // waiting|active|folded|allin|out
      hole: [],

      betInRound: 0,
      contributed: 0,
      hasActed: false,
    };

    this.players[seatIndex] = player;
    this._pushLog(`玩家 ${nickname} 加入座位 #${seatIndex + 1}`);

    if (this.status === 'waiting') {
      player.status = 'waiting';
    }

    return { playerId, seatIndex };
  }

  removePlayer(playerId, { disconnected = false } = {}) {
    const p = this._getPlayerById(playerId);
    if (!p) return;

    const name = p.nickname;

    // 如果在牌局中，视为弃牌（筹码仍在池里）
    if (this.status === 'in_hand' && p.status !== 'out') {
      if (p.status === 'active') {
        p.status = 'folded';
        this._pushLog(`玩家 ${name} ${disconnected ? '掉线' : '离开'}，自动弃牌`);
      } else {
        this._pushLog(`玩家 ${name} ${disconnected ? '掉线' : '离开'}`);
      }

      if (this.turnIndex === p.seatIndex) {
        this._advanceTurn();
        this._afterActionAdvanceIfNeeded();
      }
    } else {
      this._pushLog(`玩家 ${name} ${disconnected ? '掉线' : '离开'}`);
    }

    this.players[p.seatIndex] = null;

    // 如果房间只剩一个玩家，结束手牌
    if (this.status === 'in_hand') {
      this._checkEarlyWin();
    }
  }

  _getPlayerById(playerId) {
    return this.players.find((p) => p && p.id === playerId) || null;
  }

  _activeSeats() {
    return this.players.filter((p) => isActiveSeat(p));
  }

  _inHandPlayers() {
    return this.players.filter((p) => isInHand(p));
  }

  _nonFoldedPlayers() {
    return this.players.filter((p) => p && (p.status === 'active' || p.status === 'allin'));
  }

  _isAllInShowdown() {
    if (this.status !== 'in_hand') return false;
    const activePlayers = this.players.filter((player) => player && (player.status === 'active' || player.status === 'allin'));
    return activePlayers.length >= 2 && activePlayers.every((player) => player.status === 'allin');
  }

  needsRunout() {
    return this.status === 'in_hand' && this.turnIndex === -1 && this._isAllInShowdown();
  }

  _resetBettingRound() {
    for (const p of this.players) {
      if (!p) continue;
      p.betInRound = 0;
      p.hasActed = false;
    }
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
  }

  _clearBetsForNextStage() {
    for (const p of this.players) {
      if (!p) continue;
      p.betInRound = 0;
    }
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
  }

  startGameIfPossible() {
    if (this.status === 'in_hand') throw new Error('牌局进行中');
    if (this.gameOver) throw new Error('游戏已结束');
    const seated = this.players.filter(Boolean);
    const canPlay = seated.filter((p) => p.chips > 0).length;
    if (canPlay < 2) throw new Error('至少需要 2 位有筹码的玩家');

    this._startNewHand();
  }

  _findNextSeat(fromIndex, predicate) {
    let idx = fromIndex;
    for (let i = 0; i < this.maxPlayers; i++) {
      idx = nextIndex(idx, this.maxPlayers);
      const p = this.players[idx];
      if (predicate(p)) return idx;
    }
    return -1;
  }

  _findPrevSeat(fromIndex, predicate) {
    let idx = fromIndex;
    for (let i = 0; i < this.maxPlayers; i++) {
      idx = (idx - 1 + this.maxPlayers) % this.maxPlayers;
      const p = this.players[idx];
      if (predicate(p)) return idx;
    }
    return -1;
  }

  _startNewHand() {
    this.status = 'in_hand';
    this.stage = 'preflop';
    this.handId += 1;

    // 初始化玩家状态
    for (const p of this.players) {
      if (!p) continue;
      if (p.chips <= 0) {
        p.status = 'out';
        p.hole = [];
      } else {
        p.status = 'active';
        p.hole = [];
      }
      p.betInRound = 0;
      p.contributed = 0;
      p.hasActed = false;
    }

    const activeCount = this.players.filter((p) => p && p.status !== 'out').length;
    if (activeCount < 2) {
      this.status = 'waiting';
      this.stage = 'waiting';
      throw new Error('可参与玩家不足');
    }

    // 洗牌
    this.deck = shuffle(buildDeck());
    this.community = [];
    this.pot = 0;
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
    this.actionLog = [];
    this.revealAllHoleCards = false;
    this.runoutPending = false;

    // 移动庄位
    const nextDealer = this._findNextSeat(this.dealerIndex, (p) => p && p.status !== 'out');
    this.dealerIndex = nextDealer;

    // 小盲 / 大盲（单挑时庄家=小盲）
    if (activeCount === 2) {
      this.sbIndex = this.dealerIndex;
      this.bbIndex = this._findNextSeat(this.dealerIndex, (p) => p && p.status !== 'out');
    } else {
      this.sbIndex = this._findNextSeat(this.dealerIndex, (p) => p && p.status !== 'out');
      this.bbIndex = this._findNextSeat(this.sbIndex, (p) => p && p.status !== 'out');
    }

    this._postBlind(this.sbIndex, this.smallBlind, '小盲');
    this._postBlind(this.bbIndex, this.bigBlind, '大盲');

    // 发手牌
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < this.maxPlayers; i++) {
        const idx = (this.dealerIndex + 1 + i) % this.maxPlayers;
        const p = this.players[idx];
        if (!p || p.status === 'out') continue;
        p.hole.push(this.deck.pop());
      }
    }

    this.currentBet = Math.max(...this.players.filter(Boolean).map((p) => p.betInRound));
    this._pushLog(`开始新手牌 #${this.handId}（小盲 ${this.smallBlind} / 大盲 ${this.bigBlind}）`);

    // 翻牌前由 UTG 行动；单挑时由庄家（小盲）先行动
    this._resetActFlagsForNewRound();
    if (activeCount === 2 && isEligibleToAct(this.players[this.sbIndex])) {
      this.turnIndex = this.sbIndex;
    } else if (activeCount === 2) {
      this.turnIndex = this._findNextSeat(this.sbIndex, (p) => isEligibleToAct(p));
    } else {
      this.turnIndex = this._findNextSeat(this.bbIndex, (p) => isEligibleToAct(p));
    }
    if (this.turnIndex === -1) {
      // 可能大家都all-in，直接发公共牌到摊牌
      this._runoutToShowdownInstant();
    }
  }

  _resetActFlagsForNewRound() {
    for (const p of this.players) {
      if (!p) continue;
      if (p.status === 'active') p.hasActed = false;
      else p.hasActed = true; // folded/allin/out 不再行动
    }
  }

  _postBlind(seatIndex, amount, label) {
    const p = this.players[seatIndex];
    if (!p || p.status === 'out') return;

    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    p.betInRound += pay;
    p.contributed += pay;
    this.pot += pay;

    if (p.chips === 0) p.status = 'allin';

    this._pushLog(`${p.nickname} 下注 ${label} ${pay}`);
  }

  _getDerivedTableState() {
    const cacheKey = JSON.stringify({
      status: this.status,
      stage: this.stage,
      community: this.community,
      players: this.players.map((player) => {
        if (!player) return null;
        return {
          id: player.id,
          seatIndex: player.seatIndex,
          nickname: player.nickname,
          status: player.status,
          contributed: player.contributed,
          hole: player.hole,
        };
      }),
    });

    if (this._derivedStateCache && this._derivedStateCache.key === cacheKey) {
      return this._derivedStateCache.value;
    }

    const pots = buildSidePots(this.players);
    const nonFoldedCount = this.players.filter(p => p && (p.status === 'active' || p.status === 'allin')).length;
    const shouldShowWinRates = this.status === 'in_hand' && this.community.length >= 3 && nonFoldedCount === 2;
    const winRateMap = shouldShowWinRates ? calculateStageEquities(this.players, this.community, pots) : {};
    const derivedState = {
      pots,
      showPots: hasAllInPlayer(this.players) && pots.length > 0,
      winRateMap,
    };

    this._derivedStateCache = {
      key: cacheKey,
      value: derivedState,
    };

    return derivedState;
  }

  getTurnMeta() {
    if (this.status !== 'in_hand' || this.turnIndex < 0) return null;

    const player = this.players[this.turnIndex];
    if (!player || player.status !== 'active') return null;

    return {
      playerId: player.id,
      seatIndex: player.seatIndex,
      nickname: player.nickname,
    };
  }

  getPublicSnapshot() {
    return {
      roomId: this.roomId,
      maxPlayers: this.maxPlayers,
      status: this.status,
      stage: this.stage,
      handId: this.handId,
    };
  }

  getPlayerView(viewerPlayerId) {
    const viewer = this._getPlayerById(viewerPlayerId);
    const derivedState = this._getDerivedTableState();
    const showAllHoleCards = this._isAllInShowdown() || (this.stage === 'hand_over' && this.revealAllHoleCards);

    const players = this.players.map((p) => {
      if (!p) return null;
      const base = {
        id: p.id,
        nickname: p.nickname,
        seatIndex: p.seatIndex,
        chips: p.chips,
        status: p.status,
        betInRound: p.betInRound,
        contributed: p.contributed,
        winRate: Number.isFinite(derivedState.winRateMap[p.id]) ? derivedState.winRateMap[p.id] : null,
      };

      if (viewer && p.id === viewer.id) {
        return {
          ...base,
          hole: clone(p.hole),
        };
      }

      if (showAllHoleCards) {
        return {
          ...base,
          hole: clone(p.hole),
        };
      }

      return {
        ...base,
        hole: p.hole && p.hole.length === 2 && this.status === 'in_hand' ? [{ hidden: true }, { hidden: true }] : [],
      };
    });

    const toCall = viewer ? Math.max(0, this.currentBet - viewer.betInRound) : 0;

    const youCanAct = viewer && this.status === 'in_hand' && this.turnIndex === viewer.seatIndex && viewer.status === 'active';

    return {
      roomId: this.roomId,
      maxPlayers: this.maxPlayers,
      status: this.status,
      stage: this.stage,
      handId: this.handId,
      dealerIndex: this.dealerIndex,
      sbIndex: this.sbIndex,
      bbIndex: this.bbIndex,
      turnIndex: this.turnIndex,

      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      pot: this.pot,
      currentBet: this.currentBet,
      lastRaiseSize: this.lastRaiseSize,

      community: clone(this.community),
      players,
      pots: derivedState.showPots ? clone(derivedState.pots) : [],
      showPots: derivedState.showPots,

      actionLog: clone(this.actionLog),

      gameOver: this.gameOver || false,
      gameWinner: this.gameWinner || null,

      you: viewer
        ? {
            id: viewer.id,
            seatIndex: viewer.seatIndex,
            chips: viewer.chips,
            status: viewer.status,
            betInRound: viewer.betInRound,
            toCall,
            canAct: youCanAct,
            winRate: Number.isFinite(derivedState.winRateMap[viewer.id]) ? derivedState.winRateMap[viewer.id] : null,
          }
        : null,

      actions: youCanAct ? this._getAllowedActions(viewer) : [],
    };
  }

  _getAllowedActions(player) {
    const toCall = Math.max(0, this.currentBet - player.betInRound);
    const actions = [];

    actions.push({ type: 'fold', label: '弃牌' });

    if (toCall === 0) {
      actions.push({ type: 'check', label: '过牌' });
      if (player.chips > 0) {
        actions.push({ type: 'bet', label: '下注', min: Math.min(player.betInRound + this.bigBlind, player.betInRound + player.chips) });
      }
    } else {
      actions.push({ type: 'call', label: `跟注 ${Math.min(toCall, player.chips)}` });
      if (player.chips > toCall) {
        const minRaiseTo = this.currentBet + this.lastRaiseSize;
        actions.push({ type: 'raise', label: '加注', min: Math.min(minRaiseTo, player.betInRound + player.chips) });
      }
    }

    if (player.chips > 0) actions.push({ type: 'allin', label: '全押' });

    return actions;
  }

  applyAction(playerId, payload) {
    if (this.status !== 'in_hand') throw new Error('当前没有进行中的牌局');

    const p = this._getPlayerById(playerId);
    if (!p) throw new Error('玩家不存在');
    if (p.seatIndex !== this.turnIndex) throw new Error('还没轮到你行动');
    if (p.status !== 'active') throw new Error('你当前不能行动');

    const type = String(payload && payload.type || '').trim();
    const rawAmount = payload && payload.amount;

    const toCall = Math.max(0, this.currentBet - p.betInRound);

    if (type === 'fold') {
      p.status = 'folded';
      p.hasActed = true;
      this._pushLog(`${p.nickname} 弃牌`);
      this._advanceTurn();
      this._afterActionAdvanceIfNeeded();
      return;
    }

    if (type === 'check') {
      if (toCall !== 0) throw new Error('当前不能过牌，需要先跟注');
      p.hasActed = true;
      this._pushLog(`${p.nickname} 过牌`);
      this._advanceTurn();
      this._afterActionAdvanceIfNeeded();
      return;
    }

    if (type === 'call') {
      const pay = Math.min(toCall, p.chips);
      this._takeChips(p, pay);
      p.hasActed = true;
      this._pushLog(`${p.nickname} 跟注 ${pay}`);
      if (p.chips === 0) p.status = 'allin';
      this._advanceTurn();
      this._afterActionAdvanceIfNeeded();
      return;
    }

    if (type === 'allin') {
      const pay = p.chips;
      if (pay <= 0) throw new Error('你已经没有筹码');

      const newTotal = p.betInRound + pay;
      const isRaise = newTotal > this.currentBet;

      this._takeChips(p, pay);
      p.status = 'allin';

      if (isRaise) {
        const raiseSize = newTotal - this.currentBet;
        this.currentBet = newTotal;
        this.lastRaiseSize = Math.max(this.lastRaiseSize, raiseSize);
        this._onAggressiveAction(p);
        this._pushLog(`${p.nickname} 全押（加注到 ${newTotal}）`);
      } else {
        p.hasActed = true;
        this._pushLog(`${p.nickname} 全押（跟注 ${pay}）`);
      }

      this._advanceTurn();
      this._afterActionAdvanceIfNeeded();
      return;
    }

    if (type === 'bet') {
      if (toCall !== 0) throw new Error('当前已有下注，请使用跟注/加注');
      const amount = Number(rawAmount);
      if (!Number.isFinite(amount)) throw new Error('下注金额无效');

      const raiseTo = Math.max(amount, this.bigBlind);
      const desiredTotal = raiseTo;
      const pay = Math.min(desiredTotal - p.betInRound, p.chips);
      if (pay <= 0) throw new Error('下注金额过小');

      this._takeChips(p, pay);

      const newTotal = p.betInRound;
      if (newTotal > this.currentBet) {
        const raiseSize = newTotal - this.currentBet;
        this.currentBet = newTotal;
        this.lastRaiseSize = Math.max(this.bigBlind, raiseSize);
        this._onAggressiveAction(p);
      }

      if (p.chips === 0) p.status = 'allin';
      this._pushLog(`${p.nickname} 下注到 ${p.betInRound}${p.status === 'allin' ? '（全押）' : ''}`);

      this._advanceTurn();
      this._afterActionAdvanceIfNeeded();
      return;
    }

    if (type === 'raise') {
      if (toCall === 0) throw new Error('当前没有下注，请使用下注');
      const amount = Number(rawAmount);
      if (!Number.isFinite(amount)) throw new Error('加注金额无效');

      const minRaiseTo = this.currentBet + this.lastRaiseSize;
      let desiredRaiseTo = Math.max(amount, minRaiseTo);

      // 如果不足以达到最小加注，允许全押
      const maxTo = p.betInRound + p.chips;
      if (desiredRaiseTo > maxTo) desiredRaiseTo = maxTo;

      const pay = desiredRaiseTo - p.betInRound;
      if (pay <= 0) throw new Error('加注金额过小');

      this._takeChips(p, pay);
      const newTotal = p.betInRound;

      if (newTotal > this.currentBet) {
        const raiseSize = newTotal - this.currentBet;
        this.currentBet = newTotal;
        this.lastRaiseSize = Math.max(this.lastRaiseSize, raiseSize);
        this._onAggressiveAction(p);
      } else {
        // 实际上没超过当前下注（只能是all-in不足），视为跟注
        p.hasActed = true;
      }

      if (p.chips === 0) p.status = 'allin';
      this._pushLog(`${p.nickname} 加注到 ${p.betInRound}${p.status === 'allin' ? '（全押）' : ''}`);

      this._advanceTurn();
      this._afterActionAdvanceIfNeeded();
      return;
    }

    throw new Error('未知操作');
  }

  applyTimeoutAction() {
    if (this.status !== 'in_hand' || this.turnIndex < 0) return null;

    const player = this.players[this.turnIndex];
    if (!player || player.status !== 'active') return null;

    const toCall = Math.max(0, this.currentBet - player.betInRound);
    if (toCall === 0) {
      player.hasActed = true;
      this._pushLog(`${player.nickname} 超时，自动过牌`);
    } else {
      player.status = 'folded';
      player.hasActed = true;
      this._pushLog(`${player.nickname} 超时，自动弃牌`);
    }

    this._advanceTurn();
    this._afterActionAdvanceIfNeeded();

    return {
      playerId: player.id,
      type: toCall === 0 ? 'check' : 'fold',
    };
  }

  _takeChips(player, amount) {
    const pay = Math.min(amount, player.chips);
    player.chips -= pay;
    player.betInRound += pay;
    player.contributed += pay;
    this.pot += pay;
  }

  _onAggressiveAction(actor) {
    // 有人下注/加注后，其他仍可行动的玩家需要重新行动
    for (const p of this.players) {
      if (!p) continue;
      if (p.id === actor.id) {
        p.hasActed = true;
        continue;
      }
      if (p.status === 'active') p.hasActed = false;
      else p.hasActed = true;
    }
  }

  _advanceTurn() {
    const next = this._findNextSeat(this.turnIndex, (p) => isEligibleToAct(p));
    this.turnIndex = next;
  }

  _checkEarlyWin() {
    const alive = this._nonFoldedPlayers();
    if (alive.length === 1) {
      const winner = alive[0];
      winner.chips += this.pot;
      this._pushLog(`所有人弃牌，${winner.nickname} 获胜，获得底池 ${this.pot}`);
      this._endHand();
      return true;
    }
    return false;
  }

  _isBettingRoundComplete() {
    const actors = this.players.filter((p) => p && p.status === 'active');
    if (actors.length === 0) return true;

    if (this.currentBet === 0) {
      return actors.every((p) => p.hasActed);
    }

    return actors.every((p) => p.hasActed && p.betInRound === this.currentBet);
  }

  _afterActionAdvanceIfNeeded() {
    const allInShowdown = this._isAllInShowdown();
    if (allInShowdown) {
      this.revealAllHoleCards = true;
    }

    if (this._checkEarlyWin()) return { allInRunout: false };

    if (this._isBettingRoundComplete()) {
      if (allInShowdown) {
        // 标记待 runout，由服务端 interval 逐步发牌
        this.turnIndex = -1;
        this.runoutPending = true;
        return { allInRunout: true };
      }
      this._advanceStage();
      return { allInRunout: false };
    }

    if (this.turnIndex === -1) {
      this._runoutToShowdownInstant();
    }

    return { allInRunout: false };
  }

  _advanceStage() {
    const { done } = this._dealNextCommunityCards();
    if (done) return;

    // 新一轮行动：从庄家左手边开始
    this._resetActFlagsForNewRound();
    this.turnIndex = this._findNextSeat(this.dealerIndex, (p) => isEligibleToAct(p));

    // 若无人可行动（全押），直接补全到摊牌
    if (this.turnIndex === -1) {
      this._runoutToShowdownInstant();
    }
  }

  _dealNextCommunityCards({ automatic = false } = {}) {
    this._clearBetsForNextStage();

    if (this.community.length < 3) {
      this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.stage = 'flop';
      this._pushLog(automatic ? '翻牌（自动发牌）' : '翻牌');
      return { stage: this.stage, done: false };
    }

    if (this.community.length === 3) {
      this.community.push(this.deck.pop());
      this.stage = 'turn';
      this._pushLog(automatic ? '转牌（自动发牌）' : '转牌');
      return { stage: this.stage, done: false };
    }

    if (this.community.length === 4) {
      this.community.push(this.deck.pop());
      this.stage = 'river';
      this._pushLog(automatic ? '河牌（自动发牌）' : '河牌');
      return { stage: this.stage, done: false };
    }

    this.stage = 'showdown';
    this._doShowdown();
    return { stage: this.stage, done: true };
  }

  runOneMoreCommunityCard() {
    const result = this._dealNextCommunityCards();
    if (result.done) {
      this.runoutPending = false;
    } else {
      this.runoutPending = true; // 还有牌要发，保持标志
    }
    return result;
  }

  _runoutToShowdownInstant() {
    while (this.status === 'in_hand' && this.community.length < 5) {
      this._dealNextCommunityCards({ automatic: true });
    }

    if (this.status === 'in_hand') {
      this.stage = 'showdown';
      this._doShowdown();
    }
  }

  _buildSidePots() {
    return buildSidePots(this.players);
  }

  _doShowdown() {
    const contenders = this.players.filter((p) => p && (p.status === 'active' || p.status === 'allin'));
    if (contenders.length === 0) {
      // 理论上不会发生
      this._pushLog('摊牌：无人可争夺底池');
      this._endHand();
      return;
    }

    // 评估每个玩家最优牌型
    const handMap = new Map();
    for (const p of contenders) {
      const cards7 = [...p.hole, ...this.community];
      const best = eval7(cards7);
      handMap.set(p.id, best);
    }

    const sidePots = this._buildSidePots();
    const payouts = new Map();

    for (const pot of sidePots) {
      const eligiblePlayers = pot.eligible.map((pid) => this._getPlayerById(pid)).filter(Boolean);
      if (eligiblePlayers.length === 0) continue;

      let bestHand = null;
      let winners = [];
      for (const p of eligiblePlayers) {
        const h = handMap.get(p.id);
        if (!bestHand || compareHand(h, bestHand) > 0) {
          bestHand = h;
          winners = [p];
        } else if (compareHand(h, bestHand) === 0) {
          winners.push(p);
        }
      }

      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;

      // 余数按座位顺序分配（从庄家左手边开始更公平，这里简化为座位从小到大）
      winners.sort((a, b) => a.seatIndex - b.seatIndex);

      for (const w of winners) {
        const add = share + (remainder > 0 ? 1 : 0);
        remainder -= remainder > 0 ? 1 : 0;
        payouts.set(w.id, (payouts.get(w.id) || 0) + add);
      }

      const names = winners.map((w) => w.nickname).join(' / ');
      this._pushLog(`摊牌：${names} 以【${bestHand.name}】分得彩池 ${pot.amount}`);
    }

    // 发放
    for (const [pid, amt] of payouts.entries()) {
      const p = this._getPlayerById(pid);
      if (!p) continue;
      p.chips += amt;
    }

    this._endHand();
  }

  _endHand() {
    this.stage = 'hand_over';
    this.status = 'waiting';

    for (const p of this.players) {
      if (!p) continue;
      if (!this.revealAllHoleCards) p.hole = [];
      p.betInRound = 0;
      p.contributed = 0;
      p.hasActed = false;
      if (p.chips <= 0) p.status = 'out';
      else p.status = 'waiting';
    }

    if (!this.revealAllHoleCards) this.community = [];
    this.deck = [];
    this.pot = 0;
    this.currentBet = 0;
    this.turnIndex = -1;

    this._pushLog('本手结束，即将自动开始下一手…');
  }
}

module.exports = {
  PokerEngine,
};
