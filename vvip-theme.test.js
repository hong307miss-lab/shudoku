const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const vvip = require("./vvip/vvip-theme.js");

const ROOT = __dirname;

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));

  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

function createFailingStorage() {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };
}

/* ------------------------------------------------------------------ *
 * Minimal fake DOM, just enough for the VVIP controller.
 * ------------------------------------------------------------------ */

function createFakeDom() {
  function createElement(tagName) {
    let innerHTMLValue = "";

    const element = {
      tagName: String(tagName).toUpperCase(),
      children: [],
      attributes: {},
      dataset: {},
      className: "",
      src: "",
      alt: "",
      listeners: {},
      style: {
        props: {},
        setProperty(name, value) {
          this.props[name] = value;
        },
        removeProperty(name) {
          delete this.props[name];
        },
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name)
          ? this.attributes[name]
          : null;
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      addEventListener(type, handler) {
        this.listeners[type] = handler;
      },
      appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        return child;
      },
    };

    Object.defineProperty(element, "innerHTML", {
      get() {
        return innerHTMLValue;
      },
      set(value) {
        innerHTMLValue = value;

        if (value === "") {
          element.children.length = 0;
        }
      },
    });

    return element;
  }

  const documentElement = createElement("html");
  const body = createElement("body");
  const document = {
    documentElement,
    body,
    createElement,
    querySelector: () => null,
  };

  return { document, documentElement, body, createElement };
}

function createTestController(overrides = {}) {
  const dom = createFakeDom();
  const root = dom.createElement("div");
  root.ownerDocument = dom.document;
  const storage = overrides.storage || createMemoryStorage();

  const controller = vvip.createController({
    root,
    storage,
    getReducedMotion: overrides.getReducedMotion || (() => false),
    onAssetError: overrides.onAssetError || null,
    onStageUp: overrides.onStageUp || null,
  });

  return { controller, root, storage, dom };
}

/* ------------------------------------------------------------------ *
 * Theme Registry
 * ------------------------------------------------------------------ */

test("vvip registry exposes three themes with unique ids", () => {
  assert.equal(vvip.themes.length, 3);

  const ids = vvip.themes.map((theme) => theme.id);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(ids, ["vvip-moonlight", "vvip-observatory", "vvip-sakura"]);
  assert.ok(ids.every((id) => id.startsWith("vvip-")));
});

test("vvip theme ids never collide with the free vip theme ids", () => {
  const contentSource = fs.readFileSync(path.join(ROOT, "game-content.js"), "utf8");
  const freeIds = [...contentSource.matchAll(/id:\s*"([^"]+)"/g)].map((match) => match[1]);

  assert.ok(freeIds.length > 0);

  for (const theme of vvip.themes) {
    assert.ok(!freeIds.includes(theme.id), `${theme.id} should not reuse a free VIP id`);
  }
});

test("growth thresholds are 0 / 5 / 15 / 30", () => {
  assert.deepEqual(vvip.stageThresholds, [0, 5, 15, 30]);
  assert.equal(vvip.maxStage, 3);
});

test("the shipped manifest keeps the same growth thresholds as the runtime", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "vvip", "theme_manifest.json"), "utf8"));

  assert.deepEqual(manifest.growth_stages, vvip.stageThresholds);
});

test("every vvip theme ships desktop and mobile background masters on disk", () => {
  for (const theme of vvip.themes) {
    const paths = vvip.getBackgroundPaths(theme.id);

    for (const size of ["desktop", "mobile"]) {
      const relative = paths[size].replace(/^\.\//, "");
      const absolute = path.join(ROOT, relative);

      assert.ok(fs.existsSync(absolute), `${relative} should exist`);
      assert.ok(fs.statSync(absolute).size > 10_000, `${relative} should not be a placeholder`);
    }
  }
});

test("every vvip theme maps a growth overlay for all four stages", () => {
  for (const theme of vvip.themes) {
    for (const stage of [0, 1, 2, 3]) {
      const relative = vvip.getStageOverlayPath(theme.id, stage).replace(/^\.\//, "");

      assert.ok(fs.existsSync(path.join(ROOT, relative)), `${relative} should exist`);
    }
  }
});

test("unknown theme ids resolve to no assets", () => {
  assert.equal(vvip.getBackgroundPaths("vvip-unknown"), null);
  assert.equal(vvip.getStageOverlayPath("vvip-unknown", 1), null);
  assert.equal(vvip.getVvipTheme("retro"), null);
  assert.equal(vvip.isVvipThemeId("retro"), false);
});

/* ------------------------------------------------------------------ *
 * Progress Manager
 * ------------------------------------------------------------------ */

test("computeStage maps completion counts onto the four stages", () => {
  const cases = [
    [0, 0],
    [1, 0],
    [4, 0],
    [5, 1],
    [14, 1],
    [15, 2],
    [29, 2],
    [30, 3],
    [400, 3],
  ];

  for (const [count, expected] of cases) {
    assert.equal(vvip.computeStage(count), expected, `${count} completions should be stage ${expected}`);
  }

  assert.equal(vvip.computeStage(-5), 0);
  assert.equal(vvip.computeStage("nonsense"), 0);
});

test("recordCompletion credits a first-time valid completion", () => {
  const storage = createMemoryStorage();
  const result = vvip.recordCompletion(storage, {
    themeId: "vvip-moonlight",
    roundId: "solo:abc",
    playerId: "u1",
  });

  assert.equal(result.credited, true);
  assert.equal(result.completedCount, 1);
  assert.equal(result.stage, 0);
  assert.equal(result.stageUp, false);
  assert.equal(vvip.getThemeProgress(storage, "vvip-moonlight").completedCount, 1);
});

test("repeating the same round id never adds progress twice", () => {
  const storage = createMemoryStorage();
  const payload = { themeId: "vvip-sakura", roundId: "round:evt-1", playerId: "u1" };

  const first = vvip.recordCompletion(storage, payload);
  const replay = vvip.recordCompletion(storage, payload);
  const replayWithSamePlayer = vvip.recordCompletion(storage, { ...payload });

  assert.equal(first.credited, true);
  assert.equal(replay.credited, false);
  assert.equal(replay.reason, "duplicate-round");
  assert.equal(replayWithSamePlayer.credited, false);
  assert.equal(vvip.getThemeProgress(storage, "vvip-sakura").completedCount, 1);
});

test("the same round id credits two different players independently", () => {
  const storage = createMemoryStorage();

  vvip.recordCompletion(storage, { themeId: "vvip-sakura", roundId: "round:evt-9", playerId: "u1" });
  vvip.recordCompletion(storage, { themeId: "vvip-sakura", roundId: "round:evt-9", playerId: "u2" });

  assert.equal(vvip.getThemeProgress(storage, "vvip-sakura").completedCount, 2);
});

test("growth progress stays isolated per theme", () => {
  const storage = createMemoryStorage();

  for (let index = 0; index < 5; index += 1) {
    vvip.recordCompletion(storage, {
      themeId: "vvip-moonlight",
      roundId: `solo:${index}`,
      playerId: "u1",
    });
  }

  assert.equal(vvip.getThemeProgress(storage, "vvip-moonlight").stage, 1);
  assert.equal(vvip.getThemeProgress(storage, "vvip-observatory").stage, 0);
  assert.equal(vvip.getThemeProgress(storage, "vvip-sakura").completedCount, 0);
});

test("crossing a threshold reports a stage up", () => {
  const storage = createMemoryStorage();
  let last = null;

  for (let index = 0; index < 15; index += 1) {
    last = vvip.recordCompletion(storage, {
      themeId: "vvip-observatory",
      roundId: `solo:${index}`,
      playerId: "u1",
    });
  }

  assert.equal(last.completedCount, 15);
  assert.equal(last.stage, 2);
  assert.equal(last.stageUp, true, "reaching the 15-credit threshold unlocks stage 2");
  assert.equal(last.previousStage, 1);

  const sixteenth = vvip.recordCompletion(storage, {
    themeId: "vvip-observatory",
    roundId: "solo:15",
    playerId: "u1",
  });

  assert.equal(sixteenth.credited, true);
  assert.equal(sixteenth.stage, 2);
  assert.equal(sixteenth.stageUp, false);

  const stageUpStorage = createMemoryStorage();
  let stageUpResult = null;

  for (let index = 0; index < 5; index += 1) {
    stageUpResult = vvip.recordCompletion(stageUpStorage, {
      themeId: "vvip-observatory",
      roundId: `solo:${index}`,
      playerId: "u1",
    });
  }

  assert.equal(stageUpResult.stage, 1);
  assert.equal(stageUpResult.stageUp, true);
  assert.equal(stageUpResult.previousStage, 0);
});

test("progress survives a storage round trip", () => {
  const storage = createMemoryStorage();

  vvip.recordCompletion(storage, { themeId: "vvip-sakura", roundId: "solo:1", playerId: "u1" });
  vvip.recordCompletion(storage, { themeId: "vvip-sakura", roundId: "solo:2", playerId: "u1" });

  const reloaded = vvip.readProgress(storage);
  assert.equal(reloaded.version, 1);
  assert.equal(reloaded.themes["vvip-sakura"].completedCount, 2);
  assert.equal(reloaded.themes["vvip-sakura"].creditedRoundIds.length, 2);
});

test("unknown progress versions reset instead of guessing", () => {
  const storage = createMemoryStorage({
    [vvip.progressStorageKey]: JSON.stringify({
      version: 99,
      themes: { "vvip-sakura": { completedCount: 30, creditedRoundIds: [] } },
    }),
  });

  const progress = vvip.readProgress(storage);
  assert.deepEqual(progress, { version: 1, themes: {} });
});

test("corrupted growth progress resets instead of throwing", () => {
  const storage = createMemoryStorage({ [vvip.progressStorageKey]: "{not json" });
  assert.deepEqual(vvip.readProgress(storage), { version: 1, themes: {} });
});

test("unknown themes and empty round ids are rejected", () => {
  const storage = createMemoryStorage();

  assert.equal(vvip.recordCompletion(storage, { themeId: "retro", roundId: "solo:1" }).credited, false);
  assert.equal(vvip.recordCompletion(storage, { themeId: "retro", roundId: "solo:1" }).reason, "unknown-theme");
  assert.equal(vvip.recordCompletion(storage, { themeId: "vvip-sakura", roundId: "   " }).reason, "missing-round-id");
  assert.equal(vvip.readProgress(storage).themes["vvip-sakura"], undefined);
});

test("a storage write failure never invents extra progress", () => {
  const result = vvip.recordCompletion(createFailingStorage(), {
    themeId: "vvip-sakura",
    roundId: "solo:1",
    playerId: "u1",
  });

  assert.equal(result.credited, true);
  assert.equal(result.persisted, false);
});

/* ------------------------------------------------------------------ *
 * Effects Controller
 * ------------------------------------------------------------------ */

test("effects off disables every ambient particle", () => {
  const plan = vvip.resolveEffectsPlan({ effectsEnabled: false, reducedMotion: false, viewportWidth: 1440 });
  assert.deepEqual(plan, { enabled: false, level: "off", particleCount: 0, animate: false });
});

test("prefers-reduced-motion keeps decoration but drops motion", () => {
  const plan = vvip.resolveEffectsPlan({ effectsEnabled: true, reducedMotion: true, viewportWidth: 1440 });
  assert.equal(plan.enabled, true);
  assert.equal(plan.animate, false);
  assert.equal(plan.particleCount, 0);
});

test("narrow and low-memory devices get fewer particles", () => {
  assert.equal(vvip.resolveEffectsPlan({ effectsEnabled: true, viewportWidth: 480 }).particleCount, 5);
  assert.equal(vvip.resolveEffectsPlan({ effectsEnabled: true, viewportWidth: 1440, deviceMemory: 2 }).particleCount, 3);
  assert.equal(vvip.resolveEffectsPlan({ effectsEnabled: true, viewportWidth: 1440, deviceMemory: 8 }).particleCount, 9);
});

test("effects preference persists and defaults to on", () => {
  const storage = createMemoryStorage();
  assert.equal(vvip.readEffectsPreference(storage), true);

  vvip.writeEffectsPreference(storage, false);
  assert.equal(vvip.readEffectsPreference(storage), false);

  vvip.writeEffectsPreference(storage, true);
  assert.equal(vvip.readEffectsPreference(storage), true);
});

test("pickThemeWithFallback swaps out unloadable themes", () => {
  assert.equal(vvip.pickThemeWithFallback("vvip-sakura", ["vvip-sakura"], "retro"), "vvip-sakura");
  assert.equal(vvip.pickThemeWithFallback("vvip-sakura", [], "retro"), "retro");
  assert.equal(vvip.pickThemeWithFallback(null, ["vvip-sakura"], "retro"), "retro");
});

/* ------------------------------------------------------------------ *
 * Renderer / Selector (fake DOM)
 * ------------------------------------------------------------------ */

test("applying a theme renders the stage overlay for the current growth stage", () => {
  const { controller, root, storage } = createTestController();

  controller.applyTheme("vvip-moonlight");

  assert.equal(root.dataset.theme, "vvip-moonlight");
  assert.equal(root.dataset.vvipStage, "0");

  const decor = root.children[0];
  const stageImage = decor.children.find((child) => child.className === "vvip-decor__stage");
  assert.ok(stageImage, "stage overlay image should be rendered");
  assert.equal(stageImage.src, vvip.getStageOverlayPath("vvip-moonlight", 0));

  for (let index = 0; index < 5; index += 1) {
    vvip.recordCompletion(storage, { themeId: "vvip-moonlight", roundId: `r${index}`, playerId: "u1" });
  }

  controller.render();
  assert.equal(root.dataset.vvipStage, "1");

  const upgraded = root.children[0].children.find((child) => child.className === "vvip-decor__stage");
  assert.equal(upgraded.src, vvip.getStageOverlayPath("vvip-moonlight", 1));
});

test("the decor layer never blocks pointer interaction", () => {
  const { controller, root } = createTestController();
  controller.applyTheme("vvip-sakura");

  const html = fs.readFileSync(path.join(ROOT, "vvip", "vvip-theme.css"), "utf8");
  const baseStyles = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  const skinRootRule = baseStyles.match(/#vip-skin-root\s*\{[^}]*\}/);

  assert.ok(skinRootRule, "#vip-skin-root rule should exist in the base stylesheet");
  assert.match(skinRootRule[0], /pointer-events:\s*none/);
  assert.match(html, /\.vvip-decor\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(html, /\.vvip-particle\s*\{[^}]*pointer-events:\s*none/s);
});

test("turning effects off removes every particle layer", () => {
  const { controller, root } = createTestController();

  controller.applyTheme("vvip-sakura");
  assert.ok(root.children[0].children.some((child) => child.className.startsWith("vvip-particles")));

  controller.setEffects(false);
  assert.equal(controller.getEffectsEnabled(), false);
  assert.ok(!controller.getEffectsPlan().enabled);
  assert.ok(!root.children[0].children.some((child) => child.className.startsWith("vvip-particles")));
});

test("reduced motion renders decoration without particles", () => {
  const { controller, root } = createTestController({ getReducedMotion: () => true });

  controller.applyTheme("vvip-observatory");

  const decor = root.children[0];
  assert.ok(decor.children.some((child) => child.className === "vvip-decor__stage"));
  assert.ok(!decor.children.some((child) => child.className.startsWith("vvip-particles")));
});

test("clearing the theme empties the decor root and drops the background variables", () => {
  const { controller, root, dom } = createTestController();

  controller.applyTheme("vvip-observatory");
  assert.ok(dom.documentElement.style.props["--vvip-bg-desktop"]);

  controller.clearTheme();

  assert.equal(root.children.length, 0);
  assert.equal(root.dataset.theme, "");
  assert.equal(dom.documentElement.style.props["--vvip-bg-desktop"], undefined);
});

test("a stage unlock fires the one-shot celebration attribute", () => {
  const { controller, storage, dom } = createTestController();

  controller.applyTheme("vvip-moonlight");

  for (let index = 0; index < 5; index += 1) {
    controller.recordCompletion({ themeId: "vvip-moonlight", roundId: `r${index}`, playerId: "u1" });
  }

  assert.equal(dom.body.dataset.vvipCelebrate, "1");
  assert.equal(controller.getThemeProgress("vvip-moonlight").stage, 1);
  assert.equal(storage.getItem(vvip.progressStorageKey) !== null, true);
});

test("a broken overlay asset reports back so the caller can fall back", () => {
  const reported = [];
  const { controller, root } = createTestController({ onAssetError: (themeId) => reported.push(themeId) });

  controller.applyTheme("vvip-sakura");
  const stageImage = root.children[0].children.find((child) => child.className === "vvip-decor__stage");
  stageImage.listeners.error();

  assert.deepEqual(reported, ["vvip-sakura"]);
});

test("non vvip themes leave the decor untouched", () => {
  const { controller, root } = createTestController();

  assert.equal(controller.applyTheme("retro"), null);
  assert.equal(root.children.length, 0);
});

/* ------------------------------------------------------------------ *
 * Static integration guards
 * ------------------------------------------------------------------ */

test("vvip assets are served from relative paths only", () => {
  const cssSource = fs.readFileSync(path.join(ROOT, "vvip", "vvip-theme.css"), "utf8");
  const jsSource = fs.readFileSync(path.join(ROOT, "vvip", "vvip-theme.js"), "utf8");

  assert.ok(!/url\(\s*["']?https?:/i.test(cssSource), "vvip-theme.css must not reference absolute URLs");
  assert.ok(!/https?:\/\//.test(jsSource), "vvip-theme.js must not reference absolute URLs");

  for (const theme of vvip.themes) {
    assert.ok(vvip.getBackgroundPaths(theme.id).desktop.startsWith("./vvip/assets/"));
    assert.ok(vvip.getStageOverlayPath(theme.id, 0).startsWith("./vvip/assets/overlays/"));
  }
});

test("the vvip module only ships on the VIP Room page", () => {
  for (const page of ["index.html", "lobby-b.html", "player-b.html"]) {
    const source = fs.readFileSync(path.join(ROOT, page), "utf8");
    const loadsVvip = source.includes("./vvip/vvip-theme.js");

    assert.equal(loadsVvip, page === "player-b.html", `${page} vvip script inclusion`);
  }
});

test("app.js routes vvip themes and never resets the running game on a theme change", () => {
  const appSource = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const handlerStart = appSource.indexOf("function handleThemeClick(event)");
  const handlerEnd = appSource.indexOf("function handleStorageSync(event)");
  const handlerSource = appSource.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart > 0 && handlerEnd > handlerStart);
  assert.ok(!handlerSource.includes("startApp("), "theme changes must not restart the app");
  assert.ok(!handlerSource.includes("openModeSelectModal("), "theme changes must not reopen mode select");
  assert.ok(!/state\.(gameMode|difficulty|sessionKey|activeRound)\s*=/.test(handlerSource));

  const applyStart = appSource.indexOf("function applyVipTheme(theme)");
  const applyEnd = appSource.indexOf("function loadVipThemePreference()");
  const applySource = appSource.slice(applyStart, applyEnd);

  assert.ok(applySource.includes("vvipController?.applyTheme(safeTheme)"));
  assert.ok(applySource.includes("vvipController?.clearTheme()"));
  assert.ok(!/state\.(gameMode|difficulty|sessionKey)\s*=/.test(applySource));
});

test("growth credits are wired for solo, versus and authoritative multiplayer completions", () => {
  const appSource = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const matches = appSource.match(/^\s*recordVvipCompletionIfNeeded\(session\);/gm) || [];

  assert.equal(matches.length, 3, "solo/ranked, versus and co-op completion paths should each credit growth");
  assert.ok(appSource.includes("function recordVvipCompletionIfNeeded(session)"));
  assert.ok(appSource.includes("state.activeRound.completedEventId"));
});

test("removing the ZIP never breaks runtime assets", () => {
  const zipPath = path.join(ROOT, "skins", "Kalis_Sudoku_VVIP_ThemePack_v1.zip");
  const vvipSource = fs.readFileSync(path.join(ROOT, "vvip", "vvip-theme.js"), "utf8");

  assert.ok(fs.existsSync(zipPath), "the source pack should still be present locally");
  assert.ok(!vvipSource.includes(".zip"), "runtime code must not read the source pack");
});
