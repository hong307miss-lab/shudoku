/**
 * Kali's Sudoku — Discord Activity SDK loader.
 *
 * The activity pages used to pull the SDK from `https://cdn.discordapp.com/sdk.js`,
 * which no longer resolves (the legacy GCS object answers 403 AccessDenied). That made
 * `window.DiscordSDK` permanently undefined, so app.js could never promote the runtime to
 * "discord" and the Discord-only three-column layout never matched.
 *
 * Discord Activities cannot load cross-origin scripts, so the SDK is vendored next to the
 * app (`./discord-embedded-app-sdk.mjs`, the published ESM bundle of
 * `@discord/embedded-app-sdk@2.5.0`) and imported from the same origin.
 *
 * This file only *starts* the import. It deliberately does not decide whether the page is
 * running inside Discord: app.js still resolves the runtime kind from a successful
 * `discordSdk.ready()` handshake, which is the only trusted Activity signal. The checks
 * below merely avoid downloading 160 KB of SDK on a plain web visit.
 */
(function (global) {
  "use strict";

  function isLikelyDiscordHost() {
    var hostname = global.location?.hostname || "";
    var search = global.location?.search || "";
    // Discord frames the activity from discord.com and appends frame_id/instance_id to the URL.
    // Matching on the referrer (instead of "any iframe") keeps plain embeds from paying for the
    // 160 KB module download and the ready() handshake timeout.
    var referrer = global.document?.referrer || "";

    return (
      hostname.indexOf("discordsays.com") !== -1
      || hostname.indexOf("discordapp.net") !== -1
      || search.indexOf("frame_id=") !== -1
      || search.indexOf("instance_id=") !== -1
      || referrer.indexOf("discord.com") !== -1
      || referrer.indexOf("discordsays.com") !== -1
    );
  }

  global.__DISCORD_SDK_PROMISE__ = null;

  if (!isLikelyDiscordHost()) {
    return;
  }

  global.__DISCORD_SDK_PROMISE__ = import("./discord-embedded-app-sdk.mjs").then(
    function (module) {
      global.DiscordSDK = module.DiscordSDK || global.DiscordSDK;
      return global.DiscordSDK || null;
    },
    function (error) {
      console.warn("Discord Activity SDK module failed to load.", error);
      return null;
    },
  );
})(window);
