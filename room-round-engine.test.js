const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ROUND_PROTOCOL_VERSION,
  VERSUS_SCORING_RULES,
  RoundRevisionMismatchError,
  createAuthoritativeRoundState,
  resolveAuthoritativeSelection,
  submitAuthoritativeCell,
  toPublicRoundState,
  updateAuthoritativeRoundState,
} = require("./room-round-engine");

function createSelection(overrides = {}) {
  return {
    ...resolveAuthoritativeSelection({
      difficulty: "easy",
      puzzleIndex: 0,
    }),
    ...overrides,
  };
}

test("createAuthoritativeRoundState builds a protocol v3 round with current versus scoring rules", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "versus",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });

  assert.equal(roundState.protocolVersion, ROUND_PROTOCOL_VERSION);
  assert.equal(roundState.matchMode, "versus");
  assert.equal(roundState.revision, 1);
  assert.equal(roundState.sessionKey, createSelection().sessionKey);
  assert.deepEqual(roundState.scores, { A: 0, B: 0 });
  assert.deepEqual(roundState.scoringRules, VERSUS_SCORING_RULES);
  assert.equal(roundState.scoringRules.correctClaimPoints, 1);
  assert.equal(roundState.scoringRules.wrongClaimPoints, -1);
  assert.equal(roundState.scoringRules.contestBonusPoints, 0);
  assert.equal(roundState.scoringRules.bombPenaltyPoints, 0);
  assert.equal(roundState.playerStates.A.freezeUntil, 0);
  assert.equal(roundState.playerStates.B.freezeUntil, 0);
  assert.equal(roundState.cells.length, 81);
  assert.match(roundState.solution, /^[1-9]{81}$/);
});

test("resolveAuthoritativeSelection canonicalizes against the scheduled daily puzzle index", () => {
  const selection = resolveAuthoritativeSelection({
    difficulty: "easy",
    puzzleIndex: 0,
    puzzleId: "forged-id",
    sessionKey: "easy:forged-id",
  });

  assert.deepEqual(selection, createSelection());
});

test("toPublicRoundState omits server-only fields and computes freeze countdown", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "versus",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });

  roundState.playerStates.B.freezeUntil = 1_730_000_001_500;
  const publicState = toPublicRoundState(roundState, 1_730_000_000_800);

  assert.equal(publicState.protocolVersion, ROUND_PROTOCOL_VERSION);
  assert.equal(publicState.playerStates.B.freezeRemainingMs, 700);
  assert.equal("solution" in publicState, false);
  assert.equal("requestLedger" in publicState, false);
  assert.equal(publicState.cells.length, 81);
});

test("updateAuthoritativeRoundState increments revision and rejects stale base revisions", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "coop",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });

  const nextRoundState = updateAuthoritativeRoundState(roundState, {
    baseRevision: 1,
    updatedAt: 1_730_000_000_321,
    mutate(next) {
      next.scores.A = 1;
    },
  });

  assert.equal(nextRoundState.revision, 2);
  assert.equal(nextRoundState.updatedAt, 1_730_000_000_321);
  assert.equal(nextRoundState.scores.A, 1);
  assert.equal(roundState.scores.A, 0);

  assert.throws(
    () => updateAuthoritativeRoundState(nextRoundState, { baseRevision: 1 }),
    (error) => {
      assert.ok(error instanceof RoundRevisionMismatchError);
      assert.equal(error.expectedRevision, 2);
      assert.equal(error.receivedRevision, 1);
      return true;
    },
  );
});

test("submitAuthoritativeCell applies versus scoring and deduplicates request ids", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "versus",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });

  const editableIndex = roundState.cells.findIndex((cell) => !cell.given);
  const correctDigit = roundState.solution[editableIndex];
  const wrongDigit = correctDigit === "9" ? "1" : "9";

  const accepted = submitAuthoritativeCell(roundState, {
    player: "A",
    requestId: "req-versus-001",
    roundId: roundState.roundId,
    cellIndex: editableIndex,
    digit: correctDigit,
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_100,
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.roundState.scores.A, 1);
  assert.equal(accepted.roundState.cells[editableIndex].value, correctDigit);
  assert.equal(accepted.roundState.cells[editableIndex].locked, true);

  const duplicate = submitAuthoritativeCell(accepted.roundState, {
    player: "A",
    requestId: "req-versus-001",
    roundId: accepted.roundState.roundId,
    cellIndex: editableIndex,
    digit: wrongDigit,
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_120,
  });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.roundState.scores.A, 1);
});

test("submitAuthoritativeCell keeps stale same-round revisions processable for different cells", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "versus",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });

  const editableIndexes = roundState.cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => !cell.given)
    .slice(0, 2)
    .map(({ index }) => index);

  const first = submitAuthoritativeCell(roundState, {
    player: "A",
    requestId: "req-versus-002",
    roundId: roundState.roundId,
    cellIndex: editableIndexes[0],
    digit: roundState.solution[editableIndexes[0]],
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_100,
    baseRoundRevision: 1,
  });

  const second = submitAuthoritativeCell(first.roundState, {
    player: "B",
    requestId: "req-versus-003",
    roundId: first.roundState.roundId,
    cellIndex: editableIndexes[1],
    digit: first.roundState.solution[editableIndexes[1]],
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_101,
    baseRoundRevision: 1,
  });

  assert.equal(second.roundState.scores.A, 1);
  assert.equal(second.roundState.scores.B, 1);
  assert.equal(second.roundState.cells[editableIndexes[0]].owner, "A");
  assert.equal(second.roundState.cells[editableIndexes[1]].owner, "B");
});

test("submitAuthoritativeCell emits coop_heart for same correct digit by different players within the contest window", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "coop",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });
  const editableIndex = roundState.cells.findIndex((cell) => !cell.given);
  const correctDigit = roundState.solution[editableIndex];

  const first = submitAuthoritativeCell(roundState, {
    player: "A",
    requestId: "req-coop-heart-a",
    roundId: roundState.roundId,
    cellIndex: editableIndex,
    digit: correctDigit,
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_100,
  });

  const second = submitAuthoritativeCell(first.roundState, {
    player: "B",
    requestId: "req-coop-heart-b",
    roundId: first.roundState.roundId,
    cellIndex: editableIndex,
    digit: correctDigit,
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_250,
  });

  assert.equal(second.roundState.recentEffects.length, 1);
  assert.equal(second.roundState.recentEffects[0].kind, "coop_heart");
  assert.equal(second.roundState.recentEffects[0].digit, correctDigit);
  assert.equal(second.roundState.recentEffects[0].startedAt, 1_730_000_000_250);
  assert.equal(second.roundState.recentEffects[0].expiresAt, 1_730_000_001_150);
  assert.equal(second.roundState.cells[editableIndex].value, correctDigit);
  assert.deepEqual(toPublicRoundState(second.roundState, 1_730_000_000_800).recentEffects.map((effect) => effect.kind), ["coop_heart"]);
  assert.equal(toPublicRoundState(second.roundState, 1_730_000_001_151).recentEffects.length, 0);
});

test("submitAuthoritativeCell emits coop_clash for different digits and never lets a wrong digit overwrite a confirmed correct value", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "coop",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });
  const editableIndex = roundState.cells.findIndex((cell) => !cell.given);
  const correctDigit = roundState.solution[editableIndex];
  const wrongDigit = correctDigit === "9" ? "1" : "9";

  const first = submitAuthoritativeCell(roundState, {
    player: "A",
    requestId: "req-coop-clash-a",
    roundId: roundState.roundId,
    cellIndex: editableIndex,
    digit: correctDigit,
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_100,
  });

  const second = submitAuthoritativeCell(first.roundState, {
    player: "B",
    requestId: "req-coop-clash-b",
    roundId: first.roundState.roundId,
    cellIndex: editableIndex,
    digit: wrongDigit,
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_220,
  });

  assert.equal(second.roundState.recentEffects.length, 1);
  assert.equal(second.roundState.recentEffects[0].kind, "coop_clash");
  assert.equal(second.roundState.cells[editableIndex].value, correctDigit);
});

test("submitAuthoritativeCell does not emit coop interaction effects for same player repeats, clear, note, duplicates, or late submissions", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "coop",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });
  const editableIndexes = roundState.cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => !cell.given)
    .slice(0, 2)
    .map(({ index }) => index);

  const digitA = roundState.solution[editableIndexes[0]];
  const digitB = roundState.solution[editableIndexes[1]];

  const first = submitAuthoritativeCell(roundState, {
    player: "A",
    requestId: "req-coop-none-a1",
    roundId: roundState.roundId,
    cellIndex: editableIndexes[0],
    digit: digitA,
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_100,
  });

  const samePlayer = submitAuthoritativeCell(first.roundState, {
    player: "A",
    requestId: "req-coop-none-a2",
    roundId: first.roundState.roundId,
    cellIndex: editableIndexes[0],
    digit: digitA,
    action: "set",
    clientSeq: 2,
    receivedAt: 1_730_000_000_200,
  });

  const note = submitAuthoritativeCell(samePlayer.roundState, {
    player: "B",
    requestId: "req-coop-none-note",
    roundId: samePlayer.roundState.roundId,
    cellIndex: editableIndexes[1],
    digit: digitB,
    action: "note_toggle",
    clientSeq: 1,
    receivedAt: 1_730_000_000_250,
  });

  const clear = submitAuthoritativeCell(note.roundState, {
    player: "B",
    requestId: "req-coop-none-clear",
    roundId: note.roundState.roundId,
    cellIndex: editableIndexes[1],
    action: "clear",
    clientSeq: 2,
    receivedAt: 1_730_000_000_260,
  });

  const late = submitAuthoritativeCell(clear.roundState, {
    player: "B",
    requestId: "req-coop-none-late",
    roundId: clear.roundState.roundId,
    cellIndex: editableIndexes[0],
    digit: digitA,
    action: "set",
    clientSeq: 3,
    receivedAt: 1_730_000_000_800,
  });

  const duplicate = submitAuthoritativeCell(late.roundState, {
    player: "B",
    requestId: "req-coop-none-late",
    roundId: late.roundState.roundId,
    cellIndex: editableIndexes[0],
    digit: digitA,
    action: "set",
    clientSeq: 3,
    receivedAt: 1_730_000_000_820,
  });

  assert.equal(first.roundState.recentEffects.length, 0);
  assert.equal(samePlayer.roundState.recentEffects.length, 0);
  assert.equal(note.roundState.recentEffects.length, 0);
  assert.equal(clear.roundState.recentEffects.length, 0);
  assert.equal(late.roundState.recentEffects.length, 0);
  assert.equal(duplicate.duplicate, true);
});

test("submitAuthoritativeCell emits a versus contest effect and freezes only the loser for a qualified same-cell race", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "versus",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });
  const editableIndex = roundState.cells.findIndex((cell) => !cell.given);
  const correctDigit = roundState.solution[editableIndex];

  const first = submitAuthoritativeCell(roundState, {
    player: "A",
    requestId: "req-versus-contest-a",
    roundId: roundState.roundId,
    cellIndex: editableIndex,
    digit: correctDigit,
    action: "set",
    clientSeq: 1,
    observedCellVersion: 0,
    observedCellLocked: false,
    receivedAt: 1_730_000_000_100,
  });

  const second = submitAuthoritativeCell(first.roundState, {
    player: "B",
    requestId: "req-versus-contest-b",
    roundId: first.roundState.roundId,
    cellIndex: editableIndex,
    digit: correctDigit,
    action: "set",
    clientSeq: 1,
    observedCellVersion: 0,
    observedCellLocked: false,
    receivedAt: 1_730_000_000_240,
  });

  assert.equal(second.roundState.scores.A, 1);
  assert.equal(second.roundState.scores.B, 0);
  assert.equal(second.roundState.recentEffects.length, 1);
  assert.equal(second.roundState.recentEffects[0].kind, "versus_contest");
  assert.equal(second.roundState.recentEffects[0].winner, "A");
  assert.equal(second.roundState.recentEffects[0].loser, "B");
  assert.equal(second.roundState.playerStates.A.freezeUntil, 0);
  assert.equal(second.roundState.playerStates.B.freezeUntil, 1_730_000_001_740);
});

test("submitAuthoritativeCell rejects non-qualifying versus lock clicks and does not create contest effects", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "versus",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });
  const editableIndex = roundState.cells.findIndex((cell) => !cell.given);
  const correctDigit = roundState.solution[editableIndex];
  const wrongDigit = correctDigit === "9" ? "1" : "9";

  const first = submitAuthoritativeCell(roundState, {
    player: "A",
    requestId: "req-versus-nonqual-a",
    roundId: roundState.roundId,
    cellIndex: editableIndex,
    digit: correctDigit,
    action: "set",
    clientSeq: 1,
    observedCellVersion: 0,
    observedCellLocked: false,
    receivedAt: 1_730_000_000_100,
  });

  assert.throws(() => submitAuthoritativeCell(first.roundState, {
    player: "B",
    requestId: "req-versus-nonqual-b",
    roundId: first.roundState.roundId,
    cellIndex: editableIndex,
    digit: correctDigit,
    action: "set",
    clientSeq: 1,
    observedCellVersion: 1,
    observedCellLocked: true,
    receivedAt: 1_730_000_000_200,
  }), /already claimed/i);

  assert.throws(() => submitAuthoritativeCell(first.roundState, {
    player: "B",
    requestId: "req-versus-nonqual-c",
    roundId: first.roundState.roundId,
    cellIndex: editableIndex,
    digit: wrongDigit,
    action: "set",
    clientSeq: 2,
    observedCellVersion: 0,
    observedCellLocked: false,
    receivedAt: 1_730_000_000_220,
  }), /already claimed/i);
});
