const crypto = require("node:crypto");
const https = require("node:https");

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1541798952150499349";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_ACTIVITY_SESSION_SECRET = process.env.DISCORD_ACTIVITY_SESSION_SECRET || DISCORD_CLIENT_SECRET || "";
const DISCORD_API_HOSTNAME = "discord.com";
const DISCORD_API_VERSION_PREFIX = "/api/v10";
const SESSION_TTL_MS = Math.max(60_000, Number(process.env.DISCORD_ACTIVITY_SESSION_TTL_MS) || 15 * 60 * 1000);

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function createSignature(value, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(value)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function getDiscordAuthConfiguration() {
  return {
    clientId: DISCORD_CLIENT_ID,
    clientSecretConfigured: Boolean(DISCORD_CLIENT_SECRET),
    sessionSecretConfigured: Boolean(DISCORD_ACTIVITY_SESSION_SECRET),
  };
}

function assertDiscordAuthConfigured() {
  const configuration = getDiscordAuthConfiguration();

  if (!configuration.clientSecretConfigured) {
    throw new Error("Discord identity verification is not configured. Add DISCORD_CLIENT_SECRET in the server environment.");
  }

  if (!configuration.sessionSecretConfigured) {
    throw new Error("Discord identity verification is not configured. Add DISCORD_ACTIVITY_SESSION_SECRET in the server environment.");
  }
}

function sanitizeDiscordUser(user) {
  const id = String(user?.id || "").trim();

  if (!/^\d{5,32}$/.test(id)) {
    throw new Error("Discord user payload is missing a valid id.");
  }

  const username = String(user?.username || "").trim().slice(0, 64);
  const globalName = String(user?.global_name || "").trim().slice(0, 64);
  const avatar = String(user?.avatar || "").trim();

  return {
    id,
    username,
    globalName,
    displayName: globalName || username || `Discord ${id.slice(-4)}`,
    avatarUrl: avatar ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=128` : "",
  };
}

function createDiscordActivitySessionToken(user) {
  assertDiscordAuthConfigured();

  const safeUser = sanitizeDiscordUser(user);
  const now = Date.now();
  const payload = {
    provider: "discord",
    userId: safeUser.id,
    username: safeUser.username,
    globalName: safeUser.globalName,
    displayName: safeUser.displayName,
    avatarUrl: safeUser.avatarUrl,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createSignature(encodedPayload, DISCORD_ACTIVITY_SESSION_SECRET);

  return {
    token: `${encodedPayload}.${signature}`,
    expiresAt: payload.expiresAt,
    user: safeUser,
  };
}

function verifyDiscordActivitySessionToken(token) {
  assertDiscordAuthConfigured();

  const normalizedToken = String(token || "").trim();
  const parts = normalizedToken.split(".");

  if (parts.length !== 2) {
    throw new Error("Discord session token is invalid.");
  }

  const [encodedPayload, signature] = parts;
  const expectedSignature = createSignature(encodedPayload, DISCORD_ACTIVITY_SESSION_SECRET);
  const providedSignature = Buffer.from(signature);
  const trustedSignature = Buffer.from(expectedSignature);

  if (
    providedSignature.length !== trustedSignature.length
    || !crypto.timingSafeEqual(providedSignature, trustedSignature)
  ) {
    throw new Error("Discord session token is invalid.");
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload));

  if (!payload || payload.provider !== "discord" || !/^\d{5,32}$/.test(String(payload.userId || ""))) {
    throw new Error("Discord session token is invalid.");
  }

  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) {
    throw new Error("Discord session expired. Please authorize again.");
  }

  return {
    provider: "discord",
    userId: String(payload.userId),
    username: String(payload.username || "").slice(0, 64),
    globalName: String(payload.globalName || "").slice(0, 64),
    displayName: String(payload.displayName || "").slice(0, 64),
    avatarUrl: String(payload.avatarUrl || "").slice(0, 256),
    issuedAt: Number(payload.issuedAt) || 0,
    expiresAt: Number(payload.expiresAt),
  };
}

function discordApiRequest(options, body = "") {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: DISCORD_API_HOSTNAME,
      port: 443,
      method: options.method || "GET",
      path: `${DISCORD_API_VERSION_PREFIX}${options.path}`,
      headers: options.headers || {},
    }, (response) => {
      const chunks = [];

      response.on("data", (chunk) => {
        chunks.push(chunk);
      });

      response.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let parsedBody = null;

        if (rawBody) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch (error) {
            parsedBody = null;
          }
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const apiError = parsedBody?.error_description || parsedBody?.message || `Discord API request failed with ${response.statusCode}.`;
          reject(new Error(apiError));
          return;
        }

        resolve(parsedBody);
      });
    });

    request.on("error", (error) => {
      reject(error);
    });

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

async function exchangeDiscordAuthorizationCode(code) {
  assertDiscordAuthConfigured();
  const authorizationCode = String(code || "").trim();

  if (!authorizationCode) {
    throw new Error("Discord authorization code is required.");
  }

  const tokenBody = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code: authorizationCode,
  }).toString();

  const tokenResponse = await discordApiRequest({
    method: "POST",
    path: "/oauth2/token",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(tokenBody),
    },
  }, tokenBody);

  if (!tokenResponse?.access_token) {
    throw new Error("Discord token exchange did not return an access token.");
  }

  const userResponse = await discordApiRequest({
    method: "GET",
    path: "/users/@me",
    headers: {
      Authorization: `Bearer ${tokenResponse.access_token}`,
    },
  });

  const session = createDiscordActivitySessionToken(userResponse);

  return {
    accessToken: String(tokenResponse.access_token),
    expiresIn: Number(tokenResponse.expires_in) || 0,
    sessionToken: session.token,
    sessionExpiresAt: session.expiresAt,
    user: session.user,
  };
}

module.exports = {
  assertDiscordAuthConfigured,
  createDiscordActivitySessionToken,
  exchangeDiscordAuthorizationCode,
  getDiscordAuthConfiguration,
  verifyDiscordActivitySessionToken,
};
