const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");

function extractFunctionSource(functionName) {
  const signature = `function ${functionName}(`;
  const startIndex = appSource.indexOf(signature);

  if (startIndex < 0) {
    throw new Error(`Unable to find ${functionName} in app.js`);
  }

  const bodyStart = appSource.indexOf("{", startIndex);
  let depth = 0;
  let endIndex = bodyStart;

  for (; endIndex < appSource.length; endIndex += 1) {
    const char = appSource[endIndex];

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        endIndex += 1;
        break;
      }
    }
  }

  return appSource.slice(startIndex, endIndex);
}

function getSessionKey(difficulty, puzzleId) {
  return `${difficulty}:${puzzleId}`;
}

const isAuthoritativeProtocolVersion = eval(`(${extractFunctionSource("isAuthoritativeProtocolVersion")})`);
const isAuthoritativeMultiplayerRoundActiveFactory = new Function(
  "state",
  "isRoomMultiplayerMode",
  "isAuthoritativeProtocolVersion",
  `${extractFunctionSource("isAuthoritativeMultiplayerRoundActive")}; return isAuthoritativeMultiplayerRoundActive;`,
);
const isCompletedAuthoritativeMultiplayerRoundFactory = new Function(
  "state",
  "isRoomMultiplayerMode",
  "isAuthoritativeProtocolVersion",
  `${extractFunctionSource("isCompletedAuthoritativeMultiplayerRound")}; return isCompletedAuthoritativeMultiplayerRound;`,
);
const getCurrentSessionFactory = new Function(
  "state",
  "ensureSession",
  `${extractFunctionSource("getCurrentSession")}; return getCurrentSession;`,
);
const getCompletedRoundReadySelectionFactory = new Function(
  "state",
  "isCompletedAuthoritativeMultiplayerRound",
  "normalizeReadySelection",
  "getDailyPuzzleConfigs",
  "getSessionKey",
  `${extractFunctionSource("getCompletedRoundReadySelection")}; return getCompletedRoundReadySelection;`,
);

const hasCellDuel = eval(`(${extractFunctionSource("hasCellDuel")})`);
const snapshotSoloCell = eval(`(${extractFunctionSource("snapshotSoloCell")})`);
const restoreSoloCell = eval(`(${extractFunctionSource("restoreSoloCell")})`);

const getDigitCountsFactory = new Function(
  "state",
  "isVersusMode",
  "hasCellDuel",
  `${extractFunctionSource("getDigitCounts")}; return getDigitCounts;`,
);
const isDigitCompletedFactory = new Function(
  "state",
  "getCurrentSession",
  "getDigitCounts",
  `${extractFunctionSource("isDigitCompleted")}; return isDigitCompleted;`,
);
const recordSoloUndoEntryFactory = new Function(
  "state",
  "getCurrentSession",
  "getSessionKey",
  "SOLO_UNDO_STACK_LIMIT",
  `${extractFunctionSource("recordSoloUndoEntry")}; return recordSoloUndoEntry;`,
);
const getSoloUndoStackForCurrentSessionFactory = new Function(
  "state",
  "getCurrentSession",
  "getSessionKey",
  `${extractFunctionSource("getSoloUndoStackForCurrentSession")}; return getSoloUndoStackForCurrentSession;`,
);
const canUndoLastMoveFactory = new Function(
  "state",
  "getCurrentSession",
  "hasAuthoritativeMultiplayerRound",
  "isSelfFrozen",
  "getSoloUndoStackForCurrentSession",
  `${extractFunctionSource("canUndoLastMove")}; return canUndoLastMove;`,
);
const canRestartCurrentRoundFactory = new Function(
  "state",
  "getCurrentSession",
  "hasAuthoritativeMultiplayerRound",
  "isCurrentRoundStarted",
  `${extractFunctionSource("canRestartCurrentRound")}; return canRestartCurrentRound;`,
);

test("Phase B client policy keeps Solo and Ranked outside authoritative multiplayer mode", () => {
  const state = {
    activeRound: {
      id: "round-1",
      sessionKey: "easy:easy-001",
      revision: 2,
      protocolVersion: 2,
    },
    gameStart: {
      startedSessionKey: "easy:easy-001",
    },
  };

  const fnForSingle = isAuthoritativeMultiplayerRoundActiveFactory(
    state,
    () => false,
    isAuthoritativeProtocolVersion,
  );

  assert.equal(fnForSingle(), false);

  const fnForMultiplayer = isAuthoritativeMultiplayerRoundActiveFactory(
    state,
    () => true,
    isAuthoritativeProtocolVersion,
  );

  assert.equal(fnForMultiplayer(), true);
});

test("Phase E client policy binds getCurrentSession to the authoritative round session", () => {
  const authoritativeSession = {
    puzzleId: "easy-001",
    difficulty: "easy",
    cells: [],
  };
  const fallbackSession = {
    puzzleId: "easy-003",
    difficulty: "easy",
    cells: [],
  };
  const state = {
    difficulty: "easy",
    sessions: {
      "easy:easy-001": authoritativeSession,
    },
    activeRound: {
      id: "round-1",
      sessionKey: "easy:easy-001",
      protocolVersion: 3,
    },
  };

  const getCurrentSession = getCurrentSessionFactory(
    state,
    () => fallbackSession,
  );

  assert.equal(getCurrentSession(), authoritativeSession);
});

test("Phase E client policy keeps completed multiplayer rematch targeting the queued next-round selection", () => {
  const state = {
    difficulty: "easy",
    puzzleIndexes: {
      easy: 0,
    },
    gameStart: {
      readyBy: {
        A: {
          difficulty: "easy",
          puzzleIndex: 1,
          puzzleId: "easy-007",
          sessionKey: "easy:easy-007",
        },
      },
    },
    activeRound: {
      id: "round-finished",
      sessionKey: "easy:easy-003",
      status: "completed",
      protocolVersion: 3,
    },
  };

  const isCompletedAuthoritativeMultiplayerRound = isCompletedAuthoritativeMultiplayerRoundFactory(
    state,
    () => true,
    isAuthoritativeProtocolVersion,
  );
  const getCompletedRoundReadySelection = getCompletedRoundReadySelectionFactory(
    state,
    isCompletedAuthoritativeMultiplayerRound,
    (selection) => selection,
    () => [
      { id: "easy-003" },
      { id: "easy-007" },
      { id: "easy-009" },
    ],
    (difficulty, puzzleId) => `${difficulty}:${puzzleId}`,
  );

  assert.deepEqual(getCompletedRoundReadySelection("A"), {
    difficulty: "easy",
    puzzleIndex: 1,
    puzzleId: "easy-007",
    sessionKey: "easy:easy-007",
  });
});

test("Phase E client policy derives the next daily puzzle when no player has queued the rematch yet", () => {
  const state = {
    difficulty: "easy",
    puzzleIndexes: {
      easy: 0,
    },
    gameStart: {
      readyBy: {
        A: null,
        B: null,
      },
    },
    activeRound: {
      id: "round-finished",
      sessionKey: "easy:easy-003",
      status: "completed",
      protocolVersion: 3,
    },
  };

  const isCompletedAuthoritativeMultiplayerRound = isCompletedAuthoritativeMultiplayerRoundFactory(
    state,
    () => true,
    isAuthoritativeProtocolVersion,
  );
  const getCompletedRoundReadySelection = getCompletedRoundReadySelectionFactory(
    state,
    isCompletedAuthoritativeMultiplayerRound,
    (selection) => selection,
    () => [
      { id: "easy-003" },
      { id: "easy-007" },
      { id: "easy-009" },
    ],
    (difficulty, puzzleId) => `${difficulty}:${puzzleId}`,
  );

  assert.deepEqual(getCompletedRoundReadySelection("A"), {
    difficulty: "easy",
    puzzleIndex: 1,
    puzzleId: "easy-007",
    sessionKey: "easy:easy-007",
  });
});

test("Phase F digit counts use the formal board: notes excluded, versus needs given or locked cells", () => {
  const versusCounts = getDigitCountsFactory(
    { gameMode: "versus" },
    () => true,
    hasCellDuel,
  );
  const versusCells = [
    { value: "5", given: true, notes: {} },
    { value: "5", given: false, locked: true, notes: {} },
    { value: "5", given: false, locked: false, notes: {} },
    { value: "", notes: { 5: true } },
    { value: "5", given: false, locked: true, notes: {} },
  ];

  assert.equal(versusCounts(versusCells)["5"], 3);

  const coopCounts = getDigitCountsFactory(
    { gameMode: "coop" },
    () => false,
    hasCellDuel,
  );

  assert.equal(coopCounts(versusCells)["5"], 4);
});

test("Phase F digit completion only disables a digit when the board already holds all nine", () => {
  const getDigitCounts = getDigitCountsFactory(
    { gameMode: "coop" },
    () => false,
    hasCellDuel,
  );
  const isDigitCompleted = isDigitCompletedFactory(
    {},
    () => ({ cells: [] }),
    getDigitCounts,
  );
  const nineFives = Array.from({ length: 9 }, () => ({ value: "5", notes: {} }));
  const eightFives = Array.from({ length: 8 }, () => ({ value: "5", notes: {} }));

  assert.equal(isDigitCompleted("5", nineFives), true);
  assert.equal(isDigitCompleted("5", eightFives), false);
  assert.equal(
    isDigitCompleted("5", [...eightFives, { value: "", notes: { 5: true } }]),
    false,
  );
});

test("Phase F solo undo history is session scoped, snapshot backed, and capped at 64 entries", () => {
  const state = { soloUndoStack: [] };
  const getCurrentSession = () => ({ difficulty: "easy", puzzleId: "easy-003" });
  const recordSoloUndoEntry = recordSoloUndoEntryFactory(state, getCurrentSession, getSessionKey, 64);

  for (let index = 0; index < 70; index += 1) {
    recordSoloUndoEntry({
      cellIndex: index,
      before: { value: "" },
      after: { value: "1" },
    });
  }

  assert.equal(state.soloUndoStack.length, 64);
  assert.equal(state.soloUndoStack[0].cellIndex, 6);
  assert.equal(state.soloUndoStack[0].sessionKey, "easy:easy-003");

  recordSoloUndoEntry({ cellIndex: 99 });
  assert.equal(state.soloUndoStack.length, 64);

  const getStack = getSoloUndoStackForCurrentSessionFactory(state, getCurrentSession, getSessionKey);

  state.soloUndoStack.push({ sessionKey: "hard:hard-011", cellIndex: 5, before: {}, after: {} });

  const currentEntries = getStack();

  assert.equal(currentEntries.length, 64);
  assert.equal(currentEntries.every((entry) => entry.sessionKey === "easy:easy-003"), true);
});

test("Phase F undo availability follows mode permissions", () => {
  const soloSession = { hasWon: false, difficulty: "easy", puzzleId: "easy-003" };
  const soloStack = [{ sessionKey: "easy:easy-003", cellIndex: 0 }];
  const canUndoSolo = canUndoLastMoveFactory(
    { soloUndoStack: soloStack, activeRound: { status: "active", protocolVersion: 3 } },
    () => soloSession,
    () => false,
    () => false,
    () => soloStack,
  );

  assert.equal(canUndoSolo(), true);
  assert.equal(canUndoSolo({ hasWon: true, difficulty: "easy", puzzleId: "easy-003" }), false);

  const versusState = { activeRound: { status: "active" } };
  const canUndoVersus = canUndoLastMoveFactory(
    versusState,
    () => soloSession,
    () => true,
    () => false,
    () => [],
  );

  assert.equal(canUndoVersus(), true);

  const canUndoFrozen = canUndoLastMoveFactory(
    versusState,
    () => soloSession,
    () => true,
    () => true,
    () => [],
  );

  assert.equal(canUndoFrozen(), false);

  const canUndoCompleted = canUndoLastMoveFactory(
    { activeRound: { status: "completed" } },
    () => soloSession,
    () => true,
    () => false,
    () => [],
  );

  assert.equal(canUndoCompleted(), false);
});

test("Phase F restart availability follows started state and authoritative round status", () => {
  const session = { hasWon: false, difficulty: "easy", puzzleId: "easy-003" };
  const canRestartIdle = canRestartCurrentRoundFactory(
    {},
    () => session,
    () => false,
    () => false,
  );
  const canRestartStarted = canRestartCurrentRoundFactory(
    {},
    () => session,
    () => false,
    () => true,
  );

  assert.equal(canRestartIdle(), false);
  assert.equal(canRestartStarted(), true);
  assert.equal(canRestartIdle({ hasWon: true, difficulty: "easy", puzzleId: "easy-003" }), true);

  const canRestartVersusActive = canRestartCurrentRoundFactory(
    { activeRound: { status: "active" } },
    () => session,
    () => true,
    () => true,
  );
  const canRestartVersusCompleted = canRestartCurrentRoundFactory(
    { activeRound: { status: "completed" } },
    () => session,
    () => true,
    () => true,
  );

  assert.equal(canRestartVersusActive(), true);
  assert.equal(canRestartVersusCompleted(), false);
});

test("Phase F solo undo snapshots and restores editable cell state", () => {
  const cell = {
    value: "7",
    owner: "A",
    peerEdited: false,
    claimCorrect: null,
    notes: { 1: true, 2: true },
    duel: { A: true },
    harmonyAt: 100,
    harmonyDigit: "7",
    lastMoveAt: 200,
    lastMoveBy: "A",
  };

  const snapshot = snapshotSoloCell(cell);

  cell.value = "";
  cell.owner = null;
  cell.notes = {};
  cell.duel = null;
  cell.harmonyDigit = null;

  restoreSoloCell(cell, snapshot);

  assert.equal(cell.value, "7");
  assert.equal(cell.owner, "A");
  assert.deepEqual(cell.notes, { 1: true, 2: true });
  assert.deepEqual(cell.duel, { A: true });
  assert.equal(cell.harmonyDigit, "7");
  assert.equal(snapshotSoloCell(null), null);
});
