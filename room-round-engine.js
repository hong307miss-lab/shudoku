const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const ROUND_PROTOCOL_VERSION = 3;
const ROUND_ENGINE_VERSION = "p2-phase-d";

const ROUND_TIMINGS = Object.freeze({
  contestWindowMs: 320,
  versusFreezeDurationMs: 1500,
  coopHeartWindowMs: 180,
  coopEffectDurationMs: 900,
  versusEffectDurationMs: 700,
});

const VERSUS_SCORING_RULES = Object.freeze({
  correctClaimPoints: 1,
  wrongClaimPoints: -1,
  contestBonusPoints: 0,
  bombPenaltyPoints: 0,
});

const MAX_REQUEST_LEDGER_SIZE = 256;
const MAX_UNDO_STACK_SIZE = 64;

const puzzleBankCache = new Map();
const puzzleSolutionCache = new Map();

const PUZZLE_BANK_FILES = Object.freeze({
  easy: {
    filePath: path.join(__dirname, "puzzle-bank", "easy.js"),
    globalName: "SUDOKU_PUZZLE_BANK_EASY",
  },
  medium: {
    filePath: path.join(__dirname, "puzzle-bank", "medium.js"),
    globalName: "SUDOKU_PUZZLE_BANK_MEDIUM",
  },
  hard: {
    filePath: path.join(__dirname, "puzzle-bank", "hard.js"),
    globalName: "SUDOKU_PUZZLE_BANK_HARD",
  },
});

const CONTENT_CONFIG_FILE = path.join(__dirname, "game-content.js");
const CONTENT_CONFIG_GLOBAL = "SUDOKU_CONTENT";
let contentConfigCache = null;

class RoundRevisionMismatchError extends Error {
  constructor(expectedRevision, receivedRevision) {
    super(`Round revision mismatch. Expected ${expectedRevision}, received ${receivedRevision}.`);
    this.name = "RoundRevisionMismatchError";
    this.code = "ROUND_REVISION_MISMATCH";
    this.expectedRevision = expectedRevision;
    this.receivedRevision = receivedRevision;
  }
}

function cloneCell(cell) {
  return {
    given: cell.given === true,
    value: typeof cell.value === "string" ? cell.value : "",
    owner: cell.owner === "A" || cell.owner === "B" || cell.owner === "given" ? cell.owner : null,
    peerEdited: cell.peerEdited === true,
    locked: cell.locked === true,
    claimCorrect: cell.claimCorrect === true ? true : cell.claimCorrect === false ? false : null,
    notes: cloneNotes(cell.notes),
    version: Number.isInteger(cell.version) ? cell.version : 0,
    lastCommitAt: Number.isFinite(cell.lastCommitAt) ? Number(cell.lastCommitAt) : null,
    lastCommitBy: cell.lastCommitBy === "A" || cell.lastCommitBy === "B" ? cell.lastCommitBy : null,
  };
}

function cloneUndoStackByPlayer(undoStackByPlayer) {
  const source = undoStackByPlayer && typeof undoStackByPlayer === "object" ? undoStackByPlayer : {};

  return {
    A: Array.isArray(source.A) ? source.A.map(cloneUndoEntry) : [],
    B: Array.isArray(source.B) ? source.B.map(cloneUndoEntry) : [],
  };
}

function cloneUndoEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return {};
  }

  return {
    cellIndex: Number.isInteger(entry.cellIndex) ? entry.cellIndex : -1,
    action: typeof entry.action === "string" ? entry.action : "set",
    digit: typeof entry.digit === "string" ? entry.digit : "",
    scored: entry.scored === true,
    before: cloneCell(entry.before),
    after: cloneCell(entry.after),
  };
}

function cloneRoundState(roundState) {
  return {
    ...roundState,
    scoringRules: { ...roundState.scoringRules },
    timings: { ...roundState.timings },
    scores: { ...roundState.scores },
    restartVotes: {
      A: roundState.restartVotes?.A === true,
      B: roundState.restartVotes?.B === true,
    },
    undoStackByPlayer: cloneUndoStackByPlayer(roundState.undoStackByPlayer),
    playerStates: {
      A: { ...roundState.playerStates.A },
      B: { ...roundState.playerStates.B },
    },
    cells: roundState.cells.map(cloneCell),
    recentEffects: roundState.recentEffects.map((effect) => ({ ...effect })),
    requestLedger: {
      requestIds: [...roundState.requestLedger.requestIds],
      lastClientSeqByPlayer: {
        A: Number.isInteger(roundState.requestLedger.lastClientSeqByPlayer.A)
          ? roundState.requestLedger.lastClientSeqByPlayer.A
          : 0,
        B: Number.isInteger(roundState.requestLedger.lastClientSeqByPlayer.B)
          ? roundState.requestLedger.lastClientSeqByPlayer.B
          : 0,
      },
    },
    interactionLedger: {
      byCell: Object.fromEntries(
        Object.entries(roundState.interactionLedger?.byCell || {}).map(([cellIndex, submission]) => [
          cellIndex,
          cloneInteractionEntry(submission),
        ]),
      ),
    },
  };
}

function cloneInteractionEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return {};
  }

  return {
    ...entry,
    resolvedLosers: entry.resolvedLosers && typeof entry.resolvedLosers === "object"
      ? { ...entry.resolvedLosers }
      : {},
  };
}

function createEmptyNotes() {
  return { A: {}, B: {} };
}

function cloneNotes(notes) {
  const source = notes && typeof notes === "object" && !Array.isArray(notes) ? notes : {};
  const nextNotes = createEmptyNotes();

  ["A", "B"].forEach((seat) => {
    const seatNotes = source[seat];

    if (!seatNotes || typeof seatNotes !== "object" || Array.isArray(seatNotes)) {
      return;
    }

    Object.keys(seatNotes).forEach((digit) => {
      if (/^[1-9]$/.test(digit) && seatNotes[digit]) {
        nextNotes[seat][digit] = true;
      }
    });
  });

  return nextNotes;
}

function readPuzzleBank(difficulty) {
  if (puzzleBankCache.has(difficulty)) {
    return puzzleBankCache.get(difficulty);
  }

  const descriptor = PUZZLE_BANK_FILES[difficulty];

  if (!descriptor) {
    throw new Error(`Unsupported puzzle difficulty: ${difficulty}`);
  }

  const code = fs.readFileSync(descriptor.filePath, "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox, { filename: descriptor.filePath });
  const puzzles = Array.isArray(sandbox.window[descriptor.globalName])
    ? sandbox.window[descriptor.globalName].map((entry) => ({ ...entry }))
    : [];

  puzzleBankCache.set(difficulty, puzzles);
  return puzzles;
}

function readContentConfig() {
  if (contentConfigCache) {
    return contentConfigCache;
  }

  const code = fs.readFileSync(CONTENT_CONFIG_FILE, "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox, { filename: CONTENT_CONFIG_FILE });
  contentConfigCache = sandbox.window[CONTENT_CONFIG_GLOBAL] && typeof sandbox.window[CONTENT_CONFIG_GLOBAL] === "object"
    ? { ...sandbox.window[CONTENT_CONFIG_GLOBAL] }
    : {};
  return contentConfigCache;
}

function getStandardDailyPuzzleCount() {
  const puzzlePolicy = readContentConfig().puzzlePolicy;
  const configuredCount = Number(puzzlePolicy?.standardDailyCount);
  return Math.max(1, Number.isFinite(configuredCount) ? configuredCount : 3);
}

function getDailyPuzzleDateKey(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function hashString(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function greatestCommonDivisor(a, b) {
  let left = Math.abs(a);
  let right = Math.abs(b);

  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }

  return left || 1;
}

function getDailyPuzzleConfigs(difficulty, requestedCount = getStandardDailyPuzzleCount()) {
  const puzzles = readPuzzleBank(difficulty);

  if (puzzles.length <= requestedCount) {
    return puzzles;
  }

  const todayKey = getDailyPuzzleDateKey();
  const selected = [];
  const start = hashString(`${todayKey}:${difficulty}:start`) % puzzles.length;
  let step = (hashString(`${todayKey}:${difficulty}:step`) % (puzzles.length - 1)) + 1;

  while (greatestCommonDivisor(step, puzzles.length) !== 1) {
    step = (step % (puzzles.length - 1)) + 1;
  }

  for (let offset = 0; offset < requestedCount; offset += 1) {
    selected.push(puzzles[(start + step * offset) % puzzles.length]);
  }

  return selected;
}

function solvePuzzleString(puzzleString) {
  const cells = String(puzzleString || "").split("");
  const rows = Array.from({ length: 9 }, () => new Set());
  const cols = Array.from({ length: 9 }, () => new Set());
  const boxes = Array.from({ length: 9 }, () => new Set());
  const empties = [];

  for (let index = 0; index < 81; index += 1) {
    const digit = cells[index];
    const row = Math.floor(index / 9);
    const col = index % 9;
    const box = Math.floor(row / 3) * 3 + Math.floor(col / 3);

    if (digit === "0") {
      empties.push(index);
      continue;
    }

    rows[row].add(digit);
    cols[col].add(digit);
    boxes[box].add(digit);
  }

  function backtrack(emptyIndex = 0) {
    if (emptyIndex >= empties.length) {
      return true;
    }

    let bestIndex = emptyIndex;
    let bestOptions = null;

    for (let cursor = emptyIndex; cursor < empties.length; cursor += 1) {
      const cellIndex = empties[cursor];
      const row = Math.floor(cellIndex / 9);
      const col = cellIndex % 9;
      const box = Math.floor(row / 3) * 3 + Math.floor(col / 3);
      const options = [];

      for (let digit = 1; digit <= 9; digit += 1) {
        const value = String(digit);

        if (!rows[row].has(value) && !cols[col].has(value) && !boxes[box].has(value)) {
          options.push(value);
        }
      }

      if (!bestOptions || options.length < bestOptions.length) {
        bestIndex = cursor;
        bestOptions = options;
      }

      if (!bestOptions.length) {
        return false;
      }
    }

    [empties[emptyIndex], empties[bestIndex]] = [empties[bestIndex], empties[emptyIndex]];
    const cellIndex = empties[emptyIndex];
    const row = Math.floor(cellIndex / 9);
    const col = cellIndex % 9;
    const box = Math.floor(row / 3) * 3 + Math.floor(col / 3);

    for (const value of bestOptions) {
      cells[cellIndex] = value;
      rows[row].add(value);
      cols[col].add(value);
      boxes[box].add(value);

      if (backtrack(emptyIndex + 1)) {
        return true;
      }

      cells[cellIndex] = "0";
      rows[row].delete(value);
      cols[col].delete(value);
      boxes[box].delete(value);
    }

    return false;
  }

  return backtrack() ? cells.join("") : "";
}

function getPuzzleConfigForSelection(selection = {}) {
  const difficulty = String(selection.difficulty || "").trim().toLowerCase();
  const puzzleId = String(selection.puzzleId || "").trim();
  const puzzleIndex = Number(selection.puzzleIndex);
  const puzzles = readPuzzleBank(difficulty);

  if (puzzleId) {
    const byId = puzzles.find((entry) => entry.id === puzzleId);

    if (byId) {
      return byId;
    }
  }

  if (Number.isInteger(puzzleIndex) && puzzleIndex >= 0 && puzzleIndex < puzzles.length) {
    return puzzles[puzzleIndex];
  }

  return null;
}

function resolveAuthoritativeSelection(selection = {}) {
  const difficulty = String(selection.difficulty || "").trim().toLowerCase();
  const puzzleIndex = Number(selection.puzzleIndex);

  if (!PUZZLE_BANK_FILES[difficulty] || !Number.isInteger(puzzleIndex) || puzzleIndex < 0) {
    return null;
  }

  const puzzles = getDailyPuzzleConfigs(difficulty);

  if (puzzleIndex >= puzzles.length) {
    return null;
  }

  const config = puzzles[puzzleIndex];

  return {
    difficulty,
    puzzleId: config.id,
    puzzleIndex,
    sessionKey: `${difficulty}:${config.id}`,
  };
}

function getPuzzleSolution(difficulty, puzzleId, puzzleString) {
  const cacheKey = `${difficulty}:${puzzleId}`;

  if (puzzleSolutionCache.has(cacheKey)) {
    return puzzleSolutionCache.get(cacheKey);
  }

  const solution = solvePuzzleString(puzzleString);
  puzzleSolutionCache.set(cacheKey, solution);
  return solution;
}

function createAuthoritativeCell(value) {
  if (value !== "0") {
    return {
      given: true,
      value,
      owner: "given",
      peerEdited: false,
      locked: true,
      claimCorrect: null,
      notes: createEmptyNotes(),
      version: 1,
      lastCommitAt: null,
      lastCommitBy: null,
    };
  }

  return {
    given: false,
    value: "",
    owner: null,
    peerEdited: false,
    locked: false,
    claimCorrect: null,
    notes: createEmptyNotes(),
    version: 0,
    lastCommitAt: null,
    lastCommitBy: null,
  };
}

function createAuthoritativeRoundState(options = {}) {
  const selection = resolveAuthoritativeSelection(options.selection || {});
  const config = selection ? getPuzzleConfigForSelection(selection) : null;

  if (!config) {
    throw new Error("Unable to initialize authoritative round state for the requested puzzle.");
  }

  const difficulty = String(selection.difficulty || "").trim().toLowerCase();
  const puzzleIndex = selection.puzzleIndex;
  const createdAt = Number.isFinite(options.createdAt) ? Number(options.createdAt) : Date.now();
  const puzzleString = String(config.puzzle || "");

  if (!/^[0-9]{81}$/.test(puzzleString)) {
    throw new Error("Authoritative round state requires a valid 81-cell puzzle string.");
  }

  const solution = getPuzzleSolution(difficulty, config.id, puzzleString);

  if (!/^[1-9]{81}$/.test(solution)) {
    throw new Error("Authoritative round state requires a solvable puzzle.");
  }

  return {
    protocolVersion: ROUND_PROTOCOL_VERSION,
    engineVersion: ROUND_ENGINE_VERSION,
    roundId: `round-${createdAt}-${crypto.randomBytes(4).toString("hex")}`,
    status: "active",
    matchMode: String(options.matchMode || "coop").trim().toLowerCase() === "versus" ? "versus" : "coop",
    sessionKey: String(selection.sessionKey || `${difficulty}:${config.id}`).trim(),
    difficulty,
    puzzleId: config.id,
    puzzleIndex,
    puzzle: puzzleString,
    solution,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    completedEventId: null,
    restartEventId: null,
    restartVotes: { A: false, B: false },
    undoStackByPlayer: { A: [], B: [] },
    scoringRules: { ...VERSUS_SCORING_RULES },
    timings: { ...ROUND_TIMINGS },
    scores: { A: 0, B: 0 },
    playerStates: {
      A: {
        freezeUntil: 0,
        lastAcceptedSeq: 0,
      },
      B: {
        freezeUntil: 0,
        lastAcceptedSeq: 0,
      },
    },
    cells: puzzleString.split("").map((value) => createAuthoritativeCell(value)),
    recentEffects: [],
    requestLedger: {
      requestIds: [],
      lastClientSeqByPlayer: { A: 0, B: 0 },
    },
    interactionLedger: {
      byCell: {},
    },
  };
}

function toPublicNotes(cell, viewer) {
  if (viewer !== "A" && viewer !== "B") {
    return {};
  }

  const seatNotes = cell.notes?.[viewer];

  if (!seatNotes || typeof seatNotes !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.keys(seatNotes)
      .filter((digit) => /^[1-9]$/.test(digit) && seatNotes[digit])
      .map((digit) => [digit, viewer]),
  );
}

function toPublicRoundState(roundState, now = Date.now(), viewer = null) {
  if (!roundState || typeof roundState !== "object") {
    return null;
  }

  return {
    protocolVersion: ROUND_PROTOCOL_VERSION,
    engineVersion: ROUND_ENGINE_VERSION,
    roundId: roundState.roundId,
    status: roundState.status,
    matchMode: roundState.matchMode,
    sessionKey: roundState.sessionKey,
    difficulty: roundState.difficulty,
    puzzleId: roundState.puzzleId,
    puzzleIndex: roundState.puzzleIndex,
    revision: roundState.revision,
    createdAt: roundState.createdAt,
    updatedAt: roundState.updatedAt,
    completedAt: roundState.completedAt,
    completedEventId: roundState.completedEventId || null,
    restartEventId: roundState.restartEventId || null,
    restartVotes: {
      A: roundState.restartVotes?.A === true,
      B: roundState.restartVotes?.B === true,
    },
    scoringRules: { ...roundState.scoringRules },
    timings: { ...roundState.timings },
    scores: { ...roundState.scores },
    playerStates: {
      A: {
        freezeUntil: roundState.playerStates.A.freezeUntil,
        freezeRemainingMs: Math.max(0, roundState.playerStates.A.freezeUntil - now),
      },
      B: {
        freezeUntil: roundState.playerStates.B.freezeUntil,
        freezeRemainingMs: Math.max(0, roundState.playerStates.B.freezeUntil - now),
      },
    },
    cells: roundState.cells.map((cell) => ({
      ...cloneCell(cell),
      notes: toPublicNotes(cell, viewer),
    })),
    recentEffects: roundState.recentEffects
      .filter((effect) => !Number.isFinite(effect.expiresAt) || effect.expiresAt > now)
      .map((effect) => ({ ...effect })),
  };
}

function updateAuthoritativeRoundState(roundState, options = {}) {
  if (!roundState || typeof roundState !== "object") {
    throw new Error("Round state is required.");
  }

  const baseRevision = Number(options.baseRevision);

  if (Number.isFinite(baseRevision) && baseRevision !== roundState.revision) {
    throw new RoundRevisionMismatchError(roundState.revision, baseRevision);
  }

  const nextRoundState = cloneRoundState(roundState);

  if (typeof options.mutate === "function") {
    options.mutate(nextRoundState);
  }

  const nextUpdatedAt = Number.isFinite(options.updatedAt) ? Number(options.updatedAt) : Date.now();
  nextRoundState.updatedAt = nextUpdatedAt;
  nextRoundState.revision += 1;
  nextRoundState.protocolVersion = ROUND_PROTOCOL_VERSION;
  nextRoundState.engineVersion = ROUND_ENGINE_VERSION;
  return nextRoundState;
}

function getRelatedIndexes(index) {
  const row = Math.floor(index / 9);
  const col = index % 9;
  const boxRow = Math.floor(row / 3) * 3;
  const boxCol = Math.floor(col / 3) * 3;
  const related = new Set();

  for (let i = 0; i < 9; i += 1) {
    related.add(row * 9 + i);
    related.add(i * 9 + col);
  }

  for (let r = boxRow; r < boxRow + 3; r += 1) {
    for (let c = boxCol; c < boxCol + 3; c += 1) {
      related.add(r * 9 + c);
    }
  }

  related.delete(index);
  return related;
}

function clearPeerNotesForDigit(cells, index, digit) {
  if (!/^[1-9]$/.test(String(digit || ""))) {
    return;
  }

  getRelatedIndexes(index).forEach((relatedIndex) => {
    const relatedCell = cells[relatedIndex];

    if (!relatedCell || relatedCell.given || relatedCell.value) {
      return;
    }

    ["A", "B"].forEach((seat) => {
      if (relatedCell.notes?.[seat]) {
        delete relatedCell.notes[seat][digit];
      }
    });
  });
}

function sanitizeAction(action, matchMode) {
  const normalized = String(action || "").trim().toLowerCase();

  if (normalized === "clear") {
    return "clear";
  }

  if (normalized === "note_toggle") {
    return "note_toggle";
  }

  return "set";
}

function sanitizeSubmissionDigit(digit, action) {
  if (action === "clear") {
    return "";
  }

  const normalized = String(digit || "").trim();
  return /^[1-9]$/.test(normalized) ? normalized : "";
}

function sanitizeRequestId(value) {
  const normalized = String(value || "").trim();
  return /^[a-z0-9:_-]{8,128}$/i.test(normalized) ? normalized : "";
}

function sanitizeObservedCellVersion(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

function isDuplicateRequest(roundState, requestId) {
  return Boolean(requestId && roundState.requestLedger.requestIds.includes(requestId));
}

function createEffectId() {
  return `fx-${crypto.randomBytes(6).toString("hex")}`;
}

function pruneExpiredEffects(nextRoundState, now) {
  nextRoundState.recentEffects = nextRoundState.recentEffects.filter((effect) => (
    !Number.isFinite(effect.expiresAt) || effect.expiresAt > now
  ));
}

function pruneInteractionLedger(nextRoundState, now) {
  const maxAge = Number(nextRoundState.timings.contestWindowMs || 0) * 2;

  nextRoundState.interactionLedger.byCell = Object.fromEntries(
    Object.entries(nextRoundState.interactionLedger.byCell || {}).filter(([, submission]) => (
      submission
      && Number.isFinite(submission.receivedAt)
      && now - submission.receivedAt <= maxAge
    )),
  );
}

function createRoundEffect(kind, options = {}) {
  const startedAt = Number.isFinite(options.startedAt) ? Number(options.startedAt) : Date.now();
  const durationMs = Number.isFinite(options.durationMs) ? Number(options.durationMs) : 0;

  return {
    effectId: createEffectId(),
    kind,
    cellIndex: Number(options.cellIndex),
    digit: typeof options.digit === "string" ? options.digit : "",
    players: Array.isArray(options.players) ? [...options.players] : [],
    winner: options.winner === "A" || options.winner === "B" ? options.winner : null,
    loser: options.loser === "A" || options.loser === "B" ? options.loser : null,
    startedAt,
    expiresAt: startedAt + durationMs,
  };
}

function getRecentCellSubmission(nextRoundState, cellIndex, now) {
  const submission = nextRoundState.interactionLedger.byCell[cellIndex];

  if (!submission || !Number.isFinite(submission.receivedAt)) {
    return null;
  }

  if (now - submission.receivedAt > nextRoundState.timings.contestWindowMs) {
    delete nextRoundState.interactionLedger.byCell[cellIndex];
    return null;
  }

  return submission;
}

function registerRequest(nextRoundState, requestId, player, clientSeq) {
  if (requestId) {
    nextRoundState.requestLedger.requestIds.push(requestId);

    if (nextRoundState.requestLedger.requestIds.length > MAX_REQUEST_LEDGER_SIZE) {
      nextRoundState.requestLedger.requestIds.splice(
        0,
        nextRoundState.requestLedger.requestIds.length - MAX_REQUEST_LEDGER_SIZE,
      );
    }
  }

  if (player === "A" || player === "B") {
    const safeSeq = Number.isInteger(clientSeq) && clientSeq > 0 ? clientSeq : 0;
    nextRoundState.requestLedger.lastClientSeqByPlayer[player] = Math.max(
      nextRoundState.requestLedger.lastClientSeqByPlayer[player] || 0,
      safeSeq,
    );
    nextRoundState.playerStates[player].lastAcceptedSeq = nextRoundState.requestLedger.lastClientSeqByPlayer[player];
  }
}

function registerCellInteraction(nextRoundState, cellIndex, submission) {
  nextRoundState.interactionLedger.byCell[cellIndex] = {
    ...submission,
    resolvedLosers: submission.resolvedLosers && typeof submission.resolvedLosers === "object"
      ? { ...submission.resolvedLosers }
      : {},
  };
}

function isPlayerFrozen(roundState, player, now = Date.now()) {
  if (player !== "A" && player !== "B") {
    return false;
  }

  return Number(roundState.playerStates[player]?.freezeUntil || 0) > now;
}

function recordUndoEntry(nextRoundState, player, entry) {
  if (player !== "A" && player !== "B") {
    return;
  }

  const stack = nextRoundState.undoStackByPlayer[player];

  stack.push({
    cellIndex: entry.cellIndex,
    action: entry.action,
    digit: entry.digit,
    scored: entry.scored === true,
    before: cloneCell(entry.before),
    after: cloneCell(entry.after),
  });

  if (stack.length > MAX_UNDO_STACK_SIZE) {
    stack.splice(0, stack.length - MAX_UNDO_STACK_SIZE);
  }
}

function applyVersusCellSubmit(nextRoundState, cell, player, digit, now) {
  const solutionDigit = nextRoundState.solution[cell.index];
  const isCorrect = solutionDigit === digit;
  const previousVersion = cell.version;

  cell.value = digit;
  cell.owner = player;
  cell.peerEdited = false;
  cell.claimCorrect = isCorrect;
  cell.notes = createEmptyNotes();
  cell.locked = isCorrect;
  cell.lastCommitAt = now;
  cell.lastCommitBy = player;
  cell.version += 1;

  if (isCorrect) {
    nextRoundState.scores[player] += nextRoundState.scoringRules.correctClaimPoints;
  } else {
    nextRoundState.scores[player] += nextRoundState.scoringRules.wrongClaimPoints;
  }

  registerCellInteraction(nextRoundState, cell.index, {
    kind: "versus_claim",
    winner: player,
    digit,
    isCorrect,
    claimAt: now,
    receivedAt: now,
    cellVersionBeforeClaim: previousVersion,
    cellVersionAfterClaim: cell.version,
    resolvedLosers: {},
  });

  return isCorrect;
}

function clearVersusOwnCell(nextRoundState, cell, player, now) {
  cell.value = "";
  cell.owner = null;
  cell.peerEdited = false;
  cell.claimCorrect = null;
  cell.locked = false;
  cell.notes = createEmptyNotes();
  cell.lastCommitAt = now;
  cell.lastCommitBy = player;
  cell.version += 1;
  delete nextRoundState.interactionLedger.byCell[cell.index];
}

function applyNoteToggle(nextRoundState, cell, player, digit, now) {
  const seatNotes = cell.notes[player] || (cell.notes[player] = {});

  if (seatNotes[digit]) {
    delete seatNotes[digit];
  } else {
    seatNotes[digit] = true;
  }

  cell.lastCommitAt = now;
  cell.lastCommitBy = player;
  cell.version += 1;
  delete nextRoundState.interactionLedger.byCell[cell.index];
}

function applyCoopCellSubmit(nextRoundState, cell, player, action, digit, now) {
  const cellIndex = cell.index;

  if (action === "note_toggle") {
    if (cell.value) {
      throw new Error("Cannot edit notes on a filled cell.");
    }

    applyNoteToggle(nextRoundState, cell, player, digit, now);
    return;
  }

  if (action === "clear") {
    if (cell.value) {
      cell.value = "";
      cell.owner = null;
      cell.peerEdited = false;
      cell.claimCorrect = null;
      cell.notes = createEmptyNotes();
    } else {
      cell.notes[player] = {};
    }

    cell.lastCommitAt = now;
    cell.lastCommitBy = player;
    cell.version += 1;
    delete nextRoundState.interactionLedger.byCell[cellIndex];
    return;
  }

  const solutionDigit = nextRoundState.solution[cellIndex];
  const incomingCorrect = digit === solutionDigit;
  const currentCorrect = cell.value === solutionDigit;
  const previousOwner = cell.owner;
  const wasPeerEdited = Boolean(cell.owner && cell.owner !== player && cell.value && cell.value !== digit);
  const previousSubmission = getRecentCellSubmission(nextRoundState, cellIndex, now);

  if (
    previousSubmission
    && previousSubmission.player !== player
    && previousSubmission.action === "set"
  ) {
    if (
      previousSubmission.digit === digit
      && previousSubmission.isCorrect
      && incomingCorrect
    ) {
      nextRoundState.recentEffects.push(createRoundEffect("coop_heart", {
        cellIndex,
        digit,
        players: [previousSubmission.player, player],
        startedAt: now,
        durationMs: nextRoundState.timings.coopEffectDurationMs,
      }));
    } else if (previousSubmission.digit !== digit) {
      nextRoundState.recentEffects.push(createRoundEffect("coop_clash", {
        cellIndex,
        digit: incomingCorrect ? digit : previousSubmission.digit,
        players: [previousSubmission.player, player],
        startedAt: now,
        durationMs: nextRoundState.timings.coopEffectDurationMs,
      }));
    }
  }

  if (incomingCorrect) {
    cell.value = digit;
    cell.owner = (
      previousSubmission
      && previousSubmission.player !== player
      && previousSubmission.digit === digit
      && previousSubmission.isCorrect
    ) ? null : player;
    cell.peerEdited = Boolean(previousOwner && previousOwner !== player && cell.value && cell.value !== digit);
  } else if (currentCorrect) {
    cell.value = solutionDigit;
  } else {
    cell.value = digit;
    cell.owner = player;
    cell.peerEdited = wasPeerEdited;
  }

  cell.claimCorrect = null;
  cell.notes = createEmptyNotes();
  cell.lastCommitAt = now;
  cell.lastCommitBy = player;
  cell.version += 1;
  clearPeerNotesForDigit(nextRoundState.cells, cell.index, digit);
  registerCellInteraction(nextRoundState, cellIndex, {
    player,
    action: "set",
    digit,
    isCorrect: incomingCorrect,
    receivedAt: now,
  });
}

function isCellSolved(nextRoundState, cell, index) {
  if (cell.given) {
    return true;
  }

  return cell.locked || cell.value === nextRoundState.solution[index];
}

function maybeCompleteRound(nextRoundState, now) {
  if (nextRoundState.status !== "active") {
    return;
  }

  const roundSolved = nextRoundState.cells.every((cell, index) => isCellSolved(nextRoundState, cell, index));

  if (!roundSolved) {
    return;
  }

  nextRoundState.status = "completed";
  nextRoundState.completedAt = now;
  nextRoundState.completedEventId = nextRoundState.completedEventId || `complete-${nextRoundState.roundId}-${now}`;
  nextRoundState.restartVotes = { A: false, B: false };
  nextRoundState.undoStackByPlayer = { A: [], B: [] };
  nextRoundState.recentEffects = [];
  nextRoundState.interactionLedger.byCell = {};
  nextRoundState.playerStates.A.freezeUntil = 0;
  nextRoundState.playerStates.B.freezeUntil = 0;
}

function canQualifyForVersusContest(nextRoundState, cell, player, digit, now, options = {}) {
  const interaction = nextRoundState.interactionLedger.byCell[cell.index];

  if (!interaction || interaction.kind !== "versus_claim") {
    return { qualifies: false, reason: "no_recent_claim" };
  }

  const observedCellVersion = sanitizeObservedCellVersion(options.observedCellVersion);
  const observedCellLocked = options.observedCellLocked === true;
  const withinWindow = now - interaction.claimAt <= nextRoundState.timings.contestWindowMs;
  const correctDigit = nextRoundState.solution[cell.index] === digit;
  const differentPlayer = interaction.winner && interaction.winner !== player;
  const unresolved = !interaction.resolvedLosers?.[player];
  const sawOpenCell = observedCellLocked === false && observedCellVersion === interaction.cellVersionBeforeClaim;

  if (
    interaction.isCorrect
    && withinWindow
    && correctDigit
    && differentPlayer
    && unresolved
    && sawOpenCell
  ) {
    return {
      qualifies: true,
      interaction,
    };
  }

  return { qualifies: false, reason: "claim_not_eligible" };
}

function applyVersusContestLoss(nextRoundState, cell, player, now, interaction) {
  nextRoundState.playerStates[player].freezeUntil = Math.max(
    Number(nextRoundState.playerStates[player].freezeUntil || 0),
    now + nextRoundState.timings.versusFreezeDurationMs,
  );

  interaction.resolvedLosers[player] = true;
  nextRoundState.recentEffects.push(createRoundEffect("versus_contest", {
    cellIndex: cell.index,
    digit: interaction.digit,
    winner: interaction.winner,
    loser: player,
    players: [interaction.winner, player],
    startedAt: now,
    durationMs: nextRoundState.timings.versusEffectDurationMs,
  }));
}

function submitAuthoritativeCell(roundState, options = {}) {
  if (!roundState || typeof roundState !== "object") {
    throw new Error("Round state is required.");
  }

  const player = options.player === "A" || options.player === "B" ? options.player : "";
  const requestId = sanitizeRequestId(options.requestId);
  const cellIndex = Number(options.cellIndex);
  const clientSeq = Number(options.clientSeq);
  const now = Number.isFinite(options.receivedAt) ? Number(options.receivedAt) : Date.now();
  const observedCellVersion = sanitizeObservedCellVersion(options.observedCellVersion);
  const observedCellLocked = options.observedCellLocked === true;

  if (!player) {
    throw new Error("Player seat is required.");
  }

  if (roundState.status !== "active") {
    throw new Error("Round is not active.");
  }

  if (options.roundId !== roundState.roundId) {
    throw new Error("Round has changed. Refresh to continue.");
  }

  if (!requestId) {
    throw new Error("Request id is required.");
  }

  if (isDuplicateRequest(roundState, requestId)) {
    return {
      roundState,
      duplicate: true,
      accepted: false,
    };
  }

  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= roundState.cells.length) {
    throw new Error("Cell index is invalid.");
  }

  if (isPlayerFrozen(roundState, player, now)) {
    throw new Error("Player is frozen.");
  }

  const action = sanitizeAction(options.action, roundState.matchMode);
  const digit = sanitizeSubmissionDigit(options.digit, action);

  if (action !== "clear" && !digit) {
    throw new Error("Digit is invalid.");
  }

  const nextRoundState = cloneRoundState(roundState);
  pruneExpiredEffects(nextRoundState, now);
  pruneInteractionLedger(nextRoundState, now);
  const cell = nextRoundState.cells[cellIndex];
  cell.index = cellIndex;

  if (!cell || cell.given) {
    throw new Error("Cell cannot be edited.");
  }

  registerRequest(nextRoundState, requestId, player, clientSeq);
  const beforeCell = cloneCell(roundState.cells[cellIndex]);

  if (nextRoundState.matchMode === "versus") {
    if (cell.locked) {
      const contest = canQualifyForVersusContest(nextRoundState, cell, player, digit, now, {
        observedCellVersion,
        observedCellLocked,
      });

      if (!contest.qualifies) {
        throw new Error("Cell is already claimed.");
      }

      applyVersusContestLoss(nextRoundState, cell, player, now, contest.interaction);
    } else if (cell.value) {
      if (cell.owner !== player) {
        throw new Error("Cell is already claimed.");
      }

      if (action === "note_toggle") {
        throw new Error("Cannot edit notes on a filled cell.");
      }

      if (action === "clear") {
        clearVersusOwnCell(nextRoundState, cell, player, now);
        recordUndoEntry(nextRoundState, player, { cellIndex, action, digit, before: beforeCell, after: cell });
      } else if (!applyVersusCellSubmit(nextRoundState, cell, player, digit, now)) {
        recordUndoEntry(nextRoundState, player, { cellIndex, action, digit, before: beforeCell, after: cell });
      }
    } else if (action === "note_toggle") {
      applyNoteToggle(nextRoundState, cell, player, digit, now);
      recordUndoEntry(nextRoundState, player, { cellIndex, action, digit, before: beforeCell, after: cell });
    } else if (action === "clear") {
      cell.notes[player] = {};
      cell.lastCommitAt = now;
      cell.lastCommitBy = player;
      cell.version += 1;
      recordUndoEntry(nextRoundState, player, { cellIndex, action, digit, before: beforeCell, after: cell });
    } else if (!applyVersusCellSubmit(nextRoundState, cell, player, digit, now)) {
      recordUndoEntry(nextRoundState, player, { cellIndex, action, digit, before: beforeCell, after: cell });
    }
  } else {
    applyCoopCellSubmit(nextRoundState, cell, player, action, digit, now);
    recordUndoEntry(nextRoundState, player, { cellIndex, action, digit, before: beforeCell, after: cell });
  }

  delete cell.index;
  nextRoundState.updatedAt = now;
  nextRoundState.revision += 1;
  maybeCompleteRound(nextRoundState, now);

  return {
    roundState: nextRoundState,
    duplicate: false,
    accepted: true,
  };
}

function undoAuthoritativeCell(roundState, options = {}) {
  if (!roundState || typeof roundState !== "object") {
    throw new Error("Round state is required.");
  }

  const player = options.player === "A" || options.player === "B" ? options.player : "";
  const requestId = sanitizeRequestId(options.requestId);
  const now = Number.isFinite(options.receivedAt) ? Number(options.receivedAt) : Date.now();

  if (!player) {
    throw new Error("Player seat is required.");
  }

  if (roundState.status !== "active") {
    throw new Error("Round is not active.");
  }

  if (options.roundId !== roundState.roundId) {
    throw new Error("Round has changed. Refresh to continue.");
  }

  if (!requestId) {
    throw new Error("Request id is required.");
  }

  if (isDuplicateRequest(roundState, requestId)) {
    return {
      roundState,
      duplicate: true,
      accepted: false,
    };
  }

  const stack = roundState.undoStackByPlayer?.[player] || [];
  const entry = stack[stack.length - 1];

  if (!entry) {
    throw new Error("Nothing to undo.");
  }

  const currentCell = roundState.cells[entry.cellIndex];

  if (!currentCell || currentCell.given) {
    throw new Error("That move can no longer be undone.");
  }

  if (
    currentCell.version !== entry.after.version
    || currentCell.value !== entry.after.value
    || currentCell.owner !== entry.after.owner
  ) {
    throw new Error("That move can no longer be undone.");
  }

  if (roundState.matchMode === "versus" && entry.scored) {
    throw new Error("Locked claims cannot be undone.");
  }

  const nextRoundState = cloneRoundState(roundState);
  pruneExpiredEffects(nextRoundState, now);
  pruneInteractionLedger(nextRoundState, now);
  registerRequest(nextRoundState, requestId, player, Number(options.clientSeq));

  const nextStack = nextRoundState.undoStackByPlayer[player];
  nextStack.pop();

  const restoredCell = cloneCell(entry.before);
  restoredCell.version = entry.before.version;
  restoredCell.lastCommitAt = now;
  restoredCell.lastCommitBy = player;
  nextRoundState.cells[entry.cellIndex] = restoredCell;
  delete nextRoundState.interactionLedger.byCell[entry.cellIndex];

  nextRoundState.updatedAt = now;
  nextRoundState.revision += 1;
  maybeCompleteRound(nextRoundState, now);

  return {
    roundState: nextRoundState,
    duplicate: false,
    accepted: true,
    undoneCellIndex: entry.cellIndex,
  };
}

function setAuthoritativeRestartVote(roundState, options = {}) {
  if (!roundState || typeof roundState !== "object") {
    throw new Error("Round state is required.");
  }

  const player = options.player === "A" || options.player === "B" ? options.player : "";
  const requestId = sanitizeRequestId(options.requestId);
  const now = Number.isFinite(options.receivedAt) ? Number(options.receivedAt) : Date.now();
  const vote = options.vote !== false;

  if (!player) {
    throw new Error("Player seat is required.");
  }

  if (options.roundId !== roundState.roundId) {
    throw new Error("Round has changed. Refresh to continue.");
  }

  if (roundState.status !== "active" && !(roundState.status === "completed" && vote === false)) {
    throw new Error("Round is not active.");
  }

  if (isDuplicateRequest(roundState, requestId)) {
    return {
      roundState,
      duplicate: true,
      restarted: false,
    };
  }

  const nextRoundState = cloneRoundState(roundState);
  pruneExpiredEffects(nextRoundState, now);
  registerRequest(nextRoundState, requestId, player, Number(options.clientSeq));
  nextRoundState.restartVotes[player] = vote;

  if (!nextRoundState.restartVotes.A || !nextRoundState.restartVotes.B) {
    nextRoundState.updatedAt = now;
    nextRoundState.revision += 1;
    return {
      roundState: nextRoundState,
      restarted: false,
    };
  }

  const createdAt = roundState.createdAt;
  const freshCells = nextRoundState.puzzle.split("").map((value) => createAuthoritativeCell(value));

  nextRoundState.status = "active";
  nextRoundState.completedAt = null;
  nextRoundState.completedEventId = null;
  nextRoundState.restartVotes = { A: false, B: false };
  nextRoundState.restartEventId = `restart-${roundState.roundId}-${now}`;
  nextRoundState.undoStackByPlayer = { A: [], B: [] };
  nextRoundState.scores = { A: 0, B: 0 };
  nextRoundState.cells = freshCells;
  nextRoundState.recentEffects = [];
  nextRoundState.interactionLedger = { byCell: {} };
  nextRoundState.playerStates.A.freezeUntil = 0;
  nextRoundState.playerStates.B.freezeUntil = 0;
  nextRoundState.createdAt = createdAt;
  nextRoundState.updatedAt = now;
  nextRoundState.revision += 1;

  return {
    roundState: nextRoundState,
    restarted: true,
  };
}

module.exports = {
  ROUND_ENGINE_VERSION,
  ROUND_PROTOCOL_VERSION,
  ROUND_TIMINGS,
  VERSUS_SCORING_RULES,
  RoundRevisionMismatchError,
  createAuthoritativeRoundState,
  getPuzzleConfigForSelection,
  isPlayerFrozen,
  resolveAuthoritativeSelection,
  setAuthoritativeRestartVote,
  submitAuthoritativeCell,
  toPublicRoundState,
  undoAuthoritativeCell,
  updateAuthoritativeRoundState,
};
