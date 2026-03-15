/**
 * websocket-router.test.js - SillyTavern Discord Connector: WebSocket Router Tests
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Packet-flow integration tests for websocket-router.js. All Discord and
 * Telegram frontends are mocked so no real connections are needed.
 * Run with: npm test (from the server folder)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { handleBridgePacket } = require("./websocket-router");

function createDeps() {
  const sentByWs = [];
  const calls = [];
  const routes = ["discord:chan1", "telegram:chat2"];
  const frontends = {
    discord: {
      async sendText(chatId, text) {
        calls.push(["discord", "sendText", chatId, text]);
      },
      async streamEnd(chatId) {
        calls.push(["discord", "streamEnd", chatId]);
      },
    },
    telegram: {
      async sendText(chatId, text) {
        calls.push(["telegram", "sendText", chatId, text]);
      },
    },
  };

  return {
    ws: { send: (m) => sentByWs.push(m) },
    fanout: async (conversationId, fnName, ...args) => {
      const invoked = [];
      for (const route of routes) {
        const [platform, nativeChatId] = route.split(":");
        const fn = frontends[platform]?.[fnName];
        if (!fn) continue;
        await fn(nativeChatId, ...args);
        invoked.push(route);
      }
      return invoked;
    },
    getRoutes: () => routes,
    getFrontend: (platform) => frontends[platform],
    parseRoute: (route) => {
      const idx = route.indexOf(":");
      return {
        platform: route.slice(0, idx),
        nativeChatId: route.slice(idx + 1),
      };
    },
    streamSessions: {},
    streamHandled: new Set(),
    streamReceived: new Set(),
    pendingImageMessages: {},
    setBridgeActivity: () => {},
    getPendingAutocompletes: () => ({}),
    log: () => {},
    __calls: calls,
    __wsSent: sentByWs,
  };
}

test("handleBridgePacket heartbeat responds immediately", async () => {
  const deps = createDeps();
  await handleBridgePacket({ type: "heartbeat" }, deps);
  assert.equal(deps.__wsSent.length, 1);
  assert.match(deps.__wsSent[0], /heartbeat/);
});

test("handleBridgePacket stream_end falls back sendText for non-streaming frontends", async () => {
  const deps = createDeps();
  deps.streamSessions.s1 = { pendingText: "final" };

  await handleBridgePacket(
    {
      type: "stream_end",
      chatId: "conv1",
      streamId: "s1",
      finalText: "done",
      characterName: "Bot",
    },
    deps,
  );

  assert.ok(
    deps.__calls.some((c) => c[0] === "discord" && c[1] === "streamEnd"),
  );
  assert.ok(
    deps.__calls.some(
      (c) =>
        c[0] === "telegram" && c[1] === "sendText" && /\*\*Bot\*\*/.test(c[3]),
    ),
  );
});

test("handleBridgePacket ai_reply is skipped once after stream_end", async () => {
  const deps = createDeps();
  deps.streamHandled.add("conv1");

  await handleBridgePacket(
    { type: "ai_reply", chatId: "conv1", text: "hello" },
    deps,
  );

  assert.equal(deps.__calls.filter((c) => c[1] === "sendText").length, 0);
  assert.equal(deps.streamHandled.has("conv1"), false);
});

test("handleBridgePacket send_images fans out full images array", async () => {
  const deps = createDeps();
  const seen = [];
  deps.fanout = async (_conv, fnName, images) => {
    seen.push([fnName, images.length]);
    return [];
  };

  await handleBridgePacket(
    {
      type: "send_images",
      chatId: "conv1",
      images: [
        { type: "inline", data: "a" },
        { type: "url", url: "https://x" },
      ],
    },
    deps,
  );

  assert.deepEqual(seen, [["sendImages", 2]]);
});
