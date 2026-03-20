/**
 * websocket.js - SillyTavern Connector: WebSocket Server
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Hosts the SillyTavern extension WebSocket endpoint and fans outbound packets
 * to any enabled frontend plugins using frontend-manager.js.
 */

"use strict";

const WebSocket = require("ws");
const { log } = require("./logger");
const { config, wssPort } = require("./config-loader");
const { streamSessions } = require("./streaming");
const { createPluginLoader } = require("./plugin-loader");
const {
  fanout,
  addRoute,
  clearRoutes,
  resolveConversationId,
  getRoutes,
  getFrontend,
  parseRoute,
  getRegisteredPlatforms,
} = require("./frontend-manager");
const {
  setBridgeActivity,
  getPendingAutocompletes,
  getAutocompleteDebouncers,
} = require("./discord");
const { handleBridgePacket } = require("./websocket-router");
const { loadLocale, makeTranslator } = require("./i18n");
const {
  load: loadPersonaMap,
  getPersonaForUser,
  setPersonaForUser,
  setDefaultPersonaName,
  getDefaultPersonaName,
  setCrossRelayEnabled,
  isCrossRelayEnabled,
} = require("./persona-map");
const {
  load: loadLangMap,
  getLangForUser,
  setLangForUser,
} = require("./lang-map");
const { AVAILABLE_LANGUAGES, findLanguage } = require("./locales-manifest");

const version = require("./package.json").version;
const width = 70;

const canColor = process.stdout.isTTY && process.env.TERM !== "dumb";

const purple = canColor ? "[38;5;93m" : "";
const gold = canColor ? "[38;5;220m" : "";
const reset = canColor ? "[0m" : "";

const title = ` SILLYTAVERN DISCORD CONNECTOR - v${version}`;
const credit = ` Developed by Senjin the Dragon https://github.com/senjinthedragon`;
const support = ` Please support my work: https://github.com/sponsors/senjinthedragon`;

console.log(`
${purple}╔${"═".repeat(width)}╗
║${gold}${title.padEnd(width)}${purple}║
║${gold}${credit.padEnd(width)}${purple}║
║${gold}${support.padEnd(width)}${purple}║
╚${"═".repeat(width)}╝${reset}
`);

loadPersonaMap();
loadLangMap();
loadLocale(config.userLocale || null);

let sillyTavernClient = null;
const pendingImageMessages = {};
const cancelledImageRequests = new Set();
const timedOutImageRequests = new Set();
const streamHandled = new Set();
const streamReceived = new Set();

function getSillyTavernClient() {
  return sillyTavernClient;
}

function sendToSillyTavern(payload) {
  if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN)
    return;
  sillyTavernClient.send(JSON.stringify(payload));
}

function dispatchCommand(platform, chatId, command, args, userId) {
  const conversationId = resolveConversationId(platform, chatId);
  addRoute(conversationId, platform, chatId);
  const userLocale = getLangForUser(platform, userId) || null;

  if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
    handleOfflineCommand(
      platform,
      chatId,
      conversationId,
      command,
      args,
      userId,
      userLocale,
    );
    return;
  }

  sendToSillyTavern({
    type: "execute_command",
    command,
    args,
    chatId: conversationId,
    userId,
    platform,
    ...(userLocale ? { userLocale } : {}),
  });
}

async function handleOfflineCommand(
  platform,
  chatId,
  conversationId,
  command,
  args,
  userId,
  userLocale,
) {
  const tl = makeTranslator(userLocale);

  if (command === "sthelp") {
    const sections = [
      tl("help.title"),
      tl("help.offlineNote"),
      tl("help.offlineInfo"),
      tl("help.lang"),
      tl("help.footer"),
    ];
    await fanout(conversationId, "sendText", sections.join("\n\n"));
    return;
  }

  if (command === "status") {
    const registeredPlatforms = getRegisteredPlatforms();
    const platformList =
      registeredPlatforms.size > 0
        ? [...registeredPlatforms].join(", ")
        : "none";
    const lines = [
      tl("status.title"),
      tl("status.connection", { value: tl("status.offline") }),
      tl("status.plugins", { value: platformList }),
      tl("status.stOffline"),
    ];
    await fanout(conversationId, "sendText", lines.join("\n"));
    return;
  }

  if (command === "setlang") {
    const input = (args?.[0] || "").trim();
    if (!input || input === "clear") {
      setLangForUser(platform, userId, null);
      await fanout(conversationId, "sendText", tl("setlang.reset"));
      return;
    }
    const match = findLanguage(input);
    if (match) {
      setLangForUser(platform, userId, match.code);
      const tAfter = makeTranslator(match.code);
      await fanout(
        conversationId,
        "sendText",
        tAfter("setlang.success", { name: match.nativeName, code: match.code }),
      );
    } else {
      await fanout(
        conversationId,
        "sendText",
        tl("setlang.unknown", { input }),
      );
    }
    return;
  }

  await fanout(conversationId, "sendText", tl("cmd.stOffline"));
}

const pluginLoader = createPluginLoader({
  onUserMessage(platform, chatId, text, userId = "") {
    const conversationId = resolveConversationId(platform, chatId);
    addRoute(conversationId, platform, chatId);
    const mappedPersona = getPersonaForUser(platform, userId);
    const userLocale = getLangForUser(platform, userId) || null;
    sendToSillyTavern({
      type: "user_message",
      text,
      chatId: conversationId,
      userId,
      platform,
      ...(mappedPersona ? { mappedPersona } : {}),
      ...(userLocale ? { userLocale } : {}),
    });

    // Cross-relay the user's message to all other platforms in the same
    // conversation so every connected client stays in sync.
    if (!isCrossRelayEnabled()) return;
    const originKey = `${platform}:${chatId}`;
    const senderLabel =
      mappedPersona || getDefaultPersonaName() || `[${platform}]`;
    const relayText = `${senderLabel}: ${text}`;
    for (const route of getRoutes(conversationId)) {
      if (route === originKey) continue;
      const { platform: targetPlatform, nativeChatId: targetChatId } =
        parseRoute(route);
      const frontend = getFrontend(targetPlatform);
      if (!frontend?.sendText) continue;
      frontend.sendText(targetChatId, relayText).catch((err) => {
        log("warn", `[Bridge] Cross-relay to ${route} failed: ${err.message}`);
      });
    }
  },
  onCommand(platform, chatId, command, args, userId = "") {
    dispatchCommand(platform, chatId, command, args, userId);
  },
});

pluginLoader.start().catch((err) => {
  log("error", `[Plugins] Failed to start plugin: ${err.message}`);
});

const wss = new WebSocket.Server({
  port: wssPort,
  maxPayload: 50 * 1024 * 1024,
});
log("log", `[Bridge] WebSocket server listening on port ${wssPort}`);

wss.on("connection", (ws) => {
  if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
    log(
      "warn",
      "[Bridge] New SillyTavern connection received while one is already active - closing previous.",
    );
    sillyTavernClient.close(1008, "Replaced by new connection");
  }
  sillyTavernClient = ws;
  log("log", "[Bridge] SillyTavern connected");

  // Build plugin status map for all known platforms. Only platforms that
  // successfully registered via registerFrontend() are marked "active".
  // Others show as "not_loaded" so the extension can tease pro platforms
  // to free version users.
  const KNOWN_PLATFORMS = ["discord", "telegram", "signal"];
  const registeredPlatforms = getRegisteredPlatforms();
  const pluginStatus = Object.fromEntries(
    KNOWN_PLATFORMS.map((p) => [
      p,
      registeredPlatforms.has(p) ? "active" : "not_loaded",
    ]),
  );

  ws.send(
    JSON.stringify({
      type: "bridge_config",
      timezone: config.timezone || null,
      locale: config.locale || null,
      userLocale: config.userLocale || null,
      availableLanguages: AVAILABLE_LANGUAGES,
      plugins: pluginStatus,
      imagePlaceholderTimeoutMs: config.imagePlaceholderTimeoutMs,
    }),
  );

  ws.on("message", async (message) => {
    let data;
    try {
      data = JSON.parse(
        typeof message === "string" ? message : message.toString("utf8"),
      );
    } catch (err) {
      log("warn", `[Bridge] Dropping invalid JSON packet: ${err.message}`);
      return;
    }

    await handleBridgePacket(data, {
      ws,
      fanout,
      getRoutes,
      getFrontend,
      parseRoute,
      streamHandled,
      streamReceived,
      pendingImageMessages,
      cancelledImageRequests,
      timedOutImageRequests,
      setBridgeActivity,
      getPendingAutocompletes,
      setPersonaForUser,
      setLangForUser,
      setCurrentPersonaName: setDefaultPersonaName,
      setCrossRelayEnabled,
      log,
    });
  });

  ws.on("close", () => {
    sillyTavernClient = null;
    setDefaultPersonaName(null);
    setCrossRelayEnabled(true);
    clearRoutes();
    setBridgeActivity(null);

    for (const key of Object.keys(streamSessions)) {
      delete streamSessions[key];
    }
    streamHandled.clear();
    streamReceived.clear();

    for (const key of Object.keys(pendingImageMessages)) {
      delete pendingImageMessages[key];
    }
    cancelledImageRequests.clear();
    timedOutImageRequests.clear();

    const autocompleteDebouncers = getAutocompleteDebouncers();
    for (const [key, debouncer] of Object.entries(autocompleteDebouncers)) {
      clearTimeout(debouncer.timer);
      delete autocompleteDebouncers[key];
      debouncer.interaction.respond([]).catch(() => {});
    }

    const pendingAutocompletes = getPendingAutocompletes();
    for (const [requestId, pending] of Object.entries(pendingAutocompletes)) {
      clearTimeout(pending.timeout);
      delete pendingAutocompletes[requestId];
      pending.interaction.respond([]).catch(() => {});
    }
  });
});

module.exports = { getSillyTavernClient, dispatchCommand };
