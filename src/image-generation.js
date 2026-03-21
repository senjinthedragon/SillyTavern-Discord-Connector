/**
 * SillyTavern-Discord-Connector - Bridge Extension for SillyTavern
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * AI image generation.
 *
 * Sends an image_placeholder immediately, fires /sd, then watches #chat for
 * a new img.mes_img element. The observer snapshots existing srcs before the
 * command fires so only genuinely new images are forwarded.
 *
 * Requests are serialised per Discord channel to prevent overlapping /sd
 * calls within the same conversation while still allowing other channels to
 * proceed. A circuit breaker pauses generation after repeated failures.
 */

import { executeSlashCommandsWithOptions } from "../../../../../scripts/slash-commands.js";
import { safeSend } from "./ws.js";
import { fetchLocalImageAsBase64 } from "./image-relay.js";
import { sanitizeSlashArg } from "./utils.js";
import { makeT, getLocaleStrings } from "./i18n.js";

// ---------------------------------------------------------------------------
// Constants and state
// ---------------------------------------------------------------------------

let imageGenerationTimeoutMs = 3 * 60 * 1000;

const IMAGE_RATE_LIMIT_WINDOW_MS = 60_000;
const IMAGE_RATE_LIMIT_MAX_REQUESTS = 3;
const IMAGE_BREAKER_THRESHOLD = 3;
const IMAGE_BREAKER_COOLDOWN_MS = 2 * 60 * 1000;

const imageQueues = new Map();
const activeImageJobs = new Map();
const imageRateHistory = new Map();
const imageCircuitState = new Map();
// All counters reset to zero on extension reload (i.e. page load).
const imageMetrics = {
  totalRequests: 0, // requests that passed rate + breaker checks
  succeeded: 0,
  timedOut: 0,
  failed: 0,
  canceled: 0,
  rateLimited: 0, // rejected by the per-channel rate window
  breakerRejected: 0, // rejected while circuit breaker was open
  breakerTrips: 0, // times the breaker opened due to consecutive failures
  inFlight: 0, // currently executing (inside enqueueImageGeneration)
  maxConcurrentInFlight: 0,
  lastError: null, // string description of the most recent failure
  lastErrorAt: null, // timestamp (ms) of lastError
};

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

export function setImageGenerationTimeoutMs(ms) {
  imageGenerationTimeoutMs = ms;
}

export function getImageGenerationTimeoutMs() {
  return imageGenerationTimeoutMs;
}

/**
 * Returns the active circuit breaker state for a channel, or null if the
 * breaker is closed (i.e. generation is allowed). Also auto-clears expired
 * state so callers never see a stale open breaker.
 *
 * @param {string} chatId
 * @returns {{consecutiveFailures: number, openUntil: number}|null}
 */
export function getBreakerState(chatId) {
  const state = imageCircuitState.get(chatId);
  if (!state) return null;
  if (Date.now() >= state.openUntil) {
    imageCircuitState.delete(chatId);
    return null;
  }
  return state;
}

export function hasActiveImageJob(chatId) {
  return activeImageJobs.has(chatId);
}

export function hasPendingImageQueue(chatId) {
  return imageQueues.has(chatId);
}

/** Returns a snapshot copy of imageMetrics. */
export function getImageMetrics() {
  return { ...imageMetrics };
}

export function makeImageRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Checks and records a rate-limit request for chatId.
 * Returns {allowed: true} or {allowed: false}.
 * If allowed, the request timestamp is recorded.
 */
export function checkAndRecordRateLimit(chatId) {
  const now = Date.now();
  const history = imageRateHistory.get(chatId) || [];
  const pruned = history.filter((ts) => now - ts < IMAGE_RATE_LIMIT_WINDOW_MS);
  if (pruned.length >= IMAGE_RATE_LIMIT_MAX_REQUESTS) {
    imageRateHistory.set(chatId, pruned);
    imageMetrics.rateLimited += 1;
    return { allowed: false };
  }
  pruned.push(now);
  imageRateHistory.set(chatId, pruned);
  return { allowed: true };
}

/**
 * Cancels the active image job for chatId.
 * Returns true if a job was cancelled, false if there was nothing to cancel.
 */
export function cancelActiveImageJob(chatId) {
  const job = activeImageJobs.get(chatId);
  if (!job) return false;
  job.cancel();
  imageMetrics.canceled += 1;
  return true;
}

/** Records a breaker rejection in metrics. */
export function recordBreakerRejected() {
  imageMetrics.breakerRejected += 1;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function markImageFailure(chatId, reason) {
  const state = imageCircuitState.get(chatId) || {
    consecutiveFailures: 0,
    openUntil: 0,
  };
  state.consecutiveFailures += 1;

  if (state.consecutiveFailures >= IMAGE_BREAKER_THRESHOLD) {
    state.openUntil = Date.now() + IMAGE_BREAKER_COOLDOWN_MS;
    imageMetrics.breakerTrips += 1;
  }

  imageCircuitState.set(chatId, state);
  imageMetrics.lastError = reason;
  imageMetrics.lastErrorAt = Date.now();
}

function markImageSuccess(chatId) {
  if (!imageCircuitState.has(chatId)) return;
  imageCircuitState.set(chatId, { consecutiveFailures: 0, openUntil: 0 });
}

function sendImageError(chatId, requestId, text, reason = "failed") {
  safeSend({ type: "generate_image_error", chatId, requestId, text, reason });
}

function getImageQueue(chatId) {
  if (!imageQueues.has(chatId)) imageQueues.set(chatId, Promise.resolve());
  return imageQueues.get(chatId);
}

/**
 * Wraps fn() in a per-channel queue with a watchdog release.
 * Even if /sd or observers wedge, the queue recovers automatically.
 *
 * @param {string} chatId
 * @param {() => Promise<{status: string, reason?: string|null}>} fn
 */
function enqueueImageGeneration(chatId, fn) {
  const prev = getImageQueue(chatId);
  const next = prev
    .then(
      () =>
        new Promise((resolve) => {
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            clearTimeout(watchdogId);
            resolve();
          };

          const watchdogId = setTimeout(() => {
            console.error(
              `[Discord Bridge] Image queue watchdog released a stuck task for ${chatId}.`,
            );
            release();
          }, imageGenerationTimeoutMs + 10_000);

          Promise.resolve()
            .then(fn)
            .catch((err) => {
              console.error(
                "[Discord Bridge] Image generation queue error:",
                err,
              );
            })
            .finally(release);
        }),
    )
    .catch((err) => {
      console.error("[Discord Bridge] Unexpected queue chain error:", err);
    });

  imageQueues.set(chatId, next);
  next.finally(() => {
    if (imageQueues.get(chatId) === next) imageQueues.delete(chatId);
  });
}

/**
 * Executes /sd and relays the resulting image to the bridge.
 * Resolves after sending generate_image_result or generate_image_error.
 *
 * @param {string} chatId
 * @param {string} requestId
 * @param {string} prompt
 * @returns {Promise<{status: string, reason?: string|null}>}
 */
async function generateAndSendImage(chatId, requestId, prompt, userLocale) {
  const tl = makeT(await getLocaleStrings(userLocale));
  const chatEl = document.getElementById("chat");
  if (!chatEl) {
    sendImageError(chatId, requestId, tl("image.noChat"));
    return { status: "failed", reason: "chat_element_missing" };
  }

  const existingSrcs = new Set(
    Array.from(chatEl.querySelectorAll("img.mes_img"))
      .map((img) => img.getAttribute("src"))
      .filter(Boolean),
  );

  let hardTimeoutId = null;
  let observer = null;
  let settled = false;
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });

  const finish = (status, reason, cleanupFn) => {
    if (settled) return;
    settled = true;
    if (observer) observer.disconnect();
    clearTimeout(hardTimeoutId);
    cleanupFn();
    if (activeImageJobs.get(chatId) === cancelJob)
      activeImageJobs.delete(chatId);
    resolve({ status, reason });
  };

  const cancelJob = {
    cancel: () => {
      finish("cancelled", "cancelled_by_user", () => {
        sendImageError(
          chatId,
          requestId,
          "Image generation cancelled.",
          "cancelled",
        );
      });
    },
  };
  activeImageJobs.set(chatId, cancelJob);

  const onNewImage = async (src) => {
    const fetched = await fetchLocalImageAsBase64(src);
    if (!fetched) {
      finish("failed", "image_fetch_failed", () => {
        sendImageError(chatId, requestId, tl("image.fetchFailed"));
      });
      return;
    }
    finish("success", null, () => {
      safeSend({
        type: "generate_image_result",
        chatId,
        requestId,
        image: { type: "inline", ...fetched },
      });
    });
  };

  observer = new MutationObserver(() => {
    for (const img of chatEl.querySelectorAll("img.mes_img")) {
      const src = img.getAttribute("src");
      if (src && !existingSrcs.has(src)) {
        onNewImage(src);
        return;
      }
    }
  });

  observer.observe(chatEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });

  hardTimeoutId = setTimeout(() => {
    finish("timed_out", "timeout", () => {
      console.warn(
        `[Discord Bridge] Image generation timed out after ${imageGenerationTimeoutMs / 1000}s.`,
      );
      sendImageError(chatId, requestId, tl("image.timedOut"), "timed_out");
    });
  }, imageGenerationTimeoutMs);

  try {
    await executeSlashCommandsWithOptions(`/sd ${sanitizeSlashArg(prompt)}`);
  } catch (err) {
    finish("failed", "sd_command_failed", () => {
      console.error("[Discord Bridge] /sd command failed:", err);
      sendImageError(
        chatId,
        requestId,
        tl("image.failed", { message: err.message || "Unknown error" }),
      );
    });
  }

  // /sd resolved without throwing but produced no image (e.g. ComfyUI
  // unavailable - ST auto-fixes the null result to an empty string).
  // Give the DOM one tick to settle, then fail fast instead of waiting
  // for the hard timeout.
  if (!settled) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!settled) {
      finish("failed", "sd_no_image", () => {
        console.warn(
          "[Discord Bridge] /sd completed with no image - ComfyUI may not be running.",
        );
        sendImageError(chatId, requestId, tl("image.noImage"));
      });
    }
  }

  return promise;
}

// ---------------------------------------------------------------------------
// Public high-level wrapper
// ---------------------------------------------------------------------------

/**
 * Queues an image generation request with metrics tracking.
 * Sends image_placeholder before queuing; sends result/error packets
 * asynchronously when generation completes.
 *
 * @param {string} chatId
 * @param {string} requestId
 * @param {string} prompt
 * @param {string|null} [userLocale]
 */
export function enqueueAndGenerateImage(chatId, requestId, prompt, userLocale) {
  imageMetrics.totalRequests += 1;
  enqueueImageGeneration(chatId, async () => {
    imageMetrics.inFlight += 1;
    imageMetrics.maxConcurrentInFlight = Math.max(
      imageMetrics.maxConcurrentInFlight,
      imageMetrics.inFlight,
    );

    const result = await generateAndSendImage(
      chatId,
      requestId,
      prompt,
      userLocale,
    );
    imageMetrics.inFlight = Math.max(0, imageMetrics.inFlight - 1);

    if (result?.status === "success") {
      imageMetrics.succeeded += 1;
      markImageSuccess(chatId);
    } else if (result?.status === "timed_out") {
      imageMetrics.timedOut += 1;
      markImageFailure(chatId, "Image generation timed out");
    } else if (result?.status === "cancelled") {
      // cancelActiveImageJob already incremented imageMetrics.canceled.
    } else {
      imageMetrics.failed += 1;
      markImageFailure(
        chatId,
        result?.reason || "Image generation failed unexpectedly",
      );
    }
  });
}
