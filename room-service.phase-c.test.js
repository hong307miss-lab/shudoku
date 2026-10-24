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
const { createAuthoritativeRoundState, resolveAuthoritativeSelection } = require("./room-round-engine");

function createSelection(overrides = {}) {
  return {
    ...resolveAuthoritativeSelection({
      difficulty: "easy",
      puzzleIndex: 0,
    }),
    ...overrides,
  };
}

function getAuthoritativeSolution(selection, matchMode = "coop") {
  return createAuthoritativeRoundState({
    matchMode,
    selection,
    createdAt: 1_730_000_000_000,
  }).solution;
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

async function createStartedCoopRoom(t, options = {}) {
  const harness = await createTestHarness(t);
  const clientA = harness.makeClient();
  const clientB = harness.makeClient();

  await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

  const createSnapshot = await emitAck(clientA, "room:create", {
    clientId: options.clientIdA || "phase-c-aaa",
    joinedAt: options.joinedAtA || 1001,
    page: "index",
    displayName: "Player A",
    autoRoomName: true,
    matchMode: "coop",
    host: harness.baseUrl.replace(/^https?:\/\//, ""),
    forwardedProto: "http",
  });

  const selection = createSelection(options.selection);
  const roomId = createSnapshot.room.roomId;

  await emitAck(clientB, "room:join", {
    clientId: options.clientIdB || "phase-c-bbb",
    joinedAt: options.joinedAtB || 1002,
    page: "player-b",
    displayName: "Player B",
    roomId,
  });

  await emitAck(clientA, "room:set_ready", {
    clientId: options.clientIdA || "phase-c-aaa",
    joinedAt: options.joinedAtA || 1001,
    page: "index",
    selection,
  });

  await emitAck(clientB, "room:set_ready", {
    clientId: options.clientIdB || "phase-c-bbb",
    joinedAt: options.joinedAtB || 1002,
    page: "player-b",
    selection,
  });

  const startSnapshot = await emitAck(clientA, "room:start_round", {
    clientId: options.clientIdA || "phase-c-aaa",
    joinedAt: options.joinedAtA || 1001,
    page: "index",
    selection,
  });

  return {
    harness,
    clientA,
    clientB,
    roomId,
    selection,
    startSnapshot,
  };
}

function getEditableIndexes(snapshot, count = 2) {
  return snapshot.roundState.cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => !cell.given)
    .slice(0, count)
    .map(({ index }) => index);
}

test("Phase C emits coop_heart for same correct digit by different players within the contest window", async (t) => {
  const originalNow = Date.now;
  let mockedNow = 1_730_000_000_100;
  Date.now = () => mockedNow;
  t.after(() => {
    Date.now = originalNow;
  });

  const { clientA, clientB, startSnapshot } = await createStartedCoopRoom(t);
  const [index] = getEditableIndexes(startSnapshot, 1);
  const digit = getAuthoritativeSolution(createSelection(), "coop")[index];

  await emitAck(clientA, "room:cell_submit", {
    clientId: "phase-c-aaa",
    joinedAt: 1001,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 1,
    requestId: "req-phase-c-heart-a",
    clientSeq: 1,
    cellIndex: index,
    digit,
    action: "set",
  });

  mockedNow = 1_730_000_000_250;
  const second = await emitAck(clientB, "room:cell_submit", {
    clientId: "phase-c-bbb",
    joinedAt: 1002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 2,
    requestId: "req-phase-c-heart-b",
    clientSeq: 1,
    cellIndex: index,
    digit,
    action: "set",
  });

  assert.equal(second.roundState.recentEffects.length, 1);
  assert.equal(second.roundState.recentEffects[0].kind, "coop_heart");
  assert.ok(second.roundState.recentEffects[0].effectId);
  assert.equal(second.roundState.recentEffects[0].startedAt, mockedNow);
  assert.equal(second.roundState.recentEffects[0].expiresAt, mockedNow + 900);
});

test("Phase C emits coop_clash for different digits and keeps a confirmed correct value intact", async (t) => {
  const originalNow = Date.now;
  let mockedNow = 1_730_000_000_400;
  Date.now = () => mockedNow;
  t.after(() => {
    Date.now = originalNow;
  });

  const { clientA, clientB, startSnapshot } = await createStartedCoopRoom(t, {
    clientIdA: "phase-c-ccc",
    clientIdB: "phase-c-ddd",
    joinedAtA: 2001,
    joinedAtB: 2002,
  });
  const [index] = getEditableIndexes(startSnapshot, 1);
  const correctDigit = getAuthoritativeSolution(createSelection(), "coop")[index];
  const wrongDigit = correctDigit === "9" ? "1" : "9";

  await emitAck(clientA, "room:cell_submit", {
    clientId: "phase-c-ccc",
    joinedAt: 2001,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 1,
    requestId: "req-phase-c-clash-a",
    clientSeq: 1,
    cellIndex: index,
    digit: correctDigit,
    action: "set",
  });

  mockedNow = 1_730_000_000_550;
  const second = await emitAck(clientB, "room:cell_submit", {
    clientId: "phase-c-ddd",
    joinedAt: 2002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 2,
    requestId: "req-phase-c-clash-b",
    clientSeq: 1,
    cellIndex: index,
    digit: wrongDigit,
    action: "set",
  });

  assert.equal(second.roundState.recentEffects.length, 1);
  assert.equal(second.roundState.recentEffects[0].kind, "coop_clash");
  assert.equal(second.roundState.cells[index].value, correctDigit);
});

test("Phase C distinguishes different players from same-player repeats and ignores note, clear, duplicate, and late submissions", async (t) => {
  const originalNow = Date.now;
  let mockedNow = 1_730_000_001_000;
  Date.now = () => mockedNow;
  t.after(() => {
    Date.now = originalNow;
  });

  const { clientA, clientB, startSnapshot } = await createStartedCoopRoom(t, {
    clientIdA: "phase-c-eee",
    clientIdB: "phase-c-fff",
    joinedAtA: 3001,
    joinedAtB: 3002,
  });
  const [indexA, indexB] = getEditableIndexes(startSnapshot, 2);
  const solution = getAuthoritativeSolution(createSelection(), "coop");

  const first = await emitAck(clientA, "room:cell_submit", {
    clientId: "phase-c-eee",
    joinedAt: 3001,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 1,
    requestId: "req-phase-c-none-a1",
    clientSeq: 1,
    cellIndex: indexA,
    digit: solution[indexA],
    action: "set",
  });

  mockedNow = 1_730_000_001_080;
  const samePlayer = await emitAck(clientA, "room:cell_submit", {
    clientId: "phase-c-eee",
    joinedAt: 3001,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: first.roundState.revision,
    requestId: "req-phase-c-none-a2",
    clientSeq: 2,
    cellIndex: indexA,
    digit: solution[indexA],
    action: "set",
  });

  mockedNow = 1_730_000_001_120;
  const note = await emitAck(clientB, "room:cell_submit", {
    clientId: "phase-c-fff",
    joinedAt: 3002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: samePlayer.roundState.revision,
    requestId: "req-phase-c-note",
    clientSeq: 1,
    cellIndex: indexB,
    digit: solution[indexB],
    action: "note_toggle",
  });

  mockedNow = 1_730_000_001_180;
  const clear = await emitAck(clientB, "room:cell_submit", {
    clientId: "phase-c-fff",
    joinedAt: 3002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: note.roundState.revision,
    requestId: "req-phase-c-clear",
    clientSeq: 2,
    cellIndex: indexB,
    action: "clear",
  });

  mockedNow = 1_730_000_001_700;
  const late = await emitAck(clientB, "room:cell_submit", {
    clientId: "phase-c-fff",
    joinedAt: 3002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: clear.roundState.revision,
    requestId: "req-phase-c-late",
    clientSeq: 3,
    cellIndex: indexA,
    digit: solution[indexA],
    action: "set",
  });

  const duplicate = await emitRawAck(clientB, "room:cell_submit", {
    clientId: "phase-c-fff",
    joinedAt: 3002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: late.roundState.revision,
    requestId: "req-phase-c-late",
    clientSeq: 3,
    cellIndex: indexA,
    digit: solution[indexA],
    action: "set",
  });

  assert.equal(first.roundState.recentEffects.length, 0);
  assert.equal(samePlayer.roundState.recentEffects.length, 0);
  assert.equal(note.roundState.recentEffects.length, 0);
  assert.equal(clear.roundState.recentEffects.length, 0);
  assert.equal(late.roundState.recentEffects.length, 0);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.snapshot.roundState.recentEffects.length, 0);
});

test("Phase C preserves unexpired effects on reconnect and omits expired effects from later resumes", async (t) => {
  const originalNow = Date.now;
  let mockedNow = 1_730_000_002_000;
  Date.now = () => mockedNow;
  t.after(() => {
    Date.now = originalNow;
  });

  const { harness, clientA, clientB, roomId, startSnapshot } = await createStartedCoopRoom(t, {
    clientIdA: "phase-c-ggg",
    clientIdB: "phase-c-hhh",
    joinedAtA: 4001,
    joinedAtB: 4002,
  });
  const [index] = getEditableIndexes(startSnapshot, 1);
  const digit = getAuthoritativeSolution(createSelection(), "coop")[index];

  await emitAck(clientA, "room:cell_submit", {
    clientId: "phase-c-ggg",
    joinedAt: 4001,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 1,
    requestId: "req-phase-c-resume-a",
    clientSeq: 1,
    cellIndex: index,
    digit,
    action: "set",
  });

  mockedNow = 1_730_000_002_120;
  await emitAck(clientB, "room:cell_submit", {
    clientId: "phase-c-hhh",
    joinedAt: 4002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 2,
    requestId: "req-phase-c-resume-b",
    clientSeq: 1,
    cellIndex: index,
    digit,
    action: "set",
  });

  clientB.disconnect();

  const resumedClient = harness.makeClient();
  await waitForConnect(resumedClient);

  mockedNow = 1_730_000_002_300;
  const resumedHot = await emitAck(resumedClient, "room:resume", {
    clientId: "phase-c-hhh",
    joinedAt: 4002,
    roomId,
    page: "player-b",
  });

  assert.equal(resumedHot.roundState.recentEffects.length, 1);
  assert.equal(resumedHot.roundState.recentEffects[0].kind, "coop_heart");

  mockedNow = 1_730_000_003_200;
  const resumedCold = await emitAck(resumedClient, "room:resume", {
    clientId: "phase-c-hhh",
    joinedAt: 4002,
    roomId,
    page: "player-b",
  });

  assert.equal(resumedCold.roundState.recentEffects.length, 0);
});
