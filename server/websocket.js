/**
 * websocket.js - SillyTavern Connector: WebSocket Server
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
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
const { fanout, addRoute, resolveConversationId, getRoutes, getFrontend, parseRoute } = require("./frontend-manager");
const {
  setBridgeActivity,
  getPendingAutocompletes,
  getAutocompleteDebouncers,
} = require("./discord");
const { handleBridgePacket } = require("./websocket-router");

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

let sillyTavernClient = null;
const pendingImageMessages = {};
const streamHandled = new Set();
const streamReceived = new Set();

function getSillyTavernClient() {
  return sillyTavernClient;
}

function sendToSillyTavern(payload) {
  if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) return;
  sillyTavernClient.send(JSON.stringify(payload));
}

const pluginLoader = createPluginLoader({
  onUserMessage(platform, chatId, text) {
    const conversationId = resolveConversationId(platform, chatId);
    addRoute(conversationId, platform, chatId);
    sendToSillyTavern({ type: "user_message", text, chatId: conversationId });
  },
  onCommand(platform, chatId, command, args) {
    const conversationId = resolveConversationId(platform, chatId);
    addRoute(conversationId, platform, chatId);
    sendToSillyTavern({
      type: "execute_command",
      command,
      args,
      chatId: conversationId,
    });
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
  sillyTavernClient = ws;
  log("log", "[Bridge] SillyTavern connected");

  ws.send(
    JSON.stringify({
      type: "bridge_config",
      timezone: config.timezone || null,
      locale: config.locale || null,
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
      streamSessions,
      streamHandled,
      streamReceived,
      pendingImageMessages,
      setBridgeActivity,
      getPendingAutocompletes,
      log,
    });
  });

  ws.on("close", () => {
    sillyTavernClient = null;
    setBridgeActivity(null);

    for (const key of Object.keys(streamSessions)) {
      delete streamSessions[key];
    }
    streamHandled.clear();
    streamReceived.clear();

    for (const key of Object.keys(pendingImageMessages)) {
      delete pendingImageMessages[key];
    }

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

module.exports = { getSillyTavernClient };
