const crypto = require("node:crypto");
const { URL } = require("node:url");
const { verifyDiscordActivitySessionToken } = require("./discord-auth");
const {
  ROUND_PROTOCOL_VERSION,
  createAuthoritativeRoundState,
  resolveAuthoritativeSelection,
  submitAuthoritativeCell,
  toPublicRoundState,
} = require("./room-round-engine");

const ROOM_REJOIN_GRACE_MS = 15_000;
const ROOM_CAPACITY = 2;
const SOCKET_IO_PATH = "/api/socket-io.js";

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

function sanitizeReadySelection(selection) {
  if (!selection || typeof selection !== "object") {
    return null;
  }

  const puzzleIndex = Number(selection.puzzleIndex);
  const resolved = resolveAuthoritativeSelection({
    difficulty: sanitizeString(selection.difficulty || "", 16).toLowerCase(),
    puzzleId: sanitizeString(selection.puzzleId || "", 64),
    puzzleIndex,
  });

  if (!resolved) {
    return null;
  }

  return resolved;
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

function sanitizeIdentityKey(value) {
  const normalized = String(value || "").trim();
  return /^[a-z0-9:_-]{1,128}$/i.test(normalized) ? normalized : "";
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

function normalizeRoomReadyState(room) {
  if (!room.readyBy || typeof room.readyBy !== "object") {
    room.readyBy = { A: null, B: null };
  }

  room.readyBy.A = sanitizeReadySelection(room.readyBy.A);
  room.readyBy.B = sanitizeReadySelection(room.readyBy.B);
  room.startedSessionKey = typeof room.startedSessionKey === "string" && room.startedSessionKey
    ? room.startedSessionKey.slice(0, 96)
    : null;
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
        identityKey: player.identityKey,
        identitySource: player.identitySource,
        authUserId: player.authUserId,
        joinedAt: player.joinedAt,
        lastSeenAt: player.lastSeenAt,
        page: player.page,
        displayName: player.displayName,
        avatarUrl: player.avatarUrl,
      };
    }
  });

  return activePlayers;
}

function buildRoomSnapshot(room) {
  const activePlayers = assignRoomSeats(room);
  normalizeRoomReadyState(room);

  return {
    protocolVersion: ROUND_PROTOCOL_VERSION,
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
      instanceId: room.instanceId || "",
      activityKey: room.activityKey || "",
    },
    lobby: {
      readyBy: room.readyBy,
      startedSessionKey: room.startedSessionKey,
    },
    revision: room.revision,
    sharedState: room.sharedState,
    roundState: room.roundState ? toPublicRoundState(room.roundState) : null,
    seats: room.seats,
    roster: activePlayers.map((player) => ({
      clientId: player.clientId,
      identityKey: player.identityKey,
      identitySource: player.identitySource,
      authUserId: player.authUserId,
      joinedAt: player.joinedAt,
      lastSeenAt: player.lastSeenAt,
      page: player.page,
      displayName: player.displayName,
      avatarUrl: player.avatarUrl,
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
    instanceId: options.instanceId || "",
    activityKey: options.activityKey || "",
    passwordHash: options.passwordHash || "",
    inviteUrl: options.inviteUrl || "",
    maxPlayers: Number(options.maxPlayers) > 0 ? Number(options.maxPlayers) : ROOM_CAPACITY,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 0,
    sharedState: null,
    roundState: null,
    seats: { A: null, B: null },
    readyBy: { A: null, B: null },
    startedSessionKey: null,
    players: new Map(),
  };

  rooms.set(room.roomId, room);
  return room;
}

function generateDiscordActivityRoomId() {
  const { rooms } = getRoomServiceState();

  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const candidate = `d-${crypto.randomBytes(5).toString("hex")}`;

    if (!rooms.has(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to create a Discord activity room right now.");
}

function findDiscordActivityRoom(activityKey) {
  const { rooms } = getRoomServiceState();
  let candidate = null;

  rooms.forEach((room) => {
    if (candidate || room.kind !== "discord-activity") {
      return;
    }

    if (room.activityKey !== activityKey) {
      return;
    }

    candidate = room;
  });

  return candidate;
}

function getOrCreateDiscordActivityRoom(req, options = {}) {
  const activityKey = sanitizeGenericRoomId(options.activityKey || options.instanceId || options.channelId);

  if (!activityKey) {
    throw new Error("Discord activity context is missing. Join from the same Discord Activity instance.");
  }

  const existingRoom = findDiscordActivityRoom(activityKey);

  if (existingRoom) {
    return existingRoom;
  }

  const room = createRoom({
    roomId: generateDiscordActivityRoomId(),
    roomName: "",
    kind: "discord-activity",
    source: "discord",
    visibility: "discord-activity",
    matchMode: options.matchMode || "coop",
    channelId: sanitizeGenericRoomId(options.channelId),
    instanceId: sanitizeGenericRoomId(options.instanceId),
    activityKey,
    inviteUrl: "",
  });

  room.inviteUrl = getAbsoluteInviteUrl(req, room.roomId, "");
  return room;
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
    if (!room.startedSessionKey && player.operator && room.readyBy?.[player.operator]) {
      room.readyBy[player.operator] = null;
    }

    room.players.delete(socket.id);
  }

  assignRoomSeats(room);

  if (getRoomPlayerCount(room) === 0) {
    scheduleRoomCleanup(currentRoomId);
    return;
  }

  emitRoomSnapshot(room);
}

function getVerifiedPlayerIdentity(payload = {}, room = null) {
  const clientId = sanitizeClientId(payload.clientId);

  if (!clientId) {
    throw new Error("A valid clientId is required.");
  }

  const requiresDiscordIdentity = Boolean(
    payload.runtimeKind === "discord"
    || payload.source === "discord"
    || payload.authToken
    || room?.source === "discord"
    || room?.kind === "discord-activity",
  );

  if (!requiresDiscordIdentity) {
    return {
      clientId,
      identityKey: `web:${clientId}`,
      identitySource: "web",
      authUserId: "",
      displayName: sanitizeString(payload.displayName || "", 48),
      avatarUrl: "",
    };
  }

  const session = verifyDiscordActivitySessionToken(payload.authToken);

  return {
    clientId,
    identityKey: `discord:${session.userId}`,
    identitySource: "discord",
    authUserId: session.userId,
    displayName: sanitizeString(session.displayName || session.username || payload.displayName || "", 48),
    avatarUrl: sanitizeString(session.avatarUrl || "", 256),
  };
}

function upsertPlayerInRoom(room, socket, payload = {}, verifiedIdentity = null) {
  const { socketRoomIndex } = getRoomServiceState();
  const existing = getSocketPlayer(room, socket);
  const now = Date.now();
  const identity = verifiedIdentity || getVerifiedPlayerIdentity(payload, room);
  const player = existing || {
    socketId: socket.id,
    clientId: identity.clientId || socket.data.clientId || socket.id,
    identityKey: identity.identityKey,
    identitySource: identity.identitySource,
    authUserId: identity.authUserId,
    joinedAt: Number(payload.joinedAt) > 0 ? Number(payload.joinedAt) : now,
    lastSeenAt: now,
    page: sanitizePage(payload.page || ""),
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    operator: null,
    pendingDisconnect: false,
  };

  player.clientId = identity.clientId || player.clientId;
  player.identityKey = identity.identityKey || player.identityKey;
  player.identitySource = identity.identitySource || player.identitySource;
  player.authUserId = identity.authUserId || player.authUserId || "";
  player.lastSeenAt = now;
  player.page = sanitizePage(payload.page || player.page || "");
  player.displayName = sanitizeString(identity.displayName || player.displayName || "", 48);
  player.avatarUrl = sanitizeString(identity.avatarUrl || player.avatarUrl || "", 256);
  player.pendingDisconnect = false;

  room.players.set(socket.id, player);
  socketRoomIndex.set(socket.id, room.roomId);
  socket.join(room.roomId);
  return player;
}

function joinRoom(socket, room, payload = {}) {
  const { socketRoomIndex } = getRoomServiceState();
  const currentRoomId = socketRoomIndex.get(socket.id);
  const identity = getVerifiedPlayerIdentity(payload, room);
  const identityKey = sanitizeIdentityKey(identity.identityKey) || sanitizeClientId(payload.clientId) || socket.data.clientId || "";

  if (currentRoomId && currentRoomId !== room.roomId) {
    removeSocketFromRoom(socket);
  }

  if (identityKey) {
    room.players.forEach((player, socketId) => {
      if (socketId !== socket.id && player.identityKey === identityKey) {
        room.players.delete(socketId);
        socketRoomIndex.delete(socketId);
      }
    });
  }

  assertRoomCapacity(room, socket);
  socket.data.clientId = identity.clientId;
  socket.data.identityKey = identity.identityKey;
  upsertPlayerInRoom(room, socket, payload, identity);
  emitRoomSnapshot(room);
  return buildRoomSnapshot(room);
}

function getRoomPlayerByOperator(room, operator) {
  return [...room.players.values()].find((player) => !player.pendingDisconnect && player.operator === operator) || null;
}

function getActiveRoomActivityMetadata(payload = {}, room = null) {
  const activityKey = sanitizeGenericRoomId(payload.activityKey || room?.activityKey || payload.instanceId || payload.channelId);
  return {
    activityKey,
    channelId: sanitizeGenericRoomId(payload.channelId || room?.channelId),
    instanceId: sanitizeGenericRoomId(payload.instanceId || room?.instanceId),
  };
}

function setPlayerReadySelection(room, socket, selection) {
  normalizeRoomReadyState(room);
  assignRoomSeats(room);
  const player = getSocketPlayer(room, socket);

  if (!player || (player.operator !== "A" && player.operator !== "B")) {
    throw new Error("Join the room as Player A or Player B before changing ready status.");
  }

  room.readyBy[player.operator] = sanitizeReadySelection(selection);
  const matchedSelection = (
    getRoomPlayerCount(room) >= ROOM_CAPACITY
    && room.readyBy.A
    && room.readyBy.B
    && room.readyBy.A.sessionKey === room.readyBy.B.sessionKey
  ) ? room.readyBy.A : null;

  if (matchedSelection) {
    ensureAuthoritativeRoomRound(room, matchedSelection);
  } else {
    room.startedSessionKey = null;
  }

  emitRoomSnapshot(room);
  return buildRoomSnapshot(room);
}

function ensureAuthoritativeRoomRound(room, selection) {
  const normalizedSelection = sanitizeReadySelection(selection);

  if (!normalizedSelection) {
    throw new Error("Choose a valid puzzle before starting the round.");
  }

  if (
    room.roundState
    && room.roundState.status === "active"
    && room.roundState.sessionKey === normalizedSelection.sessionKey
  ) {
    room.startedSessionKey = normalizedSelection.sessionKey;
    return room.roundState;
  }

  if (room.roundState && room.roundState.status === "active") {
    throw new Error("A room round is already active.");
  }

  room.startedSessionKey = normalizedSelection.sessionKey;
  room.roundState = createAuthoritativeRoundState({
    matchMode: room.matchMode,
    selection: normalizedSelection,
  });
  return room.roundState;
}

function startRoomRound(room, socket, selection) {
  normalizeRoomReadyState(room);
  assignRoomSeats(room);
  const player = getSocketPlayer(room, socket);

  if (!player || (player.operator !== "A" && player.operator !== "B")) {
    throw new Error("Join the room as Player A or Player B before starting the round.");
  }

  const normalizedSelection = sanitizeReadySelection(selection);

  if (!normalizedSelection) {
    throw new Error("Choose a valid puzzle before starting the round.");
  }

  if (getRoomPlayerCount(room) < ROOM_CAPACITY) {
    throw new Error("Both players must join before the round can start.");
  }

  if (!room.readyBy.A || !room.readyBy.B) {
    throw new Error("Both players must press Ready before the round can start.");
  }

  if (room.readyBy.A.sessionKey !== room.readyBy.B.sessionKey) {
    throw new Error("Both players must confirm the same puzzle before the round can start.");
  }

  if (room.readyBy.A.sessionKey !== normalizedSelection.sessionKey) {
    throw new Error("Your current puzzle does not match the ready-checked room puzzle.");
  }

  ensureAuthoritativeRoomRound(room, normalizedSelection);
  emitRoomSnapshot(room);
  return buildRoomSnapshot(room);
}

function resetRoomServiceState() {
  globalThis.__SUDOKU_ROOM_SERVICE_STATE__ = {
    rooms: new Map(),
    socketRoomIndex: new Map(),
    io: null,
  };
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
    socket.data.identityKey = "";

    function getInviteRequestHeaders(payload = {}) {
      return {
        host: payload.host || socket.handshake.headers.host || "localhost",
        "x-forwarded-proto": sanitizeForwardedProto(payload.forwardedProto) || socket.handshake.headers["x-forwarded-proto"] || "http",
      };
    }

    socket.on("room:create", (payload = {}, callback = () => {}) => {
      try {
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
        const reqLike = { headers: getInviteRequestHeaders(payload) };
        let room;

        if (payload.runtimeKind === "discord") {
          const activity = getActiveRoomActivityMetadata(payload);
          room = getOrCreateDiscordActivityRoom(reqLike, {
            activityKey: activity.activityKey,
            channelId: activity.channelId,
            instanceId: activity.instanceId,
            matchMode: payload.matchMode || "coop",
          });
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

        if (room.roundState) {
          callback({
            ok: false,
            error: `This multiplayer round uses protocol v${ROUND_PROTOCOL_VERSION}. Refresh to continue.`,
            snapshot: buildRoomSnapshot(room),
          });
          return;
        }

        const baseRevision = Number(payload.baseRevision);

        if (Number.isFinite(baseRevision) && baseRevision < room.revision) {
          callback({
            ok: false,
            error: "Revision mismatch.",
            snapshot: buildRoomSnapshot(room),
          });
          return;
        }

        const nextSharedState = payload.sharedState && typeof payload.sharedState === "object"
          ? payload.sharedState
          : room.sharedState;

        if (nextSharedState && typeof nextSharedState === "object") {
          nextSharedState.gameStart = {
            readyBy: room.readyBy,
            startedSessionKey: room.startedSessionKey,
          };
        }

        room.sharedState = nextSharedState;
        room.revision += 1;
        emitRoomSnapshot(room);
        callback({ ok: true, snapshot: buildRoomSnapshot(room) });
      } catch (error) {
        callback({ ok: false, error: error.message || "State sync failed." });
      }
    });

    socket.on("room:cell_submit", (payload = {}, callback = () => {}) => {
      try {
        const { rooms, socketRoomIndex } = getRoomServiceState();
        const roomId = socketRoomIndex.get(socket.id);

        if (!roomId || !rooms.has(roomId)) {
          throw new Error("Room not found.");
        }

        const room = rooms.get(roomId);
        upsertPlayerInRoom(room, socket, payload);

        if (!room.roundState) {
          throw new Error("Round is not active.");
        }

        const player = getSocketPlayer(room, socket);

        if (!player || (player.operator !== "A" && player.operator !== "B")) {
          throw new Error("Join the room as Player A or Player B before submitting.");
        }

        const result = submitAuthoritativeCell(room.roundState, {
          player: player.operator,
          requestId: payload.requestId,
          roundId: payload.roundId,
          cellIndex: payload.cellIndex,
          digit: payload.digit,
          action: payload.action,
          clientSeq: payload.clientSeq,
          baseRoundRevision: payload.baseRoundRevision,
          observedCellVersion: payload.observedCellVersion,
          observedCellLocked: payload.observedCellLocked,
          receivedAt: Date.now(),
        });

        room.roundState = result.roundState;
        room.revision += 1;
        emitRoomSnapshot(room);
        callback({
          ok: true,
          duplicate: result.duplicate,
          snapshot: buildRoomSnapshot(room),
        });
      } catch (error) {
        const { rooms, socketRoomIndex } = getRoomServiceState();
        const roomId = socketRoomIndex.get(socket.id);
        const room = roomId && rooms.has(roomId) ? rooms.get(roomId) : null;

        callback({
          ok: false,
          error: error.message || "Cell submission failed.",
          snapshot: room ? buildRoomSnapshot(room) : undefined,
        });
      }
    });

    socket.on("room:set_ready", (payload = {}, callback = () => {}) => {
      try {
        const { rooms, socketRoomIndex } = getRoomServiceState();
        const roomId = socketRoomIndex.get(socket.id);

        if (!roomId || !rooms.has(roomId)) {
          throw new Error("Room not found.");
        }

        const room = rooms.get(roomId);
        upsertPlayerInRoom(room, socket, payload);
        const snapshot = setPlayerReadySelection(room, socket, payload.selection || null);
        callback({ ok: true, snapshot });
      } catch (error) {
        callback({ ok: false, error: error.message || "Ready update failed." });
      }
    });

    socket.on("room:start_round", (payload = {}, callback = () => {}) => {
      try {
        const { rooms, socketRoomIndex } = getRoomServiceState();
        const roomId = socketRoomIndex.get(socket.id);

        if (!roomId || !rooms.has(roomId)) {
          throw new Error("Room not found.");
        }

        const room = rooms.get(roomId);
        upsertPlayerInRoom(room, socket, payload);
        const snapshot = startRoomRound(room, socket, payload.selection);
        callback({ ok: true, snapshot });
      } catch (error) {
        callback({ ok: false, error: error.message || "Start round failed." });
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
    protocolVersion: ROUND_PROTOCOL_VERSION,
    rooms: rooms.size,
    sockets: io?.engine?.clientsCount || 0,
  };
}

module.exports = {
  SOCKET_IO_PATH,
  attachRoomSocketHandlers,
  getRoomServiceHealth,
  resetRoomServiceState,
};
