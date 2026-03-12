"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function loadFrontendManager() {
  const configLoaderPath = path.join(__dirname, "config-loader.js");
  require.cache[configLoaderPath] = {
    id: configLoaderPath,
    filename: configLoaderPath,
    loaded: true,
    exports: {
      config: {
        conversationLinks: [],
        plugins: {
          telegram: {
            circuitBreaker: {
              enabled: true,
              failureThreshold: 1,
              cooldownSeconds: 60,
            },
          },
          signal: { circuitBreaker: { enabled: false } },
        },
      },
    },
  };

  const loggerPath = path.join(__dirname, "logger.js");
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { log: () => {} },
  };

  delete require.cache[path.join(__dirname, "frontend-manager.js")];
  return require("./frontend-manager");
}

test("fanout continues when one frontend throws", async () => {
  const manager = loadFrontendManager();
  const conversationId = `test-${Date.now()}-a`;
  const delivered = [];

  manager.registerFrontend("ok", {
    async sendText(chatId, text) {
      delivered.push(`${chatId}:${text}`);
    },
  });

  manager.registerFrontend("bad", {
    async sendText() {
      throw new Error("boom");
    },
  });

  manager.addRoute(conversationId, "ok", "123");
  manager.addRoute(conversationId, "bad", "456");

  const invoked = await manager.fanout(conversationId, "sendText", "hello");
  assert.deepEqual(delivered, ["123:hello"]);
  assert.ok(invoked.includes("ok:123"));
  assert.ok(!invoked.includes("bad:456"));
});

test("parseRoute keeps native chat id when it contains colons", () => {
  const manager = loadFrontendManager();
  const parsed = manager.parseRoute("signal:+12:34:56");
  assert.equal(parsed.platform, "signal");
  assert.equal(parsed.nativeChatId, "+12:34:56");
});

test("circuit breaker opens after threshold and skips attempts", async () => {
  const manager = loadFrontendManager();
  const conversationId = `test-${Date.now()}-b`;
  let attempts = 0;

  manager.registerFrontend("telegram", {
    async sendText() {
      attempts += 1;
      throw new Error("down");
    },
  });

  manager.addRoute(conversationId, "telegram", "100");

  await manager.fanout(conversationId, "sendText", "hello");
  await manager.fanout(conversationId, "sendText", "hello-again");

  assert.equal(attempts, 1);
  assert.equal(manager.canAttemptPlatform("telegram"), false);
});
