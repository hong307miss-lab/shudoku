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
