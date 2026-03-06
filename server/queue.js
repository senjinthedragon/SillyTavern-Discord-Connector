/**
 * queue.js - SillyTavern Discord Connector: Per-channel Message Queue
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 *
 * Serialises message sends and deletes within a channel so arrival order is
 * preserved. Each enqueue() call chains onto the previous promise for that
 * channel; the slot is freed automatically once the tail resolves.
 *
 * Stream edits bypass this queue intentionally - they fire directly to stay
 * real-time. Only stream_end (final post), ai_reply, and image operations use
 * the queue.
 */

"use strict";

const { log } = require("./logger");

const channelQueues = {};
const QUEUE_TASK_TIMEOUT_MS = 30_000;

function withTimeout(promise, channelId) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Queue task timed out after ${QUEUE_TASK_TIMEOUT_MS}ms for channel ${channelId}`,
        ),
      );
    }, QUEUE_TASK_TIMEOUT_MS);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

/**
 * @param {string} channelId
 * @param {() => Promise<any>} fn
 */
function enqueue(channelId, fn) {
  const prev = channelQueues[channelId] || Promise.resolve();
  const next = prev
    .then(() => withTimeout(Promise.resolve().then(() => fn()), channelId))
    .catch((err) => {
      log("error", `[Queue] Error in channel ${channelId}:`, err.message);
    });
  channelQueues[channelId] = next;
  next.then(() => {
    if (channelQueues[channelId] === next) delete channelQueues[channelId];
  });
  return next;
}

function clearAllQueues() {
  for (const channelId of Object.keys(channelQueues)) {
    delete channelQueues[channelId];
  }
}

module.exports = { enqueue, clearAllQueues };
