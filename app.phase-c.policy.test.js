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
const vendorSdkSource = readFile("vendor/discord-embedded-app-sdk.mjs");
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

  // Host identity and available space are two separate questions. The three-column contract is
  // gated on width only, so a short Activity panel keeps the rails instead of collapsing into the
  // long vertical web page.
  assert.match(stylesSource, /@media \(min-width: 880px\) \{/);
  assert.doesNotMatch(stylesSource, /@media \(min-width: 880px\) and \(min-height: 560px\)/);

  // Short landscape is still three columns, just tightened: the rows become fractions so a crowded
  // rail scrolls inside the viewport rather than overflowing the page.
  assert.match(stylesSource, /@media \(min-width: 880px\) and \(max-height: 559px\)/);

  // The only stacked, page-scrolling fallback is the narrow layout.
  assert.match(stylesSource, /@media \(max-width: 879px\) \{/);
  assert.doesNotMatch(stylesSource, /\(max-width: 879px\), \(max-height: 559px\)/);
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

/* ----------------------------------------------------------------- *
 * 7. Ranked Solo readability — the name dialog and the ranked cards
 * ----------------------------------------------------------------- */

const RANKED_CARD_SELECTORS = [
  ".ranked-summary-card strong",
  ".ranked-live-stat strong",
  ".ranked-leaderboard-item-name",
];

function extractRuleBodyContaining(source, fragment) {
  const index = source.indexOf(fragment);

  if (index < 0) {
    return null;
  }

  const open = source.indexOf("{", index);
  const close = source.indexOf("}", open);
  return open < 0 || close < 0 ? null : source.slice(open + 1, close);
}

function cssValue(body, property) {
  const match = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+);`).exec(body);
  return match ? match[1].trim() : null;
}

function hexToRgb(hex) {
  const value = String(hex).replace("#", "").trim();
  const full = value.length === 3 ? value.split("").map((channel) => channel + channel).join("") : value;
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16));
}

/** A translucent white surface is at its lightest over white and at its darkest over black. */
function translucentWhiteOver(alpha, background) {
  return [0, 1, 2].map((channel) => 255 * alpha + background[channel] * (1 - alpha));
}

function relativeLuminance(rgb) {
  const [red, green, blue] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test("the name field is inked from its own light surface instead of from the room", () => {
  const fieldRule = extractCssRuleBody(stylesSource, ".room-form-field input");

  assert.match(fieldRule, /color:\s*var\(--field-text\)/);
  // The touch height and the light fill that made the field usable stay untouched.
  assert.match(fieldRule, /min-height:\s*44px/);
  assert.match(fieldRule, /background:\s*rgba\(255,\s*255,\s*255,\s*0\.94\)/);

  assert.match(extractCssRuleBody(stylesSource, ".room-form-field input::placeholder"), /color:\s*var\(--field-placeholder\)/);
  assert.match(extractCssRuleBody(stylesSource, ".room-form-field input::selection"), /color:\s*#ffffff/);
  assert.match(extractCssRuleBody(stylesSource, ".room-form-field input:focus"), /outline:\s*2px solid var\(--field-focus-ring/);
});

test("the dark room keeps its own light text while only the field and card ink goes dark", () => {
  const observatory = extractCssRuleBody(vvipThemeCss, 'body[data-vip-theme="vvip-observatory"]');

  // The room's own copy stays light on the dark glass; that is what must not be flipped.
  assert.match(observatory, /--text:\s*#f3f0ff/);
  assert.match(observatory, /--muted:\s*#c4bcec/);

  // The light surfaces get their own, darker ink.
  const fieldText = hexToRgb(cssValue(observatory, "--field-text"));
  const cardText = hexToRgb(cssValue(observatory, "--card-text"));

  assert.ok(relativeLuminance(fieldText) < 0.1, "--field-text must be a dark ink");
  assert.ok(relativeLuminance(cardText) < 0.1, "--card-text must be a dark ink");
  assert.notEqual(cssValue(observatory, "--field-text"), "#f3f0ff");
});

test("every ranked card text node is inked from the card and none from the room", () => {
  // From the white room summary card down to the ranked panel: every surface in this stretch is
  // the same translucent white, in both the web host and the Discord host.
  // Anchored on the leading newline: the same selector also appears inside the Discord host
  // override block, and only the standalone rule starts a line.
  const rankedRegion = stylesSource.slice(stylesSource.indexOf("\n.room-summary-card {"), stylesSource.indexOf("\n.room-hub-card {"));

  assert.ok(rankedRegion.length > 0, "the ranked panel region must be locatable");
  // The cards are white at 0.82 alpha, so a room-flavoured ink would vanish in the dark room.
  assert.doesNotMatch(rankedRegion, /color:\s*var\(--muted\)/);
  assert.doesNotMatch(rankedRegion, /color:\s*var\(--text\)/);
  assert.match(rankedRegion, /color:\s*var\(--card-text\)/);
  assert.match(rankedRegion, /color:\s*var\(--card-muted\)/);

  RANKED_CARD_SELECTORS.forEach((selector) => {
    const rule = extractRuleBodyContaining(rankedRegion, selector);
    assert.match(rule || "", /color:\s*var\(--card-text\)/, `${selector} must be inked from the card`);
  });

  // The Discord host re-inks the cards at a higher specificity, so it has to agree.
  const discordCardRule = extractRuleBodyContaining(stylesSource, 'body[data-runtime-kind="discord"] .ranked-summary-card strong');
  const discordMutedRule = extractRuleBodyContaining(stylesSource, 'body[data-runtime-kind="discord"] .ranked-live-stat-label');

  assert.match(discordCardRule || "", /color:\s*var\(--card-text\)/);
  assert.match(discordMutedRule || "", /color:\s*var\(--card-muted\)/);
});

test("the observatory Name button is inked for the light card and keeps its press and focus states", () => {
  const buttonBase = extractCssRuleBody(vvipThemeCss, 'body[data-vvip-theme="vvip-observatory"] .ranked-summary-card .chip-button');
  const pressed = extractCssRuleBody(vvipThemeCss, 'body[data-vvip-theme="vvip-observatory"] .ranked-summary-card .chip-button:active');
  const focus = extractCssRuleBody(vvipThemeCss, 'body[data-vvip-theme="vvip-observatory"] .ranked-summary-card .chip-button:focus-visible');

  assert.match(buttonBase, /color:\s*var\(--card-text\)/);
  // The override outranks `.chip-button:active`, so the pressed state has to be restated here or
  // the button would give no feedback at all.
  assert.ok(pressed, "the pressed state must be restated on the more specific rule");
  assert.match(pressed, /color:\s*#f3f0ff/);
  assert.match(pressed, /background:\s*#3a2a63/);
  assert.match(focus, /outline:\s*2px solid/);
});

test("the dream room ink clears WCAG AA on the lightest and darkest card and field surfaces", () => {
  const palettes = ["vvip-moonlight", "vvip-observatory", "vvip-sakura"];

  palettes.forEach((themeId) => {
    const palette = extractCssRuleBody(vvipThemeCss, `body[data-vip-theme="${themeId}"]`);
    const roomBackground = hexToRgb(cssValue(palette, "--bg"));

    // White at 0.82 alpha: brightest over white, dimmest over black.
    const cardSurfaces = [
      hexToRgb("#ffffff"),
      translucentWhiteOver(0.82, roomBackground),
      translucentWhiteOver(0.82, [0, 0, 0]),
    ];
    const fieldSurfaces = [hexToRgb("#ffffff"), translucentWhiteOver(0.94, [0, 0, 0])];

    const cardInks = [cssValue(palette, "--card-text"), cssValue(palette, "--card-muted")];
    const fieldInks = [cssValue(palette, "--field-text"), cssValue(palette, "--field-placeholder")];

    cardSurfaces.forEach((surface) => {
      cardInks.forEach((ink) => {
        const ratio = contrastRatio(hexToRgb(ink), surface);
        assert.ok(ratio >= 4.5, `${themeId} ${ink} on a ranked card is ${ratio.toFixed(2)}:1, below AA 4.5:1`);
      });
    });

    fieldSurfaces.forEach((surface) => {
      fieldInks.forEach((ink) => {
        const ratio = contrastRatio(hexToRgb(ink), surface);
        assert.ok(ratio >= 4.5, `${themeId} ${ink} in the name field is ${ratio.toFixed(2)}:1, below AA 4.5:1`);
      });
    });
  });
});

test("the Enter Your Name dialog keeps one deliberate gap between the field and its buttons", () => {
  const actionsRule = extractCssRuleBody(stylesSource, ".ranked-profile-card .room-hub-inline-actions");
  const marginTop = actionsRule ? /margin-top:\s*(\d+)px/.exec(actionsRule) : null;

  assert.ok(actionsRule, "the ranked profile action row needs its own spacing rule");
  assert.ok(marginTop, "the gap must come from a single explicit margin");
  assert.ok(Number(marginTop[1]) >= 16 && Number(marginTop[1]) <= 20, `the gap must sit in the 16-20px band, got ${marginTop[1]}px`);

  // The form only supplies the label -> input gap, so no second margin is stacked into the space.
  const formField = extractCssRuleBody(stylesSource, ".room-form-field");
  assert.match(formField, /gap:\s*6px/);
  assert.doesNotMatch(formField, /margin/);

  // Touch sizes and the narrow-window fallback are untouched.
  assert.match(extractCssRuleBody(stylesSource, ".room-form-field input"), /min-height:\s*44px/);
  assert.match(extractCssRuleBody(stylesSource, "\n.room-hub-inline-actions"), /flex-wrap:\s*wrap/);
});

/* ----------------------------------------------------------------- *
 * 8. The hidden, read-only diagnostics entry
 * ----------------------------------------------------------------- */

test("the diagnostics panel needs either the query flag or the developer chord", () => {
  assert.match(appSource, /function isRuntimeDebugActive\(\)/);
  assert.match(appSource, /function toggleRuntimeDiagnostics\(\)/);
  assert.match(extractFunctionSource("isRuntimeDebugActive"), /isRuntimeDebugEnabled\(\)\s*\|\|\s*runtimeDebugShortcutActive/);
  assert.match(extractFunctionSource("setupRuntimeDiagnostics"), /!isRuntimeDebugActive\(\)/);
  assert.match(extractFunctionSource("toggleRuntimeDiagnostics"), /setupRuntimeDiagnostics\(\)/);

  // Rendered by the query flag on load and by the chord on demand - nowhere else.
  assert.match(appSource, /if \(!guardVipEntry\(\)\) \{\s*setupRuntimeDiagnostics\(\);/);
});

test("the developer chord is an explicit three-key combination with no on-screen affordance", () => {
  assert.match(appSource, /const isShortcutChord = \(event\.ctrlKey \|\| event\.metaKey\) && event\.shiftKey && !event\.altKey/);
  assert.match(appSource, /event\.key\.toLowerCase\(\) !== "d"/);
  assert.match(appSource, /event\.preventDefault\(\);\s*toggleRuntimeDiagnostics\(\);/);

  // No player-facing page advertises the panel or its chord.
  [indexPage, lobbyPage, playerPage].forEach((page) => {
    assert.doesNotMatch(page, /runtime-debug|runtime-diagnostics|Shift \+ D/i);
  });
});

test("the diagnostics entry is read-only, reports the required fields and never fabricates a host", () => {
  const diagnosticsSource = extractFunctionSource("collectRuntimeDiagnostics");
  const panelSource = extractFunctionSource("setupRuntimeDiagnostics");
  const toggleSource = extractFunctionSource("toggleRuntimeDiagnostics");

  [diagnosticsSource, panelSource, toggleSource].forEach((source) => {
    // The panel must report the runtime, never write it: forcing `runtime.kind` would fake the
    // exact condition the panel exists to measure.
    assert.doesNotMatch(source, /runtime\.kind\s*=\s*[^=]/);
    assert.doesNotMatch(source, /syncRuntimeSurface\(/);
    assert.doesNotMatch(source, /dataset\.runtimeKind\s*=/);
    assert.doesNotMatch(source, /applyDiscordRuntimeDetails\(/);
  });

  // `runtime.kind` is read straight off the state the rest of the app uses.
  assert.match(diagnosticsSource, /\["runtime\.kind", state\.runtime\.kind\]/);

  ["runtime.kind", "ready() handshake", "viewport", "grid column count", "active theme", "build css / js"].forEach((label) => {
    assert.match(diagnosticsSource, new RegExp(`\\["${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",`), `the panel must report ${label}`);
  });

  // No tokens, secrets or profile data.
  assert.doesNotMatch(diagnosticsSource, /token|secret|authorization/i);
  assert.doesNotMatch(diagnosticsSource, /global_name|avatar|discriminator|email/i);
});

/* ----------------------------------------------------------------- *
 * 9. Keeping the Activity layout across pages, and starting a new
 *    Activity session from the initial lobby
 * ----------------------------------------------------------------- */

test("the in-app nav links carry the Discord frame query so the next page can still handshake", () => {
  const linkSyncSource = extractFunctionSource("syncPageLinksWithRoom");
  const carrySource = extractFunctionSource("carryDiscordHostParams");

  // The nav chips are the only full-page jump between Lobby / VIP Room / VVIP Rooms, and the href
  // they publish has to keep `frame_id` — the vendored SDK reads it back out of location.search and
  // throws without it, which is what used to drop every later page onto the web layout.
  assert.match(linkSyncSource, /carryDiscordHostParams\(targetUrl\)/);

  // Only parameters already on the current page are copied, and only from inside a Discord frame.
  assert.match(carrySource, /isLikelyDiscordFrame\(\)/);
  assert.match(carrySource, /new URLSearchParams\(window\.location\.search\)/);
  assert.ok(
    carrySource.indexOf("isLikelyDiscordFrame()") < carrySource.indexOf("URLSearchParams"),
    "the Discord check must gate the copy, not follow it",
  );
  assert.doesNotMatch(carrySource, /localStorage|sessionStorage/);
  assert.doesNotMatch(carrySource, /userAgent|innerWidth|innerHeight/);

  // The carried list has to cover every parameter the vendored SDK throws on. It is not just
  // `frame_id` / `instance_id`: `platform` is mandatory too, and a real Discord iframe carries all
  // three, so a jump that dropped `platform` would fail the SDK exactly like a dropped `frame_id`.
  const hostParams = /const DISCORD_HOST_QUERY_PARAMS = \[([^\]]*)\]/.exec(appSource);
  assert.ok(hostParams, "DISCORD_HOST_QUERY_PARAMS must still be declared");
  const requiredParams = Array.from(
    vendorSdkSource.matchAll(/"([a-z_]+) query param is not defined"/g),
    (match) => match[1],
  );
  assert.deepEqual(
    [...requiredParams].sort(),
    ["frame_id", "instance_id", "platform"],
    "the vendored SDK's mandatory frame parameters changed; the carry list must be revisited",
  );
  requiredParams.forEach((name) => {
    assert.ok(
      hostParams[1].includes(`"${name}"`),
      `DISCORD_HOST_QUERY_PARAMS must carry every mandatory SDK parameter (missing ${name})`,
    );
  });
  // `channel_id` is optional to the SDK but becomes the channel name in the status rail, so it has
  // to survive an in-app jump as well.
  assert.ok(hostParams[1].includes('"channel_id"'), "DISCORD_HOST_QUERY_PARAMS must carry channel_id");

  // The first Lobby of a session only shows the mode picker, so `bootstrap()` — and with it the
  // room-aware rewrite above — never runs there. The chips still have to be stamped at boot, and
  // they inherit the same gate because the stamping goes through `carryDiscordHostParams`.
  const bootStampSource = extractFunctionSource("applyDiscordHostParamsToNavLinks");
  assert.match(bootStampSource, /carryDiscordHostParams\(/);
  assert.doesNotMatch(bootStampSource, /localStorage|sessionStorage|isLikelyDiscordFrame/);
  assert.doesNotMatch(bootStampSource, /state\.runtime\.kind/);
});

test("no page hard-codes a Discord frame id, so the host context can only come from the live frame", () => {
  [indexPage, lobbyPage, playerPage].forEach((page) => {
    assert.doesNotMatch(page, /frame_id=|instance_id=/);
  });
});

test("a new Discord Activity session drops the finished solo board and nothing else", () => {
  const discardSource = extractFunctionSource("discardCompletedSoloBoards");
  const beginSource = extractFunctionSource("beginDiscordActivitySession");

  assert.match(discardSource, /\[SOLO_STORAGE_KEY, SOLO_RANKED_STORAGE_KEY\]/);
  assert.match(discardSource, /hasWon !== true/);

  // A round that is still being played keeps its resume, and so does every other stored key: the
  // ranked name, the theme rights, the auth session and the multiplayer room payloads.
  assert.doesNotMatch(discardSource, /isPaused|hasProgress/);
  ["VIP_THEME_STORAGE_KEY", "RANKED_PLAYER_NAME_STORAGE_KEY", "DISCORD_AUTH_STORAGE_KEY", "STORAGE_KEY:"].forEach((key) => {
    assert.ok(!discardSource.includes(key), `discardCompletedSoloBoards must not touch ${key}`);
  });

  // No lifecycle shortcut: a page jump or a hidden window must never clear a board.
  assert.doesNotMatch(discardSource, /beforeunload|visibilitychange|pagehide|\.clear\(\)/);
  assert.doesNotMatch(beginSource, /beforeunload|visibilitychange|pagehide|\.clear\(\)/);

  // The marker lives in sessionStorage, which survives every in-app jump and dies with the Activity.
  assert.match(extractFunctionSource("readActivitySessionMarker"), /readSessionValue\(ACTIVITY_SESSION_STORAGE_KEY\)/);
  assert.match(beginSource, /writeSessionValue\(ACTIVITY_SESSION_STORAGE_KEY, "1"\)/);
  assert.match(beginSource, /discardCompletedSoloBoards\(\)/);
  assert.doesNotMatch(appSource, /localStorage\.setItem\(ACTIVITY_SESSION_STORAGE_KEY/);
});

test("no script wipes a whole storage area", () => {
  assert.doesNotMatch(appSource, /localStorage\.clear\(|sessionStorage\.clear\(/);
});

test("the Activity session is opened after ready() and before the launch decision runs", () => {
  const initSource = extractFunctionSource("initRuntimeEnvironment");
  const readyIndex = initSource.indexOf("discordSdk.ready()");
  const kindIndex = initSource.indexOf('state.runtime.kind = "discord"');
  const sessionIndex = initSource.indexOf("beginDiscordActivitySession()");
  // `startApp()` also runs on the web-fallback branch early in the function; the launch decision
  // that matters here is the shared tail call, so anchor on the last occurrence.
  const startAppIndex = initSource.lastIndexOf("startApp()");

  assert.ok(readyIndex >= 0, "ready() must still be awaited");
  assert.ok(kindIndex > readyIndex, "the runtime must still claim Discord only after ready()");
  assert.ok(sessionIndex > kindIndex, "the session marker may only be written from a resolved handshake");
  assert.ok(startAppIndex > sessionIndex, "the finished board must be dropped before the launch decision");
});

test("a new Activity session opens on the lobby even when the stored round is unfinished", () => {
  const startAppSource = extractFunctionSource("startApp");
  const gateIndex = startAppSource.indexOf('state.runtime.activitySession === "new"');
  const resumeIndex = startAppSource.indexOf("shouldResumeSinglePlayerModeOnLaunch(");

  // "Not reopened" is not "not kept": the unfinished round is silenced for the launch, not deleted —
  // the only code that removes a stored board is `discardCompletedSoloBoards()`, and it removes
  // finished ones only. This branch must therefore never reach for a storage API.
  assert.ok(gateIndex >= 0, "startApp must consult the Activity session marker before resuming");
  assert.ok(resumeIndex > gateIndex, "the Activity session must be checked before the round is resumed");
  assert.doesNotMatch(startAppSource, /hasWon|removeItem|\.clear\(\)/);
});

test("a handshake that lands after the timeout closes an unfinished board too", () => {
  const promoteSource = extractFunctionSource("promoteSurfaceWhenDiscordHandshakeLands");

  // The late handshake promotes the surface after `startApp()` already ran against the web surface,
  // so it has to take the in-progress board off the screen the same way it does a finished one.
  assert.match(promoteSource, /hasStoredSessionProgress\(session\)/);
});

test("a handshake that lands after the timeout resets a finished board instead of leaving it up", () => {
  const promoteSource = extractFunctionSource("promoteSurfaceWhenDiscordHandshakeLands");

  assert.match(promoteSource, /beginDiscordActivitySession\(\)/);
  assert.match(promoteSource, /resetRoomStateForModeSelection\(\)/);
  // A live multiplayer room keeps its own snapshot and reconnection rules.
  assert.match(promoteSource, /!isRoomMultiplayerMode\(\)/);

  // Exactly one definition and the two call sites that rewrite the nav chips — no listener may open
  // a session.
  assert.equal((appSource.match(/beginDiscordActivitySession\(\)/g) || []).length, 3);
  assert.equal((appSource.match(/carryDiscordHostParams\(/g) || []).length, 3);
  // The boot path must rewrite the chips even when the mode picker means `bootstrap()` never runs.
  const initSource = extractFunctionSource("initRuntimeEnvironment");
  assert.ok(
    initSource.indexOf("applyDiscordHostParamsToNavLinks()") > initSource.indexOf("syncRuntimeSurface()"),
    "the nav chips must be stamped after the runtime surface is written",
  );
});

test("the diagnostics report which Activity session the page belongs to", () => {
  assert.match(extractFunctionSource("collectRuntimeDiagnostics"), /\["activity session", state\.runtime\.activitySession\]/);
  assert.match(appSource, /activitySession: "pending"/);
});
