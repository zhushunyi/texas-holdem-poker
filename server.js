const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const { PokerEngine } = require('./game/pokerEngine');

const PORT = process.env.PORT || 3000;
const TURN_DURATION_MS = 30 * 1000;
const ALL_IN_RUNOUT_DELAY_MS = 1500;
const ALL_IN_RUNOUT_INTERVAL_MS = 1500;

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
 * }
 */
const rooms = new Map();

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
}

// 全局 all-in runout 处理：用 interval 每隔 ALL_IN_RUNOUT_INTERVAL_MS 扫一次所有房间
// 对每个 runoutPending=true 的房间，发一张牌并广播
// 用 lastRunoutAt 节流：同一个房间两次 runout 之间至少间隔 ALL_IN_RUNOUT_INTERVAL_MS
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.engine || !room.engine.runoutPending) continue;
    if (room.engine.status !== 'in_hand') {
      console.log(`[runout] room ${room.id}: runoutPending=true but status=${room.engine.status}, clearing`);
      room.engine.runoutPending = false;
      continue;
    }
    // 节流：上次发牌后需等待足够时间
    if (room.lastRunoutAt && now - room.lastRunoutAt < ALL_IN_RUNOUT_INTERVAL_MS - 50) continue;

    room.lastRunoutAt = now;
    console.log(`[runout] room ${room.id}: dealing card, community=${room.engine.community.length}, stage=${room.engine.stage}`);
    try {
      const result = room.engine.runOneMoreCommunityCard();
      console.log(`[runout] room ${room.id}: done=${result.done}, community=${room.engine.community.length}, stage=${room.engine.stage}, runoutPending=${room.engine.runoutPending}`);
      broadcastRoomState(room);
      emitRoomList();
    } catch (e) {
      console.error(`[runout] room ${room.id}: ERROR`, e.message);
      room.engine.runoutPending = false;
    }
  }
}, ALL_IN_RUNOUT_INTERVAL_MS);

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
      players: snapshot.players.filter(Boolean).length,
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
        turnDeadlineAt: 0,
        turnTimerKey: '',
        lastRunoutAt: 0,
      };
      rooms.set(roomId, room);

      // 创建后直接加入
      joinRoomInternal(socket, roomId, nickname);

      emitRoomList();
    } catch (err) {
      socket.emit('error:toast', { message: err.message || '创建房间失败' });
    }
  });

  socket.on('room:join', ({ nickname, roomId }) => {
    try {
      nickname = String(nickname || '').trim().slice(0, 16);
      roomId = String(roomId || '').trim();
      if (!nickname) throw new Error('请输入昵称');
      if (!roomId) throw new Error('房间ID无效');

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
    safeLeaveRoom(socket, { disconnected: true });
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
  // runout 由全局 interval 驱动，无需在此调度

  // 给每个玩家单独发一份“可见状态”（隐藏他人手牌）
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
