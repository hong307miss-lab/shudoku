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
const {
  createAuthoritativeRoundState,
  resolveAuthoritativeSelection,
} = require("./room-round-engine");

let requestCounter = 0;

function nextRequestId(prefix = "req-phase-f") {
  requestCounter += 1;
  return `${prefix}-${requestCounter}`;
}

function createSelection(overrides = {}) {
  return {
    ...resolveAuthoritativeSelection({
      difficulty: "easy",
      puzzleIndex: 0,
    }),
    ...overrides,
  };
}

function getSolutionForSelection(selection, matchMode) {
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

async function createStartedRoom(t, matchMode) {
  const harness = await createTestHarness(t);
  const clientA = harness.makeClient();
  const clientB = harness.makeClient();

  await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

  const identityA = { clientId: `phase-f-a-${matchMode}`, joinedAt: 7001, page: "index" };
  const identityB = { clientId: `phase-f-b-${matchMode}`, joinedAt: 7002, page: "player-b" };

  const createSnapshot = await emitAck(clientA, "room:create", {
    ...identityA,
    displayName: "Player A",
    autoRoomName: true,
    matchMode,
    host: harness.baseUrl.replace(/^https?:\/\//, ""),
    forwardedProto: "http",
  });

  const selection = createSelection();
  const roomId = createSnapshot.room.roomId;

  await emitAck(clientB, "room:join", {
    ...identityB,
    displayName: "Player B",
    roomId,
  });

  await emitAck(clientA, "room:set_ready", { ...identityA, selection });
  await emitAck(clientB, "room:set_ready", { ...identityB, selection });

  const startSnapshot = await emitAck(clientA, "room:start_round", { ...identityA, selection });

  return {
    clientA,
    clientB,
    roomId,
    selection,
    startSnapshot,
    solution: getSolutionForSelection(selection, matchMode),
    identityA,
    identityB,
  };
}

function getEditableIndexes(snapshot) {
  return snapshot.roundState.cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => !cell.given)
    .map(({ index }) => index);
}

function submitCell(socket, identity, roundSnapshot, index, digit, options = {}) {
  return emitAck(socket, "room:cell_submit", {
    ...identity,
    roundId: roundSnapshot.roundState.roundId,
    baseRoundRevision: roundSnapshot.roundState.revision,
    requestId: options.requestId || nextRequestId(),
    clientSeq: options.clientSeq ?? 1,
    cellIndex: index,
    digit,
    action: options.action || "set",
    observedCellVersion: roundSnapshot.roundState.cells[index]?.version || 0,
    observedCellLocked: roundSnapshot.roundState.cells[index]?.locked === true,
  });
}

test("Phase F coop sockets keep notes private per viewer", async (t) => {
  const room = await createStartedRoom(t, "coop");
  const [cellIndex] = getEditableIndexes(room.startSnapshot);

  const afterA = await submitCell(room.clientA, room.identityA, room.startSnapshot, cellIndex, "5", {
    action: "note_toggle",
    clientSeq: 1,
  });

  assert.deepEqual(afterA.roundState.cells[cellIndex].notes, { 5: "A" });

  await submitCell(room.clientB, room.identityB, afterA, cellIndex, "6", {
    action: "note_toggle",
    clientSeq: 1,
  });

  const viewA = await emitAck(room.clientA, "room:ping", { ...room.identityA });
  const viewB = await emitAck(room.clientB, "room:ping", { ...room.identityB });

  assert.deepEqual(viewA.roundState.cells[cellIndex].notes, { 5: "A" });
  assert.deepEqual(viewB.roundState.cells[cellIndex].notes, { 6: "B" });
  assert.equal(viewA.roundState.cells[cellIndex].notes[6], undefined);
  assert.equal(viewB.roundState.cells[cellIndex].notes[5], undefined);
});

test("Phase F coop sockets undo only the caller's own still-valid move", async (t) => {
  const room = await createStartedRoom(t, "coop");
  const [cellIndex] = getEditableIndexes(room.startSnapshot);

  const afterA = await submitCell(room.clientA, room.identityA, room.startSnapshot, cellIndex, "4", {
    clientSeq: 1,
  });

  assert.equal(afterA.roundState.cells[cellIndex].value, "4");

  const undone = await emitAck(room.clientA, "room:cell_undo", {
    ...room.identityA,
    roundId: afterA.roundState.roundId,
    clientSeq: 2,
    requestId: nextRequestId("req-phase-f-undo"),
  });

  assert.equal(undone.roundState.cells[cellIndex].value, "");

  const overwrittenBase = await submitCell(room.clientA, room.identityA, undone, cellIndex, "7", {
    clientSeq: 3,
  });
  const afterB = await submitCell(room.clientB, room.identityB, overwrittenBase, cellIndex, "8", {
    clientSeq: 1,
  });

  const rejected = await emitRawAck(room.clientA, "room:cell_undo", {
    ...room.identityA,
    roundId: afterB.roundState.roundId,
    clientSeq: 4,
    requestId: nextRequestId("req-phase-f-undo-peer"),
  });

  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /can no longer be undone/i);
  assert.equal(rejected.snapshot.roundState.cells[cellIndex].value, "8");
});

test("Phase F versus sockets never refund or reverse a scored claim", async (t) => {
  const room = await createStartedRoom(t, "versus");
  const [cellIndex] = getEditableIndexes(room.startSnapshot);
  const solutionDigit = room.solution[cellIndex];

  const claimed = await submitCell(room.clientA, room.identityA, room.startSnapshot, cellIndex, solutionDigit, {
    clientSeq: 1,
  });

  assert.equal(claimed.roundState.scores.A, 1);
  assert.equal(claimed.roundState.cells[cellIndex].value, solutionDigit);

  const rejected = await emitRawAck(room.clientA, "room:cell_undo", {
    ...room.identityA,
    roundId: claimed.roundState.roundId,
    clientSeq: 2,
    requestId: nextRequestId("req-phase-f-versus-undo"),
  });

  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /nothing to undo/i);
  assert.equal(rejected.snapshot.roundState.scores.A, 1);
  assert.equal(rejected.snapshot.roundState.cells[cellIndex].value, solutionDigit);
});

test("Phase F coop sockets restart only after both seats vote and reset the board", async (t) => {
  const room = await createStartedRoom(t, "coop");
  const [cellIndex] = getEditableIndexes(room.startSnapshot);

  const edited = await submitCell(room.clientA, room.identityA, room.startSnapshot, cellIndex, "3", {
    clientSeq: 1,
  });

  const voteA = await emitRawAck(room.clientB, "room:restart_vote", {
    ...room.identityB,
    roundId: edited.roundState.roundId,
    clientSeq: 1,
    requestId: nextRequestId("req-phase-f-restart-b"),
  });

  assert.equal(voteA.ok, true);
  assert.equal(voteA.restarted, false);
  assert.equal(voteA.snapshot.roundState.restartVotes.B, true);
  assert.equal(voteA.snapshot.roundState.cells[cellIndex].value, "3");

  const voteB = await emitRawAck(room.clientA, "room:restart_vote", {
    ...room.identityA,
    roundId: edited.roundState.roundId,
    clientSeq: 2,
    requestId: nextRequestId("req-phase-f-restart-a"),
  });

  assert.equal(voteB.ok, true);
  assert.equal(voteB.restarted, true);
  assert.equal(voteB.snapshot.roundState.cells[cellIndex].value, "");
  assert.deepEqual(voteB.snapshot.roundState.restartVotes, { A: false, B: false });
  assert.match(voteB.snapshot.roundState.restartEventId, /^restart-/);

  const viewB = await emitAck(room.clientB, "room:ping", { ...room.identityB });

  assert.equal(viewB.roundState.cells[cellIndex].value, "");
  assert.equal(viewB.roundState.restartEventId, voteB.snapshot.roundState.restartEventId);
});
