/**
 * Kali's Sudoku — VVIP theme system.
 *
 * Separation of concerns (kept in one file on purpose so the runtime payload stays small):
 *   - Theme Registry   : theme metadata + asset mapping + growth stages
 *   - Progress Manager : versioned local growth progress (pure logic, node-testable)
 *   - Effects Controller: resolves how much motion is allowed (pure logic)
 *   - Theme Renderer   : background variables + stage decoration DOM
 *   - Theme Selector   : theme control markup + active state
 *
 * No DOM access happens at load time; nothing here touches game state.
 */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Theme Registry
   * ------------------------------------------------------------------ */

  // Theme ids are intentionally distinct from any future paid-entitlement ids.
  const VVIP_THEMES = [
    {
      id: "vvip-moonlight",
      label: "Moonlight Conservatory",
      labelZh: "月光玻璃温室",
      assetDir: "01_moonlight_conservatory",
      overlayPrefix: "flower",
      accent: "#cfe3d4",
      previewNote: "Warm greenhouse glass under moonlight.",
    },
    {
      id: "vvip-observatory",
      label: "Celestial Observatory",
      labelZh: "星河天文台",
      assetDir: "02_celestial_observatory",
      overlayPrefix: "constellation",
      accent: "#bcd4ff",
      previewNote: "Constellations gather as you solve.",
    },
    {
      id: "vvip-sakura",
      label: "Sakura Moon Garden",
      labelZh: "樱月庭院",
      assetDir: "03_sakura_moon_garden",
      overlayPrefix: "sakura_petals",
      accent: "#f6c6de",
      previewNote: "Petals drift across a quiet garden.",
    },
  ];

  const VVIP_STAGE_THRESHOLDS = [0, 5, 15, 30];
  const VVIP_MAX_STAGE = VVIP_STAGE_THRESHOLDS.length - 1;

  const VVIP_BASE_PATH = "./vvip/assets";
  const VVIP_THEME_ASSET_ROOT = `${VVIP_BASE_PATH}/themes/vvip`;
  const VVIP_OVERLAY_ROOT = `${VVIP_BASE_PATH}/overlays`;

  const vvipThemeById = Object.fromEntries(VVIP_THEMES.map((theme) => [theme.id, theme]));

  function getVvipTheme(themeId) {
    return vvipThemeById[themeId] || null;
  }

  function isVvipThemeId(themeId) {
    return Object.prototype.hasOwnProperty.call(vvipThemeById, themeId);
  }

  function getBackgroundPaths(themeId) {
    const theme = getVvipTheme(themeId);

    if (!theme) {
      return null;
    }

    const dir = `${VVIP_THEME_ASSET_ROOT}/${theme.assetDir}`;

    return {
      desktop: `${dir}/bg_desktop.webp`,
      mobile: `${dir}/bg_mobile.webp`,
    };
  }

  function getStageOverlayPath(themeId, stage) {
    const theme = getVvipTheme(themeId);

    if (!theme) {
      return null;
    }

    const safeStage = Math.min(VVIP_MAX_STAGE, Math.max(0, Math.floor(Number(stage) || 0)));

    return `${VVIP_OVERLAY_ROOT}/${theme.overlayPrefix}_stage_${safeStage}.svg`;
  }

  /* ------------------------------------------------------------------ *
   * Progress Manager (pure, versioned local storage)
   * ------------------------------------------------------------------ */

  const VVIP_PROGRESS_STORAGE_KEY = "discord-sudoku-vvip-progress-v1";
  const VVIP_PROGRESS_VERSION = 1;
  const VVIP_MAX_CREDITED_ROUNDS = 200;

  function createEmptyProgress() {
    return { version: VVIP_PROGRESS_VERSION, themes: {} };
  }

  function computeStage(completedCount) {
    const count = Math.max(0, Math.floor(Number(completedCount) || 0));
    let stage = 0;

    for (let index = 0; index < VVIP_STAGE_THRESHOLDS.length; index += 1) {
      if (count >= VVIP_STAGE_THRESHOLDS[index]) {
        stage = index;
      }
    }

    return stage;
  }

  function getNextStageThreshold(completedCount) {
    const count = Math.max(0, Math.floor(Number(completedCount) || 0));

    for (const threshold of VVIP_STAGE_THRESHOLDS) {
      if (count < threshold) {
        return threshold;
      }
    }

    return VVIP_STAGE_THRESHOLDS[VVIP_STAGE_THRESHOLDS.length - 1];
  }

  function normalizeProgressEntry(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    const completedCount = Math.max(0, Math.floor(Number(entry.completedCount) || 0));
    const creditedRoundIds = Array.isArray(entry.creditedRoundIds)
      ? entry.creditedRoundIds.filter((item) => typeof item === "string" && item).slice(-VVIP_MAX_CREDITED_ROUNDS)
      : [];

    return {
      completedCount,
      stage: computeStage(completedCount),
      creditedRoundIds,
    };
  }

  /**
   * Reads a versioned progress document. Unknown versions are discarded instead of guessed,
   * so a schema change can never silently credit the wrong number of games.
   */
  function normalizeProgress(raw) {
    const result = createEmptyProgress();

    if (!raw || typeof raw !== "object" || raw.version !== VVIP_PROGRESS_VERSION) {
      return result;
    }

    const themes = raw.themes && typeof raw.themes === "object" ? raw.themes : {};

    for (const themeId of Object.keys(themes)) {
      if (!isVvipThemeId(themeId)) {
        continue;
      }

      const entry = normalizeProgressEntry(themes[themeId]);

      if (entry) {
        result.themes[themeId] = entry;
      }
    }

    return result;
  }

  function readProgress(storage) {
    if (!storage) {
      return createEmptyProgress();
    }

    let raw = null;

    try {
      const serialized = storage.getItem(VVIP_PROGRESS_STORAGE_KEY);
      raw = serialized ? JSON.parse(serialized) : null;
    } catch (error) {
      raw = null;
    }

    return normalizeProgress(raw);
  }

  function writeProgress(storage, progress) {
    if (!storage) {
      return false;
    }

    try {
      storage.setItem(VVIP_PROGRESS_STORAGE_KEY, JSON.stringify(progress));
      return true;
    } catch (error) {
      return false;
    }
  }

  function getThemeProgress(storage, themeId) {
    const entry = readProgress(storage).themes[themeId];

    return entry || { completedCount: 0, stage: 0, creditedRoundIds: [] };
  }

  /**
   * Credits exactly one valid completion per (playerId, roundId) pair.
   * Restarts, losses and repeated completion events never add progress.
   */
  function recordCompletion(storage, { themeId, roundId, playerId } = {}) {
    if (!isVvipThemeId(themeId)) {
      return { credited: false, reason: "unknown-theme", completedCount: 0, stage: 0, stageUp: false };
    }

    const normalizedRoundId = typeof roundId === "string" ? roundId.trim() : "";

    if (!normalizedRoundId) {
      return { credited: false, reason: "missing-round-id", completedCount: 0, stage: 0, stageUp: false };
    }

    const progress = readProgress(storage);
    const entry = progress.themes[themeId] || { completedCount: 0, stage: 0, creditedRoundIds: [] };
    const token = `${playerId || "local"}::${normalizedRoundId}`;

    if (entry.creditedRoundIds.includes(token)) {
      return {
        credited: false,
        reason: "duplicate-round",
        completedCount: entry.completedCount,
        stage: entry.stage,
        previousStage: entry.stage,
        stageUp: false,
      };
    }

    const previousStage = entry.stage;
    entry.creditedRoundIds.push(token);

    if (entry.creditedRoundIds.length > VVIP_MAX_CREDITED_ROUNDS) {
      entry.creditedRoundIds = entry.creditedRoundIds.slice(-VVIP_MAX_CREDITED_ROUNDS);
    }

    entry.completedCount += 1;
    entry.stage = computeStage(entry.completedCount);
    progress.themes[themeId] = entry;
    const persisted = writeProgress(storage, progress);

    return {
      credited: true,
      reason: "",
      completedCount: entry.completedCount,
      stage: entry.stage,
      previousStage,
      stageUp: entry.stage > previousStage,
      persisted,
    };
  }

  /* ------------------------------------------------------------------ *
   * Effects Controller (pure planning)
   * ------------------------------------------------------------------ */

  const VVIP_EFFECTS_STORAGE_KEY = "discord-sudoku-vvip-effects-v1";
  const VVIP_EFFECTS_PARTICLE_COUNT = { off: 0, minimal: 0, low: 3, narrow: 5, full: 9 };

  function resolveEffectsPlan({ effectsEnabled, reducedMotion, viewportWidth, deviceMemory } = {}) {
    if (effectsEnabled === false) {
      return { enabled: false, level: "off", particleCount: 0, animate: false };
    }

    if (reducedMotion === true) {
      return { enabled: true, level: "minimal", particleCount: 0, animate: false };
    }

    const width = Number(viewportWidth) || 0;
    const memory = Number(deviceMemory) || 0;

    if (memory > 0 && memory <= 4) {
      return { enabled: true, level: "low", particleCount: VVIP_EFFECTS_PARTICLE_COUNT.low, animate: true };
    }

    if (width > 0 && width < 720) {
      return { enabled: true, level: "narrow", particleCount: VVIP_EFFECTS_PARTICLE_COUNT.narrow, animate: true };
    }

    return { enabled: true, level: "full", particleCount: VVIP_EFFECTS_PARTICLE_COUNT.full, animate: true };
  }

  function readEffectsPreference(storage) {
    if (!storage) {
      return true;
    }

    try {
      return storage.getItem(VVIP_EFFECTS_STORAGE_KEY) !== "off";
    } catch (error) {
      return true;
    }
  }

  function writeEffectsPreference(storage, enabled) {
    if (!storage) {
      return;
    }

    try {
      storage.setItem(VVIP_EFFECTS_STORAGE_KEY, enabled ? "on" : "off");
    } catch (error) {
      // Preference stays for this session only when storage is unavailable.
    }
  }

  /** Falls back to `fallbackId` whenever the requested theme cannot be loaded. */
  function pickThemeWithFallback(requestedId, loadableIds, fallbackId) {
    if (typeof requestedId === "string" && Array.isArray(loadableIds) && loadableIds.includes(requestedId)) {
      return requestedId;
    }

    return fallbackId;
  }

  /* ------------------------------------------------------------------ *
   * Renderer / Selector (DOM)
   * ------------------------------------------------------------------ */

  function createSeededSequence(seed) {
    let cursor = seed >>> 0;

    return function next() {
      cursor = (cursor * 1664525 + 1013904223) >>> 0;
      return cursor / 4294967296;
    };
  }

  function getSafeElementDocument(element) {
    return element && element.ownerDocument ? element.ownerDocument : global.document || null;
  }

  function createController(options = {}) {
    const root = options.root || null;
    const storage = options.storage || null;
    const doc = getSafeElementDocument(root);
    const getReducedMotion = typeof options.getReducedMotion === "function"
      ? options.getReducedMotion
      : () => false;
    const onStageUp = typeof options.onStageUp === "function" ? options.onStageUp : null;
    const onAssetError = typeof options.onAssetError === "function" ? options.onAssetError : null;

    let activeThemeId = null;
    let effectsEnabled = readEffectsPreference(storage);
    let lastPlan = resolveEffectsPlan({ effectsEnabled, reducedMotion: getReducedMotion() });
    let celebrationTimerId = null;

    function getPlan() {
      const viewportWidth = global.innerWidth || 0;
      const deviceMemory = global.navigator ? global.navigator.deviceMemory : 0;

      lastPlan = resolveEffectsPlan({
        effectsEnabled,
        reducedMotion: getReducedMotion(),
        viewportWidth,
        deviceMemory,
      });

      return lastPlan;
    }

    function clearCelebration() {
      if (celebrationTimerId !== null) {
        global.clearTimeout(celebrationTimerId);
        celebrationTimerId = null;
      }

      if (doc && doc.body) {
        delete doc.body.dataset.vvipCelebrate;
      }
    }

    function triggerCelebration() {
      if (!doc || !doc.body || !lastPlan.animate) {
        return;
      }

      clearCelebration();
      doc.body.dataset.vvipCelebrate = "1";
      celebrationTimerId = global.setTimeout(() => {
        celebrationTimerId = null;

        if (doc && doc.body) {
          delete doc.body.dataset.vvipCelebrate;
        }
      }, 2600);
    }

    function removeThemeBackground() {
      if (!doc || !doc.documentElement) {
        return;
      }

      doc.documentElement.style.removeProperty("--vvip-bg-desktop");
      doc.documentElement.style.removeProperty("--vvip-bg-mobile");
    }

    function applyThemeBackground(themeId) {
      const paths = getBackgroundPaths(themeId);

      if (!paths || !doc || !doc.documentElement) {
        removeThemeBackground();
        return;
      }

      doc.documentElement.style.setProperty("--vvip-bg-desktop", `url("${paths.desktop}")`);
      doc.documentElement.style.setProperty("--vvip-bg-mobile", `url("${paths.mobile}")`);
    }

    function buildParticles(themeId, plan) {
      if (!doc || plan.particleCount <= 0) {
        return null;
      }

      const theme = getVvipTheme(themeId);

      if (!theme) {
        return null;
      }

      const layer = doc.createElement("div");
      layer.className = `vvip-particles vvip-particles--${theme.overlayPrefix}`;
      layer.setAttribute("aria-hidden", "true");

      const next = createSeededSequence(themeId.length * 7919 + plan.particleCount);

      for (let index = 0; index < plan.particleCount; index += 1) {
        const particle = doc.createElement("span");
        particle.className = "vvip-particle";
        particle.style.setProperty("--vvip-x", `${Math.round(next() * 96) + 2}%`);
        particle.style.setProperty("--vvip-y", `${Math.round(next() * 78) + 6}%`);
        particle.style.setProperty("--vvip-delay", `${(next() * 6).toFixed(2)}s`);
        particle.style.setProperty("--vvip-duration", `${(7 + next() * 7).toFixed(2)}s`);
        particle.style.setProperty("--vvip-scale", `${(0.7 + next() * 0.7).toFixed(2)}`);
        particle.style.setProperty("--vvip-drift", `${Math.round((next() - 0.5) * 60)}px`);
        layer.appendChild(particle);
      }

      return layer;
    }

    function render() {
      if (!root) {
        return;
      }

      root.innerHTML = "";

      const theme = getVvipTheme(activeThemeId);

      if (!theme) {
        root.dataset.theme = "";
        delete root.dataset.vvipStage;
        removeThemeBackground();
        return;
      }

      const plan = getPlan();
      const progressEntry = getThemeProgress(storage, theme.id);
      const overlayPath = getStageOverlayPath(theme.id, progressEntry.stage);

      root.dataset.theme = theme.id;
      root.dataset.vvipStage = String(progressEntry.stage);

      const decor = doc.createElement("div");
      decor.className = `vvip-decor vvip-decor--${theme.overlayPrefix}`;
      decor.setAttribute("aria-hidden", "true");

      const aura = doc.createElement("span");
      aura.className = "vvip-decor__aura";
      decor.appendChild(aura);

      if (plan.enabled && overlayPath) {
        const stageImage = doc.createElement("img");
        stageImage.className = "vvip-decor__stage";
        stageImage.alt = "";
        stageImage.decoding = "async";
        stageImage.loading = "lazy";
        stageImage.src = overlayPath;
        stageImage.addEventListener("error", () => {
          if (onAssetError) {
            onAssetError(theme.id, overlayPath);
          }
        });
        decor.appendChild(stageImage);
      }

      const particles = buildParticles(theme.id, plan);

      if (particles) {
        decor.appendChild(particles);
      }

      root.appendChild(decor);
      applyThemeBackground(theme.id);
    }

    function applyTheme(themeId) {
      if (!isVvipThemeId(themeId)) {
        activeThemeId = null;
        render();
        return null;
      }

      activeThemeId = themeId;
      render();

      return getThemeProgress(storage, themeId);
    }

    function clearTheme() {
      activeThemeId = null;
      clearCelebration();
      render();
    }

    function setEffects(enabled) {
      effectsEnabled = enabled !== false;
      writeEffectsPreference(storage, effectsEnabled);
      render();
      return effectsEnabled;
    }

    function creditThemeCompletion(payload) {
      const result = recordCompletion(storage, payload);

      if (result.credited && payload && isVvipThemeId(payload.themeId)) {
        if (payload.themeId === activeThemeId) {
          render();
        }

        if (result.stageUp) {
          triggerCelebration();
        }

        if (onStageUp) {
          onStageUp(result);
        }
      }

      return result;
    }

    return {
      applyTheme,
      clearTheme,
      render,
      setEffects,
      recordCompletion: creditThemeCompletion,
      getActiveThemeId: () => activeThemeId,
      getEffectsEnabled: () => effectsEnabled,
      getEffectsPlan: () => lastPlan,
      getThemeProgress: (themeId) => getThemeProgress(storage, themeId),
      isCelebrating: () => Boolean(doc && doc.body && doc.body.dataset.vvipCelebrate),
    };
  }

  const api = {
    themes: VVIP_THEMES,
    stageThresholds: VVIP_STAGE_THRESHOLDS,
    maxStage: VVIP_MAX_STAGE,
    progressStorageKey: VVIP_PROGRESS_STORAGE_KEY,
    effectsStorageKey: VVIP_EFFECTS_STORAGE_KEY,
    getVvipTheme,
    isVvipThemeId,
    getBackgroundPaths,
    getStageOverlayPath,
    computeStage,
    getNextStageThreshold,
    createEmptyProgress,
    normalizeProgress,
    readProgress,
    writeProgress,
    getThemeProgress,
    recordCompletion,
    resolveEffectsPlan,
    readEffectsPreference,
    writeEffectsPreference,
    pickThemeWithFallback,
    createController,
  };

  global.SUDOKU_VVIP = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
