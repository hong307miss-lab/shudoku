const DISCORD_CLIENT_ID = "1541798952150499349";
const DISCORD_READY_TIMEOUT_MS = 5000;
const DISCORD_AUTH_STORAGE_KEY = "discord-sudoku-discord-auth-v1";
const ROOM_LINK_PARAM = "roomId";
const ROOM_CLIENT_ID_KEY = "discord-sudoku-room-client-id-v1";
const ROOM_JOINED_AT_KEY = "discord-sudoku-room-joined-at-v1";
const ROOM_OPERATOR_KEY = "discord-sudoku-room-operator-v1";
const ROOM_CONTEXT_KEY = "discord-sudoku-room-context-v1";
const ROOM_NAV_INTENT_KEY = "discord-sudoku-room-nav-intent-v1";
const VIP_THEME_STORAGE_KEY = "discord-sudoku-vip-theme-v1";
const RANKED_PLAYER_NAME_STORAGE_KEY = "discord-sudoku-ranked-player-name-v1";
const DEFAULT_VIP_THEME = "retro";
const ROOM_CONTEXT_TTL_MS = 45_000;
const ROOM_PROTOCOL_VERSION = 3;
let appBootstrapped = false;
let sharedStateSyncPromise = Promise.resolve();
let isApplyingRemoteState = false;
let sharedRevision = 0;
let roomCellRequestSeq = 0;
let roundEffectSweepId = null;
let freezeCountdownTickId = null;
let sessionStorageFallback = {};
let discordSdk = null;
let roomSocket = null;
let roomSocketReadyPromise = null;
let roomReconnectPending = false;
const puzzleSolutionCache = new Map();

function getRoomJoinCode() {
  const params = new URLSearchParams(window.location.search);
  const roomCode = params.get(ROOM_LINK_PARAM) || params.get("room");
  return /^[a-z0-9_-]{1,64}$/i.test(roomCode || "") ? roomCode : "";
}

function getRoomJoinPassword() {
  const password = new URLSearchParams(window.location.search).get("password");
  return typeof password === "string" ? password.trim().slice(0, 32) : "";
}

function getRoomJoinMode() {
  return getRoomJoinCode() ? "manual" : "";
}

function getRoomMatchMode() {
  return state.gameMode === "versus" ? "versus" : "coop";
}

function revealDiscordActivitySurface() {
  document.body.classList.remove("discord-pending");
  document.body.style.backgroundColor = "#ffffff";
}

function bootstrapOnce() {
  if (appBootstrapped) {
    return;
  }

  appBootstrapped = true;
  bootstrap();
}

function getDiscordSdkConstructor() {
  return window.DiscordSDK || window.Discord?.DiscordSDK || null;
}

function isLikelyDiscordFrame() {
  return Boolean(
    window.location.hostname.includes("discordsays.com")
    || window.location.hostname.includes("discordapp.net")
    || window.location.search.includes("frame_id=")
    || window.location.search.includes("instance_id="),
  );
}

async function initRuntimeEnvironment() {
  const DiscordSDKConstructor = getDiscordSdkConstructor();
  setDiscordAuthState(readStoredDiscordAuth());

  if (!DiscordSDKConstructor) {
    state.runtime.kind = "web";
    clearDiscordRuntimeError();
    revealDiscordActivitySurface();
    startApp();
    return;
  }

  try {
    discordSdk = new DiscordSDKConstructor({ clientId: DISCORD_CLIENT_ID });
    await Promise.race([
      discordSdk.ready(),
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error("Discord SDK ready() timed out")), DISCORD_READY_TIMEOUT_MS);
      }),
    ]);

    state.runtime.kind = "discord";
    clearDiscordRuntimeError();
    state.runtime.guildId = discordSdk.guildId || null;
    state.runtime.channelId = discordSdk.channelId || discordSdk.instanceId || "";
    state.runtime.instanceId = discordSdk.instanceId || null;
    state.runtime.channelType = "";

    if (discordSdk.commands?.getChannel && discordSdk.channelId) {
      try {
        const channel = await discordSdk.commands.getChannel({ channel_id: discordSdk.channelId });
        state.runtime.channelName = channel?.name || "";
        state.runtime.channelType = channel?.type ?? "";
      } catch (error) {
        console.warn("Failed to resolve Discord channel details.", error);
      }
    }
  } catch (error) {
    console.warn("Discord SDK bootstrap failed.", error);
    state.runtime.kind = "web";
    state.runtime.channelId = "";
    state.runtime.channelType = "";
    if (isLikelyDiscordFrame()) {
      setDiscordRuntimeError(error?.message || "Discord SDK failed to initialize.");
    } else {
      clearDiscordRuntimeError();
    }
  }

  revealDiscordActivitySurface();
  startApp();
}

const STORAGE_KEY = "discord-sudoku-prototype-v4";
const SOLO_STORAGE_KEY = "discord-sudoku-solo-v1";
const SOLO_RANKED_STORAGE_KEY = "discord-sudoku-ranked-solo-v1";
const GAME_MODE_STORAGE_KEY = "discord-sudoku-game-mode-v1";
const RUNTIME_CONFIG = window.SUDOKU_RUNTIME_CONFIG || {};
const CONTENT_CONFIG = window.SUDOKU_CONTENT || {};
const PUZZLES = CONTENT_CONFIG.puzzleBank || { easy: [], medium: [], hard: [] };
const PUZZLE_POLICY = CONTENT_CONFIG.puzzlePolicy || {
  standardDailyCount: 3,
  vipReservedDailyCount: 10,
};
const STANDARD_DAILY_PUZZLE_COUNT = Math.max(1, Number(PUZZLE_POLICY.standardDailyCount) || 3);
const RESERVED_VIP_DAILY_PUZZLE_COUNT = Math.max(
  STANDARD_DAILY_PUZZLE_COUNT,
  Number(PUZZLE_POLICY.vipReservedDailyCount) || 10,
);
const VIP_THEME_REGISTRY = Array.isArray(CONTENT_CONFIG.vipThemes)
  ? CONTENT_CONFIG.vipThemes
  : [];
const vipThemeRegistryById = Object.fromEntries(
  VIP_THEME_REGISTRY.map((theme) => [theme.id, theme]),
);

const difficultyLabels = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

const entryModeLabels = {
  value: "Digit",
  note: "Notes",
};

const gameModeLabels = {
  single: "Single Mode",
  ranked: "Ranked Solo",
  coop: "Co-op Mode",
  versus: "Versus Mode",
};

const vipThemeLabels = Object.fromEntries(
  VIP_THEME_REGISTRY.map((theme) => [theme.id, theme.label]),
);

const SIMULTANEOUS_INPUT_WINDOW_MS = 300;
const HEART_TIE_WINDOW_MS = 140;
const EXPLOSION_DURATION_MS = 650;
const HEART_EFFECT_DURATION_MS = 850;
const ROOM_SEAT_STALE_MS = 20000;
const ROOM_SEAT_HEARTBEAT_MS = 5000;
const DISCORD_VOICE_CHANNEL_TYPES = new Set([2, 13, "2", "13"]);

const state = {
  gameMode: readStoredGameMode(),
  difficulty: "easy",
  operator: null,
  entryMode: "value",
  selectedIndex: null,
  activeDigit: null,
  feedback: "No conflicts yet. Finish the board to trigger the win popup.",
  puzzleIndexes: {
    easy: 0,
    medium: 0,
    hard: 0,
  },
  sessions: {},
  explosionTimeouts: {},
  explodingCells: {},
  heartTimeouts: {},
  heartCelebrations: {},
  syncStatus: "Choose Room",
  roomProtocolVersion: 0,
  roomId: "",
  roomCode: getRoomJoinCode(),
  roomName: "",
  roomPassword: getRoomJoinPassword(),
  roomJoinMode: getRoomJoinMode(),
  roomInviteUrl: "",
  roomType: "",
  roomSource: "",
  roomHubView: "entry",
  roomCreateLinkReady: false,
  lastRoomError: "",
  roomRoster: [],
  roomSeats: {
    A: null,
    B: null,
  },
  runtime: {
    kind: "pending",
    channelId: "",
    channelName: "",
    channelType: "",
    guildId: null,
    instanceId: null,
    auth: getDefaultDiscordAuthState(),
    lastError: "",
  },
  vipTheme: DEFAULT_VIP_THEME,
  gameStart: {
    readyBy: {
      A: null,
      B: null,
    },
    startedSessionKey: null,
  },
  activeRound: {
    id: "",
    sessionKey: "",
    status: "",
    revision: 0,
    protocolVersion: 0,
    effects: [],
    playerStates: {
      A: { freezeUntil: 0, freezeRemainingMs: 0 },
      B: { freezeUntil: 0, freezeRemainingMs: 0 },
    },
  },
  ranked: {
    playerName: readStoredRankedPlayerName(),
    leaderboard: [],
    playerEntry: null,
    playerRank: null,
    totalEntries: 0,
    status: "Choose Ranked Solo to load this puzzle leaderboard.",
    isLoading: false,
    boardKey: "",
    liveElapsedSeconds: null,
  },
};
const isVipRoomPage = document.body.dataset.pageLabel === "VIP Room";
let persistedStorageFallback = {};
let gameModeStorageFallback = null;
let vipThemeStorageFallback = null;
let rankedPlayerNameStorageFallback = "";
let roomHeartbeatId = null;

function getDefaultDiscordAuthState() {
  return {
    status: "idle",
    sessionToken: "",
    expiresAt: 0,
    userId: "",
    displayName: "",
    username: "",
    avatarUrl: "",
    error: "",
  };
}

function sanitizeRoomNameInput(value) {
  return String(value || "").trim().toLowerCase().slice(0, 24);
}

function isValidManualRoomName(value) {
  return /^[a-z0-9][a-z0-9_-]{0,23}$/i.test(String(value || "").trim());
}

function isDiscordVoiceChannelContext() {
  if (state.runtime.kind !== "discord" || !state.runtime.channelId) {
    return false;
  }

  const channelType = state.runtime.channelType;

  if (DISCORD_VOICE_CHANNEL_TYPES.has(channelType)) {
    return true;
  }

  if (channelType === "" || channelType == null) {
    return true;
  }

  const normalizedType = String(channelType).toLowerCase();
  return normalizedType.includes("voice") || normalizedType.includes("stage");
}

function parseInviteLink(value) {
  const rawValue = String(value || "").trim();

  if (!rawValue) {
    throw new Error("Invite link is required.");
  }

  let inviteUrl;

  try {
    inviteUrl = new URL(rawValue, window.location.href);
  } catch (error) {
    throw new Error("Invite link is invalid.");
  }

  const roomCode = inviteUrl.searchParams.get(ROOM_LINK_PARAM) || inviteUrl.searchParams.get("room") || "";
  const password = inviteUrl.searchParams.get("password") || "";

  if (!/^[a-z0-9_-]{1,64}$/i.test(roomCode)) {
    throw new Error("Invite link is missing a valid room name.");
  }

  return {
    roomCode,
    password: String(password).trim().slice(0, 32),
  };
}

function readSessionValue(key) {
  try {
    return window.sessionStorage.getItem(key);
  } catch (error) {
    return sessionStorageFallback[key] ?? null;
  }
}

function writeSessionValue(key, value) {
  sessionStorageFallback[key] = value;

  try {
    window.sessionStorage.setItem(key, value);
  } catch (error) {
    // Keep the in-memory fallback so the current tab can still function.
  }
}

function removeSessionValue(key) {
  delete sessionStorageFallback[key];

  try {
    window.sessionStorage.removeItem(key);
  } catch (error) {
    // Ignore storage removal errors and rely on in-memory fallback.
  }
}

function readStoredDiscordAuth() {
  const rawValue = readSessionValue(DISCORD_AUTH_STORAGE_KEY);

  if (!rawValue) {
    return getDefaultDiscordAuthState();
  }

  try {
    const parsed = JSON.parse(rawValue);
    const expiresAt = Number(parsed?.expiresAt);

    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      removeSessionValue(DISCORD_AUTH_STORAGE_KEY);
      return getDefaultDiscordAuthState();
    }

    const userId = String(parsed?.userId || "").trim();

    if (!/^\d{5,32}$/.test(userId)) {
      removeSessionValue(DISCORD_AUTH_STORAGE_KEY);
      return getDefaultDiscordAuthState();
    }

    return {
      status: "authenticated",
      sessionToken: typeof parsed?.sessionToken === "string" ? parsed.sessionToken : "",
      expiresAt,
      userId,
      displayName: typeof parsed?.displayName === "string" ? parsed.displayName : "",
      username: typeof parsed?.username === "string" ? parsed.username : "",
      avatarUrl: typeof parsed?.avatarUrl === "string" ? parsed.avatarUrl : "",
      error: "",
    };
  } catch (error) {
    removeSessionValue(DISCORD_AUTH_STORAGE_KEY);
    return getDefaultDiscordAuthState();
  }
}

function persistDiscordAuthState() {
  const auth = state.runtime.auth || getDefaultDiscordAuthState();

  if (auth.status !== "authenticated" || !auth.sessionToken || !auth.userId || auth.expiresAt <= Date.now()) {
    removeSessionValue(DISCORD_AUTH_STORAGE_KEY);
    return;
  }

  writeSessionValue(DISCORD_AUTH_STORAGE_KEY, JSON.stringify({
    sessionToken: auth.sessionToken,
    expiresAt: auth.expiresAt,
    userId: auth.userId,
    displayName: auth.displayName || "",
    username: auth.username || "",
    avatarUrl: auth.avatarUrl || "",
  }));
}

function setDiscordAuthState(nextAuthState) {
  state.runtime.auth = {
    ...getDefaultDiscordAuthState(),
    ...(nextAuthState || {}),
  };
  persistDiscordAuthState();
}

function setDiscordRuntimeError(message) {
  state.runtime.lastError = String(message || "").trim();
}

function clearDiscordRuntimeError() {
  state.runtime.lastError = "";
}

function getDiscordActivityKey() {
  return state.runtime.instanceId || state.runtime.channelId || "";
}

function getCurrentRoomIdentityKey() {
  if (state.runtime.kind === "discord" && state.runtime.auth?.status === "authenticated" && state.runtime.auth.userId) {
    return `discord:${state.runtime.auth.userId}`;
  }

  return `web:${roomClientId}`;
}

function getCurrentPlayerDisplayName() {
  if (state.runtime.kind === "discord" && state.runtime.auth?.status === "authenticated") {
    return state.runtime.auth.displayName || state.runtime.auth.username || "";
  }

  return "";
}

async function requestDiscordActivityAuthCode() {
  if (!discordSdk?.commands?.authorize) {
    throw new Error("Discord authorize() is unavailable in this client.");
  }

  const authorizeResult = await discordSdk.commands.authorize({
    client_id: DISCORD_CLIENT_ID,
    response_type: "code",
    state: roomClientId,
    prompt: "none",
    scope: ["identify"],
  });

  const code = typeof authorizeResult?.code === "string" ? authorizeResult.code : "";

  if (!code) {
    throw new Error("Discord authorize() did not return an authorization code.");
  }

  return code;
}

async function ensureDiscordAuthenticated() {
  if (state.runtime.kind !== "discord") {
    return getDefaultDiscordAuthState();
  }

  const cachedAuth = state.runtime.auth || getDefaultDiscordAuthState();

  if (
    cachedAuth.status === "authenticated"
    && cachedAuth.sessionToken
    && cachedAuth.userId
    && cachedAuth.expiresAt > Date.now() + 5_000
  ) {
    return cachedAuth;
  }

  if (!discordSdk?.commands?.authenticate) {
    throw new Error("Discord authenticate() is unavailable in this client.");
  }

  setDiscordAuthState({
    ...cachedAuth,
    status: "authorizing",
    error: "",
  });
  clearDiscordRuntimeError();

  try {
    const code = await requestDiscordActivityAuthCode();
    const response = await window.fetch("./api/discord/auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code }),
    });
    const payload = await response.json();

    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error || "Discord authorization failed.");
    }

    const accessToken = typeof payload?.accessToken === "string" ? payload.accessToken : "";
    const authenticated = await discordSdk.commands.authenticate({
      access_token: accessToken,
    });
    const authenticatedUserId = String(authenticated?.user?.id || "").trim();
    const resolvedUserId = String(payload?.user?.id || "").trim();

    if (authenticatedUserId && resolvedUserId && authenticatedUserId !== resolvedUserId) {
      throw new Error("Discord user verification failed. Please reopen the Activity and try again.");
    }

    const nextAuthState = {
      status: "authenticated",
      sessionToken: typeof payload?.sessionToken === "string" ? payload.sessionToken : "",
      expiresAt: Number(payload?.sessionExpiresAt) || 0,
      userId: resolvedUserId || authenticatedUserId,
      displayName: String(payload?.user?.displayName || authenticated?.user?.global_name || authenticated?.user?.username || ""),
      username: String(payload?.user?.username || authenticated?.user?.username || ""),
      avatarUrl: String(payload?.user?.avatarUrl || ""),
      error: "",
    };

    if (!nextAuthState.sessionToken || !nextAuthState.userId || nextAuthState.expiresAt <= Date.now()) {
      throw new Error("Discord authorization finished without a reusable room session.");
    }

    setDiscordAuthState(nextAuthState);
    return state.runtime.auth;
  } catch (error) {
    const message = error?.message || "Discord authorization failed.";
    setDiscordAuthState({
      ...getDefaultDiscordAuthState(),
      status: "error",
      error: message,
    });
    setDiscordRuntimeError(message);
    throw new Error(message);
  }
}

function readStoredRoomContext() {
  const rawValue = readSessionValue(ROOM_CONTEXT_KEY);

  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue);
    const roomCode = /^[a-z0-9_-]{1,64}$/i.test(parsed?.roomCode || "") ? parsed.roomCode : "";
    const roomPassword = typeof parsed?.roomPassword === "string" ? parsed.roomPassword.trim().slice(0, 32) : "";
    const pageLabel = typeof parsed?.pageLabel === "string" ? parsed.pageLabel : "";
    const roomJoinMode = typeof parsed?.roomJoinMode === "string" ? parsed.roomJoinMode : "";
    const updatedAt = Number(parsed?.updatedAt);

    if (!roomCode) {
      return null;
    }

    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > ROOM_CONTEXT_TTL_MS) {
      removeSessionValue(ROOM_CONTEXT_KEY);
      return null;
    }

    return {
      roomCode,
      roomPassword,
      pageLabel,
      roomJoinMode,
      updatedAt,
    };
  } catch (error) {
    return null;
  }
}

function persistCurrentRoomContext() {
  const roomCode = state.roomCode || state.roomId;

  if (isRoomMultiplayerMode() && roomCode) {
    writeSessionValue(ROOM_CONTEXT_KEY, JSON.stringify({
      roomCode,
      roomPassword: state.roomPassword || "",
      roomJoinMode: state.roomJoinMode || "",
      pageLabel: document.body?.dataset.pageLabel || "",
      updatedAt: Date.now(),
    }));
    return;
  }

  removeSessionValue(ROOM_CONTEXT_KEY);
}

function getCrossPageRoomContextOnLaunch() {
  const pendingNavigation = readPendingRoomNavigation();

  if (pendingNavigation) {
    removeSessionValue(ROOM_NAV_INTENT_KEY);
    return pendingNavigation;
  }

  const storedContext = readStoredRoomContext();

  if (!storedContext) {
    return null;
  }

  return storedContext;
}

function readPendingRoomNavigation() {
  const rawValue = readSessionValue(ROOM_NAV_INTENT_KEY);

  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue);
    const roomCode = /^[a-z0-9_-]{1,64}$/i.test(parsed?.roomCode || "") ? parsed.roomCode : "";
    const roomPassword = typeof parsed?.roomPassword === "string" ? parsed.roomPassword.trim().slice(0, 32) : "";
    const roomJoinMode = typeof parsed?.roomJoinMode === "string" ? parsed.roomJoinMode : "";
    const pathname = typeof parsed?.pathname === "string" ? parsed.pathname : "";
    const search = typeof parsed?.search === "string" ? parsed.search : "";
    const createdAt = Number(parsed?.createdAt);
    const currentPath = `${window.location.pathname}${window.location.search}`;

    if (!roomCode || !pathname || `${pathname}${search}` !== currentPath) {
      return null;
    }

    if (!Number.isFinite(createdAt) || Date.now() - createdAt > 15000) {
      return null;
    }

    return {
      roomCode,
      roomPassword,
      roomJoinMode,
    };
  } catch (error) {
    return null;
  }
}

function persistPendingRoomNavigation(targetHref) {
  const roomCode = state.roomCode || state.roomId;

  if (!isRoomMultiplayerMode() || !roomCode) {
    removeSessionValue(ROOM_NAV_INTENT_KEY);
    return;
  }

  const targetUrl = new URL(targetHref, window.location.href);
  const payload = {
    roomCode,
    roomPassword: state.roomPassword || "",
    roomJoinMode: state.roomJoinMode || "",
    pathname: targetUrl.pathname,
    search: targetUrl.search,
    createdAt: Date.now(),
  };
  writeSessionValue(ROOM_NAV_INTENT_KEY, JSON.stringify(payload));
}

function readInitialStoredOperator() {
  try {
    const stored = window.sessionStorage.getItem(ROOM_OPERATOR_KEY);
    return stored === "A" || stored === "B" ? stored : null;
  } catch (error) {
    const fallback = sessionStorageFallback[ROOM_OPERATOR_KEY];
    return fallback === "A" || fallback === "B" ? fallback : null;
  }
}

function guardVipEntry() {
  if (document.body?.dataset.pageLabel !== "VIP Room") {
    return false;
  }

  const currentUrl = new URL(window.location.href);

  if (currentUrl.searchParams.get("view") === "vip") {
    return false;
  }

  const targetFile = readInitialStoredOperator() === "B" ? "lobby-b.html" : "index.html";
  const targetUrl = new URL(`./${targetFile}`, window.location.href);
  targetUrl.search = currentUrl.search;
  targetUrl.searchParams.delete("view");
  targetUrl.hash = currentUrl.hash;
  window.location.replace(targetUrl.toString());
  return true;
}

function getDefaultLobbyFile() {
  if (state.operator === "B" || document.body?.dataset.playerPage === "B") {
    return "lobby-b.html";
  }

  return "index.html";
}

function routeRoomEntryToLobby() {
  const pageLabel = document.body?.dataset.pageLabel;

  if (pageLabel === "Lobby" || pageLabel === "VIP Room") {
    return false;
  }

  const targetUrl = new URL(`./${getDefaultLobbyFile()}`, window.location.href);
  targetUrl.hash = window.location.hash;
  persistPendingRoomNavigation(targetUrl.toString());
  window.location.replace(targetUrl.toString());
  return true;
}

function generateClientId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getRoomClientId() {
  const existing = readSessionValue(ROOM_CLIENT_ID_KEY);

  if (existing) {
    return existing;
  }

  const created = generateClientId();
  writeSessionValue(ROOM_CLIENT_ID_KEY, created);
  return created;
}

function getRoomJoinedAt() {
  const existing = Number(readSessionValue(ROOM_JOINED_AT_KEY));

  if (Number.isFinite(existing) && existing > 0) {
    return existing;
  }

  const created = Date.now();
  writeSessionValue(ROOM_JOINED_AT_KEY, String(created));
  return created;
}

function readStoredOperator() {
  const stored = readSessionValue(ROOM_OPERATOR_KEY);
  return stored === "A" || stored === "B" ? stored : null;
}

function writeStoredOperator(operator) {
  if (operator === "A" || operator === "B") {
    writeSessionValue(ROOM_OPERATOR_KEY, operator);
    return;
  }

  try {
    window.sessionStorage.removeItem(ROOM_OPERATOR_KEY);
  } catch (error) {
    delete sessionStorageFallback[ROOM_OPERATOR_KEY];
  }
}

const roomClientId = getRoomClientId();
const roomJoinedAt = getRoomJoinedAt();

function readStoredGameMode() {
  try {
    const stored = localStorage.getItem(GAME_MODE_STORAGE_KEY);
    return stored === "single" || stored === "ranked" || stored === "coop" || stored === "versus" ? stored : null;
  } catch (error) {
    return gameModeStorageFallback;
  }
}

function writeStoredGameMode(mode) {
  gameModeStorageFallback = mode;

  try {
    localStorage.setItem(GAME_MODE_STORAGE_KEY, mode);
  } catch (error) {
    // Keep the in-memory fallback so the current session still works.
  }
}

function clearStoredGameMode() {
  gameModeStorageFallback = null;

  try {
    localStorage.removeItem(GAME_MODE_STORAGE_KEY);
  } catch (error) {
    // Keep the in-memory fallback cleared for this session.
  }
}

function sanitizeRankedPlayerName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 20);
}

function readStoredRankedPlayerName() {
  try {
    return sanitizeRankedPlayerName(localStorage.getItem(RANKED_PLAYER_NAME_STORAGE_KEY) || "");
  } catch (error) {
    return rankedPlayerNameStorageFallback;
  }
}

function writeStoredRankedPlayerName(name) {
  const normalizedName = sanitizeRankedPlayerName(name);
  rankedPlayerNameStorageFallback = normalizedName;

  try {
    if (normalizedName) {
      localStorage.setItem(RANKED_PLAYER_NAME_STORAGE_KEY, normalizedName);
    } else {
      localStorage.removeItem(RANKED_PLAYER_NAME_STORAGE_KEY);
    }
  } catch (error) {
    // Keep the in-memory fallback for this session.
  }
}

function isSinglePlayerMode() {
  return state.gameMode === "single" || state.gameMode === "ranked";
}

function isRankedSoloMode() {
  return state.gameMode === "ranked";
}

function isCoopMode() {
  return state.gameMode === "coop";
}

function isVersusMode() {
  return state.gameMode === "versus";
}

function isRoomMultiplayerMode() {
  return isCoopMode() || isVersusMode();
}

function isFilledClaimCell(cell) {
  return Boolean(cell && !cell.given && cell.value && (cell.owner === "A" || cell.owner === "B"));
}

function getActiveStateStorageKey() {
  if (isRankedSoloMode()) {
    return SOLO_RANKED_STORAGE_KEY;
  }

  return isSinglePlayerMode()
    ? SOLO_STORAGE_KEY
    : `${STORAGE_KEY}:${state.roomId || state.roomCode || "pending"}`;
}

function readPersistedState() {
  const storageKey = getActiveStateStorageKey();

  try {
    return localStorage.getItem(storageKey);
  } catch (error) {
    console.warn("Sudoku storage read failed. Falling back to in-memory state.", error);
    return persistedStorageFallback[storageKey] ?? null;
  }
}

function readPersistedStateByKey(storageKey) {
  if (!storageKey) {
    return null;
  }

  try {
    return localStorage.getItem(storageKey);
  } catch (error) {
    console.warn("Sudoku storage read failed. Falling back to in-memory state.", error);
    return persistedStorageFallback[storageKey] ?? null;
  }
}

function readPreferredVipTheme() {
  try {
    return localStorage.getItem(VIP_THEME_STORAGE_KEY);
  } catch (error) {
    return vipThemeStorageFallback;
  }
}

function writePreferredVipTheme(theme) {
  vipThemeStorageFallback = theme;

  try {
    localStorage.setItem(VIP_THEME_STORAGE_KEY, theme);
  } catch (error) {
    // Keep the fallback value for the current browser session.
  }
}

function writePersistedState(value) {
  const storageKey = getActiveStateStorageKey();
  persistedStorageFallback[storageKey] = value;

  try {
    localStorage.setItem(storageKey, value);
    return true;
  } catch (error) {
    console.warn("Sudoku storage write failed. Using in-memory state only.", error);
    return false;
  }
}

const boardElement = document.querySelector("#sudoku-board");
const controlsPanel = document.querySelector("#controls-panel");
const controlDrawerToggle = document.querySelector("#control-drawer-toggle");
const controlDrawerBackdrop = document.querySelector("#control-drawer-backdrop");
const topbarEyebrow = document.querySelector(".eyebrow");
const topbarTitle = document.querySelector(".topbar h1");
const topbarSubtitle = document.querySelector(".subtitle");
const pageSwitcher = document.querySelector(".page-switcher");
const difficultyControls = document.querySelector("#difficulty-controls");
const operatorGroup = document.querySelector("#operator-group");
const operatorControls = document.querySelector("#operator-controls");
const entryModeControls = document.querySelector("#entry-mode-controls");
const themeControls = document.querySelector("#theme-controls");
const vipSkinRoot = document.querySelector("#vip-skin-root");
const keypad = document.querySelector("#keypad");
const boardLegend = document.querySelector(".legend");
const newPuzzleButton = document.querySelector("#new-puzzle-button");
const startGameButton = document.querySelector("#start-game-button");
const statusDifficulty = document.querySelector("#status-difficulty");
const statusOperator = document.querySelector("#status-operator");
const statusEntryMode = document.querySelector("#status-entry-mode");
const statusGame = document.querySelector("#status-game");
const statusTimer = document.querySelector("#status-timer");
const statusSync = document.querySelector("#status-sync");
const roomPlayerStatus = document.querySelector("#room-player-status");
const helperText = document.querySelector("#helper-text");
const feedbackElement = document.querySelector("#game-feedback");
const modeSelectModal = document.querySelector("#mode-select-modal");
const modeOptionButtons = document.querySelectorAll("[data-game-mode]");
const roomHubModal = document.querySelector("#room-hub-modal");
const roomHubTitle = document.querySelector("#room-hub-title");
const roomHubCopy = document.querySelector("#room-hub-copy");
const roomHubStatus = document.querySelector("#room-hub-status");
const roomEnvironmentBadge = document.querySelector("#room-environment-badge");
const roomHubMeta = document.querySelector(".room-hub-meta");
const roomHubNav = document.querySelector("#room-hub-nav");
const roomHubBackButton = document.querySelector("#room-hub-back-button");
const roomHubEntryPane = document.querySelector("#room-hub-entry-pane");
const roomHubJoinPane = document.querySelector("#room-hub-join-pane");
const roomHubCreatePane = document.querySelector("#room-hub-create-pane");
const roomHubJoinEntryCopy = document.querySelector("#room-hub-join-entry-copy");
const roomHubAutoJoinCopy = document.querySelector("#room-hub-auto-join-copy");
const roomControlGroup = document.querySelector(".room-control-group");
const roomSummaryTitle = document.querySelector("#room-summary-title");
const roomSummaryCopy = document.querySelector("#room-summary-copy");
const openRoomHubButton = document.querySelector("#open-room-hub-button");
const copyRoomLinkButton = document.querySelector("#copy-room-link-button");
const roomInviteBlock = document.querySelector(".room-invite-block");
const roomInviteField = document.querySelector("#room-invite-field");
const copyRoomLinkInlineButton = document.querySelector("#copy-room-link-inline-button");
const enterCreatedRoomButton = document.querySelector("#enter-created-room-button");
const roomHubEnterJoinButton = document.querySelector("#room-hub-enter-join-button");
const roomHubEnterCreateButton = document.querySelector("#room-hub-enter-create-button");
const roomJoinAutoButton = document.querySelector("#room-join-auto-button");
const roomJoinCodeInput = document.querySelector("#room-join-code-input");
const roomJoinPasswordInput = document.querySelector("#room-join-password-input");
const roomJoinLinkInput = document.querySelector("#room-join-link-input");
const roomJoinByCodeButton = document.querySelector("#room-join-by-code-button");
const roomJoinByLinkButton = document.querySelector("#room-join-by-link-button");
const roomCreateNameInput = document.querySelector("#room-create-name-input");
const roomCreatePasswordInput = document.querySelector("#room-create-password-input");
const roomCreateButton = document.querySelector("#room-create-button");
const roomCreateLinkButton = document.querySelector("#room-create-link-button");
const exitToModeSelectButton = document.querySelector("#exit-to-mode-select-button");
const rankedPanel = document.querySelector("#ranked-panel");
const rankedPlayerNameDisplay = document.querySelector("#ranked-player-name-display");
const rankedPlayerNameCopy = document.querySelector("#ranked-player-name-copy");
const rankedCurrentTime = document.querySelector("#ranked-current-time");
const rankedCurrentRank = document.querySelector("#ranked-current-rank");
const rankedLeaderboardSubtitle = document.querySelector("#ranked-leaderboard-subtitle");
const rankedLeaderboardStatus = document.querySelector("#ranked-leaderboard-status");
const rankedLeaderboardList = document.querySelector("#ranked-leaderboard-list");
const rankedChangeNameButton = document.querySelector("#ranked-change-name-button");
const rankedProfileModal = document.querySelector("#ranked-profile-modal");
const rankedPlayerNameInput = document.querySelector("#ranked-player-name-input");
const rankedProfileCancelButton = document.querySelector("#ranked-profile-cancel-button");
const rankedProfileSaveButton = document.querySelector("#ranked-profile-save-button");
const winModal = document.querySelector("#win-modal");
const winTitle = document.querySelector("#win-title");
const winCopy = document.querySelector("#win-copy");
const winTime = document.querySelector("#win-time");
const closeWinModalButton = document.querySelector("#close-win-modal");
const pageLinkButtons = document.querySelectorAll(".page-link-button");
const defaultTopbarEyebrowText = topbarEyebrow?.textContent || "";
const defaultTopbarTitleText = topbarTitle?.textContent || "";
const defaultTopbarSubtitleText = topbarSubtitle?.textContent || "";
let timerIntervalId = null;
let vipSkinLinkElement = null;
let vipSkinLoadToken = 0;

function setControlsDrawerOpen(isOpen) {
  document.body.dataset.controlsOpen = isOpen ? "true" : "false";
  controlDrawerToggle?.setAttribute("aria-expanded", isOpen ? "true" : "false");
  controlDrawerToggle?.setAttribute("aria-label", isOpen ? "Close controls" : "Open controls");

  if (controlDrawerBackdrop) {
    controlDrawerBackdrop.hidden = !isOpen;
  }
}

function openModeSelectModal() {
  if (!modeSelectModal) {
    return;
  }

  modeSelectModal.classList.remove("hidden");
  modeSelectModal.setAttribute("aria-hidden", "false");
}

function closeModeSelectModal() {
  if (!modeSelectModal) {
    return;
  }

  modeSelectModal.classList.add("hidden");
  modeSelectModal.setAttribute("aria-hidden", "true");
}

function openRoomHubModal() {
  if (!roomHubModal) {
    return;
  }

  roomHubModal.classList.remove("hidden");
  roomHubModal.setAttribute("aria-hidden", "false");
}

function closeRoomHubModal() {
  if (!roomHubModal) {
    return;
  }

  roomHubModal.classList.add("hidden");
  roomHubModal.setAttribute("aria-hidden", "true");
}

function getRankedBoardKey(selection = getCurrentSelection()) {
  return `${selection.difficulty}:${selection.puzzleId}`;
}

function getRankedLeaderboardSubtitleText(selection = getCurrentSelection()) {
  return `${difficultyLabels[selection.difficulty]} Puzzle ${selection.puzzleIndex + 1}`;
}

function hasRankedPlayerName() {
  return Boolean(sanitizeRankedPlayerName(state.ranked.playerName));
}

function getRankedLiveElapsedSeconds(session = getCurrentSession()) {
  if (
    !isRankedSoloMode()
    || !hasRankedPlayerName()
    || !session
    || session.hasWon
    || !isCurrentRoundStarted(session)
  ) {
    return null;
  }

  return getElapsedSeconds(session);
}

function isSameRankedEntry(left, right) {
  if (!left || !right) {
    return false;
  }

  if (left.entryId && right.entryId) {
    return left.entryId === right.entryId;
  }

  return (
    String(left.playerName || "").toLowerCase() === String(right.playerName || "").toLowerCase()
    && Number(left.rank) === Number(right.rank)
    && Number(left.elapsedSeconds) === Number(right.elapsedSeconds)
  );
}

function openRankedProfileModal() {
  if (!rankedProfileModal) {
    return;
  }

  rankedPlayerNameInput.value = state.ranked.playerName || "";
  rankedProfileModal.classList.remove("hidden");
  rankedProfileModal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => {
    rankedPlayerNameInput?.focus();
    rankedPlayerNameInput?.select();
  }, 0);
}

function closeRankedProfileModal() {
  if (!rankedProfileModal) {
    return;
  }

  rankedProfileModal.classList.add("hidden");
  rankedProfileModal.setAttribute("aria-hidden", "true");
}

function renderRankedPanel() {
  if (!rankedPanel) {
    return;
  }

  const rankedMode = isRankedSoloMode();
  rankedPanel.classList.toggle("hidden", !rankedMode);

  if (!rankedMode) {
    return;
  }

  const selection = getCurrentSelection();
  const currentSession = getCurrentSession();
  const liveElapsedSeconds = getRankedLiveElapsedSeconds(currentSession);
  const currentPlayerEntry = state.ranked.playerEntry;
  const currentElapsedSeconds = Number.isFinite(liveElapsedSeconds) && liveElapsedSeconds > 0
    ? liveElapsedSeconds
    : currentPlayerEntry?.elapsedSeconds || (hasSessionProgress(currentSession) ? getElapsedSeconds(currentSession) : null);

  rankedPlayerNameDisplay.textContent = state.ranked.playerName || "No Name Yet";
  rankedPlayerNameCopy.textContent = !state.ranked.playerName
    ? "Enter your name to see this puzzle's fastest 10 clears and your live rank."
    : state.ranked.playerRank
      ? liveElapsedSeconds !== null
        ? `Current run projects to #${state.ranked.playerRank} on this exact puzzle.`
        : `Your best visible rank on this puzzle is #${state.ranked.playerRank}.`
      : "This panel shows the fastest 10 clears for this exact puzzle.";
  if (rankedCurrentTime) {
    rankedCurrentTime.textContent = Number.isFinite(currentElapsedSeconds) && currentElapsedSeconds > 0
      ? formatElapsedTime(currentElapsedSeconds)
      : "--:--";
  }
  if (rankedCurrentRank) {
    rankedCurrentRank.textContent = state.ranked.playerRank
      ? `#${state.ranked.playerRank}/${Math.max(state.ranked.totalEntries, state.ranked.playerRank)}`
      : "--";
  }
  rankedLeaderboardSubtitle.textContent = getRankedLeaderboardSubtitleText(selection);
  rankedLeaderboardStatus.textContent = state.ranked.status;
  rankedLeaderboardStatus.hidden = state.ranked.leaderboard.length > 0;
  rankedLeaderboardList.replaceChildren();

  const currentPlayerShown = state.ranked.leaderboard.some((entry) => isSameRankedEntry(entry, currentPlayerEntry));

  state.ranked.leaderboard.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "ranked-leaderboard-item";

    if (isSameRankedEntry(entry, currentPlayerEntry)) {
      item.classList.add("current-player");
    }

    const name = document.createElement("span");
    name.className = "ranked-leaderboard-item-name";
    name.textContent = `#${entry.rank} ${entry.playerName}`;

    const time = document.createElement("span");
    time.className = "ranked-leaderboard-item-time";
    time.textContent = formatElapsedTime(entry.elapsedSeconds);

    item.append(name, time);
    rankedLeaderboardList.append(item);
  });

  if (currentPlayerEntry && !currentPlayerShown) {
    const ellipsisItem = document.createElement("li");
    ellipsisItem.className = "ranked-leaderboard-gap";
    ellipsisItem.textContent = "...";
    rankedLeaderboardList.append(ellipsisItem);

    const playerItem = document.createElement("li");
    playerItem.className = "ranked-leaderboard-item current-player";

    const playerName = document.createElement("span");
    playerName.className = "ranked-leaderboard-item-name";
    playerName.textContent = `#${currentPlayerEntry.rank} ${currentPlayerEntry.playerName}`;

    const playerTime = document.createElement("span");
    playerTime.className = "ranked-leaderboard-item-time";
    playerTime.textContent = formatElapsedTime(currentPlayerEntry.elapsedSeconds);

    playerItem.append(playerName, playerTime);
    rankedLeaderboardList.append(playerItem);
  }
}

async function refreshRankedLeaderboard(options = {}) {
  if (!isRankedSoloMode()) {
    state.ranked.leaderboard = [];
    state.ranked.playerEntry = null;
    state.ranked.playerRank = null;
    state.ranked.totalEntries = 0;
    state.ranked.status = "Choose Ranked Solo to load this puzzle leaderboard.";
    state.ranked.isLoading = false;
    state.ranked.boardKey = "";
    state.ranked.liveElapsedSeconds = null;
    renderRankedPanel();
    return;
  }

  const selection = options.selection || getCurrentSelection();
  const boardKey = getRankedBoardKey(selection);
  const liveElapsedSeconds = Number.isFinite(options.liveElapsedSeconds)
    ? Math.floor(options.liveElapsedSeconds)
    : getRankedLiveElapsedSeconds();

  if (
    !options.force
    && state.ranked.boardKey === boardKey
    && state.ranked.liveElapsedSeconds === liveElapsedSeconds
    && !state.ranked.isLoading
  ) {
    renderRankedPanel();
    return;
  }

  state.ranked.boardKey = boardKey;
  state.ranked.liveElapsedSeconds = liveElapsedSeconds;
  state.ranked.isLoading = true;
  state.ranked.status = "Loading top 10 times...";
  renderRankedPanel();

  try {
    const url = new URL("/api/ranked-leaderboard", getRoomServerUrl());
    url.searchParams.set("difficulty", selection.difficulty);
    url.searchParams.set("puzzleId", selection.puzzleId);
    if (state.ranked.playerName) {
      url.searchParams.set("playerName", state.ranked.playerName);
    }
    if (Number.isFinite(liveElapsedSeconds) && liveElapsedSeconds > 0) {
      url.searchParams.set("elapsedSeconds", String(liveElapsedSeconds));
    }

    const response = await window.fetch(url.toString(), { cache: "no-store" });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Failed to load leaderboard.");
    }

    state.ranked.leaderboard = Array.isArray(payload.leaderboard) ? payload.leaderboard : [];
    state.ranked.playerEntry = payload.playerEntry || null;
    state.ranked.playerRank = Number.isInteger(payload.playerRank) && payload.playerRank > 0
      ? payload.playerRank
      : null;
    state.ranked.totalEntries = Number.isInteger(payload.totalEntries) && payload.totalEntries >= 0
      ? payload.totalEntries
      : state.ranked.leaderboard.length;
    state.ranked.status = state.ranked.leaderboard.length > 0
      ? ""
      : "No clear times yet for this puzzle.";
  } catch (error) {
    state.ranked.leaderboard = [];
    state.ranked.playerEntry = null;
    state.ranked.playerRank = null;
    state.ranked.totalEntries = 0;
    state.ranked.status = error.message || "Failed to load leaderboard.";
  } finally {
    state.ranked.isLoading = false;
    renderRankedPanel();
  }
}

async function submitRankedLeaderboardResult(session = getCurrentSession()) {
  if (
    !isRankedSoloMode()
    || !session?.hasWon
    || !hasRankedPlayerName()
    || session.rankedEntryId
  ) {
    return;
  }

  const url = new URL("/api/ranked-leaderboard", getRoomServerUrl());
  const selection = {
    difficulty: session.difficulty,
    puzzleId: session.puzzleId,
    puzzleIndex: state.puzzleIndexes[session.difficulty] ?? 0,
  };

  session.rankedSubmissionError = "";
  renderRankedPanel();

  try {
    const response = await window.fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        playerName: state.ranked.playerName,
        difficulty: session.difficulty,
        puzzleId: session.puzzleId,
        elapsedSeconds: getElapsedSeconds(session),
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Failed to submit ranked time.");
    }

    session.rankedEntryId = payload.entry?.entryId || "";
    session.rankedRank = Number.isInteger(payload.rank) && payload.rank > 0 ? payload.rank : null;
    state.ranked.leaderboard = Array.isArray(payload.leaderboard) ? payload.leaderboard : [];
    state.ranked.playerEntry = payload.playerEntry || payload.entry || null;
    state.ranked.playerRank = Number.isInteger(payload.playerRank) && payload.playerRank > 0
      ? payload.playerRank
      : session.rankedRank;
    state.ranked.totalEntries = Number.isInteger(payload.totalEntries) && payload.totalEntries >= 0
      ? payload.totalEntries
      : state.ranked.leaderboard.length;
    state.ranked.status = state.ranked.leaderboard.length > 0 ? "" : "No clear times yet for this puzzle.";
    state.ranked.boardKey = getRankedBoardKey(selection);
    state.ranked.liveElapsedSeconds = null;
    saveState();

    if (winCopy) {
      winCopy.textContent = state.ranked.playerRank
        ? `Finished in ${formatElapsedTime(getElapsedSeconds(session))}. You are now #${state.ranked.playerRank} on this puzzle leaderboard.`
        : `Finished in ${formatElapsedTime(getElapsedSeconds(session))}. Your time has been added to this puzzle leaderboard.`;
    }
  } catch (error) {
    session.rankedSubmissionError = error.message || "Failed to submit ranked time.";
    saveState();

    if (winCopy) {
      winCopy.textContent = `Finished in ${formatElapsedTime(getElapsedSeconds(session))}. ${session.rankedSubmissionError}`;
    }
  }

  renderRankedPanel();
}

function getRoomSummaryTitle() {
  if (isRankedSoloMode()) {
    return "Ranked Solo";
  }

  if (isSinglePlayerMode()) {
    return "Solo Board";
  }

  if (!state.roomId) {
    if (state.runtime.lastError) {
      return "Discord Status";
    }

    return isDiscordVoiceChannelContext() ? "Discord Room Pending" : "No Room Joined";
  }

  if (state.roomType === "discord-activity") {
    return state.runtime.channelName
      ? `Discord Activity · ${state.runtime.channelName}`
      : `Discord Channel · ${state.roomId}`;
  }

  const baseLabel = state.roomType === "vip"
    ? "Private Room"
    : state.roomType === "quick-match"
      ? "Quick Match Room"
      : "Private Room";

  if (state.roomCode && state.roomName) {
    return `${baseLabel} · ${state.roomName}`;
  }

  if (state.roomName) {
    return `${baseLabel} · ${state.roomName}`;
  }

  return state.roomCode ? `${baseLabel} · ${state.roomCode}` : baseLabel;
}

function getRoomSummaryCopy() {
  if (isRankedSoloMode()) {
    return "Play alone, submit your time to the same-puzzle leaderboard, and compare against the top 10 clears.";
  }

  if (isSinglePlayerMode()) {
    return "Play locally. Other browsers can open the game too, but their inputs stay isolated.";
  }

  if (state.lastRoomError) {
    return state.lastRoomError;
  }

  if (state.runtime.lastError) {
    return state.runtime.lastError;
  }

  const realtimeRoomUnavailableMessage = getRealtimeRoomUnavailableMessage();

  if (realtimeRoomUnavailableMessage) {
    return realtimeRoomUnavailableMessage;
  }

  if (!state.roomId) {
    return isDiscordVoiceChannelContext()
      ? "Pick Coop or Versus to create the Discord Activity room for this instance, then let your second player join the same Activity."
      : "Auto-join a waiting room, join with room name and password, or paste a room link.";
  }

  if (state.roomType === "discord-activity") {
    const participants = getRoomParticipantSummary();
    return `${gameModeLabels[state.gameMode] || "Multiplayer"} room linked to this Discord Activity. Player B joins the same room when opening the same Activity instance.${participants ? ` ${participants}.` : ""}`;
  }

  if (state.roomInviteUrl) {
    return state.roomCode
      ? `Room name: ${state.roomCode}. Share this room name and password with your friend, or use the generated invite link.`
      : "Invite your friend with the generated link. Room state and board progress stay isolated inside this room.";
  }

  return state.roomCode
    ? `Room name: ${state.roomCode}. Progress is synced only inside this room.`
    : "Room connected. Progress is synced only inside this room.";
}

function getRoomHubHeading() {
  return state.roomHubView === "join"
    ? "Join Room"
    : state.roomHubView === "create"
      ? "Create Room"
    : "Choose Room Action";
}

function getRoomHubIntroCopy() {
  if (state.roomHubView === "join") {
    return isDiscordVoiceChannelContext()
      ? "Choose how to join: auto-join this Discord voice channel, enter a room name, or paste a room link."
      : "Choose how to join: auto-join a waiting room, enter a room name, or paste a room link.";
  }

  if (state.roomHubView === "create") {
    if (state.roomCreateLinkReady) {
      return "Invite link is ready. Copy it, then tap Enter Room to start playing in the room you just created.";
    }

    return "Choose whether to create a room with a room name and password, or create one with an invite link. The room name is the only private-room identifier.";
  }

  return "Choose whether to enter an existing room or create a new room.";
}

function setRoomHubView(view) {
  state.roomHubView = view === "join" || view === "create" ? view : "entry";
}

function syncRuntimeSurface() {
  const runtimeKind = state.runtime.kind === "discord" ? "discord" : "web";
  document.body.dataset.runtimeKind = runtimeKind;
  document.body.dataset.roomHubView = state.roomHubView;

  if (roomHubCopy) {
    roomHubCopy.textContent = getRoomHubIntroCopy();
  }

  if (roomHubTitle) {
    roomHubTitle.textContent = getRoomHubHeading();
  }

  if (roomHubJoinEntryCopy) {
    roomHubJoinEntryCopy.textContent = "Auto join, room name join, or invite link join.";
  }

  if (roomHubAutoJoinCopy) {
    roomHubAutoJoinCopy.textContent = isDiscordVoiceChannelContext()
      ? "Inside Discord, choosing Coop or Versus now creates or rejoins the shared room for this Activity instance."
      : "If you are on the web or not in a Discord voice channel, this will join any waiting room. If none is waiting, it creates one for you.";
  }

  if (roomHubNav) {
    roomHubNav.hidden = state.roomHubView === "entry";
  }

  if (roomHubMeta) {
    roomHubMeta.hidden = state.roomHubView === "entry";
  }

  if (roomHubEntryPane) {
    roomHubEntryPane.hidden = state.roomHubView !== "entry";
  }

  if (roomHubJoinPane) {
    roomHubJoinPane.hidden = state.roomHubView !== "join";
  }

  if (roomHubCreatePane) {
    roomHubCreatePane.hidden = state.roomHubView !== "create";
  }
}

function renderRoomHub() {
  const environmentLabel = state.runtime.kind === "discord" ? "Discord Activity" : "Web Browser";
  syncRuntimeSurface();

  if (roomEnvironmentBadge) {
    roomEnvironmentBadge.textContent = environmentLabel;
  }

  if (roomHubStatus) {
    roomHubStatus.textContent = state.lastRoomError || getRoomSummaryCopy();
  }

  if (roomSummaryTitle) {
    roomSummaryTitle.textContent = getRoomSummaryTitle();
  }

  if (roomSummaryCopy) {
    roomSummaryCopy.textContent = getRoomSummaryCopy();
  }

  if (roomInviteField) {
    roomInviteField.value = state.roomInviteUrl || "";
  }

  if (roomInviteBlock) {
    roomInviteBlock.hidden = state.roomHubView !== "create";
  }

  const canCopyInvite = Boolean(state.roomInviteUrl);
  const canEnterCreatedRoom = state.roomCreateLinkReady && Boolean(state.roomId);
  copyRoomLinkButton?.toggleAttribute("disabled", !canCopyInvite);
  copyRoomLinkInlineButton?.toggleAttribute("disabled", !canCopyInvite);
  if (enterCreatedRoomButton) {
    enterCreatedRoomButton.hidden = !state.roomCreateLinkReady;
    enterCreatedRoomButton.toggleAttribute("disabled", !canEnterCreatedRoom);
  }
  openRoomHubButton?.toggleAttribute("disabled", !isRoomMultiplayerMode());
  roomHubEnterJoinButton?.toggleAttribute("disabled", !isRoomMultiplayerMode());
  roomHubEnterCreateButton?.toggleAttribute("disabled", !isRoomMultiplayerMode());
  roomJoinAutoButton?.toggleAttribute("disabled", !isRoomMultiplayerMode());
  roomJoinByCodeButton?.toggleAttribute("disabled", !isRoomMultiplayerMode());
  roomJoinByLinkButton?.toggleAttribute("disabled", !isRoomMultiplayerMode());
  roomCreateButton?.toggleAttribute("disabled", !isRoomMultiplayerMode());
  roomCreateLinkButton?.toggleAttribute("disabled", !isRoomMultiplayerMode());
}

async function copyInviteLink() {
  if (!state.roomInviteUrl) {
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(state.roomInviteUrl);
    return;
  }

  roomInviteField?.focus();
  roomInviteField?.select();
  document.execCommand("copy");
}

async function finalizeRoomJoin(snapshot, options = {}) {
  state.lastRoomError = "";
  state.roomCreateLinkReady = false;
  state.roomName = options.roomName ?? state.roomName;
  state.roomPassword = options.roomPassword ?? state.roomPassword;
  state.roomJoinMode = options.roomJoinMode ?? state.roomJoinMode;
  applyRoomSnapshot(snapshot, { force: true });
  connectRoomEventStream();
  startRoomHeartbeat();
  renderRoomHub();
}

async function joinDiscordAutoRoom() {
  if (state.runtime.kind !== "discord") {
    throw new Error("Discord Activity room join is only available inside Discord.");
  }

  if (!getDiscordActivityKey()) {
    throw new Error("Discord Activity context is missing. Reopen the Activity from the same channel and try again.");
  }

  updateSyncStatus("Connecting...");
  renderRoomHub();
  const snapshot = await roomSocketRequest("room:auto_join", {
    matchMode: getRoomMatchMode(),
    runtimeKind: "discord",
  });

  await finalizeRoomJoin(snapshot, {
    roomPassword: "",
    roomJoinMode: "discord-activity",
  });

  if (snapshot?.room?.matchMode && snapshot.room.matchMode !== getRoomMatchMode()) {
    state.lastRoomError = `${gameModeLabels[snapshot.room.matchMode] || "Room"} is already active in this Discord Activity.`;
  }
}

async function createManualRoom(options = {}) {
  updateSyncStatus("Connecting...");
  renderRoomHub();
  const password = String(options.password || "").trim();
  const roomName = sanitizeRoomNameInput(options.roomName || "");
  const snapshot = await roomSocketRequest("room:create", {
    clientId: roomClientId,
    joinedAt: roomJoinedAt,
    page: getCurrentPageLabel(),
    matchMode: getRoomMatchMode(),
    roomName,
    autoRoomName: options.autoRoomName === true,
    password,
    source: options.source || "web",
  });

  await finalizeRoomJoin(snapshot, {
    roomName: roomName || snapshot.room?.roomName || "",
    roomPassword: password,
    roomJoinMode: "manual",
  });
}

async function joinManualRoomByCode(roomCode, password) {
  updateSyncStatus("Connecting...");
  renderRoomHub();
  const snapshot = await roomSocketRequest("room:join", {
    clientId: roomClientId,
    joinedAt: roomJoinedAt,
    page: getCurrentPageLabel(),
    roomId: roomCode,
    password,
  });

  await finalizeRoomJoin(snapshot, {
    roomPassword: password,
    roomJoinMode: "manual",
  });
}

async function quickMatchRoom() {
  updateSyncStatus("Connecting...");
  renderRoomHub();
  const snapshot = await roomSocketRequest("room:auto_join", {
    clientId: roomClientId,
    joinedAt: roomJoinedAt,
    page: getCurrentPageLabel(),
    matchMode: getRoomMatchMode(),
    runtimeKind: "web",
    channelId: "",
  });

  await finalizeRoomJoin(snapshot, {
    roomPassword: "",
    roomJoinMode: "quick-match",
  });
}

async function ensureCoopRoomSelection() {
  if (!isRoomMultiplayerMode()) {
    disconnectRoomEventStream();
    stopRoomHeartbeat();
    renderRoomHub();
    return;
  }

  if (state.runtime.kind === "discord") {
    try {
      await joinDiscordAutoRoom();
      if (routeRoomEntryToLobby()) {
        return;
      }

      closeRoomHubModal();
      renderRoomHub();
      return;
    } catch (error) {
      state.lastRoomError = error.message || "Failed to join the Discord Activity room.";
      updateSyncStatus("Choose Room");
      setRoomHubView("entry");
      openRoomHubModal();
      renderRoomHub();
      return;
    }
  }

  setRoomHubView("entry");
  openRoomHubModal();
  renderRoomHub();

  updateSyncStatus("Choose Room");
  renderRoomHub();
}

async function resolveExplicitRoomEntryOnLaunch() {
  if (!hasExplicitManualRoomEntry()) {
    return;
  }

  const roomId = state.roomId || state.roomCode;

  if (!roomId) {
    return;
  }

  closeRoomHubModal();
  updateSyncStatus("Connecting...");
  renderRoomHub();

  try {
    const snapshot = await roomSocketRequest("room:resume", {
      clientId: roomClientId,
      joinedAt: roomJoinedAt,
      roomId,
      password: state.roomPassword,
      page: getCurrentPageLabel(),
    });

    await finalizeRoomJoin(snapshot, {
      roomPassword: state.roomPassword,
      roomJoinMode: state.roomJoinMode || "manual",
    });

    if (routeRoomEntryToLobby()) {
      return;
    }

    closeRoomHubModal();
  } catch (error) {
    state.lastRoomError = error.message || "Failed to join room.";
    updateSyncStatus("Choose Room");
    setRoomHubView("entry");
    openRoomHubModal();
    renderRoomHub();
  }
}

function applyGameModeSelection(mode) {
  if (mode !== "single" && mode !== "ranked" && mode !== "coop" && mode !== "versus") {
    return;
  }

  state.gameMode = mode;
  if (isVersusMode()) {
    state.entryMode = "value";
  }
  writeStoredGameMode(mode);
  state.lastRoomError = "";
  updateSyncStatus(isRankedSoloMode() ? "Ranked" : isSinglePlayerMode() ? "Solo" : "Choose Room");
  closeModeSelectModal();
  bootstrapOnce();

  if (isRoomMultiplayerMode()) {
    void ensureCoopRoomSelection();
  } else {
    removeSessionValue(ROOM_CONTEXT_KEY);
    closeRoomHubModal();
    updateRoomAssignment();
    renderRoomHub();
    if (isRankedSoloMode()) {
      void refreshRankedLeaderboard({ force: true });

      if (!hasRankedPlayerName()) {
        openRankedProfileModal();
      } else {
        closeRankedProfileModal();
      }
    } else {
      closeRankedProfileModal();
    }
  }
}

function handleModeOptionClick(event) {
  const button = event.currentTarget;
  const mode = button?.dataset.gameMode;

  if (!mode || button.disabled) {
    return;
  }

  applyGameModeSelection(mode);
}

function hasExplicitManualRoomEntry() {
  return Boolean(state.roomCode || state.roomId);
}

function getPersistedStateStorageKeyForMode(mode) {
  if (mode === "ranked") {
    return SOLO_RANKED_STORAGE_KEY;
  }

  if (mode === "single") {
    return SOLO_STORAGE_KEY;
  }

  return "";
}

function hasStoredSessionProgress(session) {
  return Boolean(
    Array.isArray(session?.cells)
      && session.cells.some((cell) =>
        cell
        && !cell.given
        && (
          cell.value
          || (cell.duel && (cell.duel.A || cell.duel.B))
          || Object.keys(cell.notes || {}).length > 0
        )),
  );
}

function getStoredLaunchSelection(parsedState) {
  if (!parsedState || typeof parsedState !== "object") {
    return null;
  }

  const difficulty = Object.prototype.hasOwnProperty.call(difficultyLabels, parsedState.difficulty)
    ? parsedState.difficulty
    : "easy";
  const puzzleIndexes = normalizePuzzleIndexes(parsedState.puzzleIndexes || {});
  const puzzleConfig = getDailyPuzzleConfigs(difficulty)[puzzleIndexes[difficulty]];

  if (!puzzleConfig?.id) {
    return null;
  }

  return {
    difficulty,
    sessionKey: getSessionKey(difficulty, puzzleConfig.id),
  };
}

function shouldResumeSinglePlayerModeOnLaunch(storedMode) {
  const storageKey = getPersistedStateStorageKeyForMode(storedMode);

  if (!storageKey) {
    return false;
  }

  const rawState = readPersistedStateByKey(storageKey);

  if (!rawState) {
    return false;
  }

  try {
    const parsedState = JSON.parse(rawState);
    const selection = getStoredLaunchSelection(parsedState);

    if (!selection) {
      return false;
    }

    const session = parsedState.sessions?.[selection.sessionKey];

    if (!session || !Array.isArray(session.cells) || session.cells.length !== 81) {
      return false;
    }

    const hasProgress = hasStoredSessionProgress(session);
    const roundStarted = parsedState.gameStart?.startedSessionKey === selection.sessionKey;
    const resumablePause = session.isPaused === true && hasProgress;
    const completedBoard = session.hasWon === true;

    return roundStarted || resumablePause || completedBoard || hasProgress;
  } catch (error) {
    console.warn("Failed to inspect persisted launch state.", error);
    return false;
  }
}

function shouldPromptModeSelectionOnLaunch() {
  return !hasExplicitManualRoomEntry();
}

function startApp() {
  const crossPageRoomContext = getCrossPageRoomContextOnLaunch();
  const storedMode = readStoredGameMode();
  const resumableSinglePlayerMode = shouldResumeSinglePlayerModeOnLaunch(storedMode)
    ? storedMode
    : null;

  if (hasExplicitManualRoomEntry()) {
    state.gameMode = storedMode === "versus" ? "versus" : "coop";
    writeStoredGameMode(state.gameMode);
    closeModeSelectModal();
    bootstrapOnce();
    void resolveExplicitRoomEntryOnLaunch();
    return;
  }

  if (crossPageRoomContext) {
    state.roomCode = crossPageRoomContext.roomCode;
    state.roomPassword = crossPageRoomContext.roomPassword;
    state.roomJoinMode = crossPageRoomContext.roomJoinMode || "manual";
    state.gameMode = storedMode === "versus" ? "versus" : "coop";
    writeStoredGameMode(state.gameMode);
    closeModeSelectModal();
    bootstrapOnce();
    void resolveExplicitRoomEntryOnLaunch();
    return;
  }

  if (resumableSinglePlayerMode) {
    state.gameMode = resumableSinglePlayerMode;
    writeStoredGameMode(state.gameMode);
    closeModeSelectModal();
    bootstrapOnce();
    return;
  }

  if (shouldPromptModeSelectionOnLaunch()) {
    state.gameMode = null;
    clearStoredGameMode();
    openModeSelectModal();
  }
}

function toggleControlsDrawer() {
  setControlsDrawerOpen(document.body.dataset.controlsOpen !== "true");
}

function closeControlsDrawer() {
  setControlsDrawerOpen(false);
}

function getDailyPuzzleDateKey() {
  const now = new Date();
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

function getDailyPuzzleConfigs(difficulty, requestedCount = STANDARD_DAILY_PUZZLE_COUNT) {
  const puzzles = PUZZLES[difficulty] || [];

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

function getAvailablePuzzleCount(difficulty) {
  return getDailyPuzzleConfigs(difficulty).length;
}

function getPuzzleConfig(difficulty) {
  const puzzles = getDailyPuzzleConfigs(difficulty);
  const index = state.puzzleIndexes[difficulty] ?? 0;
  const safeIndex = index >= 0 && index < puzzles.length ? index : 0;
  return puzzles[safeIndex];
}

function solvePuzzleString(puzzleString) {
  const cells = puzzleString.split("");
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

function getPuzzleSolution(difficulty, puzzleId) {
  const cacheKey = `${difficulty}:${puzzleId}`;

  if (puzzleSolutionCache.has(cacheKey)) {
    return puzzleSolutionCache.get(cacheKey);
  }

  const config = getDailyPuzzleConfigs(difficulty).find((item) => item.id === puzzleId);
  const solution = config ? solvePuzzleString(config.puzzle) : "";
  puzzleSolutionCache.set(cacheKey, solution);
  return solution;
}

function getSessionKey(difficulty, puzzleId) {
  return `${difficulty}:${puzzleId}`;
}

function normalizePuzzleIndexes(puzzleIndexes) {
  const nextIndexes = {};

  Object.keys(PUZZLES).forEach((difficulty) => {
    const value = puzzleIndexes?.[difficulty];
    const max = getAvailablePuzzleCount(difficulty);
    nextIndexes[difficulty] =
      Number.isInteger(value) && value >= 0 && value < max ? value : 0;
  });

  return nextIndexes;
}

function normalizeReadySelection(selection) {
  if (!selection || typeof selection !== "object") {
    return null;
  }

  if (!Object.prototype.hasOwnProperty.call(difficultyLabels, selection.difficulty)) {
    return null;
  }

  const config = getDailyPuzzleConfigs(selection.difficulty)[selection.puzzleIndex];

  if (!config || config.id !== selection.puzzleId) {
    return null;
  }

  return {
    difficulty: selection.difficulty,
    puzzleIndex: selection.puzzleIndex,
    puzzleId: selection.puzzleId,
    sessionKey: getSessionKey(selection.difficulty, selection.puzzleId),
  };
}

function normalizeGameStartState(gameStart) {
  return {
    readyBy: {
      A: normalizeReadySelection(gameStart?.readyBy?.A),
      B: normalizeReadySelection(gameStart?.readyBy?.B),
    },
    startedSessionKey: typeof gameStart?.startedSessionKey === "string"
      ? gameStart.startedSessionKey
      : null,
  };
}

function normalizeRoomSeatEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  if (!entry.clientId && !entry.identityKey) {
    return null;
  }

  const joinedAt = Number(entry.joinedAt);
  const lastSeenAt = Number(entry.lastSeenAt);

  return {
    clientId: typeof entry.clientId === "string" ? entry.clientId : "",
    identityKey: typeof entry.identityKey === "string" ? entry.identityKey : "",
    identitySource: typeof entry.identitySource === "string" ? entry.identitySource : "",
    authUserId: typeof entry.authUserId === "string" ? entry.authUserId : "",
    joinedAt: Number.isFinite(joinedAt) && joinedAt > 0 ? joinedAt : Number.MAX_SAFE_INTEGER,
    lastSeenAt: Number.isFinite(lastSeenAt) && lastSeenAt > 0 ? lastSeenAt : 0,
    page: typeof entry.page === "string" ? entry.page : "",
    displayName: typeof entry.displayName === "string" ? entry.displayName : "",
    avatarUrl: typeof entry.avatarUrl === "string" ? entry.avatarUrl : "",
  };
}

function normalizeRoomSeats(roomSeats) {
  return {
    A: normalizeRoomSeatEntry(roomSeats?.A),
    B: normalizeRoomSeatEntry(roomSeats?.B),
  };
}

function isSeatActive(seat, now = Date.now()) {
  return Boolean(seat && now - seat.lastSeenAt <= ROOM_SEAT_STALE_MS);
}

function buildRoomRosterFromSeats(roomSeats = state.roomSeats, now = Date.now()) {
  return ["A", "B"]
    .map((operator) => {
      const seat = normalizeRoomSeatEntry(roomSeats?.[operator]);

      if (!isSeatActive(seat, now)) {
        return null;
      }

      return {
        ...seat,
        operator,
      };
    })
    .filter(Boolean);
}

function getRoomParticipantSummary() {
  return ["A", "B"]
    .map((operator) => {
      const seat = normalizeRoomSeatEntry(state.roomSeats?.[operator]);

      if (!isSeatActive(seat)) {
        return null;
      }

      return seat.displayName
        ? `Player ${operator}: ${seat.displayName}`
        : `Player ${operator}`;
    })
    .filter(Boolean)
    .join(" | ");
}

function createEmptyCell() {
  return {
    given: false,
    value: "",
    owner: null,
    peerEdited: false,
    claimCorrect: null,
    notes: {},
    duel: null,
    harmonyAt: null,
    harmonyDigit: null,
    lastMoveAt: null,
    lastMoveBy: null,
    locked: false,
  };
}

function normalizeNotes(notes) {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(notes).filter(([digit, owner]) => /^[1-9]$/.test(digit) && (owner === "A" || owner === "B")),
  );
}

function normalizeDuel(duel) {
  if (!duel || typeof duel !== "object" || Array.isArray(duel)) {
    return null;
  }

  const nextDuel = {};

  if (/^[1-9]$/.test(duel.A || "")) {
    nextDuel.A = duel.A;
  }

  if (/^[1-9]$/.test(duel.B || "")) {
    nextDuel.B = duel.B;
  }

  return Object.keys(nextDuel).length > 0 ? nextDuel : null;
}

function normalizeCell(cell) {
  if (!cell || typeof cell !== "object") {
    return createEmptyCell();
  }

  if (cell.given) {
    return {
      given: true,
      value: /^[1-9]$/.test(cell.value) ? cell.value : "",
      owner: "given",
      peerEdited: false,
      claimCorrect: null,
      notes: {},
      duel: null,
      harmonyAt: null,
      harmonyDigit: null,
      lastMoveAt: null,
      lastMoveBy: null,
      locked: true,
    };
  }

  const duel = normalizeDuel(cell.duel);
  const value = duel ? "" : /^[1-9]$/.test(cell.value) ? cell.value : "";
  const harmonyAt = Number.isFinite(cell.harmonyAt) ? cell.harmonyAt : null;
  const harmonyDigit =
    value && /^[1-9]$/.test(cell.harmonyDigit) && cell.harmonyDigit === value ? cell.harmonyDigit : null;

  return {
    given: false,
    value,
    owner: duel ? null : cell.owner === "A" || cell.owner === "B" ? cell.owner : null,
    peerEdited: !duel && value ? cell.peerEdited === true : false,
    claimCorrect: duel ? null : cell.claimCorrect === true ? true : cell.claimCorrect === false ? false : null,
    notes: normalizeNotes(cell.notes),
    duel,
    harmonyAt: harmonyDigit ? harmonyAt : null,
    harmonyDigit,
    lastMoveAt: Number.isFinite(cell.lastMoveAt) ? cell.lastMoveAt : null,
    lastMoveBy: cell.lastMoveBy === "A" || cell.lastMoveBy === "B" ? cell.lastMoveBy : null,
    locked: cell.locked === true,
  };
}

function createSession(difficulty) {
  const config = getPuzzleConfig(difficulty);

  return {
    difficulty,
    puzzleId: config.id,
    hasWon: false,
    isPaused: false,
    elapsedSeconds: 0,
    timerStartedAt: null,
    rankedEntryId: "",
    rankedRank: null,
    rankedSubmissionError: "",
    cells: config.puzzle.split("").map((char) => {
      if (char === "0") {
        return createEmptyCell();
      }

      return {
        given: true,
        value: char,
        owner: "given",
        peerEdited: false,
        claimCorrect: null,
        notes: {},
        duel: null,
        harmonyAt: null,
        harmonyDigit: null,
        lastMoveAt: null,
        lastMoveBy: null,
        locked: true,
      };
    }),
  };
}

function updateSyncStatus(label) {
  state.syncStatus = label;

  if (statusSync) {
    statusSync.textContent = label;
  }

  renderRoomHub();
}

function syncPageLinksWithRoom() {
  const useManualParams = (
    state.roomType === "manual"
    || state.roomType === "vip"
    || state.roomType === "quick-match"
    || (state.roomJoinMode === "manual" && Boolean(state.roomCode || state.roomId))
  );

  pageLinkButtons.forEach((link) => {
    const targetUrl = new URL(link.getAttribute("href"), window.location.href);
    if (targetUrl.pathname.endsWith("/index.html") || targetUrl.pathname.endsWith("/lobby-b.html")) {
      targetUrl.pathname = targetUrl.pathname.replace(/(?:index|lobby-b)\.html$/, state.operator === "B" ? "lobby-b.html" : "index.html");
      targetUrl.searchParams.delete("view");
    }

    if (targetUrl.pathname.endsWith("/player-b.html")) {
      targetUrl.searchParams.set("view", "vip");
    }

    if (useManualParams) {
      targetUrl.searchParams.set(ROOM_LINK_PARAM, state.roomCode || state.roomId);

      if (state.roomPassword) {
        targetUrl.searchParams.set("password", state.roomPassword);
      } else {
        targetUrl.searchParams.delete("password");
      }
    } else {
      targetUrl.searchParams.delete(ROOM_LINK_PARAM);
      targetUrl.searchParams.delete("room");
      targetUrl.searchParams.delete("password");
    }

    link.setAttribute("href", `${targetUrl.pathname.split("/").pop()}${targetUrl.search}${targetUrl.hash}`);
  });
}

function syncCurrentUrlWithRoom() {
  const currentUrl = new URL(window.location.href);
  currentUrl.searchParams.delete("join");
  currentUrl.searchParams.delete(ROOM_LINK_PARAM);
  currentUrl.searchParams.delete("room");
  currentUrl.searchParams.delete("password");

  if (document.body?.dataset.pageLabel === "VIP Room") {
    currentUrl.searchParams.set("view", "vip");
  } else {
    currentUrl.searchParams.delete("view");
  }

  window.history.replaceState({}, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
}

function buildSharedPayload() {
  return {
    difficulty: state.difficulty,
    puzzleIndexes: state.puzzleIndexes,
    sessions: state.sessions,
    roomSeats: state.roomSeats,
    gameStart: state.gameStart,
  };
}

function isAuthoritativeProtocolVersion(protocolVersion) {
  return Number(protocolVersion) >= 2;
}

function getDefaultActiveRoundPlayerStates() {
  return {
    A: { freezeUntil: 0, freezeRemainingMs: 0 },
    B: { freezeUntil: 0, freezeRemainingMs: 0 },
  };
}

function isAuthoritativeMultiplayerRoundActive() {
  return Boolean(
    isRoomMultiplayerMode()
    && isAuthoritativeProtocolVersion(state.activeRound.protocolVersion)
    && state.activeRound.id
    && state.activeRound.sessionKey
    && state.gameStart.startedSessionKey,
  );
}

function hasAuthoritativeMultiplayerRound() {
  return Boolean(
    isRoomMultiplayerMode()
    && isAuthoritativeProtocolVersion(state.activeRound.protocolVersion)
    && state.activeRound.id
    && state.activeRound.sessionKey,
  );
}

function resetActiveRoundState() {
  if (roundEffectSweepId) {
    window.clearTimeout(roundEffectSweepId);
    roundEffectSweepId = null;
  }

  if (freezeCountdownTickId) {
    window.clearTimeout(freezeCountdownTickId);
    freezeCountdownTickId = null;
  }

  state.activeRound = {
    id: "",
    sessionKey: "",
    status: "",
    revision: 0,
    protocolVersion: 0,
    effects: [],
    playerStates: getDefaultActiveRoundPlayerStates(),
  };
}

function createRoomRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function pruneActiveRoundEffects(now = Date.now()) {
  if (!Array.isArray(state.activeRound.effects)) {
    state.activeRound.effects = [];
    return;
  }

  state.activeRound.effects = state.activeRound.effects.filter((effect) => (
    effect
    && Number.isFinite(effect.expiresAt)
    && effect.expiresAt > now
  ));
}

function getActiveRoundPlayerState(operator = state.operator) {
  if (operator !== "A" && operator !== "B") {
    return { freezeUntil: 0, freezeRemainingMs: 0 };
  }

  return state.activeRound.playerStates?.[operator] || { freezeUntil: 0, freezeRemainingMs: 0 };
}

function getSelfFreezeRemainingMs(now = Date.now()) {
  const playerState = getActiveRoundPlayerState();
  return Math.max(0, Number(playerState.freezeUntil || 0) - now);
}

function isSelfFrozen(now = Date.now()) {
  return getSelfFreezeRemainingMs(now) > 0;
}

function scheduleFreezeCountdownTick() {
  if (freezeCountdownTickId) {
    window.clearTimeout(freezeCountdownTickId);
    freezeCountdownTickId = null;
  }

  if (!isSelfFrozen()) {
    return;
  }

  freezeCountdownTickId = window.setTimeout(() => {
    freezeCountdownTickId = null;
    renderControls();
    renderKeypad();
    renderBoard();
    scheduleFreezeCountdownTick();
  }, 100);
}

function scheduleRoundEffectSweep() {
  if (roundEffectSweepId) {
    window.clearTimeout(roundEffectSweepId);
    roundEffectSweepId = null;
  }

  pruneActiveRoundEffects();
  scheduleFreezeCountdownTick();

  if (!state.activeRound.effects.length && !isSelfFrozen()) {
    return;
  }

  const expiries = state.activeRound.effects
    .map((effect) => Number(effect.expiresAt))
    .filter((expiresAt) => Number.isFinite(expiresAt));

  if (isSelfFrozen()) {
    expiries.push(Date.now() + 100);
  }

  const nextExpiry = Math.min(...expiries);

  if (!Number.isFinite(nextExpiry)) {
    return;
  }

  const delay = Math.max(0, nextExpiry - Date.now()) + 8;
  roundEffectSweepId = window.setTimeout(() => {
    roundEffectSweepId = null;
    pruneActiveRoundEffects();
    renderBoard();
    renderControls();
    renderKeypad();
    scheduleRoundEffectSweep();
  }, delay);
}

function getActiveRoundEffects(now = Date.now()) {
  pruneActiveRoundEffects(now);
  return state.activeRound.effects;
}

function getActiveRoundEffect(index, kind = "") {
  const effects = getActiveRoundEffects();

  return effects.find((effect) => (
    effect
    && effect.cellIndex === index
    && (!kind || effect.kind === kind)
  )) || null;
}

function getFreezeCountdownLabel(milliseconds) {
  return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
}

function buildSessionFromRoundState(roundState) {
  if (!roundState || typeof roundState !== "object") {
    return null;
  }

  const difficulty = roundState.difficulty || state.difficulty;
  const puzzleId = roundState.puzzleId || getPuzzleConfig(difficulty)?.id;
  const puzzleIndex = Number.isInteger(roundState.puzzleIndex)
    ? roundState.puzzleIndex
    : (state.puzzleIndexes[difficulty] ?? 0);
  const sessionKey = roundState.sessionKey || getSessionKey(difficulty, puzzleId);
  const previousSession = state.sessions[sessionKey];
  const isSameRound = state.activeRound.id && state.activeRound.id === roundState.roundId;

  state.puzzleIndexes[difficulty] = puzzleIndex;
  const nextSession = createSession(difficulty);
  nextSession.puzzleId = puzzleId;
  nextSession.cells = Array.isArray(roundState.cells)
    ? roundState.cells.map((cell) => normalizeCell({
      ...cell,
      duel: null,
      harmonyAt: null,
      harmonyDigit: null,
    }))
    : nextSession.cells;
  nextSession.timerStartedAt = isSameRound && previousSession?.timerStartedAt
    ? previousSession.timerStartedAt
    : Date.now();
  nextSession.elapsedSeconds = isSameRound && previousSession ? previousSession.elapsedSeconds : 0;
  nextSession.isPaused = false;
  nextSession.hasWon = roundState.status === "completed"
    || (isSameRound && previousSession ? previousSession.hasWon : false);
  return {
    sessionKey,
    session: nextSession,
  };
}

function applyAuthoritativeRoundState(roundState) {
  if (!roundState || typeof roundState !== "object") {
    resetActiveRoundState();
    return;
  }

  const built = buildSessionFromRoundState(roundState);

  if (!built) {
    resetActiveRoundState();
    return;
  }

  state.difficulty = roundState.difficulty || state.difficulty;
  if (roundState.status === "active" && roundState.sessionKey) {
    state.gameStart.startedSessionKey = roundState.sessionKey;
  }
  state.sessions[built.sessionKey] = built.session;
  state.activeRound = {
    id: roundState.roundId || "",
    sessionKey: built.sessionKey,
    status: typeof roundState.status === "string" ? roundState.status : "",
    revision: Number.isFinite(roundState.revision) ? Number(roundState.revision) : 0,
    protocolVersion: Number.isFinite(roundState.protocolVersion)
      ? Number(roundState.protocolVersion)
      : state.roomProtocolVersion,
    effects: Array.isArray(roundState.recentEffects)
      ? roundState.recentEffects.map((effect) => ({ ...effect }))
      : [],
    playerStates: roundState.playerStates
      ? {
        A: {
          freezeUntil: Number(roundState.playerStates.A?.freezeUntil || 0),
          freezeRemainingMs: Math.max(0, Number(roundState.playerStates.A?.freezeRemainingMs || 0)),
        },
        B: {
          freezeUntil: Number(roundState.playerStates.B?.freezeUntil || 0),
          freezeRemainingMs: Math.max(0, Number(roundState.playerStates.B?.freezeRemainingMs || 0)),
        },
      }
      : getDefaultActiveRoundPlayerStates(),
  };
  scheduleRoundEffectSweep();
}

function applySharedPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  state.difficulty = payload.difficulty || state.difficulty;
  state.puzzleIndexes = normalizePuzzleIndexes(payload.puzzleIndexes || state.puzzleIndexes);
  state.sessions = payload.sessions || state.sessions;
  state.roomSeats = normalizeRoomSeats(payload.roomSeats || state.roomSeats);
  state.gameStart = normalizeGameStartState(payload.gameStart);
}

function syncSharedStateFromStorage() {
  if (hasAuthoritativeMultiplayerRound()) {
    return;
  }

  try {
    const raw = readPersistedState();

    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);

    state.difficulty = parsed.difficulty || state.difficulty;
    state.puzzleIndexes = normalizePuzzleIndexes(parsed.puzzleIndexes || state.puzzleIndexes);
    state.sessions = parsed.sessions || state.sessions;
    state.roomSeats = normalizeRoomSeats(parsed.roomSeats || state.roomSeats);
    state.gameStart = normalizeGameStartState(parsed.gameStart);
  } catch (error) {
    console.warn("Failed to sync sudoku state from storage.", error);
  }
}

function loadState() {
  try {
    state.operator = readStoredOperator();
    const raw = readPersistedState();

    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);

    applySharedPayload(parsed);
  } catch (error) {
    console.warn("Failed to load persisted sudoku state.", error);
  }
}

function cacheStateLocally() {
  writePersistedState(JSON.stringify(buildSharedPayload()));
  persistCurrentRoomContext();
}

function getVipThemeDefinition(theme) {
  return vipThemeRegistryById[theme] || null;
}

function ensureVipSkinLinkElement() {
  if (!isVipRoomPage) {
    return null;
  }

  if (!vipSkinLinkElement) {
    vipSkinLinkElement = document.createElement("link");
    vipSkinLinkElement.id = "vip-skin-package-stylesheet";
    vipSkinLinkElement.rel = "stylesheet";
    document.head.appendChild(vipSkinLinkElement);
  }

  return vipSkinLinkElement;
}

async function loadVipThemePackage(theme) {
  if (!isVipRoomPage) {
    return;
  }

  const definition = getVipThemeDefinition(theme);
  const skinLink = ensureVipSkinLinkElement();

  if (!definition) {
    if (skinLink) {
      skinLink.removeAttribute("href");
    }

    if (vipSkinRoot) {
      vipSkinRoot.innerHTML = "";
      vipSkinRoot.dataset.theme = "";
    }
    return;
  }

  if (skinLink && skinLink.getAttribute("href") !== definition.skinCssPath) {
    skinLink.setAttribute("href", definition.skinCssPath);
  }

  const requestToken = ++vipSkinLoadToken;

  if (!definition.decorPath || !vipSkinRoot) {
    return;
  }

  try {
    const response = await window.fetch(definition.decorPath, { cache: "no-cache" });

    if (!response.ok) {
      throw new Error(`Skin decor request failed: ${response.status}`);
    }

    const markup = await response.text();

    if (requestToken !== vipSkinLoadToken) {
      return;
    }

    vipSkinRoot.innerHTML = markup.trim();
    vipSkinRoot.dataset.theme = theme;
  } catch (error) {
    console.error(`Failed to load VIP skin package for ${theme}.`, error);

    if (requestToken !== vipSkinLoadToken) {
      return;
    }

    vipSkinRoot.innerHTML = "";
    vipSkinRoot.dataset.theme = theme;
  }
}

function applyVipTheme(theme) {
  if (!isVipRoomPage) {
    return;
  }

  const normalizedTheme = theme === "meadow"
    ? "forest"
    : theme === "punk"
      ? DEFAULT_VIP_THEME
      : theme;

  const safeTheme = Object.prototype.hasOwnProperty.call(vipThemeLabels, normalizedTheme)
    ? normalizedTheme
    : DEFAULT_VIP_THEME;

  state.vipTheme = safeTheme;
  document.body.dataset.vipTheme = safeTheme;
  loadVipThemePackage(safeTheme);
}

function loadVipThemePreference() {
  if (!isVipRoomPage) {
    return;
  }

  applyVipTheme(readPreferredVipTheme() || DEFAULT_VIP_THEME);
}

function renderThemeControls() {
  if (!themeControls) {
    return;
  }

  const markup = VIP_THEME_REGISTRY.map(
    (theme) => `<button type="button" class="chip-button theme-button" data-theme="${theme.id}">${theme.label}</button>`,
  ).join("");

  if (themeControls.dataset.registryMarkup !== markup) {
    themeControls.innerHTML = markup;
    themeControls.dataset.registryMarkup = markup;
  }

  themeControls.querySelectorAll("[data-theme]").forEach((button) => {
    button.classList.toggle("active", button.dataset.theme === state.vipTheme);
  });
}

function getOperatorFromRoomSeats(now = Date.now()) {
  const currentIdentityKey = getCurrentRoomIdentityKey();

  if (isSeatActive(state.roomSeats.A, now) && state.roomSeats.A.identityKey === currentIdentityKey) {
    return "A";
  }

  if (isSeatActive(state.roomSeats.B, now) && state.roomSeats.B.identityKey === currentIdentityKey) {
    return "B";
  }

  return null;
}

function getOperatorLabel() {
  if (isSinglePlayerMode()) {
    return "Solo";
  }

  if (state.operator === "A") {
    return "Player A";
  }

  if (state.operator === "B") {
    return "Player B";
  }

  return state.roomRoster.length >= 2 ? "Spectator" : "Waiting...";
}

function hasPlayableSeat() {
  if (isSinglePlayerMode()) {
    return true;
  }

  return state.operator === "A" || state.operator === "B";
}

function updateRoomAssignment() {
  if (isSinglePlayerMode()) {
    const assignmentChanged = state.operator !== "A";
    state.roomRoster = [];
    state.roomSeats = normalizeRoomSeats();
    state.operator = "A";
    writeStoredOperator("A");

    if (!appBootstrapped) {
      return;
    }

    if (assignmentChanged) {
      state.selectedIndex = null;
      state.activeDigit = null;
    }

    syncPageLinksWithRoom();
    syncCurrentUrlWithRoom();
    updateGameStateAfterBoardChange();
    renderControls();
    renderKeypad();
    renderBoard();
    return;
  }

  const now = Date.now();
  state.roomRoster = buildRoomRosterFromSeats(state.roomSeats, now);
  const nextOperator = getOperatorFromRoomSeats(now);
  const assignmentChanged = nextOperator !== state.operator;

  state.operator = nextOperator;
  writeStoredOperator(nextOperator);

  if (!appBootstrapped) {
    return;
  }

  if (assignmentChanged) {
    state.selectedIndex = null;
    state.activeDigit = null;
  }

  syncPageLinksWithRoom();
  syncCurrentUrlWithRoom();
  updateGameStateAfterBoardChange();
  renderControls();
  renderKeypad();
  renderBoard();
}

function getCurrentPageLabel() {
  return document.body.dataset.pageLabel || "Lobby";
}

function getConfiguredRoomServerUrl() {
  const rawValue = typeof RUNTIME_CONFIG.roomServerUrl === "string"
    ? RUNTIME_CONFIG.roomServerUrl.trim()
    : "";

  if (!rawValue) {
    return "";
  }

  try {
    const normalizedUrl = new URL(rawValue, window.location.href);

    if (normalizedUrl.protocol !== "http:" && normalizedUrl.protocol !== "https:") {
      return "";
    }

    return normalizedUrl.origin;
  } catch (error) {
    return "";
  }
}

function getRoomServerUrl() {
  return getConfiguredRoomServerUrl() || window.location.origin;
}

function getInviteBaseHost() {
  return window.location.host;
}

function getInviteBaseProtocol() {
  return window.location.protocol.replace(/:$/, "") || "https";
}

async function getBaseRoomRequestPayload() {
  const basePayload = {
    clientId: roomClientId,
    joinedAt: roomJoinedAt,
    page: getCurrentPageLabel(),
    displayName: getCurrentPlayerDisplayName(),
  };

  if (state.runtime.kind !== "discord") {
    return basePayload;
  }

  const auth = await ensureDiscordAuthenticated();
  return {
    ...basePayload,
    runtimeKind: "discord",
    authToken: auth.sessionToken,
    activityKey: getDiscordActivityKey(),
    channelId: state.runtime.channelId,
    instanceId: state.runtime.instanceId,
  };
}

function getSocketIoFactory() {
  return typeof window.io === "function" ? window.io : null;
}

function getRealtimeRoomUnavailableMessage() {
  if (isSinglePlayerMode()) {
    return "";
  }

  if (!getSocketIoFactory()) {
    return "The room client failed to load. Make sure ./vendor/socket.io.min.js is deployed with the site.";
  }

  if (
    (window.location.hostname.endsWith("netlify.app") || window.location.hostname.endsWith("vercel.app"))
    && !getConfiguredRoomServerUrl()
  ) {
    return "This static deployment needs roomServerUrl in ./config.js set to your Railway site or custom domain.";
  }

  if (getSocketIoFactory()) {
    return "";
  }

  return "This web deployment does not have the live room service available. Local play works, but create/join room needs server.js + Socket.IO running on a Node host.";
}

async function ensureRoomSocket() {
  if (roomSocket?.connected) {
    return roomSocket;
  }

  if (roomSocketReadyPromise) {
    return roomSocketReadyPromise;
  }

  roomSocketReadyPromise = new Promise((resolve, reject) => {
    const ioFactory = getSocketIoFactory();

    if (!ioFactory) {
      roomSocketReadyPromise = null;
      reject(new Error(getRealtimeRoomUnavailableMessage() || "Socket.IO client is unavailable."));
      return;
    }

      if (!roomSocket) {
        roomSocket = ioFactory(getRoomServerUrl(), {
          path: "/api/socket-io.js",
          transports: ["websocket"],
          autoConnect: false,
        });

      roomSocket.on("room:snapshot", (snapshot) => {
        applyRoomSnapshot(snapshot, { force: true });
      });

      roomSocket.on("room:destroyed", ({ roomId }) => {
        if (roomId && roomId === state.roomId) {
          state.lastRoomError = "Room closed because all players left.";
          disconnectRoomEventStream();
          resetRoomStateForModeSelection();
        }
      });

      roomSocket.on("disconnect", () => {
        roomSocketReadyPromise = null;
        if (isRoomMultiplayerMode() && state.roomId) {
          updateSyncStatus("Reconnecting...");
          roomReconnectPending = true;
        }
      });

      roomSocket.on("connect", () => {
        if (roomReconnectPending && isRoomMultiplayerMode() && state.roomId) {
          roomReconnectPending = false;
          void roomSocketRequest("room:resume", {
            roomId: state.roomId,
            password: state.roomPassword,
          }).catch(() => {
            updateSyncStatus("Offline");
          });
        }
      });
    }

    const handleConnect = () => {
      cleanup();
      resolve(roomSocket);
    };

    const handleError = (error) => {
      cleanup();
      roomSocketReadyPromise = null;
        const errorMessage = error instanceof Error ? error.message : "Socket connection failed.";
        reject(new Error(`Failed to reach the room server at ${getRoomServerUrl()}. ${errorMessage}`));
    };

    const cleanup = () => {
      roomSocket.off("connect", handleConnect);
      roomSocket.off("connect_error", handleError);
    };

    roomSocket.on("connect", handleConnect);
    roomSocket.on("connect_error", handleError);

    if (!roomSocket.connected) {
      roomSocket.connect();
    }
  });

  return roomSocketReadyPromise;
}

async function roomSocketRequest(eventName, payload = {}) {
  const identityPayload = await getBaseRoomRequestPayload();
  const socket = await ensureRoomSocket();

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error("Room request timed out."));
    }, 10000);

    socket.emit(eventName, {
      ...identityPayload,
      ...payload,
      host: getInviteBaseHost(),
      forwardedProto: getInviteBaseProtocol(),
    }, (response = {}) => {
      window.clearTimeout(timeoutId);

      if (response.snapshot) {
        applyRoomSnapshot(response.snapshot, { force: true });
      }

      if (!response.ok) {
        if (response.error && /refresh/i.test(response.error)) {
          state.lastRoomError = response.error;
          state.feedback = response.error;
          updateFeedback(state.feedback);
          renderRoomHub();
        }

        reject(new Error(response.error || "Room request failed."));
        return;
      }

      resolve(response.snapshot || response);
    });
  });
}

function disconnectRoomEventStream() {
  roomReconnectPending = false;
}

function stopRoomHeartbeat() {
  if (roomHeartbeatId) {
    window.clearInterval(roomHeartbeatId);
    roomHeartbeatId = null;
  }
}

function applyRoomSnapshot(snapshot, options = {}) {
  if (!snapshot) {
    return;
  }

  const previousPlayerCount = state.roomRoster.length;
  const previousStartedSessionKey = state.gameStart.startedSessionKey;
  const nextRevision = Number.isFinite(snapshot.revision) ? Number(snapshot.revision) : 0;

  if (!options.force && nextRevision < sharedRevision) {
    return;
  }

  sharedRevision = nextRevision;
  state.roomProtocolVersion = Number.isFinite(snapshot.protocolVersion) ? Number(snapshot.protocolVersion) : 0;

  if (state.roomProtocolVersion > ROOM_PROTOCOL_VERSION) {
    state.lastRoomError = "This room needs a newer client version. Refresh to continue.";
    updateFeedback(state.lastRoomError);
  }

  if (snapshot.room) {
    state.roomId = snapshot.room.roomId || state.roomId;
    state.roomCode = snapshot.room.roomCode || state.roomCode;
    state.roomName = snapshot.room.roomName || "";
    state.roomType = snapshot.room.kind || "";
    state.roomSource = snapshot.room.source || "";
    state.roomInviteUrl = snapshot.room.inviteUrl || "";
    if (snapshot.room.matchMode === "coop" || snapshot.room.matchMode === "versus") {
      state.gameMode = snapshot.room.matchMode;
      writeStoredGameMode(state.gameMode);

      if (isVersusMode()) {
        state.entryMode = "value";
      }
    }
  }

  isApplyingRemoteState = true;

  const hasAuthoritativeRoundSnapshot = Boolean(
    isAuthoritativeProtocolVersion(snapshot.protocolVersion)
    && snapshot.roundState,
  );

  if (snapshot.sharedState && !hasAuthoritativeRoundSnapshot) {
    applySharedPayload({
      ...snapshot.sharedState,
      roomSeats: snapshot.seats || snapshot.sharedState.roomSeats,
      gameStart: snapshot.lobby || snapshot.sharedState.gameStart,
    });
  } else {
    state.roomSeats = normalizeRoomSeats(snapshot.seats || state.roomSeats);
    state.gameStart = normalizeGameStartState(snapshot.lobby || state.gameStart);
  }

  if (hasAuthoritativeRoundSnapshot) {
    applyAuthoritativeRoundState(snapshot.roundState);
  } else if (!snapshot.roundState) {
    resetActiveRoundState();
  }

  state.roomSeats = normalizeRoomSeats(snapshot.seats || state.roomSeats);
  state.roomRoster = buildRoomRosterFromSeats(state.roomSeats);
  cacheStateLocally();
  isApplyingRemoteState = false;
  if (!hasAuthoritativeRoundSnapshot) {
    syncStartedRoundFromSnapshot(previousStartedSessionKey);
  }
  if (!hasAuthoritativeMultiplayerRound()) {
    syncHarmonyEffects();
  }
  updateRoomAssignment();
  updateSyncStatus(
    snapshot.playerCount >= 2
      ? (isCurrentRoundStarted() ? "Live" : getReadyCountForCurrentSelection() === 2 ? "Ready" : "Waiting...")
      : "Waiting...",
  );

  if (
    previousPlayerCount < 2
    && state.roomRoster.length >= 2
    && hasPlayableSeat()
    && !isCurrentRoundStarted()
  ) {
    state.feedback = "Both players joined. Choose the same difficulty and puzzle, then press Start Game.";
    updateFeedback(state.feedback, "success");
  }

  renderRoomHub();
}

function connectRoomEventStream() {
  if (!isRoomMultiplayerMode()) {
    return;
  }

  void ensureRoomSocket().catch(() => {
    updateSyncStatus("Offline");
  });
}

async function heartbeatRoom() {
  if (!state.roomId || !isRoomMultiplayerMode()) {
    return;
  }

  try {
    await roomSocketRequest("room:ping", {
      clientId: roomClientId,
      joinedAt: roomJoinedAt,
      page: getCurrentPageLabel(),
    });
  } catch (error) {
    console.warn("Room heartbeat failed.", error);
    updateSyncStatus("Offline");
  }
}

function startRoomHeartbeat() {
  if (!isRoomMultiplayerMode()) {
    return;
  }

  stopRoomHeartbeat();
  void heartbeatRoom();
  roomHeartbeatId = window.setInterval(() => {
    if (document.visibilityState === "hidden") {
      return;
    }

    void heartbeatRoom();
  }, ROOM_SEAT_HEARTBEAT_MS);
}

async function refreshRoomSnapshot() {
  if (!state.roomId || !isRoomMultiplayerMode()) {
    return;
  }

  await heartbeatRoom();
}

async function updateRoomReadySelection(selection) {
  if (!state.roomId || !isRoomMultiplayerMode()) {
    throw new Error("Join a multiplayer room before changing ready state.");
  }

  const snapshot = await roomSocketRequest("room:set_ready", {
    selection: selection || null,
  });

  applyRoomSnapshot(snapshot, { force: true });
  return snapshot;
}

async function requestRoomRoundStart(selection) {
  if (!state.roomId || !isRoomMultiplayerMode()) {
    throw new Error("Join a multiplayer room before starting the round.");
  }

  const snapshot = await roomSocketRequest("room:start_round", {
    selection,
  });

  applyRoomSnapshot(snapshot, { force: true });
  return snapshot;
}

async function persistSharedState() {
  if (hasAuthoritativeMultiplayerRound()) {
    return;
  }

  if (!isRoomMultiplayerMode() || !state.roomId) {
    return;
  }

  const payload = buildSharedPayload();
  const baseRevision = sharedRevision;

  sharedStateSyncPromise = sharedStateSyncPromise
    .catch(() => undefined)
    .then(async () => {
      try {
        const snapshot = await roomSocketRequest("room:state_sync", {
          clientId: roomClientId,
          joinedAt: roomJoinedAt,
          page: getCurrentPageLabel(),
          baseRevision,
          sharedState: payload,
        });

        applyRoomSnapshot(snapshot, { force: true });
      } catch (error) {
        console.error("Failed to persist shared sudoku state.", error);
        updateSyncStatus("Offline");
      }
    });
}

function saveState() {
  cacheStateLocally();

  if (isRoomMultiplayerMode() && !isApplyingRemoteState && !hasAuthoritativeMultiplayerRound()) {
    void persistSharedState();
  }
}

async function submitAuthoritativeCellChange(index, options = {}) {
  if (!isAuthoritativeMultiplayerRoundActive() || !state.roomId) {
    throw new Error("No active authoritative round.");
  }

  const action = String(options.action || "set").trim().toLowerCase();
  const session = getCurrentSession();
  const observedCell = session?.cells?.[index];
  const snapshot = await roomSocketRequest("room:cell_submit", {
    roundId: state.activeRound.id,
    baseRoundRevision: state.activeRound.revision,
    requestId: createRoomRequestId(),
    clientSeq: ++roomCellRequestSeq,
    cellIndex: index,
    action,
    digit: action === "clear" ? "" : options.digit,
    observedCellVersion: Number.isInteger(observedCell?.version) ? observedCell.version : 0,
    observedCellLocked: observedCell?.locked === true,
  });

  applyRoomSnapshot(snapshot, { force: true });
  return snapshot;
}

function ensureSession(difficulty) {
  const config = getPuzzleConfig(difficulty);
  const sessionKey = getSessionKey(difficulty, config.id);
  const fallback = createSession(difficulty);

  if (!state.sessions[sessionKey]) {
    state.sessions[sessionKey] = fallback;
    return state.sessions[sessionKey];
  }

  const session = state.sessions[sessionKey];

  if (!Array.isArray(session.cells) || session.cells.length !== 81) {
    state.sessions[sessionKey] = fallback;
    return state.sessions[sessionKey];
  }

  session.cells = session.cells.map(normalizeCell);
  session.puzzleId = session.puzzleId || fallback.puzzleId;
  session.difficulty = difficulty;
  session.hasWon = Boolean(session.hasWon);
  session.isPaused = Boolean(session.isPaused);
  session.elapsedSeconds = Number.isFinite(session.elapsedSeconds) && session.elapsedSeconds >= 0
    ? Math.floor(session.elapsedSeconds)
    : 0;
  session.timerStartedAt = Number.isFinite(session.timerStartedAt) ? session.timerStartedAt : null;
  session.rankedEntryId = typeof session.rankedEntryId === "string" ? session.rankedEntryId : "";
  session.rankedRank = Number.isInteger(session.rankedRank) && session.rankedRank > 0 ? session.rankedRank : null;
  session.rankedSubmissionError = typeof session.rankedSubmissionError === "string" ? session.rankedSubmissionError : "";

  if (session.hasWon) {
    finalizeSessionTimer(session);
  }

  return session;
}

function getCurrentSelection() {
  const difficulty = state.difficulty;
  const puzzleIndex = state.puzzleIndexes[difficulty] ?? 0;
  const config = getPuzzleConfig(difficulty);

  return {
    difficulty,
    puzzleIndex,
    puzzleId: config.id,
    sessionKey: getSessionKey(difficulty, config.id),
  };
}

function getSelectionFromSessionKey(sessionKey) {
  const normalizedKey = String(sessionKey || "").trim();
  const separatorIndex = normalizedKey.indexOf(":");

  if (separatorIndex <= 0) {
    return null;
  }

  const difficulty = normalizedKey.slice(0, separatorIndex);
  const puzzleId = normalizedKey.slice(separatorIndex + 1);

  if (!Object.prototype.hasOwnProperty.call(difficultyLabels, difficulty) || !puzzleId) {
    return null;
  }

  const puzzleIndex = getDailyPuzzleConfigs(difficulty).findIndex((item) => item?.id === puzzleId);

  if (puzzleIndex < 0) {
    return null;
  }

  return {
    difficulty,
    puzzleId,
    puzzleIndex,
    sessionKey: getSessionKey(difficulty, puzzleId),
  };
}

function resetCurrentSelectionSession() {
  const selection = getCurrentSelection();
  state.sessions[selection.sessionKey] = createSession(selection.difficulty);
}

function startSinglePlayerRound(selection = getCurrentSelection(), options = {}) {
  const nextSelection = selection || getCurrentSelection();
  const nextMessage = typeof options.feedback === "string" && options.feedback
    ? options.feedback
    : isRankedSoloMode()
      ? `Ranked run started on ${difficultyLabels[nextSelection.difficulty]} puzzle ${nextSelection.puzzleIndex + 1}.`
      : `Solo round started on ${difficultyLabels[nextSelection.difficulty]} puzzle ${nextSelection.puzzleIndex + 1}.`;

  state.selectedIndex = null;
  state.activeDigit = null;
  state.sessions[nextSelection.sessionKey] = createSession(nextSelection.difficulty);
  state.sessions[nextSelection.sessionKey].timerStartedAt = Date.now();
  state.gameStart.readyBy.A = nextSelection;
  state.gameStart.readyBy.B = null;
  state.gameStart.startedSessionKey = nextSelection.sessionKey;
  state.feedback = nextMessage;
  updateFeedback(state.feedback);
  saveState();

  if (isRankedSoloMode()) {
    void refreshRankedLeaderboard({ force: true });
  }

  updateGameStateAfterBoardChange();
  renderControls();
  renderKeypad();
  renderBoard();
}

function getVersusClaimableTotal(session = getCurrentSession()) {
  return session.cells.filter((cell) => !cell.given).length;
}

function getVersusClaimedCount(session = getCurrentSession()) {
  return session.cells.filter((cell) => isFilledClaimCell(cell)).length;
}

function getVersusScores(session = getCurrentSession()) {
  return session.cells.reduce((scores, cell) => {
    if (!isFilledClaimCell(cell)) {
      return scores;
    }

    const delta = cell.claimCorrect === false ? -1 : 1;
    scores[cell.owner] += delta;
    return scores;
  }, { A: 0, B: 0 });
}

function getVersusWinner(scores = getVersusScores()) {
  if (scores.A === scores.B) {
    return "tie";
  }

  return scores.A > scores.B ? "A" : "B";
}

function getVersusScoreSummary(session = getCurrentSession()) {
  const scores = getVersusScores(session);
  const claimedCount = getVersusClaimedCount(session);
  const totalClaimable = getVersusClaimableTotal(session);
  const remainingCells = Math.max(0, totalClaimable - claimedCount);

  return {
    scores,
    claimedCount,
    totalClaimable,
    remainingCells,
    winner: getVersusWinner(scores),
  };
}

function getVersusFinishMessage(session = getCurrentSession()) {
  const summary = getVersusScoreSummary(session);

  if (summary.winner === "tie") {
    return `Versus finished in a tie. A ${summary.scores.A} : B ${summary.scores.B}.`;
  }

  return `Player ${summary.winner} wins. A ${summary.scores.A} : B ${summary.scores.B}.`;
}

function hasBothPlayersJoined() {
  if (isSinglePlayerMode()) {
    return true;
  }

  return state.roomRoster.length >= 2;
}

function isReadyForSelection(operator, selection) {
  const normalizedSelection = normalizeReadySelection(selection);
  const readySelection = state.gameStart.readyBy[operator];

  return Boolean(
    normalizedSelection
      && readySelection
      && readySelection.sessionKey === normalizedSelection.sessionKey
      && readySelection.puzzleIndex === normalizedSelection.puzzleIndex
      && readySelection.difficulty === normalizedSelection.difficulty,
  );
}

function getReadyCountForSelection(selection) {
  const normalizedSelection = normalizeReadySelection(selection);

  if (!normalizedSelection) {
    return 0;
  }

  return ["A", "B"].filter((operator) => isReadyForSelection(operator, normalizedSelection)).length;
}

function hasBothPlayersReady() {
  if (isSinglePlayerMode()) {
    return true;
  }

  return hasBothPlayersJoined() && getReadyCountForCurrentSelection() === 2;
}

function isReadyForCurrentSelection(operator) {
  return isReadyForSelection(operator, getCurrentSelection());
}

function getReadyCountForCurrentSelection() {
  return getReadyCountForSelection(getCurrentSelection());
}

function isCompletedAuthoritativeMultiplayerRound() {
  return Boolean(
    isRoomMultiplayerMode()
    && isAuthoritativeProtocolVersion(state.activeRound.protocolVersion)
    && state.activeRound.id
    && state.activeRound.sessionKey
    && state.activeRound.status === "completed",
  );
}

function getCompletedRoundReadySelection(operator = state.operator) {
  if (!isCompletedAuthoritativeMultiplayerRound()) {
    return null;
  }

  const queuedSelection = operator
    ? normalizeReadySelection(state.gameStart.readyBy[operator])
    : null;

  if (queuedSelection && queuedSelection.sessionKey !== state.activeRound.sessionKey) {
    return queuedSelection;
  }

  const difficulty = state.difficulty;
  const puzzles = getDailyPuzzleConfigs(difficulty);

  if (!puzzles.length) {
    return null;
  }

  const currentIndex = state.puzzleIndexes[difficulty] ?? 0;
  const nextIndex = (currentIndex + 1) % puzzles.length;
  const config = puzzles[nextIndex];

  if (!config?.id) {
    return null;
  }

  return {
    difficulty,
    puzzleIndex: nextIndex,
    puzzleId: config.id,
    sessionKey: getSessionKey(difficulty, config.id),
  };
}

function getMultiplayerReadySelection(operator = state.operator) {
  return getCompletedRoundReadySelection(operator) || getCurrentSelection();
}

function isCurrentRoundStarted(session = getCurrentSession()) {
  return state.gameStart.startedSessionKey === getSessionKey(session.difficulty, session.puzzleId);
}

function canConfigureCurrentRound(session = getCurrentSession()) {
  return !isCurrentRoundStarted(session) || session.hasWon;
}

function canSwitchPuzzle(session = getCurrentSession()) {
  return !isCurrentRoundStarted(session) || session.hasWon || session.isPaused;
}

function resetCurrentRoundGate() {
  state.gameStart = normalizeGameStartState();
}

function getCurrentRoundStatus(session = getCurrentSession()) {
  if (session.hasWon) {
    return "Completed";
  }

  if (isResumableSession(session)) {
    return "Paused";
  }

  if (isCurrentRoundStarted(session)) {
    if (isVersusMode() && isSelfFrozen()) {
      return `Frozen ${getFreezeCountdownLabel(getSelfFreezeRemainingMs())}`;
    }

    return "Live";
  }

  if (isRankedSoloMode()) {
    return hasRankedPlayerName() ? "Leaderboard Ready" : "Name Needed";
  }

  if (isSinglePlayerMode()) {
    return "Ready";
  }

  if (isVersusMode()) {
    if (!hasBothPlayersJoined()) {
      return "Waiting for 2 Players";
    }

    const readyCount = getReadyCountForCurrentSelection();
    return readyCount === 2 ? "Face Off" : `${readyCount}/2 Ready`;
  }

  if (!hasBothPlayersJoined()) {
    return "Waiting for 2 Players";
  }

  const readyCount = getReadyCountForCurrentSelection();

  if (readyCount === 0) {
    return "Ready Check";
  }

  return `${readyCount}/2 Ready`;
}

function getPreStartFeedbackMessage() {
  if (isRankedSoloMode()) {
    return hasRankedPlayerName()
      ? "Choose a difficulty and puzzle, then press Start Game to post your best clear time onto this puzzle leaderboard."
      : "Enter your player name first, then press Start Game to begin your ranked run.";
  }

  if (isSinglePlayerMode()) {
    return "Choose a difficulty and puzzle, then press Start Game to begin your solo run.";
  }

  if (!hasPlayableSeat()) {
    if (!state.roomId) {
      return isVersusMode()
        ? "Choose or create a versus room first."
        : "Choose or create a co-op room first.";
    }

    return state.roomRoster.length >= 2
      ? "Room already has two players. You are watching as a spectator."
      : "Waiting for both players to join this room.";
  }

  if (!hasBothPlayersJoined()) {
    return isVersusMode()
      ? "Choose a difficulty and puzzle, then wait for both Player A and Player B to join the match."
      : "Choose a difficulty and puzzle, then wait for both Player A and Player B to join.";
  }

  if (isVersusMode()) {
    return hasBothPlayersReady()
      ? "Both players are ready. The server is starting the versus round now."
      : "Both players must lock the same puzzle. Each claimed cell is final: correct answers score, wrong answers lose points.";
  }

  const readyCount = getReadyCountForCurrentSelection();

  if (readyCount === 0) {
    return "Both players must confirm the same puzzle. Press Ready after agreeing on the current difficulty and puzzle.";
  }

  if (readyCount === 1) {
    return "One player is ready. The other player needs to confirm the same difficulty and puzzle, then press Ready.";
  }

  return "Both players are ready. Starting the round...";
}

function getRoomPlayerStatusMessage() {
  if (isSinglePlayerMode()) {
    return "Solo";
  }

  const playerCount = Math.min(state.roomRoster.length, 2);

  if (!state.roomId) {
    return "0/2";
  }

  if (playerCount >= 2) {
    return hasPlayableSeat() ? "2/2" : "Full";
  }

  return `${playerCount}/2`;
}

function hasSessionProgress(session = getCurrentSession()) {
  return Boolean(
    session?.cells?.some((cell) =>
      !cell.given && (
        cell.value
        || hasCellDuel(cell)
        || Object.keys(cell.notes || {}).length > 0
      )),
  );
}

function isResumableSession(session = getCurrentSession()) {
  return Boolean(session?.isPaused && hasSessionProgress(session));
}

function getElapsedSeconds(session, now = Date.now()) {
  const baseElapsed = Number.isFinite(session.elapsedSeconds) ? session.elapsedSeconds : 0;

  if (!session.timerStartedAt) {
    return baseElapsed;
  }

  return baseElapsed + Math.max(0, Math.floor((now - session.timerStartedAt) / 1000));
}

function finalizeSessionTimer(session) {
  if (!session) {
    return;
  }

  session.elapsedSeconds = getElapsedSeconds(session);
  session.timerStartedAt = null;
  session.isPaused = false;
}

function formatElapsedTime(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  }

  return [minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function syncTimerDisplay() {
  const session = getCurrentSession();

  if (session.hasWon && session.timerStartedAt) {
    finalizeSessionTimer(session);
    saveState();
  }

  const formattedTime = (isCurrentRoundStarted(session) || session.hasWon)
    ? formatElapsedTime(getElapsedSeconds(session))
    : "00:00";

  statusTimer.textContent = session.isPaused ? `${formattedTime} (Paused)` : formattedTime;
  winTime.textContent = `Time: ${formattedTime}`;

  if (
    isRankedSoloMode()
    && hasRankedPlayerName()
    && !session.hasWon
    && !session.isPaused
    && isCurrentRoundStarted(session)
    && !state.ranked.isLoading
  ) {
    void refreshRankedLeaderboard({ liveElapsedSeconds: getElapsedSeconds(session) });
  }
}

function getCurrentSession() {
  const activeSessionKey = typeof state.activeRound.sessionKey === "string"
    ? state.activeRound.sessionKey
    : "";

  if (activeSessionKey && state.sessions[activeSessionKey]) {
    return state.sessions[activeSessionKey];
  }

  return ensureSession(state.difficulty);
}

function syncStartedRoundFromSnapshot(previousStartedSessionKey) {
  if (isSinglePlayerMode()) {
    return;
  }

  const nextStartedSessionKey = state.gameStart.startedSessionKey;

  if (!nextStartedSessionKey || nextStartedSessionKey === previousStartedSessionKey) {
    return;
  }

  const selection = getSelectionFromSessionKey(nextStartedSessionKey);

  if (!selection) {
    return;
  }

  state.difficulty = selection.difficulty;
  state.puzzleIndexes[selection.difficulty] = selection.puzzleIndex;

  const existingSession = state.sessions[selection.sessionKey];
  const canReuseExistingSession = Boolean(
    existingSession && (
      hasSessionProgress(existingSession)
      || existingSession.elapsedSeconds > 0
      || existingSession.timerStartedAt
      || existingSession.isPaused
      || existingSession.hasWon
    ),
  );

  if (!canReuseExistingSession) {
    state.sessions[selection.sessionKey] = createSession(selection.difficulty);
    state.sessions[selection.sessionKey].timerStartedAt = Date.now();
    state.feedback = isVersusMode()
      ? `Versus match started on ${difficultyLabels[selection.difficulty]} puzzle ${selection.puzzleIndex + 1}. Claim cells to score.`
      : `Round started on ${difficultyLabels[selection.difficulty]} puzzle ${selection.puzzleIndex + 1}.`;
    updateFeedback(state.feedback);
    saveState();
  }
}

function isSessionInteractive(session = getCurrentSession()) {
  return hasPlayableSeat()
    && isCurrentRoundStarted(session)
    && !session.hasWon
    && !session.isPaused
    && !isSelfFrozen();
}

function getCellKey(index, session = getCurrentSession()) {
  return `${session.difficulty}:${session.puzzleId}:${index}`;
}

function hasCellDuel(cell) {
  return Boolean(cell?.duel?.A || cell?.duel?.B);
}

function getCellDisplayDigits(cell) {
  if (!cell) {
    return [];
  }

  if (hasCellDuel(cell)) {
    return ["A", "B"].map((operator) => cell.duel?.[operator]).filter(Boolean);
  }

  return cell.value ? [cell.value] : [];
}

function getActiveDigitTone(cells) {
  if (state.selectedIndex === null || !state.activeDigit) {
    return null;
  }

  const selectedCell = cells[state.selectedIndex];

  if (!selectedCell || hasCellDuel(selectedCell) || selectedCell.value !== state.activeDigit) {
    return null;
  }

  if (selectedCell.given) {
    return "given";
  }

  if (selectedCell.owner === "B") {
    return "player-b";
  }

  return "player-a";
}

function getMatchedDigitIndexes(cells) {
  if (!state.activeDigit) {
    return new Set();
  }

  return cells.reduce((indexes, cell, index) => {
    if (getCellDisplayDigits(cell).includes(state.activeDigit)) {
      indexes.add(index);
    }

    return indexes;
  }, new Set());
}

function getSingleValueOwner(cell) {
  if (!cell || hasCellDuel(cell) || !cell.value) {
    return null;
  }

  return cell.owner;
}

function triggerCellExplosion(index, session = getCurrentSession()) {
  const cellKey = getCellKey(index, session);

  if (state.explosionTimeouts[cellKey]) {
    window.clearTimeout(state.explosionTimeouts[cellKey]);
  }

  state.explodingCells[cellKey] = true;
  state.explosionTimeouts[cellKey] = window.setTimeout(() => {
    delete state.explodingCells[cellKey];
    delete state.explosionTimeouts[cellKey];
    renderBoard();
  }, EXPLOSION_DURATION_MS);
}

function triggerCellHeart(index, session = getCurrentSession(), effectAt = Date.now()) {
  const cellKey = getCellKey(index, session);

  if (state.heartCelebrations[cellKey] === effectAt) {
    return;
  }

  if (state.heartTimeouts[cellKey]) {
    window.clearTimeout(state.heartTimeouts[cellKey]);
  }

  state.heartCelebrations[cellKey] = effectAt;
  state.heartTimeouts[cellKey] = window.setTimeout(() => {
    if (state.heartCelebrations[cellKey] === effectAt) {
      delete state.heartCelebrations[cellKey];
    }

    delete state.heartTimeouts[cellKey];
    renderBoard();
  }, HEART_EFFECT_DURATION_MS);
}

function syncHarmonyEffects() {
  Object.values(state.sessions).forEach((session) => {
    if (!session?.cells || !session.puzzleId || !session.difficulty) {
      return;
    }

    session.cells.forEach((cell, index) => {
      if (
        cell?.harmonyAt
        && cell.harmonyDigit
        && cell.value === cell.harmonyDigit
        && Date.now() - cell.harmonyAt <= HEART_EFFECT_DURATION_MS + 150
      ) {
        triggerCellHeart(index, session, cell.harmonyAt);
      }
    });
  });
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
  if (!/^[1-9]$/.test(digit)) {
    return;
  }

  getRelatedIndexes(index).forEach((relatedIndex) => {
    const relatedCell = cells[relatedIndex];

    if (!relatedCell || relatedCell.given || relatedCell.value || !relatedCell.notes[digit]) {
      return;
    }

    delete relatedCell.notes[digit];
  });
}

function getConflictIndexes(cells) {
  const conflictIndexes = new Set();

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];

    if (!cell.value || hasCellDuel(cell)) {
      continue;
    }

    const row = Math.floor(index / 9);
    const col = index % 9;
    const boxRow = Math.floor(row / 3) * 3;
    const boxCol = Math.floor(col / 3) * 3;

    for (let i = 0; i < 9; i += 1) {
      const rowIndex = row * 9 + i;
      const colIndex = i * 9 + col;

      if (rowIndex !== index && cells[rowIndex].value === cell.value) {
        conflictIndexes.add(index);
        conflictIndexes.add(rowIndex);
      }

      if (colIndex !== index && cells[colIndex].value === cell.value) {
        conflictIndexes.add(index);
        conflictIndexes.add(colIndex);
      }
    }

    for (let r = boxRow; r < boxRow + 3; r += 1) {
      for (let c = boxCol; c < boxCol + 3; c += 1) {
        const boxIndex = r * 9 + c;

        if (boxIndex !== index && cells[boxIndex].value === cell.value) {
          conflictIndexes.add(index);
          conflictIndexes.add(boxIndex);
        }
      }
    }
  }

  return conflictIndexes;
}

function getConflictSummary(cells) {
  if (isVersusMode()) {
    return {
      conflictIndexes: new Set(),
      message: "",
    };
  }

  const conflictIndexes = getConflictIndexes(cells);

  if (conflictIndexes.size === 0) {
    return {
      conflictIndexes,
      message: "",
    };
  }

  return {
    conflictIndexes,
    message: "Duplicate digits detected. Each row, column, and 3x3 box must contain unique numbers.",
  };
}

function getDigitCounts(cells) {
  return cells.reduce((counts, cell) => {
    if (cell.value && !hasCellDuel(cell)) {
      counts[cell.value] = (counts[cell.value] || 0) + 1;
    }

    return counts;
  }, {});
}

function isDigitCompleted(digit, cells = getCurrentSession().cells) {
  if (isVersusMode()) {
    return false;
  }

  const counts = getDigitCounts(cells);
  return (counts[digit] || 0) >= 9;
}

function isBoardFilled(cells) {
  return cells.every((cell) => cell.value && !hasCellDuel(cell));
}

function updateFeedback(message, tone = "") {
  feedbackElement.textContent = message;
  feedbackElement.className = "game-feedback";

  if (tone) {
    feedbackElement.classList.add(tone);
  }
}

function openWinModal() {
  const session = getCurrentSession();
  const formattedTime = formatElapsedTime(getElapsedSeconds(session));

  if (winTitle && winCopy) {
    if (isVersusMode()) {
      const summary = getVersusScoreSummary(session);

      if (summary.winner === "tie") {
        winTitle.textContent = "Tie Game";
        winCopy.textContent = `Final score A ${summary.scores.A} : B ${summary.scores.B}.`;
      } else {
        winTitle.textContent = `Player ${summary.winner} Wins`;
        winCopy.textContent = `Final score A ${summary.scores.A} : B ${summary.scores.B}.`;
      }
    } else if (isRankedSoloMode()) {
      winTitle.textContent = "Ranked Clear";
      winCopy.textContent = session.rankedRank
        ? `Finished in ${formattedTime}. You are now #${session.rankedRank} on this puzzle leaderboard.`
        : hasRankedPlayerName()
          ? "Finished clean. Submitting your ranked time to the puzzle leaderboard..."
          : "Finished clean. Enter a player name to submit ranked times.";
    } else {
      winTitle.textContent = "Congratulations!";
      winCopy.textContent = "You filled the whole board without any duplicate conflicts.";
    }
  }

  winTime.textContent = `Time: ${formattedTime}`;
  syncTimerDisplay();
  winModal.classList.remove("hidden");
  winModal.setAttribute("aria-hidden", "false");
}

function closeWinModal() {
  winModal.classList.add("hidden");
  winModal.setAttribute("aria-hidden", "true");
}

function updateGameStateAfterBoardChange() {
  const session = getCurrentSession();
  const roundStarted = isCurrentRoundStarted(session);
  const { conflictIndexes, message } = getConflictSummary(session.cells);
  const boardFilled = isBoardFilled(session.cells);
  const previousHasWon = session.hasWon;

  if (!roundStarted) {
    if (session.hasWon) {
      state.feedback = isVersusMode()
        ? getVersusFinishMessage(session)
        : isRankedSoloMode()
          ? `Ranked clear in ${formatElapsedTime(getElapsedSeconds(session))}.`
          : `Board complete in ${formatElapsedTime(getElapsedSeconds(session))}.`;
      updateFeedback(state.feedback, "success");
    } else if (hasSessionProgress(session)) {
      state.feedback = isVersusMode()
        ? "Saved versus round loaded. Locked cells keep their score impact."
        : isRankedSoloMode()
          ? "Saved ranked run loaded. Your leaderboard entry will submit once you finish cleanly."
          : "Saved puzzle loaded. Switch back anytime to continue this board.";
      updateFeedback(state.feedback);
    } else {
      state.feedback = getPreStartFeedbackMessage();
      updateFeedback(state.feedback);
    }

    closeWinModal();
    syncTimerDisplay();
    return;
  }

  if (isVersusMode()) {
    if (session.isPaused) {
      session.hasWon = false;
      state.feedback = "Match paused. Resume to keep claiming cells.";
      updateFeedback(state.feedback);
      closeWinModal();
      syncTimerDisplay();

      if (previousHasWon !== session.hasWon) {
        saveState();
      }
      return;
    }

    const summary = getVersusScoreSummary(session);

    if (summary.claimedCount >= summary.totalClaimable) {
      finalizeSessionTimer(session);
      state.feedback = getVersusFinishMessage(session);
      updateFeedback(state.feedback, "success");
      syncTimerDisplay();

      if (!session.hasWon) {
        session.hasWon = true;
        saveState();
        openWinModal();
      }
      return;
    }

    session.hasWon = false;
    state.feedback = `Score A ${summary.scores.A} : B ${summary.scores.B}. ${summary.remainingCells} cells left to claim.`;
    updateFeedback(state.feedback);
    closeWinModal();
    syncTimerDisplay();

    if (previousHasWon !== session.hasWon) {
      saveState();
    }
    return;
  }

  if (session.isPaused) {
    session.hasWon = false;
    state.feedback = "Timer paused. Resume to continue solving.";
    updateFeedback(state.feedback);
    closeWinModal();
    syncTimerDisplay();

    if (previousHasWon !== session.hasWon) {
      saveState();
    }
    return;
  }

  if (conflictIndexes.size > 0) {
    session.hasWon = false;
    state.feedback = message;
    updateFeedback(state.feedback, "error");
    closeWinModal();

    if (previousHasWon !== session.hasWon) {
      saveState();
    }
    return;
  }

  if (boardFilled) {
    finalizeSessionTimer(session);
    state.feedback = isRankedSoloMode()
      ? `Ranked clear in ${formatElapsedTime(session.elapsedSeconds)}.`
      : `Board complete in ${formatElapsedTime(session.elapsedSeconds)}.`;
    updateFeedback(state.feedback, "success");
    syncTimerDisplay();

    if (!session.hasWon) {
      session.hasWon = true;
      saveState();
      openWinModal();

      if (isRankedSoloMode()) {
        void submitRankedLeaderboardResult(session);
      }
    }
    return;
  }

  session.hasWon = false;
  state.feedback = "No conflicts yet. Finish the board to trigger the win popup.";
  updateFeedback(state.feedback);
  closeWinModal();
  syncTimerDisplay();

  if (previousHasWon !== session.hasWon) {
    saveState();
  }
}

function renderControls() {
  const currentSession = getCurrentSession();
  const roundStarted = isCurrentRoundStarted(currentSession);
  const canConfigure = canConfigureCurrentRound(currentSession);
  const readySelection = !isSinglePlayerMode()
    ? getMultiplayerReadySelection(state.operator)
    : getCurrentSelection();
  const currentPlayerReady = state.operator ? isReadyForSelection(state.operator, readySelection) : false;
  const resumableSession = isResumableSession(currentSession);
  const versusSummary = isVersusMode() ? getVersusScoreSummary(currentSession) : null;
  const rankedMode = isRankedSoloMode();
  const multiplayerAutoStarting = !isSinglePlayerMode() && hasBothPlayersReady() && !roundStarted && !resumableSession;
  const canSwitchWaitingRoomToSolo = !isSinglePlayerMode()
    && !roundStarted
    && state.roomRoster.length < 2
    && hasPlayableSeat();

  difficultyControls.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.difficulty === state.difficulty);
  });

  roomControlGroup?.toggleAttribute("hidden", rankedMode);
  operatorGroup?.toggleAttribute("hidden", rankedMode);
  pageSwitcher?.toggleAttribute("hidden", rankedMode);

  if (operatorControls) {
    operatorControls.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", button.dataset.operator === state.operator);
    });
  }

  entryModeControls.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.entryMode === state.entryMode);
    button.disabled = isVersusMode() && button.dataset.entryMode !== "value";
  });

  if (statusDifficulty) {
    statusDifficulty.textContent = difficultyLabels[state.difficulty];
  }

  if (statusOperator) {
    statusOperator.textContent = getOperatorLabel();
  }

  if (statusEntryMode) {
    statusEntryMode.textContent = entryModeLabels[state.entryMode];
  }

  if (statusGame) {
    statusGame.textContent = getCurrentRoundStatus(currentSession);
  }
  newPuzzleButton.textContent = `New Puzzle ${state.puzzleIndexes[state.difficulty] + 1}/${getAvailablePuzzleCount(state.difficulty)}`;
  startGameButton.textContent = currentSession.hasWon
    ? !isSinglePlayerMode() && isCompletedAuthoritativeMultiplayerRound() && !state.gameStart.startedSessionKey && currentPlayerReady
      ? "Ready Locked"
      : "Next Round"
    : resumableSession
      ? "Resume"
    : roundStarted
      ? currentSession.isPaused
        ? "Resume"
        : "Pause"
        : multiplayerAutoStarting
          ? "Starting..."
        : !isSinglePlayerMode() && currentPlayerReady
          ? "Ready Locked"
          : !isSinglePlayerMode()
            ? "Ready"
            : "Start Game";
  startGameButton.setAttribute(
    "aria-label",
    (roundStarted || resumableSession) && !currentSession.hasWon
      ? currentSession.isPaused
        ? "Resume game"
        : "Pause game"
      : startGameButton.textContent,
  );
  startGameButton.setAttribute(
    "title",
    (roundStarted || resumableSession) && !currentSession.hasWon
      ? currentSession.isPaused
        ? "Resume game"
        : "Pause game"
      : startGameButton.textContent,
  );
  startGameButton.classList.toggle(
    "active",
    (currentPlayerReady && !roundStarted && !resumableSession && !multiplayerAutoStarting)
      || ((roundStarted || resumableSession) && currentSession.isPaused),
  );
  startGameButton.disabled = !hasPlayableSeat() || multiplayerAutoStarting || (isRankedSoloMode() && !hasRankedPlayerName());
  if (roomPlayerStatus) {
    roomPlayerStatus.textContent = rankedMode ? "1/1" : getRoomPlayerStatusMessage();
    roomPlayerStatus.classList.toggle("ready", !isSinglePlayerMode() && state.roomRoster.length >= 2 && hasPlayableSeat());
  }
  if (exitToModeSelectButton) {
    exitToModeSelectButton.textContent = canSwitchWaitingRoomToSolo ? "Switch to Solo" : "Exit";
    exitToModeSelectButton.setAttribute("title", exitToModeSelectButton.textContent);
  }
  if (topbarEyebrow) {
    topbarEyebrow.textContent = rankedMode ? "Discord Ranked Sudoku" : defaultTopbarEyebrowText;
  }
  if (topbarTitle) {
    topbarTitle.textContent = rankedMode ? "Ranked Solo" : defaultTopbarTitleText;
  }
  if (topbarSubtitle) {
    topbarSubtitle.textContent = rankedMode
      ? "Single-player time attack on the same exact puzzle. Enter your name, clear cleanly, and track your live rank."
      : defaultTopbarSubtitleText;
  }
  if (boardLegend) {
    boardLegend.replaceChildren();

    const legendItems = isSinglePlayerMode()
      ? [
        { dotClass: "dot-a", label: isRankedSoloMode() ? "Your entries" : "Your entries" },
        { dotClass: "dot-given", label: "Given digits" },
      ]
      : [
        { dotClass: "dot-a", label: "Player A" },
        { dotClass: "dot-b", label: "Player B" },
        { dotClass: "dot-given", label: "Given digits" },
      ];

    legendItems.forEach((item) => {
      const legendEntry = document.createElement("span");
      const legendDot = document.createElement("i");
      legendDot.className = `dot ${item.dotClass}`;
      legendDot.setAttribute("aria-hidden", "true");
      legendEntry.append(legendDot, item.label);
      boardLegend.appendChild(legendEntry);
    });
  }
  difficultyControls.querySelectorAll("button").forEach((button) => {
    button.disabled = !hasPlayableSeat() || !canConfigure;
  });
  newPuzzleButton.disabled = !hasPlayableSeat() || !canSwitchPuzzle(currentSession);
  updateSyncStatus(isRankedSoloMode() ? "Ranked" : isSinglePlayerMode() ? "Solo" : state.syncStatus);
  renderThemeControls();
  renderRankedPanel();
  syncTimerDisplay();
  helperText.textContent =
      isRankedSoloMode()
        ? !hasRankedPlayerName()
          ? "Enter your player name first. Ranked Solo saves your best clear time for this exact puzzle."
          : !roundStarted
          ? "Ranked Solo shows this exact puzzle's fastest 10 clears, plus your live time and current rank."
          : currentSession.isPaused
          ? "Timer paused. Resume to continue your ranked run."
          : state.entryMode === "note"
          ? "Notes mode stays available in ranked runs. Finish cleanly to submit your time."
          : "Finish the puzzle without conflicts to submit your best time to this puzzle leaderboard."
        : isSinglePlayerMode()
        ? !roundStarted
          ? "Single mode keeps this board local to you. Choose a difficulty and press Start Game when ready."
          : currentSession.isPaused
          ? "Timer paused. Press Resume to continue your solo run."
          : state.entryMode === "note"
          ? "Notes mode: select an empty cell, then tap multiple digits to add or remove small pencil marks."
          : "Select an empty cell to open small pencil digits inside the cell, or enter one final number with the keypad."
        : !hasPlayableSeat()
        ? !state.roomId
          ? "Open Room Lobby first, then auto-join, create, or enter a room before starting the board."
          : state.roomRoster.length >= 2
          ? "Room already has two players. You are watching as a spectator."
          : "Joining room... the first player becomes A, the second becomes B."
        : !roundStarted
        ? isVersusMode()
          ? "Both players need to confirm the same puzzle. Once a cell is claimed, it is locked for the rest of the match."
          : "Both players need to confirm the current difficulty and puzzle before the board unlocks and the timer begins."
        : currentSession.isPaused
        ? isVersusMode()
          ? "Match paused. Resume to keep claiming cells."
          : "Timer paused. Press Resume to continue playing."
        : isVersusMode() && isSelfFrozen()
        ? `Bomb hit. Your inputs unlock in ${getFreezeCountdownLabel(getSelfFreezeRemainingMs())}.`
        : isVersusMode()
        ? `Versus score A ${versusSummary?.scores.A ?? 0} : B ${versusSummary?.scores.B ?? 0}. ${versusSummary?.remainingCells ?? 0} cells remain.`
        : state.entryMode === "note"
        ? "Notes mode: select an empty cell, then tap multiple digits to add or remove small pencil marks."
        : "Select an empty cell to open small pencil digits inside the cell, or enter one final number with the keypad.";
}

function renderKeypad() {
  const session = getCurrentSession();
  const digitCounts = isVersusMode() ? {} : getDigitCounts(session.cells);
  const inputsLocked = !isSessionInteractive(session);
  let activeDigitChanged = false;

  if (state.activeDigit && (digitCounts[state.activeDigit] || 0) >= 9) {
    state.activeDigit = null;
    activeDigitChanged = true;
  }

  keypad.querySelectorAll("[data-value]").forEach((button) => {
    const count = digitCounts[button.dataset.value] || 0;
    const completed = count >= 9;

    button.classList.toggle("active", !completed && button.dataset.value === state.activeDigit);
    button.classList.toggle("completed", completed);
    button.disabled = completed || inputsLocked;
    button.setAttribute("aria-disabled", completed || inputsLocked ? "true" : "false");
  });

  const eraseButton = keypad.querySelector("[data-action=\"erase\"]");

  if (eraseButton) {
    const eraseDisabled = inputsLocked || isVersusMode();
    eraseButton.disabled = eraseDisabled;
    eraseButton.setAttribute("aria-disabled", eraseDisabled ? "true" : "false");
  }

  if (activeDigitChanged) {
    renderControls();
  }
}

function createCellContent(cell, index, options = {}) {
  const { activeDigitTone = null } = options;
  const content = document.createElement("div");
  content.className = "cell-content";
  const heartEffect = isAuthoritativeMultiplayerRoundActive() ? getActiveRoundEffect(index, "coop_heart") : null;
  const isSelectedEmpty = index === state.selectedIndex && !cell.value && !cell.given && !hasCellDuel(cell);

  if (hasCellDuel(cell)) {
    const duelValues = document.createElement("div");
    duelValues.className = "cell-duel-values";

    ["A", "B"].forEach((operator) => {
      if (!cell.duel?.[operator]) {
        return;
      }

      const duelValue = document.createElement("span");
      duelValue.className = "cell-duel-value";
      duelValue.textContent = cell.duel[operator];

      duelValue.classList.add(operator === "B" ? "player-b" : "player-a");

        if (cell.duel[operator] === state.activeDigit) {
          duelValue.classList.add("matched-digit");

          if (activeDigitTone) {
            duelValue.classList.add(activeDigitTone);
          }
        }

      duelValues.appendChild(duelValue);
    });

    content.appendChild(duelValues);
    return content;
  }

  if (cell.value) {
    const value = document.createElement("span");
    value.className = "cell-value";
    value.textContent = cell.value;

    if ((cell.harmonyAt && cell.harmonyDigit === cell.value) || (heartEffect && heartEffect.digit === cell.value)) {
      value.classList.add("harmony");
    }

    if (cell.owner === "A" || cell.owner === "B") {
      value.classList.add(cell.owner === "B" ? "player-b" : "player-a");
    }

    if (isVersusMode() && cell.claimCorrect === false) {
      value.classList.add("wrong-claim");
    }

    if (cell.value === state.activeDigit) {
      value.classList.add("matched-digit");

      if (activeDigitTone) {
        value.classList.add(activeDigitTone);
      }
    }

      if (cell.peerEdited) {
        value.classList.add("peer-edited");
      }

    content.appendChild(value);
    return content;
  }

  if (Object.keys(cell.notes).length === 0 && !isSelectedEmpty) {
    return content;
  }

  const notesGrid = document.createElement("div");
  notesGrid.className = "notes-grid";

  for (let digit = 1; digit <= 9; digit += 1) {
    const key = String(digit);
    const owner = cell.notes[key];
    const note = document.createElement("span");

    note.className = "note note-slot";
    note.dataset.noteDigit = key;
    note.textContent = owner ? key : isSelectedEmpty ? key : "";
    note.setAttribute("aria-label", `Note ${key}`);
    note.classList.toggle("filled", Boolean(owner));

    if (owner === "A" || owner === "B") {
      note.classList.add(owner === "B" ? "player-b" : "player-a");
    }

    notesGrid.appendChild(note);
  }

  content.appendChild(notesGrid);
  return content;
}

function renderBoard() {
  const session = getCurrentSession();
  const { conflictIndexes } = getConflictSummary(session.cells);
  const relatedIndexes =
    state.selectedIndex === null ? new Set() : getRelatedIndexes(state.selectedIndex);
  const matchedDigitIndexes = getMatchedDigitIndexes(session.cells);
  const activeDigitTone = getActiveDigitTone(session.cells);

  boardElement.innerHTML = "";

  session.cells.forEach((cell, index) => {
    const button = document.createElement("button");
    const row = Math.floor(index / 9);
    const col = index % 9;

    button.type = "button";
    button.className = "cell";
    button.dataset.index = String(index);
    button.dataset.row = String(row);
    button.dataset.col = String(col);
    button.setAttribute("aria-label", `Cell ${row + 1},${col + 1}`);

    if (cell.given) {
      button.classList.add("given");
    }

    if (cell.value && (cell.owner === "A" || cell.owner === "B")) {
      button.classList.add(cell.owner === "B" ? "player-b" : "player-a");
    }

    if (isVersusMode() && cell.claimCorrect === false) {
      button.classList.add("wrong-claim");
    }

    if (index === state.selectedIndex) {
      button.classList.add("selected");
    } else if (relatedIndexes.has(index)) {
      button.classList.add("related");
    }

      if (matchedDigitIndexes.has(index)) {
        button.classList.add("matched-digit-cell");
      }

    if (conflictIndexes.has(index)) {
      button.classList.add("conflict");
    }

    if (!isSessionInteractive(session)) {
      button.classList.add("paused");
      button.setAttribute("aria-disabled", "true");
    }

    if (hasCellDuel(cell)) {
      button.classList.add("dual-value");
    }

    if (state.explodingCells[getCellKey(index, session)]) {
      button.classList.add("exploding");
    }

    const heartEffect = isAuthoritativeMultiplayerRoundActive() ? getActiveRoundEffect(index, "coop_heart") : null;
    const clashEffect = isAuthoritativeMultiplayerRoundActive() ? getActiveRoundEffect(index, "coop_clash") : null;
    const versusContestEffect = isAuthoritativeMultiplayerRoundActive() ? getActiveRoundEffect(index, "versus_contest") : null;

      button.appendChild(createCellContent(cell, index, { activeDigitTone }));

    if (state.explodingCells[getCellKey(index, session)]) {
      const explosion = document.createElement("span");
      explosion.className = "cell-explosion";
      explosion.textContent = "💥";
      button.appendChild(explosion);
    }

    if (state.heartCelebrations[getCellKey(index, session)]) {
      const heart = document.createElement("span");
      heart.className = "cell-heart";
      heart.textContent = "💖";
      button.appendChild(heart);
    }

    if (heartEffect) {
      const heart = document.createElement("span");
      heart.className = "cell-heart";
      heart.textContent = "💖";
      button.appendChild(heart);
    }

    if (clashEffect) {
      const clash = document.createElement("span");
      clash.className = "cell-clash";
      clash.textContent = "⚡";
      button.appendChild(clash);
    }

    if (versusContestEffect) {
      const victory = document.createElement("span");
      victory.className = "cell-versus-peace";
      victory.textContent = "✌️";
      victory.setAttribute("aria-hidden", "true");
      button.appendChild(victory);

      const bomb = document.createElement("span");
      bomb.className = "cell-versus-bomb";
      bomb.textContent = "💣";
      bomb.setAttribute("aria-hidden", "true");
      button.appendChild(bomb);
    }

    boardElement.appendChild(button);
  });

  updateGameStateAfterBoardChange();
  renderKeypad();
}

function setEntryMode(mode) {
  if (isVersusMode() && mode !== "value") {
    return;
  }

  state.entryMode = mode;
  renderControls();
}

function setActiveDigit(digit) {
  state.activeDigit = digit;
  renderKeypad();
  renderBoard();
}

function updateCellValue(index, nextValue) {
  syncSharedStateFromStorage();

  if (isAuthoritativeMultiplayerRoundActive()) {
    void submitAuthoritativeCellChange(index, {
      action: nextValue ? "set" : "clear",
      digit: nextValue,
    }).catch((error) => {
      state.feedback = error.message || "Failed to submit cell.";
      updateFeedback(state.feedback);
    });
    return;
  }

  const session = getCurrentSession();
  const cell = session.cells[index];
  const now = Date.now();

  if (!cell || cell.given) {
    return;
  }

  if (isVersusMode()) {
    if (!nextValue || isFilledClaimCell(cell) || hasCellDuel(cell)) {
      return;
    }

    const solution = getPuzzleSolution(session.difficulty, session.puzzleId);
    const isCorrect = solution[index] === nextValue;
    cell.value = nextValue;
    cell.owner = state.operator;
    cell.peerEdited = false;
    cell.claimCorrect = isCorrect;
    cell.duel = null;
    cell.harmonyAt = null;
    cell.harmonyDigit = null;
    cell.lastMoveAt = now;
    cell.lastMoveBy = state.operator;
    cell.notes = {};

    saveState();
    renderBoard();
    return;
  }

  if (!nextValue) {
    cell.value = "";
    cell.owner = null;
    cell.peerEdited = false;
    cell.claimCorrect = null;
    cell.duel = null;
    cell.harmonyAt = null;
    cell.harmonyDigit = null;
    cell.lastMoveAt = now;
    cell.lastMoveBy = state.operator;
  } else {
    const currentOwner = getSingleValueOwner(cell);
    const wasPeerEdited =
      currentOwner &&
      currentOwner !== state.operator &&
      cell.value &&
      cell.value !== nextValue;
    const isRecentForeignMove =
      currentOwner &&
      currentOwner !== state.operator &&
      cell.lastMoveAt &&
      now - cell.lastMoveAt <= SIMULTANEOUS_INPUT_WINDOW_MS;

    if (isRecentForeignMove && cell.value !== nextValue) {
      cell.duel = {
        [currentOwner]: cell.value,
        [state.operator]: nextValue,
      };
      cell.value = "";
      cell.owner = null;
      cell.peerEdited = false;
      cell.claimCorrect = null;
      cell.notes = {};
      cell.harmonyAt = null;
      cell.harmonyDigit = null;
      cell.lastMoveAt = now;
      cell.lastMoveBy = state.operator;
      clearPeerNotesForDigit(session.cells, index, cell.duel[currentOwner]);
      clearPeerNotesForDigit(session.cells, index, nextValue);
    } else if (isRecentForeignMove && cell.value === nextValue) {
      const delta = Math.max(0, now - cell.lastMoveAt);

      if (delta <= HEART_TIE_WINDOW_MS) {
        cell.value = nextValue;
        cell.owner = null;
        cell.peerEdited = false;
        cell.claimCorrect = null;
        cell.duel = null;
        cell.notes = {};
        cell.harmonyAt = now;
        cell.harmonyDigit = nextValue;
        cell.lastMoveAt = now;
        cell.lastMoveBy = state.operator;
        clearPeerNotesForDigit(session.cells, index, nextValue);
        triggerCellHeart(index, session, now);
      } else {
        triggerCellExplosion(index, session);
        renderBoard();
        return;
      }
    } else {
      cell.value = nextValue;
      cell.owner = state.operator;
      cell.peerEdited = Boolean(wasPeerEdited);
      cell.claimCorrect = null;
      cell.duel = null;
      cell.harmonyAt = null;
      cell.harmonyDigit = null;
      cell.lastMoveAt = now;
      cell.lastMoveBy = state.operator;
      cell.notes = {};
      clearPeerNotesForDigit(session.cells, index, nextValue);
    }
  }

  saveState();
  renderBoard();
}

function toggleCellNote(index, digit) {
  syncSharedStateFromStorage();

  if (isAuthoritativeMultiplayerRoundActive()) {
    void submitAuthoritativeCellChange(index, {
      action: "note_toggle",
      digit,
    }).catch((error) => {
      state.feedback = error.message || "Failed to update notes.";
      updateFeedback(state.feedback);
    });
    return;
  }

  const session = getCurrentSession();
  const cell = session.cells[index];

  if (isVersusMode() || !cell || cell.given || cell.value || hasCellDuel(cell)) {
    return;
  }

  if (cell.notes[digit]) {
    delete cell.notes[digit];
  } else {
    cell.notes[digit] = state.operator;
  }

  saveState();
  renderBoard();
}

function clearCell(index) {
  syncSharedStateFromStorage();

  if (isAuthoritativeMultiplayerRoundActive()) {
    if (isVersusMode()) {
      return;
    }

    void submitAuthoritativeCellChange(index, {
      action: "clear",
    }).catch((error) => {
      state.feedback = error.message || "Failed to clear cell.";
      updateFeedback(state.feedback);
    });
    return;
  }

  const session = getCurrentSession();
  const cell = session.cells[index];

  if (isVersusMode() || !cell || cell.given) {
    return;
  }

  if (cell.value) {
    cell.value = "";
    cell.owner = null;
    cell.peerEdited = false;
    cell.claimCorrect = null;
  } else if (hasCellDuel(cell)) {
    cell.duel = null;
  } else {
    cell.notes = {};
  }

  cell.harmonyAt = null;
  cell.harmonyDigit = null;
  cell.lastMoveAt = Date.now();
  cell.lastMoveBy = state.operator;

  saveState();
  renderBoard();
}

function applyDigitInput(digit) {
  syncSharedStateFromStorage();

  if (isDigitCompleted(digit)) {
    return;
  }

  setActiveDigit(digit);

  if (state.selectedIndex === null) {
    return;
  }

  const session = getCurrentSession();
  const cell = session.cells[state.selectedIndex];

  if (!cell || cell.given || (isVersusMode() && isFilledClaimCell(cell))) {
    return;
  }

  if (state.entryMode === "note" && !cell.value) {
    toggleCellNote(state.selectedIndex, digit);
    return;
  }

  updateCellValue(state.selectedIndex, digit);
}

function handleBoardClick(event) {
  if (!isSessionInteractive()) {
    return;
  }

  const noteTarget = event.target.closest(".note-slot");

  if (noteTarget) {
    const cellTarget = noteTarget.closest(".cell");

    if (!cellTarget) {
      return;
    }

    const index = Number(cellTarget.dataset.index);
    const session = getCurrentSession();
    const cell = session.cells[index];

    if (!cell || cell.given || cell.value) {
      return;
    }

    state.selectedIndex = index;
    toggleCellNote(index, noteTarget.dataset.noteDigit);
    return;
  }

  const target = event.target.closest(".cell");

  if (!target) {
    return;
  }

  state.selectedIndex = Number(target.dataset.index);

  const cell = getCurrentSession().cells[state.selectedIndex];

  if (cell.value) {
    state.activeDigit = cell.value;
  }

  renderKeypad();
  renderBoard();
}

function handleDifficultyClick(event) {
  if (!hasPlayableSeat()) {
    return;
  }

  const currentSession = getCurrentSession();
  const button = event.target.closest("[data-difficulty]");

  if (!button) {
    return;
  }

  if (!canSwitchPuzzle(currentSession)) {
    return;
  }

  state.difficulty = button.dataset.difficulty;
  state.selectedIndex = null;
  state.activeDigit = null;
  ensureSession(state.difficulty);
  saveState();
  updateGameStateAfterBoardChange();
  if (isRankedSoloMode()) {
    void refreshRankedLeaderboard({ force: true });
  }
  renderControls();
  renderKeypad();
  renderBoard();
}

function handleNewPuzzleClick() {
  if (!hasPlayableSeat()) {
    return;
  }

  const currentSession = getCurrentSession();

  if (!canSwitchPuzzle(currentSession)) {
    return;
  }

  const puzzles = getDailyPuzzleConfigs(state.difficulty);
  const currentIndex = state.puzzleIndexes[state.difficulty] ?? 0;

  state.puzzleIndexes[state.difficulty] = (currentIndex + 1) % puzzles.length;
  state.selectedIndex = null;
  state.activeDigit = null;
  ensureSession(state.difficulty);
  saveState();
  updateGameStateAfterBoardChange();
  if (isRankedSoloMode()) {
    void refreshRankedLeaderboard({ force: true });
  }
  renderControls();
  renderKeypad();
  renderBoard();
}

async function handleStartGameClick() {
  if (!hasPlayableSeat() || !state.operator) {
    return;
  }

  if (isRankedSoloMode() && !hasRankedPlayerName()) {
    openRankedProfileModal();
    return;
  }

  let currentSession = getCurrentSession();
  const shouldAdvanceToNextRound = currentSession.hasWon;
  const shouldResumeSavedSession = isResumableSession(currentSession) && !isCurrentRoundStarted(currentSession);

  if (isCurrentRoundStarted(currentSession) && !currentSession.hasWon) {
    toggleTimerPause();
    return;
  }

  if (shouldAdvanceToNextRound && isCompletedAuthoritativeMultiplayerRound() && !isSinglePlayerMode()) {
    await refreshRoomSnapshot();
    currentSession = getCurrentSession();

    if (!isCompletedAuthoritativeMultiplayerRound()) {
      renderControls();
      renderKeypad();
      renderBoard();
      return;
    }

    if (!hasBothPlayersJoined()) {
      state.feedback = "Both players need to be in the room before the next round can be readied.";
      updateFeedback(state.feedback);
      renderControls();
      return;
    }

    const selection = getMultiplayerReadySelection(state.operator);

    if (!selection) {
      state.feedback = "No next-round puzzle is available right now.";
      updateFeedback(state.feedback, "error");
      renderControls();
      return;
    }

    state.selectedIndex = null;
    state.activeDigit = null;

    if (!isReadyForSelection(state.operator, selection)) {
      await updateRoomReadySelection(selection);
      if (isAuthoritativeMultiplayerRoundActive() || isCurrentRoundStarted(getCurrentSession())) {
        renderControls();
        renderKeypad();
        renderBoard();
        return;
      }

      state.feedback = isVersusMode()
        ? "Next round ready locked. Waiting for the other player to confirm the same puzzle before the match starts."
        : "Next round ready locked. Waiting for the other player to confirm the same puzzle.";
      updateFeedback(state.feedback);
      renderControls();
      renderKeypad();
      renderBoard();
      return;
    }

    if (getReadyCountForSelection(selection) < 2) {
      await updateRoomReadySelection(null);
      state.feedback = "Next round ready cleared. Pick your puzzle and press Ready again when both players agree.";
      updateFeedback(state.feedback);
      renderControls();
      renderKeypad();
      renderBoard();
      return;
    }

    state.feedback = "Both players are locked in. Waiting for the server to start the next round...";
    updateFeedback(state.feedback);
    renderControls();
    renderKeypad();
    renderBoard();
    return;
  }

  if (shouldAdvanceToNextRound) {
    const puzzles = getDailyPuzzleConfigs(state.difficulty);
    const currentIndex = state.puzzleIndexes[state.difficulty] ?? 0;
    state.puzzleIndexes[state.difficulty] = (currentIndex + 1) % puzzles.length;
    state.selectedIndex = null;
    state.activeDigit = null;
    resetCurrentRoundGate();
    const nextSelection = getCurrentSelection();
    state.sessions[nextSelection.sessionKey] = createSession(nextSelection.difficulty);
    currentSession = state.sessions[nextSelection.sessionKey];
  }

  if (shouldResumeSavedSession) {
    currentSession.timerStartedAt = Date.now();
    currentSession.isPaused = false;
    state.gameStart.startedSessionKey = getSessionKey(currentSession.difficulty, currentSession.puzzleId);
    state.feedback = isVersusMode()
      ? "Saved versus match resumed."
      : isRankedSoloMode()
        ? "Saved ranked run resumed."
        : "Saved puzzle resumed.";
    updateFeedback(state.feedback);
    saveState();
    updateGameStateAfterBoardChange();
    renderControls();
    renderKeypad();
    renderBoard();
    return;
  }

  if (isSinglePlayerMode()) {
    const selection = getCurrentSelection();

    state.gameStart.readyBy.A = selection;
    state.gameStart.readyBy.B = null;
    state.selectedIndex = null;
    state.activeDigit = null;
    state.sessions[selection.sessionKey] = createSession(selection.difficulty);
    state.sessions[selection.sessionKey].timerStartedAt = Date.now();
    state.gameStart.startedSessionKey = selection.sessionKey;
    state.feedback = isRankedSoloMode()
      ? `Ranked run started on ${difficultyLabels[selection.difficulty]} puzzle ${selection.puzzleIndex + 1}.`
      : `Solo round started on ${difficultyLabels[selection.difficulty]} puzzle ${selection.puzzleIndex + 1}.`;
    updateFeedback(state.feedback);
    saveState();
    if (isRankedSoloMode()) {
      void refreshRankedLeaderboard({ force: true });
    }
    updateGameStateAfterBoardChange();
    renderControls();
    renderKeypad();
    renderBoard();
    return;
  }

  await refreshRoomSnapshot();
  currentSession = getCurrentSession();

  if (isCurrentRoundStarted(currentSession) && !currentSession.hasWon) {
    renderControls();
    renderKeypad();
    renderBoard();
    return;
  }

  if (!hasBothPlayersJoined()) {
    state.feedback = state.roomId
      ? "Both Player A and Player B need to be in the room before the game can start."
      : isVersusMode()
        ? "Open Room Lobby first and join a versus room before starting."
        : "Open Room Lobby first and join a co-op room before starting.";
    updateFeedback(state.feedback);
    renderControls();
    return;
  }

  const selection = getCurrentSelection();
  state.selectedIndex = null;
  state.activeDigit = null;

  if (!isReadyForCurrentSelection(state.operator)) {
    await updateRoomReadySelection(selection);
    if (isAuthoritativeMultiplayerRoundActive() || isCurrentRoundStarted(getCurrentSession())) {
      renderControls();
      renderKeypad();
      renderBoard();
      return;
    }

    state.feedback = isVersusMode()
      ? "Ready locked. Waiting for the other player to confirm the same puzzle before the match starts."
      : "Ready locked. Waiting for the other player to confirm the same puzzle.";
    updateFeedback(state.feedback);
    renderControls();
    renderKeypad();
    renderBoard();
    return;
  }

  if (!hasBothPlayersReady()) {
    await updateRoomReadySelection(null);
    state.feedback = "Ready cleared. Pick your puzzle and press Ready again when both players agree.";
    updateFeedback(state.feedback);
    renderControls();
    renderKeypad();
    renderBoard();
    return;
  }

    state.feedback = "Both players are locked in. Waiting for the server to start the round...";
  updateFeedback(state.feedback);
  renderControls();
  renderKeypad();
  renderBoard();
}

function handleOperatorClick(event) {
  event.preventDefault();
}

function handleThemeClick(event) {
  if (!themeControls) {
    return;
  }

  const button = event.target.closest("[data-theme]");

  if (!button) {
    return;
  }

  applyVipTheme(button.dataset.theme);
  writePreferredVipTheme(state.vipTheme);
  renderControls();
  renderBoard();
}

function handleStorageSync(event) {
  if (!isSinglePlayerMode()) {
    return;
  }

  if (event.key !== getActiveStateStorageKey()) {
    return;
  }

  const previousEntryMode = state.entryMode;

  loadState();
  updateRoomAssignment();
  syncHarmonyEffects();
  state.entryMode = previousEntryMode;
  state.selectedIndex = null;
  state.activeDigit = null;
  renderControls();
  renderKeypad();
  renderBoard();

  if (isRankedSoloMode()) {
    void refreshRankedLeaderboard({ force: true });
  }
}

function toggleTimerPause() {
  if (!hasPlayableSeat()) {
    return;
  }

  const session = getCurrentSession();

  if (!isCurrentRoundStarted(session) || session.hasWon) {
    return;
  }

  if (session.isPaused) {
    session.isPaused = false;
    session.timerStartedAt = Date.now();
  } else {
    session.elapsedSeconds = getElapsedSeconds(session);
    session.timerStartedAt = null;
    session.isPaused = true;
    state.selectedIndex = null;
    state.activeDigit = null;
  }

  saveState();
  updateGameStateAfterBoardChange();
  renderControls();
  renderKeypad();
  renderBoard();
}

function handleEntryModeClick(event) {
  const button = event.target.closest("[data-entry-mode]");

  if (!button) {
    return;
  }

  setEntryMode(button.dataset.entryMode);
}

function handleKeypadClick(event) {
  if (!isSessionInteractive()) {
    return;
  }

  const button = event.target.closest(".keypad-button");

  if (!button) {
    return;
  }

  if (button.dataset.action === "erase") {
    if (state.selectedIndex !== null) {
      clearCell(state.selectedIndex);
    }
    return;
  }

  const value = button.dataset.value;

  if (!value) {
    return;
  }

  applyDigitInput(value);
}

function handleKeyboardInput(event) {
  if (event.code === "Space" && !event.repeat) {
    event.preventDefault();
    toggleTimerPause();
    return;
  }

  if (!isSessionInteractive()) {
    if (event.key === "Escape") {
      state.activeDigit = null;
      renderKeypad();
      renderBoard();
    }
    return;
  }

  if (!isVersusMode() && event.shiftKey && /^[1-9]$/.test(event.key) && state.selectedIndex !== null) {
    const session = getCurrentSession();
    const cell = session.cells[state.selectedIndex];

    if (cell && !cell.given && !cell.value) {
      toggleCellNote(state.selectedIndex, event.key);
    }
    return;
  }

  if (/^[1-9]$/.test(event.key)) {
    applyDigitInput(event.key);
    return;
  }

  if (event.key === "Backspace" || event.key === "Delete" || event.key === "0") {
    if (state.selectedIndex !== null) {
      clearCell(state.selectedIndex);
    }
    return;
  }

  if (!isVersusMode() && event.key.toLowerCase() === "n") {
    setEntryMode(state.entryMode === "value" ? "note" : "value");
    return;
  }

  if (event.key === "Escape") {
    state.activeDigit = null;
    renderKeypad();
    renderBoard();
  }
}

function handleWinModalClose() {
  closeWinModal();
}

function handleWinModalClick(event) {
  if (event.target === winModal) {
    closeWinModal();
  }
}

function handleRankedChangeNameClick() {
  openRankedProfileModal();
}

function handleRankedProfileCancelClick() {
  closeRankedProfileModal();

  if (!hasRankedPlayerName() && isRankedSoloMode()) {
    resetRoomStateForModeSelection();
  }
}

function handleRankedProfileSaveClick() {
  const nextName = sanitizeRankedPlayerName(rankedPlayerNameInput?.value || "");

  if (!nextName) {
    state.ranked.status = "Enter your name before starting a ranked run.";
    renderRankedPanel();
    rankedPlayerNameInput?.focus();
    return;
  }

  state.ranked.playerName = nextName;
  state.ranked.playerEntry = null;
  state.ranked.playerRank = null;
  state.ranked.totalEntries = 0;
  state.ranked.liveElapsedSeconds = null;
  writeStoredRankedPlayerName(nextName);
  closeRankedProfileModal();
  renderControls();
  void refreshRankedLeaderboard({ force: true });
}

function handleRankedProfileModalClick(event) {
  if (event.target === rankedProfileModal) {
    handleRankedProfileCancelClick();
  }
}

function handleControlsPanelClick(event) {
  if (event.target === controlDrawerBackdrop) {
    closeControlsDrawer();
  }
}

function handleRoomHubClick(event) {
  if (event.target === roomHubModal) {
    closeRoomHubModal();
  }
}

async function runRoomAction(action) {
  try {
    state.lastRoomError = "";
    renderRoomHub();
    await action();
    renderRoomHub();
  } catch (error) {
    state.lastRoomError = error.message || "Room action failed.";
    updateSyncStatus("Offline");
    renderRoomHub();
  }
}

function handleOpenRoomHubClick() {
  state.roomCreateLinkReady = false;
  setRoomHubView("entry");
  openRoomHubModal();
  renderRoomHub();
}

async function handleCopyRoomLinkClick() {
  await runRoomAction(async () => {
    await copyInviteLink();
    state.lastRoomError = "Invite link copied.";
  });
}

function handleRoomHubBackClick() {
  state.roomCreateLinkReady = false;
  setRoomHubView("entry");
  renderRoomHub();
}

function handleRoomHubEnterJoinClick() {
  state.lastRoomError = "";
  state.roomCreateLinkReady = false;
  setRoomHubView("join");
  renderRoomHub();
}

function handleRoomHubEnterCreateClick() {
  state.lastRoomError = "";
  state.roomCreateLinkReady = false;
  setRoomHubView("create");
  renderRoomHub();
}

function handleRoomJoinAutoClick() {
  void runRoomAction(async () => {
    if (isDiscordVoiceChannelContext()) {
      await joinDiscordAutoRoom();
    } else {
      await quickMatchRoom();
    }

    if (routeRoomEntryToLobby()) {
      return;
    }

    closeRoomHubModal();
  });
}

function handleRoomJoinByCodeClick() {
  void runRoomAction(async () => {
    const roomCode = String(roomJoinCodeInput?.value || "").trim();
    const password = String(roomJoinPasswordInput?.value || "").trim();

    if (!roomCode) {
      throw new Error("Room name is required.");
    }

    if (!isValidManualRoomName(roomCode)) {
      throw new Error("Room name is invalid. Use letters and numbers, like 7, a7, or b12.");
    }

    await joinManualRoomByCode(roomCode, password);

    if (routeRoomEntryToLobby()) {
      return;
    }

    closeRoomHubModal();
  });
}

function handleRoomJoinByLinkClick() {
  void runRoomAction(async () => {
    const inviteLink = String(roomJoinLinkInput?.value || "").trim();
    const invite = parseInviteLink(inviteLink);
    roomJoinCodeInput.value = invite.roomCode;
    roomJoinPasswordInput.value = invite.password;
    await joinManualRoomByCode(invite.roomCode, invite.password);

    if (routeRoomEntryToLobby()) {
      return;
    }

    closeRoomHubModal();
  });
}

function handleRoomCreateClick() {
  void runRoomAction(async () => {
    state.roomCreateLinkReady = false;
    const roomName = String(roomCreateNameInput?.value || "").trim();

    if (!roomName) {
      throw new Error("Room name is required. Use letters and numbers, like 7, a7, or b12.");
    }

    if (!isValidManualRoomName(roomName)) {
      throw new Error("Room name is invalid. Use letters and numbers, like 7, a7, or b12.");
    }

    await createManualRoom({
      source: state.runtime.kind === "discord" ? "discord" : "web",
      kind: "manual",
      roomName,
      password: roomCreatePasswordInput?.value || "",
    });

    if (routeRoomEntryToLobby()) {
      return;
    }

    closeRoomHubModal();
  });
}

function handleRoomCreateLinkClick() {
  void runRoomAction(async () => {
    await createManualRoom({
      source: state.runtime.kind === "discord" ? "discord" : "web",
      kind: "manual",
      roomName: "",
      autoRoomName: true,
      password: "",
    });
    state.lastRoomError = "";
    state.roomCreateLinkReady = true;
    setRoomHubView("create");
    renderRoomHub();
  });
}

function handleEnterCreatedRoomClick() {
  state.roomCreateLinkReady = false;
  state.lastRoomError = "";

  if (routeRoomEntryToLobby()) {
    return;
  }

  closeRoomHubModal();
  renderRoomHub();
}

function releaseRoomSeatOnUnload() {
  if (!state.roomId || !isRoomMultiplayerMode()) {
    return;
  }

  roomReconnectPending = false;

  if (roomSocket) {
    roomSocket.disconnect();
  }
}

async function leaveCurrentRoom() {
  if (!state.roomId || !isRoomMultiplayerMode()) {
    return;
  }

  await roomSocketRequest("room:leave");
}

function resetRoomStateForModeSelection() {
  disconnectRoomEventStream();
  stopRoomHeartbeat();
  resetCurrentRoundGate();
  resetCurrentSelectionSession();
  state.gameMode = null;
  state.roomProtocolVersion = 0;
  state.roomId = "";
  state.roomCode = "";
  state.roomName = "";
  state.roomType = "";
  state.roomSource = "";
  state.roomInviteUrl = "";
  state.roomCreateLinkReady = false;
  state.roomPassword = "";
  state.roomJoinMode = "";
  state.lastRoomError = "";
  state.roomHubView = "entry";
  state.roomRoster = [];
  state.roomSeats = normalizeRoomSeats();
  resetActiveRoundState();
  state.operator = null;
  state.selectedIndex = null;
  state.activeDigit = null;
  sharedRevision = 0;
  roomCellRequestSeq = 0;
  clearStoredGameMode();
  writeStoredOperator(null);
  removeSessionValue(ROOM_CONTEXT_KEY);
  removeSessionValue(ROOM_NAV_INTENT_KEY);
  closeRoomHubModal();
  closeRankedProfileModal();
  closeControlsDrawer();
  saveState();
  updateSyncStatus("Choose Mode");
  syncPageLinksWithRoom();
  syncCurrentUrlWithRoom();
  updateGameStateAfterBoardChange();
  renderControls();
  renderRoomHub();
  renderKeypad();
  renderBoard();
  openModeSelectModal();
}

function handleExitToModeSelectClick() {
  void (async () => {
    try {
      await leaveCurrentRoom();
    } catch (error) {
      console.warn("Failed to leave current room before exiting.", error);
    }

    if (isRoomMultiplayerMode() && !isCurrentRoundStarted() && state.roomRoster.length < 2 && hasPlayableSeat()) {
      disconnectRoomEventStream();
      stopRoomHeartbeat();
      resetCurrentRoundGate();
      sharedRevision = 0;
      state.roomId = "";
      state.roomCode = "";
      state.roomName = "";
      state.roomType = "";
      state.roomSource = "";
      state.roomInviteUrl = "";
      state.roomCreateLinkReady = false;
      state.roomPassword = "";
      state.roomJoinMode = "";
      state.lastRoomError = "";
      state.roomHubView = "entry";
      state.roomRoster = [];
      state.roomSeats = normalizeRoomSeats();
      state.operator = null;
      removeSessionValue(ROOM_CONTEXT_KEY);
      removeSessionValue(ROOM_NAV_INTENT_KEY);
      closeRoomHubModal();
      closeRankedProfileModal();
      closeControlsDrawer();
      state.gameMode = "single";
      writeStoredGameMode("single");
      updateSyncStatus("Solo");
      updateRoomAssignment();
      syncPageLinksWithRoom();
      syncCurrentUrlWithRoom();
      startSinglePlayerRound(getCurrentSelection(), {
        feedback: `Switched to Solo. Round started on ${difficultyLabels[state.difficulty]} puzzle ${state.puzzleIndexes[state.difficulty] + 1}.`,
      });
      return;
    }

    resetRoomStateForModeSelection();
  })();
}

function handlePageLinkClick(event) {
  const link = event.currentTarget;

  if (!(link instanceof HTMLAnchorElement)) {
    return;
  }

  if (
    event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
  ) {
    return;
  }

  persistPendingRoomNavigation(link.href);
}

function bootstrap() {
  updateSyncStatus(isRankedSoloMode() ? "Ranked" : isSinglePlayerMode() ? "Solo" : "Choose Room");
  loadState();
  updateRoomAssignment();
  loadVipThemePreference();
  ensureSession("easy");
  ensureSession("medium");
  ensureSession("hard");
  syncPageLinksWithRoom();

  if (operatorGroup) {
    operatorGroup.classList.add("hidden");
  }

  updateGameStateAfterBoardChange();
  renderControls();
  renderRoomHub();
  renderKeypad();
  renderBoard();
  if (isRankedSoloMode()) {
    void refreshRankedLeaderboard({ force: true });
  }
  timerIntervalId = window.setInterval(syncTimerDisplay, 1000);

  boardElement.addEventListener("click", handleBoardClick);
  controlDrawerToggle?.addEventListener("click", toggleControlsDrawer);
  controlDrawerBackdrop?.addEventListener("click", handleControlsPanelClick);
  difficultyControls.addEventListener("click", handleDifficultyClick);
  operatorControls.addEventListener("click", handleOperatorClick);
  entryModeControls.addEventListener("click", handleEntryModeClick);
  themeControls?.addEventListener("click", handleThemeClick);
  keypad.addEventListener("click", handleKeypadClick);
  window.addEventListener("keydown", handleKeyboardInput);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.dataset.controlsOpen === "true") {
      closeControlsDrawer();
    }
  });
  window.addEventListener("storage", handleStorageSync);
  window.addEventListener("visibilitychange", () => {
    if (isRoomMultiplayerMode() && document.visibilityState === "visible") {
      void heartbeatRoom();
    }
  });
  window.addEventListener("beforeunload", releaseRoomSeatOnUnload);
  closeWinModalButton.addEventListener("click", handleWinModalClose);
  winModal.addEventListener("click", handleWinModalClick);
  rankedProfileModal?.addEventListener("click", handleRankedProfileModalClick);
  roomHubModal?.addEventListener("click", handleRoomHubClick);
  openRoomHubButton?.addEventListener("click", handleOpenRoomHubClick);
  roomHubBackButton?.addEventListener("click", handleRoomHubBackClick);
  copyRoomLinkButton?.addEventListener("click", () => {
    void handleCopyRoomLinkClick();
  });
  copyRoomLinkInlineButton?.addEventListener("click", () => {
    void handleCopyRoomLinkClick();
  });
  roomHubEnterJoinButton?.addEventListener("click", handleRoomHubEnterJoinClick);
  roomHubEnterCreateButton?.addEventListener("click", handleRoomHubEnterCreateClick);
  roomJoinAutoButton?.addEventListener("click", handleRoomJoinAutoClick);
  roomJoinByCodeButton?.addEventListener("click", handleRoomJoinByCodeClick);
  roomJoinByLinkButton?.addEventListener("click", handleRoomJoinByLinkClick);
  roomCreateButton?.addEventListener("click", handleRoomCreateClick);
  roomCreateLinkButton?.addEventListener("click", handleRoomCreateLinkClick);
  enterCreatedRoomButton?.addEventListener("click", handleEnterCreatedRoomClick);
  exitToModeSelectButton?.addEventListener("click", handleExitToModeSelectClick);
  rankedChangeNameButton?.addEventListener("click", handleRankedChangeNameClick);
  rankedProfileCancelButton?.addEventListener("click", handleRankedProfileCancelClick);
  rankedProfileSaveButton?.addEventListener("click", handleRankedProfileSaveClick);
  rankedPlayerNameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleRankedProfileSaveClick();
    }
  });
  pageLinkButtons.forEach((link) => {
    link.addEventListener("click", handlePageLinkClick);
  });
  newPuzzleButton.addEventListener("click", handleNewPuzzleClick);
  startGameButton.addEventListener("click", handleStartGameClick);
  setControlsDrawerOpen(false);
}

modeOptionButtons.forEach((button) => {
  button.addEventListener("click", handleModeOptionClick);
});

if (!guardVipEntry()) {
  initRuntimeEnvironment();
}
