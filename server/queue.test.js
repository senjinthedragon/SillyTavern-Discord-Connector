/**
 * queue.test.js - SillyTavern Discord Connector: Queue Tests
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 *
 * Tests for the per-channel message queue in queue.js.
 * Run with: npm test (from the server folder)
 *
 * queue.js reads its timeout value from config-loader.js at require() time, so
 * each test loads a fresh isolated instance via loadQueueWithTimeout() which
 * stubs both logger.js and config-loader.js in the module cache before requiring
 * queue.js. This lets each test control the timeout independently without
 * touching any real config file.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns a fresh queue module instance configured with the given timeout.
 * Stubs logger.js and config-loader.js in the require cache so the real files
 * are never touched, then busts the queue.js cache entry so it re-initialises
 * with the stubbed values.
 *
 * @param {number} timeoutMs
 */
function loadQueueWithTimeout(timeoutMs) {
  const loggerPath = path.join(__dirname, "logger.js");
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { log: () => {} },
  };

  const configLoaderPath = path.join(__dirname, "config-loader.js");
  require.cache[configLoaderPath] = {
    id: configLoaderPath,
    filename: configLoaderPath,
    loaded: true,
    exports: { config: { queueTaskTimeoutMs: timeoutMs } },
  };

  delete require.cache[path.join(__dirname, "queue.js")];
  return require("./queue");
}

test("enqueue executes channel tasks in order", async () => {
  const { enqueue, clearAllQueues } = loadQueueWithTimeout(200);

  const seen = [];
  enqueue("chan-a", async () => {
    await wait(30);
    seen.push("first");
  });

  await enqueue("chan-a", async () => {
    seen.push("second");
  });

  assert.deepEqual(seen, ["first", "second"]);
  clearAllQueues();
});

test("enqueue recovers after timed-out task", async () => {
  const { enqueue, clearAllQueues } = loadQueueWithTimeout(20);

  // This task deliberately takes longer than the timeout so the queue advances
  // past it and the next task still runs correctly.
  enqueue("chan-b", async () => {
    await wait(60);
  });

  const marker = [];
  await enqueue("chan-b", async () => {
    marker.push("ran");
  });

  assert.deepEqual(marker, ["ran"]);
  clearAllQueues();
});
