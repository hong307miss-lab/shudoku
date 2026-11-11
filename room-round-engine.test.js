const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ROUND_PROTOCOL_VERSION,
  VERSUS_SCORING_RULES,
  RoundRevisionMismatchError,
  createAuthoritativeRoundState,
  resolveAuthoritativeSelection,
  setAuthoritativeRestartVote,
  submitAuthoritativeCell,
  toPublicRoundState,
  undoAuthoritativeCell,
  updateAuthoritativeRoundState,
} = require("./room-round-engine");

function getEditableIndexes(roundState) {
  return roundState.cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => !cell.given)
    .map(({ index }) => index);
}

function getWrongDigit(roundState, index) {
  const correctDigit = roundState.solution[index];
  return correctDigit === "9" ? "1" : "9";
}

function fillCells(roundState, indexes, pickDigit) {
  let next = roundState;

  indexes.forEach((index, offset) => {
    const seq = offset + 1;
    next = submitAuthoritativeCell(next, {
      player: seq % 2 === 0 ? "B" : "A",
      requestId: `req-fill-${seq}`,
      roundId: next.roundId,
      cellIndex: index,
      digit: pickDigit(next, index),
      action: "set",
      clientSeq: seq,
      receivedAt: 1_730_000_000_000 + seq,
    }).roundState;
  });

  return next;
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

test("toPublicRoundState isolates private notes per viewer seat", () => {
  let roundState = createAuthoritativeRoundState({
    matchMode: "coop",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });
  const editableIndex = roundState.cells.findIndex((cell) => !cell.given);
  const digitA = roundState.solution[editableIndex];
  const digitB = digitA === "9" ? "1" : "9";

  roundState = submitAuthoritativeCell(roundState, {
    player: "A",
    requestId: "req-notes-a",
    roundId: roundState.roundId,
    cellIndex: editableIndex,
    digit: digitA,
    action: "note_toggle",
    clientSeq: 1,
    receivedAt: 1_730_000_000_100,
  }).roundState;

  roundState = submitAuthoritativeCell(roundState, {
    player: "B",
    requestId: "req-notes-b",
    roundId: roundState.roundId,
    cellIndex: editableIndex,
    digit: digitB,
    action: "note_toggle",
    clientSeq: 1,
    receivedAt: 1_730_000_000_110,
  }).roundState;

  const viewA = toPublicRoundState(roundState, 1_730_000_000_200, "A");
  const viewB = toPublicRoundState(roundState, 1_730_000_000_200, "B");
  const anonymous = toPublicRoundState(roundState, 1_730_000_000_200);

  assert.deepEqual(viewA.cells[editableIndex].notes, { [digitA]: "A" });
  assert.deepEqual(viewB.cells[editableIndex].notes, { [digitB]: "B" });
  assert.deepEqual(anonymous.cells[editableIndex].notes, {});

  // The authoritative state still holds both seats' notes for scoring and review.
  assert.equal(roundState.cells[editableIndex].notes.A[digitA], true);
  assert.equal(roundState.cells[editableIndex].notes.B[digitB], true);
});

test("submitAuthoritativeCell lets only the owner clear a versus mistake and never refunds the score", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "versus",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });
  const editableIndex = roundState.cells.findIndex((cell) => !cell.given);
  const wrongDigit = getWrongDigit(roundState, editableIndex);

  const wrong = submitAuthoritativeCell(roundState, {
    player: "A",
    requestId: "req-versus-mistake",
    roundId: roundState.roundId,
    cellIndex: editableIndex,
    digit: wrongDigit,
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_100,
  });

  assert.equal(wrong.roundState.scores.A, -1);
  assert.equal(wrong.roundState.cells[editableIndex].locked, false);
  assert.equal(wrong.roundState.cells[editableIndex].claimCorrect, false);

  assert.throws(() => submitAuthoritativeCell(wrong.roundState, {
    player: "B",
    requestId: "req-versus-mistake-b",
    roundId: wrong.roundState.roundId,
    cellIndex: editableIndex,
    action: "clear",
    clientSeq: 1,
    receivedAt: 1_730_000_000_150,
  }), /already claimed/i);

  const cleared = submitAuthoritativeCell(wrong.roundState, {
    player: "A",
    requestId: "req-versus-mistake-clear",
    roundId: wrong.roundState.roundId,
    cellIndex: editableIndex,
    action: "clear",
    clientSeq: 2,
    receivedAt: 1_730_000_000_180,
  });

  assert.equal(cleared.roundState.cells[editableIndex].value, "");
  assert.equal(cleared.roundState.cells[editableIndex].locked, false);
  assert.equal(cleared.roundState.scores.A, -1);
  assert.equal(cleared.roundState.interactionLedger.byCell[editableIndex], undefined);
});

test("undoAuthoritativeCell restores the player's own edit and refuses moves overwritten by the peer", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "coop",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });
  const editableIndex = roundState.cells.findIndex((cell) => !cell.given);
  const correctDigit = roundState.solution[editableIndex];

  const first = submitAuthoritativeCell(roundState, {
    player: "A",
    requestId: "req-undo-a1",
    roundId: roundState.roundId,
    cellIndex: editableIndex,
    digit: correctDigit,
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_100,
  });

  assert.equal(first.roundState.undoStackByPlayer.A.length, 1);

  const contested = submitAuthoritativeCell(first.roundState, {
    player: "B",
    requestId: "req-undo-b1",
    roundId: first.roundState.roundId,
    cellIndex: editableIndex,
    digit: correctDigit,
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_150,
  });

  assert.throws(() => undoAuthoritativeCell(contested.roundState, {
    player: "A",
    requestId: "req-undo-a2",
    roundId: contested.roundState.roundId,
    clientSeq: 2,
    receivedAt: 1_730_000_000_200,
  }), /can no longer be undone/i);

  const undone = undoAuthoritativeCell(contested.roundState, {
    player: "B",
    requestId: "req-undo-b2",
    roundId: contested.roundState.roundId,
    clientSeq: 2,
    receivedAt: 1_730_000_000_220,
  });

  assert.equal(undone.undoneCellIndex, editableIndex);
  assert.equal(undone.roundState.cells[editableIndex].value, correctDigit);
  assert.equal(undone.roundState.cells[editableIndex].owner, "A");
  assert.equal(undone.roundState.undoStackByPlayer.B.length, 0);
});

test("undoAuthoritativeCell never reverses a scored versus claim and dedupes request ids", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "versus",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });
  const editableIndex = roundState.cells.findIndex((cell) => !cell.given);

  const claimed = submitAuthoritativeCell(roundState, {
    player: "A",
    requestId: "req-versus-lock",
    roundId: roundState.roundId,
    cellIndex: editableIndex,
    digit: roundState.solution[editableIndex],
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_100,
  });

  assert.equal(claimed.roundState.scores.A, 1);
  assert.equal(claimed.roundState.undoStackByPlayer.A.length, 0);
  assert.throws(() => undoAuthoritativeCell(claimed.roundState, {
    player: "A",
    requestId: "req-versus-lock-undo",
    roundId: claimed.roundState.roundId,
    clientSeq: 2,
    receivedAt: 1_730_000_000_200,
  }), /nothing to undo/i);

  const wrongIndex = getEditableIndexes(claimed.roundState).find((index) => index !== editableIndex);
  const wrong = submitAuthoritativeCell(claimed.roundState, {
    player: "A",
    requestId: "req-versus-lock-wrong",
    roundId: claimed.roundState.roundId,
    cellIndex: wrongIndex,
    digit: getWrongDigit(claimed.roundState, wrongIndex),
    action: "set",
    clientSeq: 3,
    receivedAt: 1_730_000_000_240,
  });

  const undone = undoAuthoritativeCell(wrong.roundState, {
    player: "A",
    requestId: "req-versus-lock-wrong-undo",
    roundId: wrong.roundState.roundId,
    clientSeq: 4,
    receivedAt: 1_730_000_000_260,
  });

  assert.equal(undone.roundState.cells[wrongIndex].value, "");
  assert.equal(undone.roundState.scores.A, 0);

  const duplicate = undoAuthoritativeCell(undone.roundState, {
    player: "A",
    requestId: "req-versus-lock-wrong-undo",
    roundId: undone.roundState.roundId,
    clientSeq: 4,
    receivedAt: 1_730_000_000_280,
  });

  assert.equal(duplicate.duplicate, true);
});

test("setAuthoritativeRestartVote only resets the round once both seats vote and dedupes request ids", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "coop",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });
  const editableIndex = roundState.cells.findIndex((cell) => !cell.given);

  const edited = submitAuthoritativeCell(roundState, {
    player: "A",
    requestId: "req-restart-edit",
    roundId: roundState.roundId,
    cellIndex: editableIndex,
    digit: roundState.solution[editableIndex],
    action: "set",
    clientSeq: 1,
    receivedAt: 1_730_000_000_100,
  }).roundState;

  const voteA = setAuthoritativeRestartVote(edited, {
    player: "A",
    requestId: "req-restart-a",
    roundId: edited.roundId,
    clientSeq: 2,
    receivedAt: 1_730_000_000_200,
  });

  assert.equal(voteA.restarted, false);
  assert.equal(voteA.roundState.restartVotes.A, true);
  assert.equal(voteA.roundState.restartVotes.B, false);
  assert.equal(voteA.roundState.cells[editableIndex].value, roundState.solution[editableIndex]);

  const duplicate = setAuthoritativeRestartVote(voteA.roundState, {
    player: "B",
    requestId: "req-restart-a",
    roundId: voteA.roundState.roundId,
    clientSeq: 3,
    receivedAt: 1_730_000_000_220,
  });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.restarted, false);
  assert.equal(duplicate.roundState.restartVotes.B, false);

  const voteB = setAuthoritativeRestartVote(voteA.roundState, {
    player: "B",
    requestId: "req-restart-b",
    roundId: voteA.roundState.roundId,
    clientSeq: 3,
    receivedAt: 1_730_000_000_240,
  });

  assert.equal(voteB.restarted, true);
  assert.match(voteB.roundState.restartEventId, /^restart-/);
  assert.equal(voteB.roundState.status, "active");
  assert.deepEqual(voteB.roundState.restartVotes, { A: false, B: false });
  assert.deepEqual(voteB.roundState.scores, { A: 0, B: 0 });
  assert.equal(voteB.roundState.undoStackByPlayer.A.length, 0);
  assert.equal(voteB.roundState.recentEffects.length, 0);
  assert.deepEqual(voteB.roundState.interactionLedger, { byCell: {} });
  assert.equal(voteB.roundState.cells[editableIndex].value, "");
  assert.equal(voteB.roundState.createdAt, roundState.createdAt);
});

test("maybeCompleteRound keeps a full board active when the digits do not match the solution", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "coop",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });
  const editableIndexes = getEditableIndexes(roundState);
  const filled = fillCells(roundState, editableIndexes, getWrongDigit);

  assert.equal(filled.cells.every((cell) => Boolean(cell.value)), true);
  assert.equal(filled.status, "active");
  assert.equal(filled.completedEventId, null);
  assert.equal(filled.completedAt, null);
});

test("maybeCompleteRound completes the round exactly once when the solution is reached", () => {
  const roundState = createAuthoritativeRoundState({
    matchMode: "coop",
    selection: createSelection(),
    createdAt: 1_730_000_000_000,
  });
  const editableIndexes = getEditableIndexes(roundState);
  const solved = fillCells(roundState, editableIndexes, (state, index) => state.solution[index]);

  assert.equal(solved.status, "completed");
  assert.equal(solved.completedEventId, `complete-${solved.roundId}-${1_730_000_000_000 + editableIndexes.length}`);
  assert.equal(solved.completedAt, 1_730_000_000_000 + editableIndexes.length);
  assert.equal(solved.undoStackByPlayer.A.length, 0);
  assert.equal(solved.undoStackByPlayer.B.length, 0);

  const publicState = toPublicRoundState(solved, 1_730_000_001_000, "A");
  assert.equal(publicState.status, "completed");
  assert.equal(publicState.completedEventId, solved.completedEventId);
  assert.equal(publicState.updatedAt, solved.completedAt);
});
