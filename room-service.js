const crypto = require("node:crypto");
const { URL } = require("node:url");

const ROOM_REJOIN_GRACE_MS = 15_000;
const ROOM_CAPACITY = 2;
const SOCKET_IO_PATH = "/api/socket-io.js/socket.io";

function getRoomServiceState() {
  if (!globalThis.__SUDOKU_ROOM_SERVICE_STATE__) {
    globalThis.__SUDOKU_ROOM_SERVICE_STATE__ = {
      rooms: new Map(),
      socketRoomIndex: new Map(),
      io: null,
    };
  }

  return globalThis.__SUDOKU_ROOM_SERVICE_STATE__;
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function sanitizeString(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function sanitizeRoomName(value) {
  return sanitizeString(value, 48);
}

function sanitizeManualRoomName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,23}$/i.test(normalized) ? normalized : "";
}

function sanitizePage(value) {
  return sanitizeString(value, 32);
}

function sanitizeMatchMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(normalized) ? normalized : "coop";
}

function sanitizeClientId(value) {
  const normalized = String(value || "").trim();
  return /^[a-z0-9-]{8,128}$/i.test(normalized) ? normalized : "";
}

function sanitizeGenericRoomId(value) {
  const normalized = String(value || "").trim();
  return /^[a-z0-9_-]{1,64}$/i.test(normalized) ? normalized : "";
}

function sanitizeForwardedProto(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "https" || normalized === "http" ? normalized : "";
}

function getAbsoluteInviteUrl(req, roomId, password) {
  const host = req.headers.host || "localhost";
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const inviteUrl = new URL(`${protocol}://${host}/index.html`);
  inviteUrl.searchParams.set("roomId", roomId);

  if (password) {
    inviteUrl.searchParams.set("password", password);
  }

  return inviteUrl.toString();
}

function generateInviteRoomName() {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const { rooms } = getRoomServiceState();

  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const candidate = `${letters[Math.floor(Math.random() * letters.length)]}${Math.floor(1 + Math.random() * 99)}`;

    if (!rooms.has(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to create a unique room name right now.");
}

function getRoomPlayerCount(room) {
  return [...room.players.values()].filter((player) => !player.pendingDisconnect).length;
}

function assignRoomSeats(room) {
  const activePlayers = [...room.players.values()]
    .filter((player) => !player.pendingDisconnect)
    .sort((left, right) => {
      if (left.joinedAt !== right.joinedAt) {
        return left.joinedAt - right.joinedAt;
      }

      return left.socketId.localeCompare(right.socketId);
    });

  room.seats = { A: null, B: null };

  activePlayers.forEach((player, index) => {
    const operator = index === 0 ? "A" : index === 1 ? "B" : null;
    player.operator = operator;

    if (operator) {
      room.seats[operator] = {
        clientId: player.clientId,
        joinedAt: player.joinedAt,
        lastSeenAt: player.lastSeenAt,
        page: player.page,
        displayName: player.displayName,
      };
    }
  });

  return activePlayers;
}

function buildRoomSnapshot(room) {
  const activePlayers = assignRoomSeats(room);

  return {
    room: {
      roomId: room.roomId,
      roomCode: room.roomId,
      roomName: room.roomName,
      kind: room.kind,
      source: room.source,
      visibility: room.visibility,
      matchMode: room.matchMode,
      maxPlayers: room.maxPlayers,
      hasPassword: Boolean(room.passwordHash),
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      inviteUrl: room.inviteUrl,
      channelId: room.channelId || "",
    },
    revision: room.revision,
    sharedState: room.sharedState,
    seats: room.seats,
    roster: activePlayers.map((player) => ({
      clientId: player.clientId,
      joinedAt: player.joinedAt,
      lastSeenAt: player.lastSeenAt,
      page: player.page,
      displayName: player.displayName,
      operator: player.operator,
    })),
    playerCount: activePlayers.filter((player) => player.operator).length,
  };
}

function emitRoomSnapshot(room, eventName = "room:snapshot") {
  const { io } = getRoomServiceState();

  room.updatedAt = Date.now();

  if (io) {
    io.to(room.roomId).emit(eventName, buildRoomSnapshot(room));
  }
}

function createRoom(options) {
  const { rooms } = getRoomServiceState();
  const room = {
    roomId: options.roomId,
    roomName: sanitizeRoomName(options.roomName || ""),
    kind: options.kind || "manual",
    source: options.source || "web",
    visibility: options.visibility || "private",
    matchMode: sanitizeMatchMode(options.matchMode),
    channelId: options.channelId || "",
    passwordHash: options.passwordHash || "",
    inviteUrl: options.inviteUrl || "",
    maxPlayers: Number(options.maxPlayers) > 0 ? Number(options.maxPlayers) : ROOM_CAPACITY,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 0,
    sharedState: null,
    seats: { A: null, B: null },
    players: new Map(),
  };

  rooms.set(room.roomId, room);
  return room;
}

function getOrCreateDiscordRoom(req, channelId) {
  const { rooms } = getRoomServiceState();
  const roomId = sanitizeGenericRoomId(channelId);

  if (!roomId) {
    throw new Error("Discord channel ID is required for auto-join.");
  }

  if (rooms.has(roomId)) {
    return rooms.get(roomId);
  }

  return createRoom({
    roomId,
    roomName: "",
    kind: "discord-auto",
    source: "discord",
    visibility: "discord-channel",
    matchMode: "coop",
    channelId: roomId,
    inviteUrl: getAbsoluteInviteUrl(req, roomId, ""),
  });
}

function createManualRoom(req, options) {
  const { rooms } = getRoomServiceState();
  const requestedRoomName = sanitizeManualRoomName(options.roomName || "");
  const shouldAutoGenerateRoomName = options.autoRoomName === true;
  const roomId = requestedRoomName || (shouldAutoGenerateRoomName ? generateInviteRoomName() : "");
  const password = sanitizeString(options.password || "", 32);

  if (!requestedRoomName && !shouldAutoGenerateRoomName) {
    throw new Error("Room name is required. Use letters and numbers, like 7, a7, or b12.");
  }

  if (options.roomName && !requestedRoomName) {
    throw new Error("Room name is invalid. Use letters and numbers, like 7, a7, or b12.");
  }

  if (rooms.has(roomId)) {
    throw new Error("Room name already exists. Try a single digit or a letter+digit name like 7, a7, or b12.");
  }

  return createRoom({
    roomId,
    roomName: roomId,
    kind: "manual",
    source: options.source || "web",
    visibility: "private",
    matchMode: options.matchMode || "coop",
    passwordHash: password ? hashPassword(password) : "",
    inviteUrl: getAbsoluteInviteUrl(req, roomId, password),
  });
}

function createQuickMatchRoom(req, options = {}) {
  const room = createManualRoom(req, {
    roomName: "",
    password: "",
    source: "web",
    matchMode: options.matchMode || "coop",
    autoRoomName: true,
  });

  room.kind = "quick-match";
  room.visibility = "public";
  return room;
}

function findWebAutoMatchRoom(matchMode = "coop") {
  const { rooms } = getRoomServiceState();
  let candidate = null;
  const normalizedMatchMode = sanitizeMatchMode(matchMode);

  rooms.forEach((room) => {
    if (candidate) {
      return;
    }

    if (room.visibility !== "public" || room.passwordHash) {
      return;
    }

    if (room.matchMode !== normalizedMatchMode) {
      return;
    }

    if (getRoomPlayerCount(room) >= ROOM_CAPACITY) {
      return;
    }

    candidate = room;
  });

  return candidate;
}

function requireManualRoom(roomId) {
  const { rooms } = getRoomServiceState();
  const sanitizedRoomId = sanitizeManualRoomName(roomId);

  if (!sanitizedRoomId) {
    throw new Error("Room name is required. Use letters and numbers, like 7, a7, or b12.");
  }

  const room = rooms.get(sanitizedRoomId);

  if (!room) {
    throw new Error("Room not found.");
  }

  return room;
}

function validateRoomPassword(room, password) {
  const normalizedPassword = sanitizeString(password || "", 32);

  if (room.passwordHash && room.passwordHash !== hashPassword(normalizedPassword)) {
    throw new Error("Wrong room password.");
  }
}

function destroyRoom(roomId) {
  const { rooms, io } = getRoomServiceState();
  const room = rooms.get(roomId);

  if (!room) {
    return;
  }

  if (io) {
    io.to(roomId).emit("room:destroyed", { roomId });
  }

  rooms.delete(roomId);
}

function scheduleRoomCleanup(roomId) {
  const { rooms } = getRoomServiceState();
  const room = rooms.get(roomId);

  if (!room || getRoomPlayerCount(room) > 0) {
    return;
  }

  destroyRoom(roomId);
}

function getSocketPlayer(room, socket) {
  return room.players.get(socket.id) || null;
}

function assertRoomCapacity(room, socket) {
  const existingPlayer = getSocketPlayer(room, socket);

  if (existingPlayer) {
    return;
  }

  const activePlayers = [...room.players.values()].filter((player) => !player.pendingDisconnect);

  if (activePlayers.length >= room.maxPlayers) {
    throw new Error("Room is full.");
  }
}

function removeSocketFromRoom(socket) {
  const { rooms, socketRoomIndex } = getRoomServiceState();
  const currentRoomId = socketRoomIndex.get(socket.id);

  if (!currentRoomId) {
    return;
  }

  const room = rooms.get(currentRoomId);
  socketRoomIndex.delete(socket.id);
  socket.leave(currentRoomId);

  if (!room) {
    return;
  }

  const player = getSocketPlayer(room, socket);

  if (player) {
    room.players.delete(socket.id);
  }

  assignRoomSeats(room);

  if (getRoomPlayerCount(room) === 0) {
    scheduleRoomCleanup(currentRoomId);
    return;
  }

  emitRoomSnapshot(room);
}

function upsertPlayerInRoom(room, socket, payload = {}) {
  const { socketRoomIndex } = getRoomServiceState();
  const existing = getSocketPlayer(room, socket);
  const now = Date.now();
  const player = existing || {
    socketId: socket.id,
    clientId: sanitizeClientId(payload.clientId) || socket.data.clientId || socket.id,
    joinedAt: Number(payload.joinedAt) > 0 ? Number(payload.joinedAt) : now,
    lastSeenAt: now,
    page: sanitizePage(payload.page || ""),
    displayName: sanitizeString(payload.displayName || "", 48),
    operator: null,
    pendingDisconnect: false,
  };

  player.lastSeenAt = now;
  player.page = sanitizePage(payload.page || player.page || "");
  player.displayName = sanitizeString(payload.displayName || player.displayName || "", 48);
  player.pendingDisconnect = false;

  room.players.set(socket.id, player);
  socketRoomIndex.set(socket.id, room.roomId);
  socket.join(room.roomId);
  return player;
}

function joinRoom(socket, room, payload = {}) {
  const { socketRoomIndex } = getRoomServiceState();
  const currentRoomId = socketRoomIndex.get(socket.id);
  const clientId = sanitizeClientId(payload.clientId) || socket.data.clientId || "";

  if (currentRoomId && currentRoomId !== room.roomId) {
    removeSocketFromRoom(socket);
  }

  if (clientId) {
    room.players.forEach((player, socketId) => {
      if (socketId !== socket.id && player.clientId === clientId) {
        room.players.delete(socketId);
        socketRoomIndex.delete(socketId);
      }
    });
  }

  assertRoomCapacity(room, socket);
  upsertPlayerInRoom(room, socket, payload);
  emitRoomSnapshot(room);
  return buildRoomSnapshot(room);
}

function attachRoomSocketHandlers(io) {
  const serviceState = getRoomServiceState();
  serviceState.io = io;

  if (io.__sudokuRoomHandlersAttached) {
    return;
  }

  io.__sudokuRoomHandlersAttached = true;

  io.on("connection", (socket) => {
    socket.data.clientId = "";

    function getInviteRequestHeaders(payload = {}) {
      return {
        host: payload.host || socket.handshake.headers.host || "localhost",
        "x-forwarded-proto": sanitizeForwardedProto(payload.forwardedProto) || socket.handshake.headers["x-forwarded-proto"] || "http",
      };
    }

    socket.on("room:create", (payload = {}, callback = () => {}) => {
      try {
        const clientId = sanitizeClientId(payload.clientId);

        if (!clientId) {
          throw new Error("A valid clientId is required.");
        }

        socket.data.clientId = clientId;
        const reqLike = { headers: getInviteRequestHeaders(payload) };
        const room = createManualRoom(reqLike, {
          roomName: payload.roomName || "",
          autoRoomName: payload.autoRoomName === true,
          password: payload.password || "",
          source: payload.source === "discord" ? "discord" : "web",
          matchMode: payload.matchMode || "coop",
        });
        const snapshot = joinRoom(socket, room, payload);
        callback({ ok: true, snapshot });
      } catch (error) {
        callback({ ok: false, error: error.message || "Failed to create room." });
      }
    });

    socket.on("room:auto_join", (payload = {}, callback = () => {}) => {
      try {
        const clientId = sanitizeClientId(payload.clientId);

        if (!clientId) {
          throw new Error("A valid clientId is required.");
        }

        socket.data.clientId = clientId;
        const reqLike = { headers: getInviteRequestHeaders(payload) };
        let room;

        if (payload.runtimeKind === "discord") {
          room = getOrCreateDiscordRoom(reqLike, payload.channelId);
        } else {
          room = findWebAutoMatchRoom(payload.matchMode || "coop");

          if (!room) {
            room = createQuickMatchRoom(reqLike, {
              matchMode: payload.matchMode || "coop",
            });
          }
        }

        const snapshot = joinRoom(socket, room, payload);
        callback({ ok: true, snapshot });
      } catch (error) {
        callback({ ok: false, error: error.message || "Auto join failed." });
      }
    });

    socket.on("room:join", (payload = {}, callback = () => {}) => {
      try {
        const clientId = sanitizeClientId(payload.clientId);

        if (!clientId) {
          throw new Error("A valid clientId is required.");
        }

        socket.data.clientId = clientId;
        const room = requireManualRoom(payload.roomId || payload.roomCode);
        validateRoomPassword(room, payload.password);
        const snapshot = joinRoom(socket, room, payload);
        callback({ ok: true, snapshot });
      } catch (error) {
        callback({ ok: false, error: error.message || "Join room failed." });
      }
    });

    socket.on("room:resume", (payload = {}, callback = () => {}) => {
      try {
        const { rooms } = getRoomServiceState();
        const clientId = sanitizeClientId(payload.clientId);

        if (!clientId) {
          throw new Error("A valid clientId is required.");
        }

        socket.data.clientId = clientId;
        const roomId = sanitizeGenericRoomId(payload.roomId || payload.roomCode);

        if (!roomId || !rooms.has(roomId)) {
          throw new Error("Room not found.");
        }

        const room = rooms.get(roomId);
        validateRoomPassword(room, payload.password);
        const snapshot = joinRoom(socket, room, payload);
        callback({ ok: true, snapshot });
      } catch (error) {
        callback({ ok: false, error: error.message || "Resume room failed." });
      }
    });

    socket.on("room:ping", (payload = {}, callback = () => {}) => {
      try {
        const { rooms, socketRoomIndex } = getRoomServiceState();
        const roomId = socketRoomIndex.get(socket.id);

        if (!roomId || !rooms.has(roomId)) {
          throw new Error("Room not found.");
        }

        const room = rooms.get(roomId);
        upsertPlayerInRoom(room, socket, payload);
        const snapshot = buildRoomSnapshot(room);
        callback({ ok: true, snapshot });
      } catch (error) {
        callback({ ok: false, error: error.message || "Ping failed." });
      }
    });

    socket.on("room:state_sync", (payload = {}, callback = () => {}) => {
      try {
        const { rooms, socketRoomIndex } = getRoomServiceState();
        const roomId = socketRoomIndex.get(socket.id);

        if (!roomId || !rooms.has(roomId)) {
          throw new Error("Room not found.");
        }

        const room = rooms.get(roomId);
        upsertPlayerInRoom(room, socket, payload);
        const baseRevision = Number(payload.baseRevision);

        if (Number.isFinite(baseRevision) && baseRevision < room.revision) {
          callback({
            ok: false,
            error: "Revision mismatch.",
            snapshot: buildRoomSnapshot(room),
          });
          return;
        }

        room.sharedState = payload.sharedState || room.sharedState;
        room.revision += 1;
        emitRoomSnapshot(room);
        callback({ ok: true, snapshot: buildRoomSnapshot(room) });
      } catch (error) {
        callback({ ok: false, error: error.message || "State sync failed." });
      }
    });

    socket.on("room:leave", (_payload = {}, callback = () => {}) => {
      try {
        removeSocketFromRoom(socket);
        callback({ ok: true });
      } catch (error) {
        callback({ ok: false, error: error.message || "Leave room failed." });
      }
    });

    socket.on("disconnect", () => {
      const { rooms, socketRoomIndex } = getRoomServiceState();
      const roomId = socketRoomIndex.get(socket.id);

      if (!roomId || !rooms.has(roomId)) {
        socketRoomIndex.delete(socket.id);
        return;
      }

      const room = rooms.get(roomId);
      const player = getSocketPlayer(room, socket);

      if (!player) {
        socketRoomIndex.delete(socket.id);
        return;
      }

      player.pendingDisconnect = true;

      setTimeout(() => {
        const { rooms: latestRooms } = getRoomServiceState();
        const activeRoom = latestRooms.get(roomId);
        const activePlayer = activeRoom?.players.get(socket.id);

        if (!activeRoom || !activePlayer || !activePlayer.pendingDisconnect) {
          return;
        }

        removeSocketFromRoom(socket);
      }, ROOM_REJOIN_GRACE_MS);
    });
  });
}

function getRoomServiceHealth() {
  const { rooms, io } = getRoomServiceState();

  return {
    ok: true,
    rooms: rooms.size,
    sockets: io?.engine?.clientsCount || 0,
  };
}

module.exports = {
  SOCKET_IO_PATH,
  attachRoomSocketHandlers,
  getRoomServiceHealth,
};
