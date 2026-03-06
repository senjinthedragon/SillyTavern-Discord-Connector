"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function loadQueueWithTimeout(timeoutMs) {
  process.env.STDC_QUEUE_TASK_TIMEOUT_MS = String(timeoutMs);

  const loggerPath = path.join(__dirname, "logger.js");
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { log: () => {} },
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
