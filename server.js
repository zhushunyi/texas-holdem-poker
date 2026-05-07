const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const { PokerEngine } = require('./game/pokerEngine');

const PORT = process.env.PORT || 3000;
const TURN_DURATION_MS = 30 * 1000;
const ALL_IN_RUNOUT_DELAY_MS = 1500;
const AUTO_NEXT_HAND_DELAY_MS = 4000; // 每手结束后自动开始下一手的延迟

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查
app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

/**
 * rooms: Map<roomId, Room>
 * Room: {
 *   id, name, createdAt,
 *   engine: PokerEngine,
 *   hostSocketId: string,
 *   actionTimer: timeout handle | null,
 *   allInRunoutTimer: timeout handle | null,
 *   turnDeadlineAt: number,
 *   turnTimerKey: string,
 *   runoutTimerKey: string,   // handId:community.length，防止重复调度
 *   nextHandTimer: timeout handle | null,  // 自动开始下一手的定时器
 * }
 */
const rooms = new Map();

/** 断线延迟清理：socketId -> timeout handle（30s 后才真正 removePlayer） */
const disconnectTimers = new Map();
const DISCONNECT_GRACE_MS = 30 * 1000;

function clearRoomTurnTimer(room) {
  if (!room) return;
  if (room.actionTimer) {
    clearTimeout(room.actionTimer);
    room.actionTimer = null;
  }
  room.turnDeadlineAt = 0;
  room.turnTimerKey = '';
}

function clearRoomAllInRunoutTimer(room) {
  if (!room) return;
  if (room.allInRunoutTimer) {
    clearTimeout(room.allInRunoutTimer);
    room.allInRunoutTimer = null;
  }
  room.runoutTimerKey = '';
}

function clearNextHandTimer(room) {
  if (!room) return;
  if (room.nextHandTimer) {
    clearTimeout(room.nextHandTimer);
    room.nextHandTimer = null;
  }
}

/**
 * 检查是否游戏结束（只剩1名有筹码玩家），若未结束则自动开始下一手。
 * 在每手 hand_over 后调用。
 */
function scheduleNextHandOrGameOver(room) {
  clearNextHandTimer(room);

  const engine = room.engine;
  const playersWithChips = engine.players.filter((p) => p && p.chips > 0);

  if (playersWithChips.length <= 1) {
    // 游戏结束
    const winner = playersWithChips[0];
    const winnerName = winner ? winner.nickname : '（无）';
    console.log(`[game] room ${room.id}: game over, winner=${winnerName}`);
    engine.gameOver = true;
    engine.gameWinner = winnerName;
    broadcastRoomState(room);
    emitRoomList();
    return;
  }

  // 还有多人，延迟后自动开始下一手
  console.log(`[game] room ${room.id}: scheduling next hand in ${AUTO_NEXT_HAND_DELAY_MS}ms`);
  room.nextHandTimer = setTimeout(() => {
    const currentRoom = rooms.get(room.id);
    if (!currentRoom) return;
    if (currentRoom.engine.status === 'in_hand') return; // 已经在进行中（理论上不会）
    if (currentRoom.engine.gameOver) return; // 游戏已结束

    try {
      currentRoom.engine.startGameIfPossible();
      console.log(`[game] room ${currentRoom.id}: auto-started next hand #${currentRoom.engine.handId}`);
      broadcastRoomState(currentRoom);
      emitRoomList();
    } catch (e) {
      console.error(`[game] room ${currentRoom.id}: auto-start failed`, e.message);
      broadcastRoomState(currentRoom);
    }
  }, AUTO_NEXT_HAND_DELAY_MS);
}

/**
 * 调度下一张 all-in 公共牌。
 * 每次用 setTimeout 而非全局 interval，避免 Railway sleep 导致 interval 冻结。
 * 用 runoutTimerKey（handId:community.length）做幂等保护，防止重复调度。
 */
function scheduleNextRunoutCard(room) {
  if (!room || !room.engine) return;
  if (!room.engine.runoutPending) return;
  if (room.engine.status !== 'in_hand') {
    room.engine.runoutPending = false;
    return;
  }

  // 幂等 key：同一手牌同一张牌位置只调度一次
  const key = `${room.engine.handId}:${room.engine.community.length}`;
  if (room.runoutTimerKey === key && room.allInRunoutTimer) return;

  clearRoomAllInRunoutTimer(room);
  room.runoutTimerKey = key;

  console.log(`[runout] room ${room.id}: scheduling next card, key=${key}`);

  room.allInRunoutTimer = setTimeout(() => {
    // 取最新房间（防止房间已关闭）
    const currentRoom = rooms.get(room.id);
    if (!currentRoom) return;
    if (!currentRoom.engine.runoutPending) return;
    if (currentRoom.engine.status !== 'in_hand') {
      currentRoom.engine.runoutPending = false;
      return;
    }
    // 确保 key 仍匹配（防止重入）
    if (currentRoom.runoutTimerKey !== key) return;

    currentRoom.allInRunoutTimer = null;

    try {
      console.log(`[runout] room ${currentRoom.id}: dealing card, community=${currentRoom.engine.community.length}, stage=${currentRoom.engine.stage}`);
      const result = currentRoom.engine.runOneMoreCommunityCard();
      console.log(`[runout] room ${currentRoom.id}: done=${result.done}, community=${currentRoom.engine.community.length}, stage=${currentRoom.engine.stage}, runoutPending=${currentRoom.engine.runoutPending}`);
      broadcastRoomState(currentRoom);
      emitRoomList();
      // broadcastRoomState 内部会再次调用 scheduleNextRunoutCard（如果仍有牌要发）
    } catch (e) {
      console.error(`[runout] room ${currentRoom.id}: ERROR`, e.message);
      console.error(`[runout] stack:`, e.stack);
      currentRoom.engine.runoutPending = false;
    }
  }, ALL_IN_RUNOUT_DELAY_MS);
}

function syncRoomTurnTimer(room) {
  if (!room || !room.engine) {
    clearRoomTurnTimer(room);
    return;
  }

  const turnMeta = room.engine.getTurnMeta();
  if (!turnMeta) {
    clearRoomTurnTimer(room);
    return;
  }

  const turnTimerKey = `${room.engine.handId}:${room.engine.stage}:${turnMeta.playerId}`;
  if (room.turnTimerKey === turnTimerKey && room.actionTimer && room.turnDeadlineAt > Date.now()) {
    return;
  }

  clearRoomTurnTimer(room);
  room.turnDeadlineAt = Date.now() + TURN_DURATION_MS;
  room.turnTimerKey = turnTimerKey;
  room.actionTimer = setTimeout(() => {
    const currentRoom = rooms.get(room.id);
    if (!currentRoom || currentRoom.turnTimerKey !== turnTimerKey) return;

    const result = currentRoom.engine.applyTimeoutAction();
    if (!result) {
      broadcastRoomState(currentRoom);
      emitRoomList();
      return;
    }

    broadcastRoomState(currentRoom);
    emitRoomList();
  }, TURN_DURATION_MS);
}

function listRooms() {
  const now = Date.now();
  return [...rooms.values()].map((r) => {
    const snapshot = r.engine.getPublicSnapshot();
    return {
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      players: r.engine.getPlayerCount(),
      maxPlayers: snapshot.maxPlayers,
      status: snapshot.status,
      handId: snapshot.handId,
      updatedAt: now,
    };
  });
}

function emitRoomList() {
  io.to('lobby').emit('lobby:roomList', listRooms());
}

function getRoomOrThrow(roomId) {
  const room = rooms.get(roomId);
  if (!room) throw new Error('房间不存在或已关闭');
  return room;
}

io.on('connection', (socket) => {
  // socket.data: { nickname, roomId, playerId }

  socket.on('lobby:join', () => {
    socket.join('lobby');
    socket.emit('lobby:roomList', listRooms());
  });

  socket.on('room:create', ({ nickname, roomName }) => {
    try {
      nickname = String(nickname || '').trim().slice(0, 16);
      roomName = String(roomName || '').trim().slice(0, 24);
      if (!nickname) throw new Error('请输入昵称');
      if (!roomName) throw new Error('请输入房间名');

      const roomId = nanoid(8);
      const engine = new PokerEngine({
        roomId,
        maxPlayers: 6,
        startingChips: 2000,
        smallBlind: 10,
        bigBlind: 20,
      });

      const room = {
        id: roomId,
        name: roomName,
        createdAt: Date.now(),
        engine,
        hostSocketId: socket.id,
        actionTimer: null,
        allInRunoutTimer: null,
        nextHandTimer: null,
        turnDeadlineAt: 0,
        turnTimerKey: '',
        runoutTimerKey: '',
      };
      rooms.set(roomId, room);

      // 创建后直接加入
      joinRoomInternal(socket, roomId, nickname);

      emitRoomList();
    } catch (err) {
      socket.emit('error:toast', { message: err.message || '创建房间失败' });
    }
  });

  socket.on('room:join', ({ nickname, roomId, playerId: storedPlayerId }) => {
    try {
      nickname = String(nickname || '').trim().slice(0, 16);
      roomId = String(roomId || '').trim();
      if (!nickname) throw new Error('请输入昵称');
      if (!roomId) throw new Error('房间ID无效');

      // 取消该 socket 之前的延迟清理（如果存在）
      const pending = disconnectTimers.get(socket.id);
      if (pending) {
        clearTimeout(pending.timer);
        disconnectTimers.delete(socket.id);
      }

      // 尝试重连：如果房间存在且玩家仍在，直接恢复会话
      const room = rooms.get(roomId);
      if (room) {
        const rejoin = room.engine.reconnectPlayer({
          socketId: socket.id,
          nickname,
          playerId: storedPlayerId || '',
        });
        if (rejoin) {
          socket.data.nickname = nickname;
          socket.data.roomId = roomId;
          socket.data.playerId = rejoin.playerId;
          socket.leave('lobby');
          socket.join(`room:${roomId}`);
          if (!room.hostSocketId || !io.sockets.sockets.get(room.hostSocketId)) {
            room.hostSocketId = socket.id;
          }
          broadcastRoomState(room);
          socket.emit('room:joined', {
            roomId,
            roomName: room.name,
            playerId: rejoin.playerId,
            seatIndex: rejoin.seatIndex,
            isHost: room.hostSocketId === socket.id,
            reconnected: true,
          });
          emitRoomList();
          return;
        }
      }

      // 正常加入（新玩家）
      joinRoomInternal(socket, roomId, nickname);
      emitRoomList();
    } catch (err) {
      socket.emit('error:toast', { message: err.message || '加入房间失败' });
    }
  });

  socket.on('room:leave', () => {
    safeLeaveRoom(socket);
    emitRoomList();
  });

  socket.on('game:start', () => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) throw new Error('你不在房间中');
      const room = getRoomOrThrow(roomId);
      if (room.hostSocketId !== socket.id) throw new Error('只有房主可以开始');

      room.engine.startGameIfPossible();
      broadcastRoomState(room);
      emitRoomList();
    } catch (err) {
      socket.emit('error:toast', { message: err.message || '开始失败' });
    }
  });

  socket.on('game:action', (payload) => {
    try {
      const roomId = socket.data.roomId;
      const playerId = socket.data.playerId;
      if (!roomId || !playerId) throw new Error('你不在房间中');

      const room = getRoomOrThrow(roomId);
      room.engine.applyAction(playerId, payload);

      if (room.engine.runoutPending) {
        console.log(`[action] room ${roomId}: runoutPending=true after action, community=${room.engine.community.length}, stage=${room.engine.stage}`);
      }

      broadcastRoomState(room);
      emitRoomList();
    } catch (err) {
      socket.emit('error:toast', { message: err.message || '操作失败' });
    }
  });

  socket.on('disconnect', () => {
    // 延迟 30s 再真正移除，留出重连窗口
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (roomId && playerId) {
      const timer = setTimeout(() => {
        disconnectTimers.delete(socket.id);
        safeLeaveRoom(socket, { disconnected: true });
        emitRoomList();
      }, DISCONNECT_GRACE_MS);
      disconnectTimers.set(socket.id, { timer, roomId, playerId, nickname: socket.data.nickname });
    }
    emitRoomList();
  });
});

function joinRoomInternal(socket, roomId, nickname) {
  const room = getRoomOrThrow(roomId);

  // 如果之前在别的房间，先离开
  safeLeaveRoom(socket);

  const { playerId, seatIndex } = room.engine.addPlayer({
    socketId: socket.id,
    nickname,
  });

  socket.data.nickname = nickname;
  socket.data.roomId = roomId;
  socket.data.playerId = playerId;

  socket.leave('lobby');
  socket.join(`room:${roomId}`);

  // 如果房主离开，新的第一个玩家当房主
  if (!room.hostSocketId) room.hostSocketId = socket.id;

  broadcastRoomState(room);
  socket.emit('room:joined', {
    roomId,
    roomName: room.name,
    playerId,
    seatIndex,
    isHost: room.hostSocketId === socket.id,
  });
}

function safeLeaveRoom(socket, opts = {}) {
  const roomId = socket.data.roomId;
  const playerId = socket.data.playerId;
  if (!roomId || !playerId) return;

  const room = rooms.get(roomId);
  if (room) {
    room.engine.removePlayer(playerId, { disconnected: !!opts.disconnected });

    // 房主转移
    if (room.hostSocketId === socket.id) {
      const nextHostSocketId = room.engine.getAnySocketId();
      room.hostSocketId = nextHostSocketId || '';
    }

    // 房间空了就关闭
    if (room.engine.getPlayerCount() === 0) {
      clearRoomTurnTimer(room);
      clearRoomAllInRunoutTimer(room);
      clearNextHandTimer(room);
      rooms.delete(roomId);
    } else {
      broadcastRoomState(room);
    }
  }

  socket.leave(`room:${roomId}`);
  socket.data.nickname = '';
  socket.data.roomId = '';
  socket.data.playerId = '';
}

function broadcastRoomState(room) {
  const roomId = room.id;
  const engine = room.engine;

  syncRoomTurnTimer(room);

  // 如果有待 runout 的牌，调度下一张（幂等，重复调用安全）
  if (engine.runoutPending && engine.status === 'in_hand') {
    scheduleNextRunoutCard(room);
  }

  // 每手结束后，自动开始下一手（或宣布游戏结束）
  if (engine.status === 'hand_over' && !engine.gameOver) {
    scheduleNextHandOrGameOver(room);
  }

  // 给每个玩家单独发一份"可见状态"（隐藏他人手牌）
  const socketsInRoom = io.sockets.adapter.rooms.get(`room:${roomId}`);
  if (!socketsInRoom) return;

  for (const socketId of socketsInRoom) {
    const s = io.sockets.sockets.get(socketId);
    if (!s) continue;
    const playerId = s.data.playerId;
    const view = engine.getPlayerView(playerId);

    s.emit('room:state', {
      roomId,
      roomName: room.name,
      isHost: room.hostSocketId === socketId,
      turnDeadlineAt: room.turnDeadlineAt,
      turnDurationMs: TURN_DURATION_MS,
      ...view,
    });
  }
}

server.listen(PORT, () => {
  console.log(`Poker server listening on http://localhost:${PORT}`);
});
