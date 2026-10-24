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

function createSelectionForPuzzleIndex(puzzleIndex, overrides = {}) {
  return {
    ...resolveAuthoritativeSelection({
      difficulty: "easy",
      puzzleIndex,
    }),
    ...overrides,
  };
}

function getAuthoritativeRound(selection) {
  return createAuthoritativeRoundState({
    matchMode: "versus",
    selection,
    createdAt: 1_730_000_000_000,
  });
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

async function createStartedVersusRoom(t, options = {}) {
  const harness = await createTestHarness(t);
  const clientA = harness.makeClient();
  const clientB = harness.makeClient();

  await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

  const createSnapshot = await emitAck(clientA, "room:create", {
    clientId: options.clientIdA || "phase-d-aaa",
    joinedAt: options.joinedAtA || 5001,
    page: "index",
    displayName: "Player A",
    autoRoomName: true,
    matchMode: "versus",
    host: harness.baseUrl.replace(/^https?:\/\//, ""),
    forwardedProto: "http",
  });

  const selection = createSelection(options.selection);
  const roomId = createSnapshot.room.roomId;

  await emitAck(clientB, "room:join", {
    clientId: options.clientIdB || "phase-d-bbb",
    joinedAt: options.joinedAtB || 5002,
    page: "player-b",
    displayName: "Player B",
    roomId,
  });

  await emitAck(clientA, "room:set_ready", {
    clientId: options.clientIdA || "phase-d-aaa",
    joinedAt: options.joinedAtA || 5001,
    page: "index",
    selection,
  });

  await emitAck(clientB, "room:set_ready", {
    clientId: options.clientIdB || "phase-d-bbb",
    joinedAt: options.joinedAtB || 5002,
    page: "player-b",
    selection,
  });

  const startSnapshot = await emitAck(clientA, "room:start_round", {
    clientId: options.clientIdA || "phase-d-aaa",
    joinedAt: options.joinedAtA || 5001,
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

async function finishStartedVersusRound(client, startSnapshot, options = {}) {
  const round = getAuthoritativeRound(createSelection());
  const remainingIndexes = startSnapshot.roundState.cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => !cell.given && !cell.locked)
    .map(({ index }) => index);

  let latestSnapshot = startSnapshot;
  let nextSeq = Number.isInteger(options.initialClientSeq) ? options.initialClientSeq : 1;

  for (const index of remainingIndexes) {
    latestSnapshot = await emitAck(client, "room:cell_submit", {
      clientId: options.clientId || "phase-d-finish",
      joinedAt: options.joinedAt || 9001,
      page: options.page || "index",
      roundId: startSnapshot.roundState.roundId,
      baseRoundRevision: latestSnapshot.roundState.revision,
      requestId: `req-phase-d-finish-all-${nextSeq}`,
      clientSeq: nextSeq,
      cellIndex: index,
      digit: round.solution[index],
      action: "set",
      observedCellVersion: latestSnapshot.roundState.cells[index]?.version || 0,
      observedCellLocked: false,
    });
    nextSeq += 1;
  }

  return latestSnapshot;
}

test("Phase D awards the correct claimer, shows a versus contest result, and freezes only the loser", async (t) => {
  const originalNow = Date.now;
  let mockedNow = 1_730_000_003_000;
  Date.now = () => mockedNow;
  t.after(() => {
    Date.now = originalNow;
  });

  const { clientA, clientB, startSnapshot } = await createStartedVersusRoom(t);
  const [index] = getEditableIndexes(startSnapshot, 1);
  const round = getAuthoritativeRound(createSelection());
  const digit = round.solution[index];

  await emitAck(clientA, "room:cell_submit", {
    clientId: "phase-d-aaa",
    joinedAt: 5001,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 1,
    requestId: "req-phase-d-a",
    clientSeq: 1,
    cellIndex: index,
    digit,
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  mockedNow = 1_730_000_003_140;
  const second = await emitAck(clientB, "room:cell_submit", {
    clientId: "phase-d-bbb",
    joinedAt: 5002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 2,
    requestId: "req-phase-d-b",
    clientSeq: 1,
    cellIndex: index,
    digit,
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  assert.equal(second.roundState.scores.A, 1);
  assert.equal(second.roundState.scores.B, 0);
  assert.equal(second.roundState.recentEffects.length, 1);
  assert.equal(second.roundState.recentEffects[0].kind, "versus_contest");
  assert.equal(second.roundState.recentEffects[0].winner, "A");
  assert.equal(second.roundState.recentEffects[0].loser, "B");
  assert.equal(second.roundState.playerStates.A.freezeRemainingMs, 0);
  assert.ok(second.roundState.playerStates.B.freezeRemainingMs > 1300);
});

test("Phase D never turns different-cell, wrong-answer, or already-locked clicks into bomb contests", async (t) => {
  const originalNow = Date.now;
  let mockedNow = 1_730_000_004_000;
  Date.now = () => mockedNow;
  t.after(() => {
    Date.now = originalNow;
  });

  const { clientA, clientB, startSnapshot } = await createStartedVersusRoom(t, {
    clientIdA: "phase-d-ccc",
    clientIdB: "phase-d-ddd",
    joinedAtA: 6001,
    joinedAtB: 6002,
  });
  const [indexA, indexB] = getEditableIndexes(startSnapshot, 2);
  const round = getAuthoritativeRound(createSelection());
  const digitA = round.solution[indexA];
  const digitB = round.solution[indexB];
  const wrongDigit = digitA === "9" ? "1" : "9";

  const differentCell = await Promise.all([
    emitAck(clientA, "room:cell_submit", {
      clientId: "phase-d-ccc",
      joinedAt: 6001,
      page: "index",
      roundId: startSnapshot.roundState.roundId,
      baseRoundRevision: 1,
      requestId: "req-phase-d-diff-a",
      clientSeq: 1,
      cellIndex: indexA,
      digit: digitA,
      action: "set",
      observedCellVersion: 0,
      observedCellLocked: false,
    }),
    emitAck(clientB, "room:cell_submit", {
      clientId: "phase-d-ddd",
      joinedAt: 6002,
      page: "player-b",
      roundId: startSnapshot.roundState.roundId,
      baseRoundRevision: 1,
      requestId: "req-phase-d-diff-b",
      clientSeq: 1,
      cellIndex: indexB,
      digit: digitB,
      action: "set",
      observedCellVersion: 0,
      observedCellLocked: false,
    }),
  ]);

  assert.ok(differentCell.every((snapshot) => snapshot.roundState.recentEffects.length === 0));

  mockedNow = 1_730_000_004_300;
  const wrongRace = await emitRawAck(clientB, "room:cell_submit", {
    clientId: "phase-d-ddd",
    joinedAt: 6002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: differentCell[0].roundState.revision,
    requestId: "req-phase-d-wrong",
    clientSeq: 2,
    cellIndex: indexA,
    digit: wrongDigit,
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  assert.equal(wrongRace.ok, false);
  assert.match(wrongRace.error, /claimed/i);
  assert.equal(wrongRace.snapshot.roundState.recentEffects.length, 0);

  const lockedClick = await emitRawAck(clientB, "room:cell_submit", {
    clientId: "phase-d-ddd",
    joinedAt: 6002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: differentCell[0].roundState.revision,
    requestId: "req-phase-d-locked",
    clientSeq: 3,
    cellIndex: indexA,
    digit: digitA,
    action: "set",
    observedCellVersion: 1,
    observedCellLocked: true,
  });

  assert.equal(lockedClick.ok, false);
  assert.match(lockedClick.error, /claimed/i);
});

test("Phase D honors the contest window boundary, request ordering, duplicate ids, and frozen input rejection", async (t) => {
  const originalNow = Date.now;
  let mockedNow = 1_730_000_005_000;
  Date.now = () => mockedNow;
  t.after(() => {
    Date.now = originalNow;
  });

  const { clientA, clientB, startSnapshot } = await createStartedVersusRoom(t, {
    clientIdA: "phase-d-eee",
    clientIdB: "phase-d-fff",
    joinedAtA: 7001,
    joinedAtB: 7002,
  });
  const [indexA, indexB] = getEditableIndexes(startSnapshot, 2);
  const round = getAuthoritativeRound(createSelection());
  const digitA = round.solution[indexA];
  const digitB = round.solution[indexB];

  await emitAck(clientA, "room:cell_submit", {
    clientId: "phase-d-eee",
    joinedAt: 7001,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 1,
    requestId: "req-phase-d-window-a",
    clientSeq: 1,
    cellIndex: indexA,
    digit: digitA,
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  mockedNow = 1_730_000_005_500;
  const late = await emitRawAck(clientB, "room:cell_submit", {
    clientId: "phase-d-fff",
    joinedAt: 7002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 2,
    requestId: "req-phase-d-window-b",
    clientSeq: 1,
    cellIndex: indexA,
    digit: digitA,
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  assert.equal(late.ok, false);
  assert.equal(late.snapshot.roundState.recentEffects.length, 0);

  mockedNow = 1_730_000_005_700;
  await emitAck(clientA, "room:cell_submit", {
    clientId: "phase-d-eee",
    joinedAt: 7001,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: late.snapshot.roundState.revision,
    requestId: "req-phase-d-freeze-a",
    clientSeq: 2,
    cellIndex: indexB,
    digit: digitB,
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  mockedNow = 1_730_000_005_860;
  const contest = await emitRawAck(clientB, "room:cell_submit", {
    clientId: "phase-d-fff",
    joinedAt: 7002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: late.snapshot.roundState.revision + 1,
    requestId: "req-phase-d-freeze-b",
    clientSeq: 2,
    cellIndex: indexB,
    digit: digitB,
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  assert.equal(contest.ok, true);
  assert.ok(contest.snapshot.roundState.playerStates.B.freezeRemainingMs > 1300);

  const duplicate = await emitRawAck(clientB, "room:cell_submit", {
    clientId: "phase-d-fff",
    joinedAt: 7002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: contest.snapshot.roundState.revision,
    requestId: "req-phase-d-freeze-b",
    clientSeq: 2,
    cellIndex: indexB,
    digit: digitB,
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.snapshot.roundState.playerStates.B.freezeRemainingMs, contest.snapshot.roundState.playerStates.B.freezeRemainingMs);

  const frozen = await emitRawAck(clientB, "room:cell_submit", {
    clientId: "phase-d-fff",
    joinedAt: 7002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: contest.snapshot.roundState.revision,
    requestId: "req-phase-d-frozen",
    clientSeq: 3,
    cellIndex: indexA,
    digit: digitA,
    action: "set",
    observedCellVersion: 1,
    observedCellLocked: true,
  });

  assert.equal(frozen.ok, false);
  assert.match(frozen.error, /frozen/i);
});

test("Phase D restores and then clears freeze across reconnect and round completion, and supports repeated contests", async (t) => {
  const originalNow = Date.now;
  let mockedNow = 1_730_000_006_000;
  Date.now = () => mockedNow;
  t.after(() => {
    Date.now = originalNow;
  });

  const { harness, clientA, clientB, roomId, startSnapshot } = await createStartedVersusRoom(t, {
    clientIdA: "phase-d-ggg",
    clientIdB: "phase-d-hhh",
    joinedAtA: 8001,
    joinedAtB: 8002,
  });
  const editableIndexes = getEditableIndexes(startSnapshot, 3);
  const round = getAuthoritativeRound(createSelection());

  await emitAck(clientA, "room:cell_submit", {
    clientId: "phase-d-ggg",
    joinedAt: 8001,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 1,
    requestId: "req-phase-d-r1-a",
    clientSeq: 1,
    cellIndex: editableIndexes[0],
    digit: round.solution[editableIndexes[0]],
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  mockedNow = 1_730_000_006_100;
  const firstContest = await emitAck(clientB, "room:cell_submit", {
    clientId: "phase-d-hhh",
    joinedAt: 8002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: 2,
    requestId: "req-phase-d-r1-b",
    clientSeq: 1,
    cellIndex: editableIndexes[0],
    digit: round.solution[editableIndexes[0]],
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  clientB.disconnect();
  const resumed = harness.makeClient();
  await waitForConnect(resumed);

  mockedNow = 1_730_000_006_300;
  const resumedSnapshot = await emitAck(resumed, "room:resume", {
    clientId: "phase-d-hhh",
    joinedAt: 8002,
    roomId,
    page: "player-b",
  });

  assert.ok(resumedSnapshot.roundState.playerStates.B.freezeRemainingMs > 1000);

  mockedNow = 1_730_000_007_700;
  const afterFreeze = await emitAck(resumed, "room:resume", {
    clientId: "phase-d-hhh",
    joinedAt: 8002,
    roomId,
    page: "player-b",
  });

  assert.equal(afterFreeze.roundState.playerStates.B.freezeRemainingMs, 0);

  await emitAck(clientA, "room:cell_submit", {
    clientId: "phase-d-ggg",
    joinedAt: 8001,
    page: "index",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: afterFreeze.roundState.revision,
    requestId: "req-phase-d-r2-a",
    clientSeq: 2,
    cellIndex: editableIndexes[1],
    digit: round.solution[editableIndexes[1]],
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  mockedNow = 1_730_000_007_820;
  const secondContest = await emitAck(resumed, "room:cell_submit", {
    clientId: "phase-d-hhh",
    joinedAt: 8002,
    page: "player-b",
    roundId: startSnapshot.roundState.roundId,
    baseRoundRevision: afterFreeze.roundState.revision + 1,
    requestId: "req-phase-d-r2-b",
    clientSeq: 2,
    cellIndex: editableIndexes[1],
    digit: round.solution[editableIndexes[1]],
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  assert.ok(secondContest.roundState.playerStates.B.freezeRemainingMs > 1300);

  const finishingIndexes = secondContest.roundState.cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => !cell.given && !cell.locked)
    .map(({ index }) => index);

  let latestSnapshot = secondContest;
  let seq = 3;

  for (const index of finishingIndexes) {
    mockedNow += 10;
    latestSnapshot = await emitAck(clientA, "room:cell_submit", {
      clientId: "phase-d-ggg",
      joinedAt: 8001,
      page: "index",
      roundId: startSnapshot.roundState.roundId,
      baseRoundRevision: latestSnapshot.roundState.revision,
      requestId: `req-phase-d-finish-${seq}`,
      clientSeq: seq,
      cellIndex: index,
      digit: round.solution[index],
      action: "set",
      observedCellVersion: 0,
      observedCellLocked: false,
    });
    seq += 1;
  }

  assert.equal(latestSnapshot.roundState.status, "completed");
  assert.equal(latestSnapshot.roundState.playerStates.A.freezeRemainingMs, 0);
  assert.equal(latestSnapshot.roundState.playerStates.B.freezeRemainingMs, 0);
  assert.equal(latestSnapshot.roundState.recentEffects.length, 0);
});

test("Phase E keeps a completed round immutable until both players ready the next puzzle, then starts one fresh authoritative round", async (t) => {
  const { clientA, clientB, startSnapshot, selection } = await createStartedVersusRoom(t, {
    clientIdA: "phase-e-aaa",
    clientIdB: "phase-e-bbb",
    joinedAtA: 9101,
    joinedAtB: 9102,
  });
  const completedSnapshot = await finishStartedVersusRound(clientA, startSnapshot, {
    clientId: "phase-e-aaa",
    joinedAt: 9101,
    page: "index",
    initialClientSeq: 1,
  });

  assert.equal(completedSnapshot.roundState.status, "completed");

  const nextSelection = createSelectionForPuzzleIndex(selection.puzzleIndex + 1);
  const firstReady = await emitAck(clientA, "room:set_ready", {
    clientId: "phase-e-aaa",
    joinedAt: 9101,
    page: "index",
    selection: nextSelection,
  });

  assert.equal(firstReady.lobby.startedSessionKey, null);
  assert.equal(firstReady.roundState.status, "completed");
  assert.equal(firstReady.roundState.roundId, completedSnapshot.roundState.roundId);
  assert.equal(firstReady.roundState.sessionKey, selection.sessionKey);
  assert.equal(firstReady.lobby.readyBy.A.sessionKey, nextSelection.sessionKey);
  assert.equal(firstReady.lobby.readyBy.B.sessionKey, selection.sessionKey);

  const duplicateReady = await emitAck(clientA, "room:set_ready", {
    clientId: "phase-e-aaa",
    joinedAt: 9101,
    page: "index",
    selection: nextSelection,
  });

  assert.equal(duplicateReady.lobby.startedSessionKey, null);
  assert.equal(duplicateReady.roundState.roundId, completedSnapshot.roundState.roundId);

  const secondReady = await emitAck(clientB, "room:set_ready", {
    clientId: "phase-e-bbb",
    joinedAt: 9102,
    page: "player-b",
    selection: nextSelection,
  });

  assert.equal(secondReady.lobby.startedSessionKey, nextSelection.sessionKey);
  assert.equal(secondReady.roundState.status, "active");
  assert.notEqual(secondReady.roundState.roundId, completedSnapshot.roundState.roundId);
  assert.equal(secondReady.roundState.sessionKey, nextSelection.sessionKey);
  assert.deepEqual(secondReady.roundState.scores, { A: 0, B: 0 });
  assert.equal(secondReady.roundState.recentEffects.length, 0);
  assert.equal(secondReady.roundState.playerStates.A.freezeRemainingMs, 0);
  assert.equal(secondReady.roundState.playerStates.B.freezeRemainingMs, 0);

  const staleReplay = await emitRawAck(clientA, "room:cell_submit", {
    clientId: "phase-e-aaa",
    joinedAt: 9101,
    page: "index",
    roundId: completedSnapshot.roundState.roundId,
    baseRoundRevision: completedSnapshot.roundState.revision,
    requestId: "req-phase-e-stale-replay",
    clientSeq: 999,
    cellIndex: getEditableIndexes(completedSnapshot, 1)[0],
    digit: getAuthoritativeRound(selection).solution[getEditableIndexes(completedSnapshot, 1)[0]],
    action: "set",
    observedCellVersion: 0,
    observedCellLocked: false,
  });

  assert.equal(staleReplay.ok, false);
  assert.match(staleReplay.error, /round has changed/i);
  assert.equal(staleReplay.snapshot.roundState.roundId, secondReady.roundState.roundId);
});
