const MAX_LEADERBOARD_SIZE = 10;

function getLeaderboardState() {
  if (!globalThis.__SUDOKU_LEADERBOARD_STATE__) {
    globalThis.__SUDOKU_LEADERBOARD_STATE__ = {
      boards: new Map(),
      nextId: 1,
    };
  }

  return globalThis.__SUDOKU_LEADERBOARD_STATE__;
}

function sanitizeDifficulty(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "easy" || normalized === "medium" || normalized === "hard" ? normalized : "";
}

function sanitizePuzzleId(value) {
  const normalized = String(value || "").trim();
  return /^[a-z0-9._:-]{1,64}$/i.test(normalized) ? normalized : "";
}

function sanitizePlayerName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 20);
}

function getBoardKey(difficulty, puzzleId) {
  return `${difficulty}:${puzzleId}`;
}

function sortEntries(entries) {
  return entries.sort((left, right) => {
    if (left.elapsedSeconds !== right.elapsedSeconds) {
      return left.elapsedSeconds - right.elapsedSeconds;
    }

    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }

    return left.playerName.localeCompare(right.playerName);
  });
}

function formatEntries(entries) {
  return entries.map((entry, index) => ({
    rank: index + 1,
    entryId: entry.entryId,
    playerName: entry.playerName,
    elapsedSeconds: entry.elapsedSeconds,
    createdAt: entry.createdAt,
  }));
}

function formatRankedEntry(entry, rank) {
  if (!entry) {
    return null;
  }

  return {
    rank: Number.isInteger(rank) && rank > 0 ? rank : null,
    entryId: entry.entryId,
    playerName: entry.playerName,
    elapsedSeconds: entry.elapsedSeconds,
    createdAt: entry.createdAt,
  };
}

function getEntryRank(entries, entryId) {
  const index = entries.findIndex((entry) => entry.entryId === entryId);
  return index >= 0 ? index + 1 : null;
}

function getProjectedLeaderboard(entries, playerName, elapsedSeconds) {
  const normalizedName = sanitizePlayerName(playerName);
  const safeElapsedSeconds = Number.isFinite(elapsedSeconds) && elapsedSeconds > 0
    ? Math.floor(elapsedSeconds)
    : null;

  if (!normalizedName) {
    return {
      entries: sortEntries([...entries]),
      currentEntry: null,
      currentRank: null,
    };
  }

  const projectedEntries = [...entries];
  const normalizedLookupName = normalizedName.toLowerCase();
  const existingIndex = projectedEntries.findIndex((entry) => entry.playerName.toLowerCase() === normalizedLookupName);
  const existingEntry = existingIndex >= 0 ? projectedEntries[existingIndex] : null;
  let currentEntry = existingEntry ? { ...existingEntry } : null;

  if (safeElapsedSeconds !== null) {
    currentEntry = existingEntry
      ? {
        ...existingEntry,
        playerName: normalizedName,
        elapsedSeconds: safeElapsedSeconds,
        createdAt: Date.now(),
      }
      : {
        entryId: `preview:${normalizedLookupName}`,
        playerName: normalizedName,
        elapsedSeconds: safeElapsedSeconds,
        createdAt: Date.now(),
      };
  }

  if (currentEntry) {
    if (existingIndex >= 0) {
      projectedEntries[existingIndex] = currentEntry;
    } else {
      projectedEntries.push(currentEntry);
    }
  }

  const sortedEntries = sortEntries(projectedEntries);
  return {
    entries: sortedEntries,
    currentEntry,
    currentRank: currentEntry ? getEntryRank(sortedEntries, currentEntry.entryId) : null,
  };
}

function getRankedLeaderboard(options = {}) {
  const difficulty = sanitizeDifficulty(options.difficulty);
  const puzzleId = sanitizePuzzleId(options.puzzleId);
  const playerName = sanitizePlayerName(options.playerName);
  const elapsedSeconds = Number(options.elapsedSeconds);

  if (!difficulty || !puzzleId) {
    throw new Error("Difficulty and puzzle ID are required.");
  }

  const { boards } = getLeaderboardState();
  const boardKey = getBoardKey(difficulty, puzzleId);
  const storedEntries = sortEntries([...(boards.get(boardKey) || [])]);
  const projected = getProjectedLeaderboard(storedEntries, playerName, elapsedSeconds);
  const leaderboard = formatEntries(projected.entries.slice(0, MAX_LEADERBOARD_SIZE));

  return {
    difficulty,
    puzzleId,
    boardKey,
    leaderboard,
    totalEntries: projected.entries.length,
    playerEntry: formatRankedEntry(projected.currentEntry, projected.currentRank),
    playerRank: projected.currentRank,
  };
}

function submitRankedTime(options = {}) {
  const difficulty = sanitizeDifficulty(options.difficulty);
  const puzzleId = sanitizePuzzleId(options.puzzleId);
  const playerName = sanitizePlayerName(options.playerName);
  const elapsedSeconds = Number(options.elapsedSeconds);

  if (!difficulty || !puzzleId) {
    throw new Error("Difficulty and puzzle ID are required.");
  }

  if (!playerName) {
    throw new Error("Player name is required.");
  }

  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    throw new Error("Elapsed time must be a positive number.");
  }

  const safeElapsedSeconds = Math.floor(elapsedSeconds);
  const { boards, nextId } = getLeaderboardState();
  const boardKey = getBoardKey(difficulty, puzzleId);
  const entries = [...(boards.get(boardKey) || [])];
  const normalizedName = playerName.toLowerCase();
  const existingIndex = entries.findIndex((entry) => entry.playerName.toLowerCase() === normalizedName);
  const targetEntryId = existingIndex >= 0 ? entries[existingIndex].entryId : `rank-${nextId}`;

  if (existingIndex >= 0) {
    const existingEntry = entries[existingIndex];

    if (existingEntry.elapsedSeconds <= safeElapsedSeconds) {
      const sortedEntries = sortEntries(entries);
      const leaderboard = formatEntries(sortedEntries.slice(0, MAX_LEADERBOARD_SIZE));
      const rank = getEntryRank(sortedEntries, existingEntry.entryId);

      return {
        difficulty,
        puzzleId,
        boardKey,
        entry: formatRankedEntry(existingEntry, rank),
        rank,
        leaderboard,
        totalEntries: sortedEntries.length,
        playerEntry: formatRankedEntry(existingEntry, rank),
        playerRank: rank,
        updated: false,
      };
    }

    entries[existingIndex] = {
      ...existingEntry,
      playerName,
      elapsedSeconds: safeElapsedSeconds,
      createdAt: Date.now(),
    };
  } else {
    entries.push({
      entryId: `rank-${nextId}`,
      playerName,
      elapsedSeconds: safeElapsedSeconds,
      createdAt: Date.now(),
    });
    getLeaderboardState().nextId += 1;
  }

  const sortedEntries = sortEntries(entries);
  boards.set(boardKey, sortedEntries);

  const leaderboard = formatEntries(sortedEntries.slice(0, MAX_LEADERBOARD_SIZE));
  const latestEntry = sortedEntries.find((entry) => entry.entryId === targetEntryId) || null;
  const rank = latestEntry ? getEntryRank(sortedEntries, latestEntry.entryId) : null;

  return {
    difficulty,
    puzzleId,
    boardKey,
    entry: formatRankedEntry(latestEntry, rank),
    rank,
    leaderboard,
    totalEntries: sortedEntries.length,
    playerEntry: formatRankedEntry(latestEntry, rank),
    playerRank: rank,
    updated: true,
  };
}

function getLeaderboardHealth() {
  const { boards } = getLeaderboardState();
  return {
    boards: boards.size,
  };
}

module.exports = {
  getLeaderboardHealth,
  getRankedLeaderboard,
  submitRankedTime,
};
