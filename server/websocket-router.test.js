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

function createDeps(overrides = {}) {
  const sentByWs = [];
  const calls = [];
  const routes = ["discord:chan1", "telegram:chat2"];
  const personaSaves = [];
  const langSaves = [];
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
    cancelledImageRequests: new Set(),
    timedOutImageRequests: new Set(),
    setBridgeActivity: () => {},
    getPendingAutocompletes: () => ({}),
    setPersonaForUser: (platform, userId, personaName) => {
      personaSaves.push({ platform, userId, personaName });
    },
    setLangForUser: (platform, userId, localeCode) => {
      langSaves.push({ platform, userId, localeCode });
    },
    setCurrentPersonaName: () => {},
    setCrossRelayEnabled: () => {},
    log: () => {},
    __calls: calls,
    __wsSent: sentByWs,
    __personaSaves: personaSaves,
    __langSaves: langSaves,
    ...overrides,
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

test("handleBridgePacket stream_end passes null finalText through to streamEnd (pendingText fallback)", async () => {
  const deps = createDeps();
  const streamEndPayloads = [];
  deps.fanout = async (_conv, fnName, payload) => {
    if (fnName === "streamEnd") streamEndPayloads.push(payload);
    return [];
  };

  await handleBridgePacket(
    {
      type: "stream_end",
      chatId: "conv1",
      streamId: "s1",
      finalText: null,
    },
    deps,
  );

  assert.equal(streamEndPayloads.length, 1);
  assert.equal(streamEndPayloads[0].finalText, null);
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

test("handleBridgePacket save_user_persona calls setPersonaForUser via deps", async () => {
  const deps = createDeps();
  await handleBridgePacket(
    {
      type: "save_user_persona",
      chatId: "conv1",
      platform: "discord",
      userId: "user123",
      personaName: "Alice",
    },
    deps,
  );

  assert.equal(deps.__personaSaves.length, 1);
  assert.deepEqual(deps.__personaSaves[0], {
    platform: "discord",
    userId: "user123",
    personaName: "Alice",
  });
});

test("handleBridgePacket save_user_persona null clears the persona", async () => {
  const deps = createDeps();
  await handleBridgePacket(
    {
      type: "save_user_persona",
      chatId: "conv1",
      platform: "telegram",
      userId: "tguser",
      personaName: null,
    },
    deps,
  );

  assert.equal(deps.__personaSaves.length, 1);
  assert.equal(deps.__personaSaves[0].personaName, null);
});

test("handleBridgePacket save_user_persona defaults platform to discord", async () => {
  const deps = createDeps();
  await handleBridgePacket(
    {
      type: "save_user_persona",
      chatId: "conv1",
      userId: "user123",
      personaName: "Bob",
    },
    deps,
  );

  assert.equal(deps.__personaSaves[0].platform, "discord");
});

test("handleBridgePacket generate_image_error cancelled adds to set and posts message", async () => {
  const deps = createDeps();
  await handleBridgePacket(
    {
      type: "generate_image_error",
      chatId: "conv1",
      requestId: "req1",
      text: "Image generation cancelled.",
      reason: "cancelled",
    },
    deps,
  );

  assert.ok(deps.cancelledImageRequests.has("req1"));
  assert.ok(
    deps.__calls.some((c) => c[1] === "sendText" && /cancelled/i.test(c[3])),
  );
});

test("handleBridgePacket generate_image_error timed_out adds to set and posts message", async () => {
  const deps = createDeps();
  await handleBridgePacket(
    {
      type: "generate_image_error",
      chatId: "conv1",
      requestId: "req1",
      text: "Image generation timed out.",
      reason: "timed_out",
    },
    deps,
  );

  assert.ok(deps.timedOutImageRequests.has("req1"));
  assert.ok(
    deps.__calls.some((c) => c[1] === "sendText" && /timed out/i.test(c[3])),
  );
});

test("handleBridgePacket generate_image_result silently discards cancelled request", async () => {
  const deps = createDeps();
  deps.cancelledImageRequests.add("req1");

  await handleBridgePacket(
    {
      type: "generate_image_result",
      chatId: "conv1",
      requestId: "req1",
      image: { type: "inline", data: "abc" },
    },
    deps,
  );

  assert.equal(
    deps.__calls.filter(
      (c) => c[1] === "sendGeneratedImage" || c[1] === "sendImages",
    ).length,
    0,
  );
  assert.equal(deps.cancelledImageRequests.has("req1"), false);
});

test("handleBridgePacket generate_image_result sends late image with note for timed_out request", async () => {
  const deps = createDeps();
  deps.timedOutImageRequests.add("req1");

  const fanoutCalls = [];
  deps.fanout = async (_conv, fnName, ...args) => {
    fanoutCalls.push([fnName, ...args]);
    return [];
  };

  await handleBridgePacket(
    {
      type: "generate_image_result",
      chatId: "conv1",
      requestId: "req1",
      image: { type: "inline", data: "abc" },
    },
    deps,
  );

  assert.ok(
    fanoutCalls.some((c) => c[0] === "sendText" && /timeout/i.test(c[1])),
  );
  assert.ok(fanoutCalls.some((c) => c[0] === "sendImages"));
  assert.equal(deps.timedOutImageRequests.has("req1"), false);
});

test("handleBridgePacket save_user_lang calls setLangForUser with correct args", async () => {
  const deps = createDeps();
  await handleBridgePacket(
    {
      type: "save_user_lang",
      chatId: "conv1",
      platform: "discord",
      userId: "user123",
      localeCode: "ja",
    },
    deps,
  );

  assert.equal(deps.__langSaves.length, 1);
  assert.deepEqual(deps.__langSaves[0], {
    platform: "discord",
    userId: "user123",
    localeCode: "ja",
  });
});

test("handleBridgePacket save_user_lang null clears the locale", async () => {
  const deps = createDeps();
  await handleBridgePacket(
    {
      type: "save_user_lang",
      chatId: "conv1",
      platform: "telegram",
      userId: "tguser",
      localeCode: null,
    },
    deps,
  );

  assert.equal(deps.__langSaves.length, 1);
  assert.equal(deps.__langSaves[0].localeCode, null);
});

test("handleBridgePacket save_user_lang defaults platform to discord", async () => {
  const deps = createDeps();
  await handleBridgePacket(
    {
      type: "save_user_lang",
      chatId: "conv1",
      userId: "user123",
      localeCode: "nl",
    },
    deps,
  );

  assert.equal(deps.__langSaves[0].platform, "discord");
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

test("handleBridgePacket messages_deleted fans out deleteRoleplayMessages with count", async () => {
  const deps = createDeps();
  const seen = [];
  deps.fanout = async (_conv, fnName, count, mode) => {
    seen.push([fnName, count, mode]);
    return [];
  };

  await handleBridgePacket(
    { type: "messages_deleted", chatId: "conv1", count: 3 },
    deps,
  );

  assert.deepEqual(seen, [["deleteRoleplayMessages", 3, "any"]]);
});

test("handleBridgePacket messages_deleted defaults count to 1 when missing", async () => {
  const deps = createDeps();
  const seen = [];
  deps.fanout = async (_conv, fnName, count, mode) => {
    seen.push([fnName, count, mode]);
    return [];
  };

  await handleBridgePacket(
    { type: "messages_deleted", chatId: "conv1" },
    deps,
  );

  assert.deepEqual(seen, [["deleteRoleplayMessages", 1, "any"]]);
});

test("handleBridgePacket messages_deleted forwards ai_only mode", async () => {
  const deps = createDeps();
  const seen = [];
  deps.fanout = async (_conv, fnName, count, mode) => {
    seen.push([fnName, count, mode]);
    return [];
  };

  await handleBridgePacket(
    { type: "messages_deleted", chatId: "conv1", count: 1, deleteMode: "ai_only" },
    deps,
  );

  assert.deepEqual(seen, [["deleteRoleplayMessages", 1, "ai_only"]]);
});
