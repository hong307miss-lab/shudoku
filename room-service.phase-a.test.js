const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { Server } = require("socket.io");
const { io: createClient } = require("socket.io-client");

const {
  SOCKET_IO_PATH,
  attachRoomSocketHandlers,
  resetRoomServiceState,
} = require("./room-service");
const { resolveAuthoritativeSelection } = require("./room-round-engine");

function createSelection(overrides = {}) {
  return {
    ...resolveAuthoritativeSelection({
      difficulty: "easy",
      puzzleIndex: 0,
    }),
    ...overrides,
  };
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }

    const cleanup = () => {
      socket.off("connect", handleConnect);
      socket.off("connect_error", handleError);
    };

    const handleConnect = () => {
      cleanup();
      resolve();
    };

    const handleError = (error) => {
      cleanup();
      reject(error);
    };

    socket.on("connect", handleConnect);
    socket.on("connect_error", handleError);
  });
}

function emitAck(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    socket.emit(eventName, payload, (response = {}) => {
      if (!response.ok) {
        reject(new Error(response.error || `${eventName} failed.`));
        return;
      }

      resolve(response.snapshot || response);
    });
  });
}

function emitRawAck(socket, eventName, payload) {
  return new Promise((resolve) => {
    socket.emit(eventName, payload, (response = {}) => {
      resolve(response);
    });
  });
}

async function createTestHarness(t) {
  resetRoomServiceState();

  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  const io = new Server(server, {
    path: SOCKET_IO_PATH,
    cors: {
      origin: true,
      credentials: true,
    },
    serveClient: false,
  });

  attachRoomSocketHandlers(io);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const cleanupSockets = [];

  t.after(async () => {
    await Promise.all(
      cleanupSockets.map((socket) => new Promise((resolve) => {
        if (!socket.connected) {
          resolve();
          return;
        }

        socket.once("disconnect", resolve);
        socket.disconnect();
      })),
    );

    await new Promise((resolve) => io.close(resolve));

    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }

    resetRoomServiceState();
  });

  function makeClient() {
    const socket = createClient(baseUrl, {
      path: SOCKET_IO_PATH,
      transports: ["websocket"],
      forceNew: true,
    });
    cleanupSockets.push(socket);
    return socket;
  }

  return {
    baseUrl,
    makeClient,
  };
}

test("Phase A room flow creates authoritative round state without breaking create/join/ready/start", async (t) => {
  const harness = await createTestHarness(t);
  const clientA = harness.makeClient();
  const clientB = harness.makeClient();

  await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

  const createSnapshot = await emitAck(clientA, "room:create", {
    clientId: "client-a1",
    joinedAt: 1,
    page: "index",
    displayName: "Player A",
    autoRoomName: true,
    matchMode: "versus",
    host: harness.baseUrl.replace(/^https?:\/\//, ""),
    forwardedProto: "http",
  });

  const roomId = createSnapshot.room.roomId;
  const selection = createSelection();

  await emitAck(clientB, "room:join", {
    clientId: "client-b1",
    joinedAt: 2,
    page: "player-b",
    displayName: "Player B",
    roomId,
  });

  await emitAck(clientA, "room:set_ready", {
    clientId: "client-a1",
    joinedAt: 1,
    page: "index",
    selection,
  });

  await emitAck(clientB, "room:set_ready", {
    clientId: "client-b1",
    joinedAt: 2,
    page: "player-b",
    selection,
  });

  const startSnapshot = await emitAck(clientA, "room:start_round", {
    clientId: "client-a1",
    joinedAt: 1,
    page: "index",
    selection,
  });

  assert.equal(startSnapshot.protocolVersion, 3);
  assert.equal(startSnapshot.room.matchMode, "versus");
  assert.equal(startSnapshot.lobby.startedSessionKey, selection.sessionKey);
  assert.ok(startSnapshot.roundState);
  assert.equal(startSnapshot.roundState.sessionKey, selection.sessionKey);
  assert.equal(startSnapshot.roundState.scores.A, 0);
  assert.equal(startSnapshot.roundState.scores.B, 0);
  assert.equal(startSnapshot.roundState.scoringRules.correctClaimPoints, 1);
  assert.equal(startSnapshot.roundState.scoringRules.wrongClaimPoints, -1);
  assert.equal(startSnapshot.roundState.scoringRules.contestBonusPoints, 0);
  assert.equal(startSnapshot.roundState.scoringRules.bombPenaltyPoints, 0);
});

test("Phase E starts the authoritative round as soon as both players ready the same puzzle and keeps the round id stable on duplicate ready", async (t) => {
  const harness = await createTestHarness(t);
  const clientA = harness.makeClient();
  const clientB = harness.makeClient();

  await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

  const createSnapshot = await emitAck(clientA, "room:create", {
    clientId: "client-ae1",
    joinedAt: 101,
    page: "index",
    displayName: "Player A",
    autoRoomName: true,
    matchMode: "coop",
    host: harness.baseUrl.replace(/^https?:\/\//, ""),
    forwardedProto: "http",
  });

  const roomId = createSnapshot.room.roomId;
  const selection = createSelection();

  await emitAck(clientB, "room:join", {
    clientId: "client-be1",
    joinedAt: 202,
    page: "player-b",
    displayName: "Player B",
    roomId,
  });

  const readyA = await emitAck(clientA, "room:set_ready", {
    clientId: "client-ae1",
    joinedAt: 101,
    page: "index",
    selection,
  });

  assert.equal(readyA.roundState, null);
  assert.equal(readyA.lobby.startedSessionKey, null);

  const readyB = await emitAck(clientB, "room:set_ready", {
    clientId: "client-be1",
    joinedAt: 202,
    page: "player-b",
    selection,
  });

  assert.equal(readyB.lobby.startedSessionKey, selection.sessionKey);
  assert.ok(readyB.roundState);
  assert.equal(readyB.roundState.sessionKey, selection.sessionKey);

  const duplicateReady = await emitAck(clientA, "room:set_ready", {
    clientId: "client-ae1",
    joinedAt: 101,
    page: "index",
    selection,
  });

  assert.ok(duplicateReady.roundState);
  assert.equal(duplicateReady.roundState.roundId, readyB.roundState.roundId);
  assert.equal(duplicateReady.roundState.sessionKey, selection.sessionKey);
});

test("Phase A still exposes room snapshots after start and rejects legacy state_sync writes", async (t) => {
  const harness = await createTestHarness(t);
  const clientA = harness.makeClient();
  const clientB = harness.makeClient();

  await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

  const createSnapshot = await emitAck(clientA, "room:create", {
    clientId: "client-a2",
    joinedAt: 10,
    page: "index",
    displayName: "Player A",
    autoRoomName: true,
    matchMode: "versus",
    host: harness.baseUrl.replace(/^https?:\/\//, ""),
    forwardedProto: "http",
  });

  const roomId = createSnapshot.room.roomId;
  const selection = createSelection();

  await emitAck(clientB, "room:join", {
    clientId: "client-b2",
    joinedAt: 20,
    page: "player-b",
    displayName: "Player B",
    roomId,
  });

  await emitAck(clientA, "room:set_ready", {
    clientId: "client-a2",
    joinedAt: 10,
    page: "index",
    selection,
  });

  await emitAck(clientB, "room:set_ready", {
    clientId: "client-b2",
    joinedAt: 20,
    page: "player-b",
    selection,
  });

  const startSnapshot = await emitAck(clientA, "room:start_round", {
    clientId: "client-a2",
    joinedAt: 10,
    page: "index",
    selection,
  });

  const response = await emitRawAck(clientB, "room:state_sync", {
    clientId: "client-b2",
    joinedAt: 20,
    page: "player-b",
    baseRevision: 0,
    sharedState: {
      sessions: {
        legacy: true,
      },
    },
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /protocol v2|refresh/i);
  assert.ok(response.snapshot.roundState);
  assert.equal(response.snapshot.roundState.roundId, startSnapshot.roundState.roundId);
  assert.equal(response.snapshot.roundState.revision, startSnapshot.roundState.revision);
  assert.equal(response.snapshot.roundState.scores.A, 0);
  assert.equal(response.snapshot.roundState.scores.B, 0);
});
