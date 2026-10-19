window.SUDOKU_CONTENT = {
  puzzlePolicy: {
    standardDailyCount: 3,
    vipReservedDailyCount: 10,
  },
  puzzleBank: {
    easy: Array.isArray(window.SUDOKU_PUZZLE_BANK_EASY) ? window.SUDOKU_PUZZLE_BANK_EASY : [],
    medium: Array.isArray(window.SUDOKU_PUZZLE_BANK_MEDIUM) ? window.SUDOKU_PUZZLE_BANK_MEDIUM : [],
    hard: Array.isArray(window.SUDOKU_PUZZLE_BANK_HARD) ? window.SUDOKU_PUZZLE_BANK_HARD : [],
  },
  vipThemes: [
    { id: "retro", label: "Retro", bundle: "base-room", skinCssPath: "./skins/retro/skin.css", decorPath: "./skins/retro/decor.html" },
    { id: "tech", label: "Metal", bundle: "base-room", skinCssPath: "./skins/metal/skin.css", decorPath: "./skins/metal/decor.html" },
    { id: "hacker", label: "Hacker", bundle: "base-room", skinCssPath: "./skins/hacker/skin.css", decorPath: "./skins/hacker/decor.html" },
    { id: "lolita", label: "Lolita", bundle: "base-room", skinCssPath: "./skins/lolita/skin.css", decorPath: "./skins/lolita/decor.html" },
    { id: "forest", label: "Forest", bundle: "base-room", skinCssPath: "./skins/forest/skin.css", decorPath: "./skins/forest/decor.html" },
    { id: "ocean", label: "Ocean", bundle: "base-room", skinCssPath: "./skins/ocean/skin.css", decorPath: "./skins/ocean/decor.html" },
  ],
};
