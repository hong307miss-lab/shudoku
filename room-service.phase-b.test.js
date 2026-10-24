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

function getAuthoritativeSolution(selection, matchMode = "versus") {
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

async function createStartedRoom(t, options = {}) {
  const harness = await createTestHarness(t);
  const clientA = harness.makeClient();
  const clientB = harness.makeClient();

  await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

  const createSnapshot = await emitAck(clientA, "room:create", {
    clientId: options.clientIdA || "phase-b-a",
    joinedAt: options.joinedAtA || 101,
    page: "index",
    displayName: "Player A",
    autoRoomName: true,
    matchMode: options.matchMode || "versus",
    host: harness.baseUrl.replace(/^https?:\/\//, ""),
    forwardedProto: "http",
  });

  const selection = createSelection(options.selection);
  const roomId = createSnapshot.room.roomId;

  await emitAck(clientB, "room:join", {
    clientId: options.clientIdB || "phase-b-b",
    joinedAt: options.joinedAtB || 202,
    page: "player-b",
    displayName: "Player B",
    roomId,
  });

  await emitAck(clientA, "room:set_ready", {
    clientId: options.clientIdA || "phase-b-a",
    joinedAt: options.joinedAtA || 101,
    page: "index",
    selection,
  });

  await emitAck(clientB, "room:set_ready", {
    clientId: options.clientIdB || "phase-b-b",
    joinedAt: options.joinedAtB || 202,
    page: "player-b",
    selection,
  });

  const startSnapshot = await emitAck(clientA, "room:start_round", {
    clientId: options.clientIdA || "phase-b-a",
    joinedAt: options.joinedAtA || 101,
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

test("Phase B canonicalizes puzzle selection and safely rejects invalid puzzle starts", async (t) => {
  const harness = await createTestHarness(t);
  const clientA = harness.makeClient();
  const clientB = harness.makeClient();

  await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

  const createSnapshot = await emitAck(clientA, "room:create", {
    clientId: "phase-b-select-a",
    joinedAt: 11,
    page: "index",
    displayName: "Player A",
    autoRoomName: true,
    matchMode: "versus",
    host: harness.baseUrl.replace(/^https?:\/\//, ""),
    forwardedProto: "http",
  });

  await emitAck(clientB, "room:join", {
    clientId: "phase-b-select-b",
    joinedAt: 12,
    page: "player-b",
    displayName: "Player B",
    roomId: createSnapshot.room.roomId,
  });

  const forgedSelection = createSelection({
    puzzleId: "forged-id",
    sessionKey: "easy:forged-id",
  });

  const readySnapshot = await emitAck(clientA, "room:set_ready", {
    clientId: "phase-b-select-a",
    joinedAt: 11,
    page: "index",
    selection: forgedSelection,
  });

  assert.equal(readySnapshot.lobby.readyBy.A.puzzleId, createSelection().puzzleId);
  assert.equal(readySnapshot.lobby.readyBy.A.sessionKey, createSelection().sessionKey);

  const invalidStart = await emitRawAck(clientA, "room:start_round", {
    clientId: "phase-b-select-a",
    joinedAt: 11,
    page: "index",
    selection: createSelection({ puzzleIndex: 9999 }),
  });

  assert.equal(invalidStart.ok, false);
  assert.match(invalidStart.error, /valid puzzle/i);
});

test("Phase B accepts simultaneous different-cell submissions without dropping valid moves", async (t) => {
  const { clientA, clientB, startSnapshot } = await createStartedRoom(t);
  const [indexA, indexB] = getEditableIndexes(startSnapshot, 2);
  const solution = getAuthoritativeSolution(createSelection(), "versus");
  const digitA = solution[indexA];
  const digitB = solution[indexB];

  const [resultA, resultB] = await Promise.all([
    emitAck(clientA, "room:cell_submit", {
      clientId: "phase-b-a",
      joinedAt: 101,
      page: "index",
      roundId: startSnapshot.roundState.roundId,
      baseRoundRevision: 1,
      requestId: "req-diff-a",
      clientSeq: 1,
      cellIndex: indexA,
      digit: digitA,
      action: "set",
    }),
    emitAck(clientB, "room:cell_submit", {
      clientId: "phase-b-b",
      joinedAt: 202,
      page: "player-b",
      roundId: startSnapshot.roundState.roundId,
      baseRoundRevision: 1,
      requestId: "req-diff-b",
      clientSeq: 1,
      cellIndex: indexB,
      digit: digitB,
      action: "set",
    }),
  ]);

  const latest = resultA.roundState.revision > resultB.roundState.revision ? resultA : resultB;
  assert.equal(latest.roundState.cells[indexA].owner, "A");
  assert.equal(latest.roundState.cells[indexB].owner, "B");
  assert.equal(latest.roundState.scores.A, 1);
  assert.equal(latest.roundState.scores.B, 1);
});

test("Phase B keeps the first same-cell winner when the later submitter does not qualify for a contest", async (t) => {
  const { clientA, clientB, startSnapshot } = await createStartedRoom(t, {
    clientIdA: "same-cell-a",
    clientIdB: "same-cell-b",
    joinedAtA: 301,
    joinedAtB: 302,
  });
  const [index] = getEditableIndexes(startSnapshot, 1);
  const solution = getAuthoritativeSolution(createSelection(), "versus");
  const digit = solution[index];

  const first = await emitAck(clientA, "room:cell_submit", {
    clientId: "same-cell-a",
    joinedAt: 301,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 1,
    requestId: "req-same-a",
    clientSeq: 1,
    cellIndex: index,
    digit,
    action: "set",
  });

  const second = await emitRawAck(clientB, "room:cell_submit", {
    clientId: "same-cell-b",
    joinedAt: 302,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: first.roundState.revision,
    requestId: "req-same-b",
    clientSeq: 1,
    cellIndex: index,
    digit,
    action: "set",
    observedCellVersion: 1,
    observedCellLocked: true,
  });

  assert.equal(first.roundState.cells[index].value, digit);
  assert.equal(first.roundState.cells[index].owner, "A");
  assert.equal(second.ok, false);
  assert.match(second.error, /claimed|edited/i);
  assert.equal(second.snapshot.roundState.cells[index].owner, "A");
});

test("Phase B applies correct plus wrong scoring and deduplicates request ids", async (t) => {
  const { clientA, clientB, startSnapshot } = await createStartedRoom(t, {
    clientIdA: "score-aa",
    clientIdB: "score-bb",
    joinedAtA: 401,
    joinedAtB: 402,
  });
  const [indexA, indexB] = getEditableIndexes(startSnapshot, 2);
  const solution = getAuthoritativeSolution(createSelection(), "versus");
  const correctDigit = solution[indexA];
  const wrongDigit = correctDigit === "9" ? "1" : "9";

  const first = await emitAck(clientA, "room:cell_submit", {
    clientId: "score-aa",
    joinedAt: 401,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 1,
    requestId: "req-score-a",
    clientSeq: 1,
    cellIndex: indexA,
    digit: correctDigit,
    action: "set",
  });

  const duplicate = await emitAck(clientA, "room:cell_submit", {
    clientId: "score-aa",
    joinedAt: 401,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 2,
    requestId: "req-score-a",
    clientSeq: 1,
    cellIndex: indexA,
    digit: correctDigit,
    action: "set",
  });

  const second = await emitAck(clientB, "room:cell_submit", {
    clientId: "score-bb",
    joinedAt: 402,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 2,
    requestId: "req-score-b",
    clientSeq: 1,
    cellIndex: indexB,
    digit: wrongDigit,
    action: "set",
  });

  assert.equal(first.roundState.scores.A, 1);
  assert.equal(duplicate.roundState.scores.A, 1);
  assert.equal(second.roundState.scores.A, 1);
  assert.equal(second.roundState.scores.B, -1);
});

test("Phase B rejects stale round ids and legacy state_sync overreach during active rounds", async (t) => {
  const { clientA, clientB, startSnapshot } = await createStartedRoom(t, {
    clientIdA: "round-aa",
    clientIdB: "round-bb",
    joinedAtA: 501,
    joinedAtB: 502,
  });
  const [index] = getEditableIndexes(startSnapshot, 1);

  const staleRoundResponse = await emitRawAck(clientA, "room:cell_submit", {
    clientId: "round-aa",
    joinedAt: 501,
    page: "index",
    roundId: "old-round",
    baseRoundRevision: 1,
    requestId: "req-old-round",
    clientSeq: 1,
    cellIndex: index,
    digit: getAuthoritativeSolution(createSelection(), "versus")[index],
    action: "set",
  });

  assert.equal(staleRoundResponse.ok, false);
  assert.match(staleRoundResponse.error, /round has changed|refresh/i);

  const legacySyncResponse = await emitRawAck(clientB, "room:state_sync", {
    clientId: "round-bb",
    joinedAt: 502,
    page: "player-b",
    baseRevision: 1,
    sharedState: {
      sessions: {
        forged: true,
      },
    },
  });

  assert.equal(legacySyncResponse.ok, false);
  assert.match(legacySyncResponse.error, /protocol v2|refresh/i);
});

test("Phase B restores authoritative board and score state after reconnect", async (t) => {
  const { harness, clientA, clientB, roomId, startSnapshot } = await createStartedRoom(t, {
    clientIdA: "resume-a",
    clientIdB: "resume-b",
    joinedAtA: 601,
    joinedAtB: 602,
  });
  const [index] = getEditableIndexes(startSnapshot, 1);
  const digit = getAuthoritativeSolution(createSelection(), "versus")[index];

  const submitted = await emitAck(clientA, "room:cell_submit", {
    clientId: "resume-a",
    joinedAt: 601,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 1,
    requestId: "req-resume-a",
    clientSeq: 1,
    cellIndex: index,
    digit,
    action: "set",
  });

  clientA.disconnect();

  const resumedClient = harness.makeClient();
  await waitForConnect(resumedClient);

  const resumed = await emitAck(resumedClient, "room:resume", {
    clientId: "resume-a",
    joinedAt: 601,
    roomId,
    page: "index",
  });

  assert.equal(resumed.roundState.roundId, submitted.roundState.roundId);
  assert.equal(resumed.roundState.cells[index].value, digit);
  assert.equal(resumed.roundState.cells[index].owner, "A");
  assert.equal(resumed.roundState.scores.A, 1);
  assert.equal(resumed.roundState.scores.B, 0);

  clientB.disconnect();
});

test("Phase B keeps Coop edits server-authoritative without changing the base edit rules", async (t) => {
  const { clientA, clientB, startSnapshot } = await createStartedRoom(t, {
    matchMode: "coop",
    clientIdA: "coop-aaa",
    clientIdB: "coop-bbb",
    joinedAtA: 701,
    joinedAtB: 702,
  });
  const [index] = getEditableIndexes(startSnapshot, 1);
  const digit = getAuthoritativeSolution(createSelection(), "coop")[index];

  const setSnapshot = await emitAck(clientA, "room:cell_submit", {
    clientId: "coop-aaa",
    joinedAt: 701,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 1,
    requestId: "req-coop-set",
    clientSeq: 1,
    cellIndex: index,
    digit,
    action: "set",
  });

  const noteSnapshot = await emitAck(clientB, "room:cell_submit", {
    clientId: "coop-bbb",
    joinedAt: 702,
    page: "player-b",
    roundId: setSnapshot.roundState.roundId,
    baseRoundRevision: setSnapshot.roundState.revision,
    requestId: "req-coop-clear",
    clientSeq: 1,
    cellIndex: index,
    action: "clear",
  });

  assert.equal(setSnapshot.roundState.cells[index].value, digit);
  assert.equal(noteSnapshot.roundState.cells[index].value, "");
  assert.equal(noteSnapshot.roundState.scores.A, 0);
  assert.equal(noteSnapshot.roundState.scores.B, 0);
});
