const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = __dirname;
const readFile = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const appSource = readFile("app.js");
const stylesSource = readFile("styles.css");
const vvipThemeCss = readFile("vvip/vvip-theme.css");
const loaderSource = readFile("vendor/discord-runtime-loader.js");
const playerPage = readFile("player-b.html");
const indexPage = readFile("index.html");
const lobbyPage = readFile("lobby-b.html");

function extractFunctionSource(functionName, source = appSource) {
  const signature = `function ${functionName}(`;
  const startIndex = source.indexOf(signature);

  if (startIndex < 0) {
    throw new Error(`Unable to find ${functionName}`);
  }

  // Walk past the parameter list first: default values such as `options = {}` contain braces,
  // so the body brace must be located after the matching closing parenthesis.
  let parenDepth = 0;
  let cursor = startIndex + signature.length - 1;

  for (; cursor < source.length; cursor += 1) {
    const char = source[cursor];

    if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth -= 1;

      if (parenDepth === 0) {
        break;
      }
    }
  }

  const bodyStart = source.indexOf("{", cursor);
  let depth = 0;
  let endIndex = bodyStart;

  for (; endIndex < source.length; endIndex += 1) {
    const char = source[endIndex];

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

  return source.slice(startIndex, endIndex);
}

function extractCssRuleBody(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  return match ? match[1] : null;
}

function cssCustomPropertyNames(body) {
  return Array.from(new Set(Array.from(body.matchAll(/(--[a-z0-9-]+)\s*:/gi), (match) => match[1]))).sort();
}

function createFakeElement(tagName) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    dataset: {},
    children: [],
    textContent: "",
    classList: {
      add(...names) {
        names.forEach((name) => {
          if (!element.className.split(" ").includes(name)) {
            element.className = `${element.className} ${name}`.trim();
          }
        });
      },
      remove(name) {
        element.className = element.className.split(" ").filter((entry) => entry !== name).join(" ");
      },
      toggle(name, force) {
        const has = element.className.split(" ").includes(name);
        const on = force === undefined ? !has : Boolean(force);

        if (on && !has) {
          element.className = `${element.className} ${name}`.trim();
        } else if (!on && has) {
          element.classList.remove(name);
        }

        return on;
      },
      contains(name) {
        return element.className.split(" ").includes(name);
      },
    },
    setAttribute() {},
    appendChild(child) {
      element.children.push(child);
      return child;
    },
  };

  return element;
}

/* ----------------------------------------------------------------- *
 * 1. Discord runtime detection — the only trusted signal is ready()
 * ----------------------------------------------------------------- */

test("Discord SDK is constructed with the client id as its first positional argument", () => {
  const initSource = extractFunctionSource("initRuntimeEnvironment");

  assert.match(initSource, /new DiscordSDKConstructor\(DISCORD_CLIENT_ID\)/);
  assert.doesNotMatch(initSource, /clientId:\s*DISCORD_CLIENT_ID/);
});

test("the runtime only becomes 'discord' after ready() resolves, and falls back to 'web' otherwise", () => {
  const initSource = extractFunctionSource("initRuntimeEnvironment");
  const readyIndex = initSource.indexOf("discordSdk.ready()");
  const discordIndex = initSource.indexOf('state.runtime.kind = "discord"');

  assert.ok(readyIndex >= 0, "ready() must be awaited");
  assert.ok(discordIndex > readyIndex, 'kind = "discord" must be set after ready() resolves');
  assert.match(initSource, /state\.runtime\.kind = "web"/);
});

test("runtime kind detection never keys off URL, user agent, or window size", () => {
  const initSource = extractFunctionSource("initRuntimeEnvironment");
  const isDiscordFrameSource = extractFunctionSource("isLikelyDiscordFrame");

  assert.doesNotMatch(initSource, /navigator\.userAgent/);
  assert.doesNotMatch(initSource, /innerWidth|innerHeight|outerWidth/);
  assert.doesNotMatch(isDiscordFrameSource, /navigator\.userAgent|innerWidth|innerHeight/);
  // A frame gate may only *permit loading*; it must never assign the runtime kind.
  assert.doesNotMatch(isDiscordFrameSource, /state\.runtime\.kind/);
});

test("the vendored loader starts the same-origin ESM import and never sets the runtime kind", () => {
  assert.match(loaderSource, /import\("\.\/discord-embedded-app-sdk\.mjs"\)/);
  assert.doesNotMatch(loaderSource, /["']https:\/\/cdn\.discordapp\.com/);
  assert.doesNotMatch(loaderSource, /data-runtime-kind|dataset\.runtimeKind|state\.runtime\.kind/);
  assert.match(loaderSource, /__DISCORD_SDK_PROMISE__/);
});

test("no page or app script still references the retired Discord CDN bundle", () => {
  // The loader keeps a prose note about the retired CDN, so match quoted URLs and script tags only.
  [appSource, playerPage, indexPage, lobbyPage].forEach((source) => {
    assert.doesNotMatch(source, /["']https:\/\/cdn\.discordapp\.com\/sdk\.js/);
  });

  [appSource, playerPage, indexPage, lobbyPage, loaderSource].forEach((source) => {
    assert.doesNotMatch(source, /src=["'][^"']*cdn\.discordapp\.com/);
  });
});

/* ----------------------------------------------------------------- *
 * 2. Discord three-column grid contract
 * ----------------------------------------------------------------- */

test("the wide Discord layout declares the three-column rail grid and no full-width panel row", () => {
  const discordShellBody = extractCssRuleBody(stylesSource, 'body[data-runtime-kind="discord"] .app-shell');

  assert.ok(discordShellBody, "the single-column Discord fallback shell must exist");
  assert.match(stylesSource, /grid-template-columns:\s*var\(--discord-side-left\)\s+max-content\s+var\(--discord-side-right\)/);

  const areas = /"topbar board keypad"\s*\n\s*"status board keypad"\s*\n\s*"controls board keypad"/.test(stylesSource);
  assert.ok(areas, "topbar/status/controls must share the left rail and keypad must own the right rail");

  // Every rail child must be pinned to a named grid area, never to a full-width span.
  ["topbar", "status", "controls", "board", "keypad"].forEach((area) => {
    assert.match(stylesSource, new RegExp(`grid-area:\\s*${area}\\s*;`));
  });

  assert.match(stylesSource, /@media \(min-width: 880px\) and \(min-height: 560px\)/);
  assert.match(stylesSource, /@media \(max-width: 879px\), \(max-height: 559px\)/);
});

test("the board owns the widest track and the rails stay bounded", () => {
  assert.match(stylesSource, /--discord-side-left:\s*clamp\(176px/);
  assert.match(stylesSource, /--discord-side-right:\s*clamp\(184px/);

  const boardWidth = extractCssRuleBody(stylesSource, 'body[data-runtime-kind="discord"]');
  assert.match(boardWidth, /--discord-board-width:/);
});

test("the left rail surfaces mode, difficulty, time, sync and players before the board", () => {
  const statusPanelHtml = /<section class="panel status-panel">[\s\S]*?<\/section>/.exec(playerPage);

  assert.ok(statusPanelHtml, "the VIP Room page needs its status panel");

  ["Mode", "Difficulty", "Time", "Sync", "Players"].forEach((label) => {
    assert.match(statusPanelHtml[0], new RegExp(`>${label}<`), `${label} must appear in the status panel`);
  });

  assert.match(statusPanelHtml[0], /id="status-mode"/);
  assert.match(statusPanelHtml[0], /id="start-game-button"/);
  // The room state (mode + room name) lives in the controls rail, not in a wide top strip.
  assert.match(playerPage, /id="room-summary-title"/);
});

test("renderControls keeps the mode chip in sync with the active game mode", () => {
  const renderSource = extractFunctionSource("renderControls");

  assert.match(renderSource, /statusMode\.textContent = gameModeLabels\[state\.gameMode\]/);
  assert.match(appSource, /const statusMode = document\.querySelector\("#status-mode"\);/);
  assert.match(appSource, /const gameModeLabels = \{[\s\S]*?versus:\s*"Versus Mode"/);
});

/* ----------------------------------------------------------------- *
 * 3. VVIP Rooms as a first-class navigation entry
 * ----------------------------------------------------------------- */

test("all three pages expose Lobby, VIP Room and VVIP Rooms as parallel navigation entries", () => {
  [playerPage, indexPage, lobbyPage].forEach((page) => {
    assert.match(page, />Lobby</);
    assert.match(page, />VIP Room</);
    assert.match(page, /VVIP Rooms · 梦幻房间/);
    assert.match(page, /href="\.\/player-b\.html\?view=vip&amp;rooms=vvip"/);
  });
});

test("the VVIP entry is navigation, not a button buried in the VIP game status panel", () => {
  assert.doesNotMatch(playerPage, /id="open-theme-room-button"/);
  assert.doesNotMatch(appSource, /openThemeRoomModal|themeRoomModal|theme-room-modal/);
  assert.doesNotMatch(stylesSource, /\.theme-room-/);
});

test("the room lobby is a separate view that leaves the running game untouched", () => {
  const openSource = extractFunctionSource("openVvipRoomsView");
  const closeSource = extractFunctionSource("closeVvipRoomsView");

  assert.match(openSource, /renderVvipRoomCards\(\)/);
  assert.match(closeSource, /classList\.add\("hidden"\)/);

  [openSource, closeSource].forEach((source) => {
    assert.doesNotMatch(source, /newRound|resetSession|clearSession|sessionKey|room:create|socket/i);
  });

  // Deep link from the lobby nav, and the on-page entry intercepts so the socket survives.
  assert.match(appSource, /get\("rooms"\) === "vvip"/);
  assert.match(appSource, /link\.id === "open-vvip-rooms-button" && vvipRoomsView/);
  // Landing on the lobby from the nav must not bounce the player into the mode picker first.
  assert.match(appSource, /if \(isVvipRoomsDeepLink\(\)\)/);
});

test("the hidden lobby really leaves the page instead of covering the board", () => {
  // `.vvip-rooms-view` is declared after the generic `.hidden` rule with equal specificity, so it
  // needs its own hide rule or `display: flex` wins and the overlay swallows every click.
  assert.match(
    stylesSource,
    /\.vvip-rooms-view\.hidden\s*\{[^}]*display:\s*none/,
    "the lobby needs a .hidden-specific display:none rule",
  );
});

test("the room lobby cards carry preview, name, free badge, growth and an enter action", () => {
  const cardSource = extractFunctionSource("buildVvipRoomCardMarkup");

  ["vvip-room-card__preview", "vvip-room-card__title", "免费体验中", "vvip-room-card__growth", "vvip-room-card__enter", "data-room-enter"].forEach((token) => {
    assert.ok(cardSource.includes(token), `${token} must be part of the room card`);
  });

  assert.match(cardSource, /data-room-stage=/);
});

test("entering a dream room repaints the skin without touching the match state", () => {
  const clickSource = extractFunctionSource("handleThemeClick");
  const roomEnterBranch = clickSource.slice(0, clickSource.indexOf('closest("[data-theme]")'));

  assert.match(roomEnterBranch, /dataset\.roomEnter/);
  assert.match(roomEnterBranch, /applyVipTheme\(roomButton\.dataset\.roomEnter\)/);
  // Picking a room returns the player to the board rather than leaving the lobby stacked on top.
  assert.match(roomEnterBranch, /closeVvipRoomsView\(\)/);
  assert.doesNotMatch(roomEnterBranch, /resetSession|clearSession|newRound|room:create|disconnect/i);
  // The card must not start the round or re-create a room when a room is picked.
  assert.doesNotMatch(roomEnterBranch, /submitAuthoritativeCellChange|startGame/);
  // The cards live in the lobby grid, not in `#theme-controls`, so the delegated handler must be
  // bound to their own container too.
  assert.match(appSource, /vvipRoomGrid\?\.addEventListener\("click", handleThemeClick\)/);
});

/* ----------------------------------------------------------------- *
 * 4. VVIP skin variables — three palettes, one contract, no bleed
 * ----------------------------------------------------------------- */

test("all three dream rooms declare the same UI variable set so no earlier skin can linger", () => {
  const palettes = {
    moonlight: extractCssRuleBody(vvipThemeCss, 'body[data-vip-theme="vvip-moonlight"]'),
    observatory: extractCssRuleBody(vvipThemeCss, 'body[data-vip-theme="vvip-observatory"]'),
    sakura: extractCssRuleBody(vvipThemeCss, 'body[data-vip-theme="vvip-sakura"]'),
  };

  Object.entries(palettes).forEach(([name, body]) => {
    assert.ok(body, `${name} palette must exist`);
  });

  const requiredSurfaces = [
    "--panel-surface", // info panels
    "--board-frame", // board border
    "--cell-surface", // board cells
    "--button-surface", // digit buttons
    "--selected", // selection state
    "--modal-surface", // modals
    "--panel-backdrop", // glass panels
    "--heading-glow",
  ];

  const base = cssCustomPropertyNames(palettes.moonlight);

  requiredSurfaces.forEach((property) => {
    assert.ok(base.includes(property), `moonlight must define ${property}`);
  });

  assert.deepEqual(cssCustomPropertyNames(palettes.observatory), base, "observatory must mirror the moonlight variable contract");
  assert.deepEqual(cssCustomPropertyNames(palettes.sakura), base, "sakura must mirror the moonlight variable contract");
});

test("each dream room maps onto its briefed palette family", () => {
  const moonlight = extractCssRuleBody(vvipThemeCss, 'body[data-vip-theme="vvip-moonlight"]');
  const observatory = extractCssRuleBody(vvipThemeCss, 'body[data-vip-theme="vvip-observatory"]');
  const sakura = extractCssRuleBody(vvipThemeCss, 'body[data-vip-theme="vvip-sakura"]');

  // Ice blue / silver white vs deep purple with champagne gold vs sakura pink with cream.
  assert.match(moonlight, /--accent:\s*#3f8fc4/);
  assert.match(observatory, /--accent:\s*#d3b063/);
  assert.match(sakura, /--accent:\s*#c9a24a/);

  // Warm/dark bases keep the semi-transparent glass panels readable.
  assert.match(moonlight, /--bg:\s*#0a1a28/);
  assert.match(observatory, /--bg:\s*#150b2e/);
  assert.match(sakura, /--bg:\s*#2b1622/);
});

test("theme visuals stay behind the board and keep the board size untouched", () => {
  const decorBody = extractCssRuleBody(vvipThemeCss, ".vvip-decor");

  assert.match(decorBody, /pointer-events:\s*none/);
  assert.doesNotMatch(vvipThemeCss, /\.board\s*\{[^}]*width/);
  assert.match(stylesSource, /#vip-skin-root \{[\s\S]*?pointer-events: none;/);
});

/* ----------------------------------------------------------------- *
 * 5. Notes: only the digits the player actually marked
 * ----------------------------------------------------------------- */

const createCellContentFactory = new Function(
  "document",
  "state",
  "isAuthoritativeMultiplayerRoundActive",
  "getActiveRoundEffect",
  "hasCellDuel",
  "isVersusMode",
  `${extractFunctionSource("createCellContent")}; return createCellContent;`,
);

function renderNoteSlots(cell, options = {}) {
  const state = { selectedIndex: options.selectedIndex ?? -1, activeDigit: null };
  const createCellContent = createCellContentFactory(
    { createElement: createFakeElement },
    state,
    () => false,
    () => null,
    (target) => Boolean(target && target.duel),
    () => false,
  );
  const content = createCellContent(cell, options.index ?? 0, options.createOptions || {});
  const grid = content.children.find((child) => String(child.className).includes("notes-grid"));

  if (!grid) {
    return null;
  }

  return grid.children.map((slot) => ({ digit: slot.dataset.noteDigit, text: slot.textContent }));
}

function visibleDigits(slots) {
  return slots.filter((slot) => slot.text).map((slot) => slot.digit);
}

test("an untouched empty cell shows no candidate digits at all", () => {
  assert.equal(renderNoteSlots({ value: "", notes: {} }), null);
});

test("a focused empty cell reserves the nine slots but leaves every one blank", () => {
  const slots = renderNoteSlots({ value: "", notes: {} }, { selectedIndex: 0, index: 0 });

  assert.equal(slots.length, 9);
  assert.deepEqual(visibleDigits(slots), []);
  assert.deepEqual(slots.map((slot) => slot.digit), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
});

test("one marked candidate shows exactly one digit", () => {
  const slots = renderNoteSlots({ value: "", notes: { 2: "A" } }, { selectedIndex: 0, index: 0 });

  assert.equal(slots.length, 9);
  assert.deepEqual(visibleDigits(slots), ["2"]);
});

test("three marked candidates show exactly those three digits", () => {
  const slots = renderNoteSlots({ value: "", notes: { 2: "A", 6: "A", 9: "B" } }, { selectedIndex: 0, index: 0 });

  assert.deepEqual(visibleDigits(slots), ["2", "6", "9"]);
});

test("nine marked candidates stay fully visible", () => {
  const notes = {};
  for (let digit = 1; digit <= 9; digit += 1) {
    notes[digit] = "A";
  }

  const slots = renderNoteSlots({ value: "", notes }, { selectedIndex: 0, index: 0 });

  assert.deepEqual(visibleDigits(slots), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
});

test("unmarked candidates hide again as soon as the mark is removed", () => {
  const slots = renderNoteSlots({ value: "", notes: { 2: "A", 9: "A" } }, { selectedIndex: 0, index: 0 });

  assert.deepEqual(visibleDigits(slots), ["2", "9"]);
  assert.ok(!visibleDigits(slots).includes("6"));
});

test("the note renderer only prints marked digits, never a faint placeholder", () => {
  const createSource = extractFunctionSource("createCellContent");

  assert.match(createSource, /note\.textContent = owner \? key : ""/);
  assert.doesNotMatch(createSource, /note\.textContent = key\b/);
  assert.match(createSource, /note\.classList\.toggle\("filled", Boolean\(owner\)\)/);
  // No CSS pseudo-element may paint a digit the player has not chosen.
  assert.doesNotMatch(stylesSource, /\.note-slot[^{]*::(?:before|after)/);
});

const toggleCellNoteFactory = new Function(
  "state",
  "syncSharedStateFromStorage",
  "isAuthoritativeMultiplayerRoundActive",
  "getCurrentSession",
  "isVersusMode",
  "hasCellDuel",
  "snapshotSoloCell",
  "recordSoloUndoEntry",
  "saveState",
  "renderBoard",
  `${extractFunctionSource("toggleCellNote")}; return toggleCellNote;`,
);

function createNoteToggleHarness(cell) {
  const state = { operator: "A", feedback: "", difficulty: "easy", puzzleIndexes: {} };
  const session = { cells: [cell] };
  const undoEntries = [];
  const renders = [];

  const toggle = toggleCellNoteFactory(
    state,
    () => {},
    () => false,
    () => session,
    () => false,
    (target) => Boolean(target && target.duel),
    (target) => ({ value: target.value, notes: { ...target.notes } }),
    (entry) => undoEntries.push(entry),
    () => {},
    () => renders.push(1),
  );

  return { toggle, cell, undoEntries, renders };
}

test("toggling notes accumulates the player's own picks and removes them on a second tap", () => {
  const harness = createNoteToggleHarness({ value: "", given: false, owner: null, notes: {}, duel: null });

  harness.toggle(0, "2");
  assert.deepEqual(Object.keys(harness.cell.notes), ["2"]);

  harness.toggle(0, "6");
  assert.deepEqual(Object.keys(harness.cell.notes), ["2", "6"]);

  harness.toggle(0, "9");
  assert.deepEqual(Object.keys(harness.cell.notes), ["2", "6", "9"]);

  harness.toggle(0, "6");
  assert.deepEqual(Object.keys(harness.cell.notes), ["2", "9"]);

  // Each toggle is undoable and repaints the board.
  assert.equal(harness.undoEntries.length, 4);
  assert.equal(harness.renders.length, 4);
});

test("notes cannot be written onto given or already solved cells", () => {
  const givenHarness = createNoteToggleHarness({ value: "", given: true, owner: null, notes: {}, duel: null });
  givenHarness.toggle(0, "4");
  assert.deepEqual(givenHarness.cell.notes, {});

  const solvedHarness = createNoteToggleHarness({ value: "7", given: false, owner: "A", notes: {}, duel: null });
  solvedHarness.toggle(0, "4");
  assert.deepEqual(solvedHarness.cell.notes, {});
});

/* ----------------------------------------------------------------- *
 * 6. Serving the module SDK with a JavaScript MIME type
 * ----------------------------------------------------------------- */

test("server.js serves .mjs as JavaScript and bypasses caches", () => {
  const serverSource = readFile("server.js");

  assert.match(serverSource, /"\.mjs":\s*"text\/javascript; charset=utf-8"/);
  assert.match(serverSource, /const shouldBypassCache = [^;]*ext === "\.mjs"/);
});

test("the vendored SDK module is served with a JavaScript content type", async (t) => {
  const port = 3300 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: "ignore",
  });

  t.after(() => {
    child.kill("SIGTERM");
  });

  let ready = false;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);

      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // server still booting
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(ready, "the local server must come up");

  const moduleResponse = await fetch(`http://127.0.0.1:${port}/vendor/discord-embedded-app-sdk.mjs`);
  const contentType = moduleResponse.headers.get("content-type") || "";

  assert.equal(moduleResponse.status, 200);
  assert.match(contentType, /javascript/);
  assert.equal(moduleResponse.headers.get("cache-control"), "no-store");

  const loaderResponse = await fetch(`http://127.0.0.1:${port}/vendor/discord-runtime-loader.js`);
  assert.match(loaderResponse.headers.get("content-type") || "", /javascript/);
});
