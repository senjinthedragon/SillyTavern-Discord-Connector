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
 *
 * Runs inside SillyTavern as a third-party extension. Connects to the bridge
 * server (server.js) over WebSocket and acts as the intermediary between
 * Discord and SillyTavern's internals.
 *
 * Streaming:
 *   Each character turn gets a unique streamId at GENERATION_STARTED.
 *   STREAM_TOKEN_RECEIVED forwards cumulative text to the bridge for throttled
 *   Discord edits. GENERATION_ENDED sends stream_end, which tells the bridge to
 *   replace the live-edit message with a clean final post. Group chats include
 *   the character name; solo chats do not. All per-message listeners are
 *   registered and cleaned up inside handleUserMessage to prevent leaks.
 *
 * Image relay:
 *   Local ST images (thumbnails, generated art, avatars) are fetched here in
 *   the browser - where same-origin access is always available - and sent as
 *   base64 inline data. External URLs are passed through for the bridge to
 *   fetch directly. This split works regardless of whether the bridge runs on
 *   the same machine as SillyTavern.
 *
 * Intro messages:
 *   /newchat greetings are written directly into the chat DOM before any
 *   generation events fire. A MutationObserver on #chat captures them and
 *   forwards them as intro_message packets.
 *
 * AI image generation:
 *   /image sends an image_placeholder immediately, then fires /sd and watches
 *   the DOM for a new img.mes_img element. On success the image is sent as
 *   generate_image_result; on timeout or failure as generate_image_error.
 *   Requests are serialised per Discord channel with a hard watchdog so a
 *   stalled task can never permanently block retries.
 *
 * Autocomplete:
 *   Character and group lists are cached with a 60-second TTL. Chat lists are
 *   keyed by characterId and invalidated on newchat/switchchar/switchgroup
 *   rather than by TTL, keeping them perfectly current.
 *
 * Reactions:
 *   Watches #expression-image in the ST DOM and forwards expression updates.
 *   Depending on extension settings, updates Discord activity only (default)
 *   or activity plus expression image posts to the last active Discord channel.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { extensionSettings, deleteLastMessage, saveSettingsDebounced } =
  SillyTavern.getContext();

import {
  eventSource,
  event_types,
  getPastCharacterChats,
  sendMessageAsUser,
  doNewChat,
  selectCharacterById,
  openCharacterChat,
  Generate,
  setExternalAbortController,
} from "../../../../script.js";

import { executeSlashCommandsWithOptions } from "../../../../scripts/slash-commands.js";

// ---------------------------------------------------------------------------
// Constants and module-level state
// ---------------------------------------------------------------------------

const MODULE_NAME = "SillyTavern-Discord-Connector";

const DEFAULT_SETTINGS = {
  bridgeUrl: "ws://127.0.0.1:2333",
  autoConnect: true,
  expressionMode: "status",
};

// String fallback covers older ST versions that don't export this event type.
const GROUP_WRAPPER_FINISHED =
  event_types.GROUP_WRAPPER_FINISHED ?? "group_wrapper_finished";

let ws = null;
let shouldReconnect = true;
let reconnectTimeout = null;
let heartbeatInterval = null;
let expressionObserver = null;
let expressionDebounceTimer = null;
let lastExpressionSignature = "";
let lastActiveChatId = null;
let bridgeTimezone = null;
let bridgeLocale = null;
let bridgePlugins = null;
const expressionCache = new Map();

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getSettings() {
  extensionSettings[MODULE_NAME] = {
    ...DEFAULT_SETTINGS,
    ...(extensionSettings[MODULE_NAME] || {}),
  };

  if (
    !["off", "status", "full"].includes(
      extensionSettings[MODULE_NAME].expressionMode,
    )
  ) {
    extensionSettings[MODULE_NAME].expressionMode =
      DEFAULT_SETTINGS.expressionMode;
  }

  return extensionSettings[MODULE_NAME];
}

function updateStatus(message, color) {
  const el = document.getElementById("discord_connection_status");
  if (el) {
    el.textContent = `Status: ${message}`;
    el.style.color = color;
  }
}

// ---------------------------------------------------------------------------
// Image relay helpers
//
// Local ST images are fetched here in the browser and sent as base64 inline
// data. External URLs are passed through for the bridge to fetch directly.
// Classification operates on the raw src string before any URL resolution.
// ---------------------------------------------------------------------------

/**
 * Classifies an image src as "local" (served by ST) or "external".
 * Relative paths and same-origin absolute URLs are local; everything else
 * (protocol-relative, different-origin http/https) is external.
 *
 * @param {string} src
 * @returns {"local"|"external"|null}
 */
function classifyImageSrc(src) {
  if (!src) return null;
  if (/^data:/i.test(src)) return "local";
  if (src.startsWith("//")) return "external";
  if (/^https?:\/\//i.test(src)) {
    try {
      return new URL(src).origin === window.location.origin
        ? "local"
        : "external";
    } catch {
      return "external";
    }
  }
  return "local";
}

/**
 * Resolves a local ST src to an absolute URL on the same origin.
 * Only called after classifyImageSrc confirms the src is local.
 *
 * @param {string} src
 * @returns {string}
 */
function resolveLocalUrl(src) {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("//")) return window.location.protocol + src;
  return window.location.origin + (src.startsWith("/") ? "" : "/") + src;
}

/**
 * Fetches a local ST image and returns it as a base64 object ready for a
 * send_images packet. Returns null on failure or if the image exceeds 8 MB.
 *
 * @param {string} src
 * @returns {Promise<{data: string, mimeType: string, filename: string}|null>}
 */
async function fetchLocalImageAsBase64(src) {
  try {
    if (/^data:([^;]+);base64,/i.test(src)) {
      const [header, data] = src.split(",", 2);
      const mimeType = header.replace(/^data:/i, "").replace(/;base64$/i, "");
      const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
      return { data, mimeType, filename: `image.${ext}` };
    }

    const url = resolveLocalUrl(src);
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(
        `[Discord Bridge] Image fetch failed (${response.status}): ${url}`,
      );
      return null;
    }

    const blob = await response.blob();
    const mimeType = blob.type || "image/png";

    const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
    if (blob.size > MAX_IMAGE_BYTES) {
      console.warn(
        `[Discord Bridge] Image too large (${(blob.size / 1024 / 1024).toFixed(1)} MB, limit 50 MB): ${url}`,
      );
      return null;
    }

    let filename;
    try {
      const parsed = new URL(url);
      if (parsed.pathname === "/thumbnail") {
        const fileParam = parsed.searchParams.get("file");
        filename = fileParam ? fileParam.split("/").pop() : "avatar.png";
      } else {
        const base = parsed.pathname.split("/").pop();
        filename =
          base && /\.[a-z]{2,5}$/i.test(base)
            ? base
            : `image.${mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png"}`;
      }
    } catch {
      filename = "image.png";
    }

    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",", 2)[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

    return { data, mimeType, filename };
  } catch (err) {
    console.warn(
      `[Discord Bridge] Failed to fetch local image: ${err.message}`,
    );
    return null;
  }
}

/**
 * Returns the raw src values of all images in a .mes_text element.
 * Unresolved so classifyImageSrc can operate on the original strings.
 *
 * @param {Element} mesTextEl
 * @returns {string[]}
 */
function extractImageSrcsFromMesText(mesTextEl) {
  if (!mesTextEl) return [];
  return Array.from(mesTextEl.querySelectorAll("img"))
    .map((img) => img.getAttribute("src"))
    .filter(Boolean);
}

/**
 * Extracts plain text from a .mes_text element, preserving paragraph breaks.
 *
 * @param {Element} mesTextEl
 * @returns {string}
 */
function extractTextFromMesText(mesTextEl) {
  if (!mesTextEl) return "";
  const clone = mesTextEl.cloneNode(true);
  for (const p of clone.querySelectorAll("p"))
    p.insertAdjacentText("afterend", "\n\n");
  for (const br of clone.querySelectorAll("br")) br.replaceWith("\n");
  return clone.innerText?.replace(/\n{3,}/g, "\n\n").trim() || "";
}

/**
 * Resolves a list of src strings into bridge-ready image descriptors.
 * Local images are fetched as inline base64; external URLs are passed through.
 *
 * @param {string[]} srcs
 * @returns {Promise<Array>}
 */
async function collectImages(srcs) {
  const results = await Promise.all(
    srcs.map(async (src) => {
      const kind = classifyImageSrc(src);
      if (!kind) return null;
      if (kind === "local") {
        const fetched = await fetchLocalImageAsBase64(src);
        return fetched ? { type: "inline", ...fetched } : null;
      }
      return { type: "url", url: src };
    }),
  );
  return results.filter(Boolean);
}

/**
 * Sends a prepared image list to the bridge.
 *
 * @param {string} chatId
 * @param {Array} images
 * @param {string|null} [caption]
 */
function sendCollectedImages(chatId, images, caption) {
  if (!images?.length || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: "send_images",
      chatId,
      images,
      caption: caption || null,
    }),
  );
}

/**
 * Extracts, classifies, and sends all images found in a .mes_text element.
 *
 * @param {string} chatId
 * @param {Element} mesTextEl
 * @param {string|null} [caption]
 */
async function sendImagesFromMesText(chatId, mesTextEl, caption) {
  const srcs = extractImageSrcsFromMesText(mesTextEl);
  if (!srcs.length) return;
  const images = await collectImages(srcs);
  if (images.length > 0) sendCollectedImages(chatId, images, caption);
}

/**
 * Fetches and sends the avatar for a character.
 * Avatars are always local ST resources served via /thumbnail.
 *
 * @param {string} chatId
 * @param {object} character
 */
async function sendCharacterAvatar(chatId, character) {
  if (!character?.avatar || ws?.readyState !== WebSocket.OPEN) return;
  const src = `/characters/${encodeURIComponent(character.avatar)}`;
  const fetched = await fetchLocalImageAsBase64(src);
  if (!fetched) {
    console.warn("[Discord Bridge] Could not fetch character avatar.");
    return;
  }
  sendCollectedImages(
    chatId,
    [{ type: "inline", ...fetched }],
    character.name ? `**${character.name}**` : null,
  );
}

/**
 * Scans the last AI message in the DOM for images and forwards them.
 * Called after generation ends to catch images ST adds post-generation
 * (auto-generated art, etc.) which don't surface via generation events.
 * Not awaited by callers so text replies reach Discord first.
 *
 * @param {string} chatId
 */
async function sendLastMessageImages(chatId) {
  const messages = document.querySelectorAll("#chat .mes");
  if (!messages.length) return;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage.getAttribute("is_user") === "true") return;
  await sendImagesFromMesText(chatId, lastMessage.querySelector(".mes_text"));
}

// ---------------------------------------------------------------------------
// Expression relay
//
// SillyTavern exposes the current expression in #expression-image. We observe
// that element and forward updates to the bridge, where Discord activity can
// be updated and (optionally) the expression image posted in-channel.
// ---------------------------------------------------------------------------

const EXPRESSION_DEBOUNCE_MS = 250;
const EXPRESSION_MODE_VALUES = new Set(["off", "status", "full"]);

function normalizeExpressionOwnerName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function cacheExpressionSnapshot(snapshot) {
  if (!snapshot?.ownerName) return;
  const key = normalizeExpressionOwnerName(snapshot.ownerName);
  if (!key) return;
  expressionCache.set(key, {
    ownerName: snapshot.ownerName,
    expression: snapshot.expression,
    image: snapshot.image || null,
    updatedAt: Date.now(),
  });
}

function getCachedExpressionSnapshot(name) {
  const key = normalizeExpressionOwnerName(name);
  if (!key) return null;
  return expressionCache.get(key) || null;
}

function parseExpressionFromElement(imgEl) {
  if (!imgEl) return null;

  const explicit =
    imgEl.getAttribute("data-expression") || imgEl.getAttribute("title") || "";
  if (explicit.trim()) return explicit.trim().toLowerCase();

  const src = imgEl.getAttribute("src") || "";
  const base = src.split("?")[0].split("/").pop() || "";
  const name = base
    .replace(/\.[a-z0-9]+$/i, "")
    .trim()
    .toLowerCase();

  // ST sometimes points to /img/default-expressions/null.png when no
  // expression is active; treat that as neutral for activity display.
  if (!name || name === "null") return "neutral";
  return name;
}

async function buildExpressionImagePayload(imgEl) {
  if (!imgEl) return null;
  const src = imgEl.getAttribute("src");
  if (!src) return null;

  const kind = classifyImageSrc(src);
  if (!kind) return null;
  if (kind === "local") {
    const fetched = await fetchLocalImageAsBase64(src);
    return fetched ? { type: "inline", ...fetched } : null;
  }
  return { type: "url", url: src };
}

/**
 * Reads the current expression block from the DOM and returns expression +
 * optional image payload.
 *
 * @param {boolean} includeImage
 * @returns {Promise<{expression: string, image: object|null, ownerName: string|null}|null>}
 */
async function getCurrentExpressionSnapshot(includeImage = false) {
  const imgEl = document.getElementById("expression-image");
  if (!imgEl) return null;

  const expression = parseExpressionFromElement(imgEl);
  if (!expression) return null;

  const image = includeImage ? await buildExpressionImagePayload(imgEl) : null;
  const ownerName =
    imgEl.getAttribute("data-sprite-folder-name")?.trim() || null;
  const snapshot = { expression, image, ownerName };
  cacheExpressionSnapshot(snapshot);
  return snapshot;
}

async function sendExpressionUpdate(chatIdHint = null) {
  if (ws?.readyState !== WebSocket.OPEN) return;

  const settings = getSettings();
  if (settings.expressionMode === "off") return;

  const snapshot = await getCurrentExpressionSnapshot(
    settings.expressionMode === "full",
  );
  if (!snapshot) return;
  const { expression, image, ownerName } = snapshot;

  const imgEl = document.getElementById("expression-image");
  const src = imgEl.getAttribute("src") || "";
  const signature = `${expression}|${src}`;
  if (signature === lastExpressionSignature) return;
  lastExpressionSignature = signature;

  let chatId = null;
  if (settings.expressionMode === "full") {
    chatId = chatIdHint || lastActiveChatId || null;
  }

  ws.send(
    JSON.stringify({
      type: "expression_update",
      expression,
      ownerName: ownerName || null,
      chatId,
      image,
    }),
  );
}

function scheduleExpressionUpdate(chatIdHint = null) {
  if (expressionDebounceTimer) clearTimeout(expressionDebounceTimer);
  expressionDebounceTimer = setTimeout(() => {
    sendExpressionUpdate(chatIdHint).catch((err) => {
      console.warn("[Discord Bridge] Failed to send expression update:", err);
    });
  }, EXPRESSION_DEBOUNCE_MS);
}

function setupExpressionObserver() {
  if (expressionObserver) return;

  const target = document.getElementById("expression-wrapper") || document.body;
  if (!target) return;

  expressionObserver = new MutationObserver(() => {
    scheduleExpressionUpdate();
  });

  expressionObserver.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "data-expression", "title"],
  });

  // Push initial state when connected and observer starts.
  scheduleExpressionUpdate();
}

// ---------------------------------------------------------------------------
// Autocomplete cache
//
// Character and group lists: TTL-based (60 s). Cheap to rebuild and change
// infrequently, so a short TTL is the right fit.
//
// Chat list: keyed by characterId, invalidated on newchat/switchchar/
// switchgroup. Switching characters is automatically a cache miss; the
// explicit invalidation handles chats added within the same character session.
// ---------------------------------------------------------------------------

const AUTOCOMPLETE_CACHE_TTL_MS = 60_000;

const autocompleteCache = {
  characters: null, // { names: string[], cachedAt: number } | null
  groups: null, // { names: string[], cachedAt: number } | null
};

const chatCache = {}; // { [characterId]: { names: string[] } }

/**
 * Invalidates the chat cache for the active character (or entirely if none
 * is selected). Call after any operation that changes chat state.
 */
function invalidateChatCache() {
  const ctx = SillyTavern.getContext();
  if (ctx.characterId !== undefined) {
    delete chatCache[ctx.characterId];
  } else {
    for (const key of Object.keys(chatCache)) delete chatCache[key];
  }
}

// ---------------------------------------------------------------------------
// Intro message capture
//
// /newchat greetings are inserted into the chat DOM before any generation
// events fire, so the normal streaming path never sees them. A
// MutationObserver on #chat collects AI .mes elements as they appear and
// forwards each one (text + images) as an intro_message packet.
//
// In group chat every member may have a greeting, so the observer stays
// connected until either the expected member count is reached or a short
// settling timer (INTRO_SETTLE_MS) fires after the DOM goes quiet.
// A 10-second hard timeout prevents a permanent listener leak if ST never
// adds any messages at all.
// ---------------------------------------------------------------------------

function captureAndSendIntroMessage(chatId) {
  const chatEl = document.getElementById("chat");
  if (!chatEl || !chatId || ws?.readyState !== WebSocket.OPEN) return;

  const ctx = SillyTavern.getContext();
  const activeGroup = ctx.groupId
    ? (ctx.groups || []).find((g) => g.id === ctx.groupId)
    : null;
  const expectedCount = activeGroup?.members?.length ?? 1;

  const seen = new Set();
  const INTRO_SETTLE_MS = 600;

  const isIntroMessage = (el) =>
    el.classList.contains("mes") && el.getAttribute("is_user") !== "true";

  const collectNew = () => {
    const fresh = [];
    for (const el of chatEl.querySelectorAll(".mes")) {
      if (isIntroMessage(el) && !seen.has(el)) {
        seen.add(el);
        fresh.push(el);
      }
    }
    return fresh;
  };

  const sendOne = async (mesEl) => {
    const mesText = mesEl.querySelector(".mes_text");
    if (!mesText) return;
    const text = extractTextFromMesText(mesText);
    if (text && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "intro_message", chatId, text }));
    }
    await sendImagesFromMesText(chatId, mesText);
  };

  let settleTimeoutId = null;
  let hardTimeoutId = null;
  let observer = null;

  const flush = async (settleId) => {
    observer.disconnect();
    clearTimeout(hardTimeoutId);
    clearTimeout(settleId);
    for (const el of collectNew()) await sendOne(el);
  };

  const onMutation = async () => {
    const fresh = collectNew();
    if (!fresh.length) return;

    for (const el of fresh) await sendOne(el);

    if (seen.size >= expectedCount) {
      flush(settleTimeoutId);
      return;
    }

    clearTimeout(settleTimeoutId);
    settleTimeoutId = setTimeout(() => flush(null), INTRO_SETTLE_MS);
  };

  observer = new MutationObserver(onMutation);
  observer.observe(chatEl, { childList: true, subtree: true });

  hardTimeoutId = setTimeout(() => {
    observer.disconnect();
    clearTimeout(settleTimeoutId);
    console.warn("[Discord Bridge] Intro message capture timed out");
  }, 10_000);

  // Run immediately in case doNewChat populated the DOM synchronously.
  onMutation();
}

// ---------------------------------------------------------------------------
// AI image generation
//
// Sends an image_placeholder immediately, fires /sd, then watches #chat for
// a new img.mes_img element. The observer snapshots existing srcs before the
// command fires so only genuinely new images are forwarded.
// Requests are serialised per Discord channel to prevent overlapping /sd calls
// within the same conversation while still allowing other channels to proceed.
// ---------------------------------------------------------------------------

const IMAGE_GENERATION_TIMEOUT_MS = 3 * 60 * 1000;
const IMAGE_QUEUE_WATCHDOG_MS = IMAGE_GENERATION_TIMEOUT_MS + 10_000;
const IMAGE_RATE_LIMIT_WINDOW_MS = 60_000;
const IMAGE_RATE_LIMIT_MAX_REQUESTS = 3;
const IMAGE_BREAKER_THRESHOLD = 3;
const IMAGE_BREAKER_COOLDOWN_MS = 2 * 60 * 1000;

const imageQueues = new Map();
const activeImageJobs = new Map();
const imageRateHistory = new Map();
const imageCircuitState = new Map();
const imageMetrics = {
  totalRequests: 0,
  succeeded: 0,
  timedOut: 0,
  failed: 0,
  canceled: 0,
  rateLimited: 0,
  breakerRejected: 0,
  breakerTrips: 0,
  inFlight: 0,
  maxConcurrentInFlight: 0,
  lastError: null,
  lastErrorAt: null,
};

function makeImageRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function sendImageError(chatId, requestId, text) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: "generate_image_error",
      chatId,
      requestId,
      text,
    }),
  );
}

function pruneImageRateHistory(chatId) {
  const now = Date.now();
  const history = imageRateHistory.get(chatId) || [];
  const pruned = history.filter((ts) => now - ts < IMAGE_RATE_LIMIT_WINDOW_MS);
  imageRateHistory.set(chatId, pruned);
  return pruned;
}

function getBreakerState(chatId) {
  const state = imageCircuitState.get(chatId);
  if (!state) return null;
  if (Date.now() >= state.openUntil) {
    imageCircuitState.delete(chatId);
    return null;
  }
  return state;
}

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
          }, IMAGE_QUEUE_WATCHDOG_MS);

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
function generateAndSendImage(chatId, requestId, prompt) {
  return new Promise(async (resolve) => {
    const chatEl = document.getElementById("chat");
    if (!chatEl || ws?.readyState !== WebSocket.OPEN) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "generate_image_error",
            chatId,
            requestId,
            text: "Could not find the SillyTavern chat element.",
          }),
        );
      }
      return resolve({ status: "failed", reason: "chat_element_missing" });
    }

    const existingSrcs = new Set(
      Array.from(chatEl.querySelectorAll("img.mes_img"))
        .map((img) => img.getAttribute("src"))
        .filter(Boolean),
    );

    let hardTimeoutId = null;
    let observer = null;
    let settled = false;

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
          sendImageError(chatId, requestId, "Image generation cancelled.");
        });
      },
    };
    activeImageJobs.set(chatId, cancelJob);

    const onNewImage = async (src) => {
      const fetched = await fetchLocalImageAsBase64(src);
      if (!fetched) {
        finish("failed", "image_fetch_failed", () => {
          sendImageError(
            chatId,
            requestId,
            "Image was generated but could not be fetched from SillyTavern.",
          );
        });
        return;
      }
      finish("success", null, () => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "generate_image_result",
              chatId,
              requestId,
              image: { type: "inline", ...fetched },
            }),
          );
        }
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
          `[Discord Bridge] Image generation timed out after ${IMAGE_GENERATION_TIMEOUT_MS / 1000}s.`,
        );
        sendImageError(
          chatId,
          requestId,
          "Image generation timed out. Please try again.",
        );
      });
    }, IMAGE_GENERATION_TIMEOUT_MS);

    try {
      await executeSlashCommandsWithOptions(`/sd ${prompt}`);
    } catch (err) {
      finish("failed", "sd_command_failed", () => {
        console.error("[Discord Bridge] /sd command failed:", err);
        sendImageError(
          chatId,
          requestId,
          `Image generation failed: ${err.message || "Unknown error"}`,
        );
      });
    }
  });
}

// ---------------------------------------------------------------------------
// WebSocket message handlers
// ---------------------------------------------------------------------------

/**
 * Handles user_message: injects the text into ST, hooks generation lifecycle
 * events to stream tokens to the bridge, and sends the final reply.
 *
 * All event listeners are registered here and removed in every exit path
 * (normal completion, user stop, error) to prevent leaks across sessions.
 */
async function handleUserMessage(data) {
  lastActiveChatId = data.chatId || lastActiveChatId;
  const messageState = { chatId: data.chatId, isStreaming: false };

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({ type: "typing_action", chatId: messageState.chatId }),
    );
  }

  await sendMessageAsUser(data.text);

  let currentStreamId = null;
  let currentCharacterName = null;

  const streamCallback = (cumulativeText) => {
    if (!currentStreamId || ws?.readyState !== WebSocket.OPEN) return;
    messageState.isStreaming = true;
    ws.send(
      JSON.stringify({
        type: "stream_chunk",
        chatId: messageState.chatId,
        streamId: currentStreamId,
        characterName: currentCharacterName,
        text: cumulativeText,
      }),
    );
  };
  eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

  const sendStreamEnd = () => {
    if (
      messageState.isStreaming &&
      currentStreamId &&
      ws?.readyState === WebSocket.OPEN
    ) {
      const isGroup = !!SillyTavern.getContext().groupId;

      // Read chat[i].mes rather than relying on the server's pendingText (last
      // raw streaming token). ST applies sentence-completion trimming to mes
      // after generation ends, so pendingText may contain a trailing fragment
      // that ST discarded. Null if the chat array hasn't flushed yet; the server
      // falls back to pendingText in that case.
      let finalText = null;
      try {
        const { chat } = SillyTavern.getContext();
        if (chat?.length) {
          for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg.is_user) break;
            if (
              !isGroup ||
              !currentCharacterName ||
              msg.name === currentCharacterName
            ) {
              if (msg.mes?.trim()) {
                finalText = msg.mes.trim();
                break;
              }
            }
          }
        }
      } catch (err) {
        console.warn(
          "[Discord Bridge] Could not read final text from chat array:",
          err,
        );
      }

      ws.send(
        JSON.stringify({
          type: "stream_end",
          chatId: messageState.chatId,
          streamId: currentStreamId,
          characterName: isGroup ? currentCharacterName : null,
          finalText,
        }),
      );
    }
    messageState.isStreaming = false;
    currentStreamId = null;
  };

  // Walks the chat array backwards to collect all consecutive AI messages
  // since the last user turn, then sends them as a single ai_reply payload.
  // Also forwards any images embedded in the last AI message (post-generation
  // art, etc.). Not awaited so text reaches Discord first.
  const collectAndSendReplies = () => {
    if (!messageState.chatId || ws?.readyState !== WebSocket.OPEN) return;
    const { chat } = SillyTavern.getContext();
    if (!chat || chat.length < 2) return;

    const aiMessages = [];
    for (let i = chat.length - 1; i >= 0; i--) {
      const msg = chat[i];
      if (msg.is_user) break;
      if (msg.mes?.trim())
        aiMessages.unshift({ name: msg.name || "", text: msg.mes.trim() });
    }

    if (aiMessages.length > 0) {
      ws.send(
        JSON.stringify({
          type: "ai_reply",
          chatId: messageState.chatId,
          messages: aiMessages,
        }),
      );
    } else {
      ws.send(
        JSON.stringify({
          type: "error_message",
          chatId: messageState.chatId,
          text: "Something went wrong and no response was found. Try again?",
        }),
      );
    }

    sendLastMessageImages(messageState.chatId);
  };

  // Assigns a new streamId at the start of each character turn so the bridge
  // maintains separate streaming messages per character in group chat.
  const onGenerationStarted = () => {
    currentStreamId = `${messageState.chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const ctx = SillyTavern.getContext();
    currentCharacterName = ctx.groupId ? ctx.name2 || null : null;
  };
  eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

  const removeAllListeners = () => {
    eventSource.removeListener(
      event_types.STREAM_TOKEN_RECEIVED,
      streamCallback,
    );
    eventSource.removeListener(
      event_types.GENERATION_STARTED,
      onGenerationStarted,
    );
    eventSource.removeListener(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.removeListener(GROUP_WRAPPER_FINISHED, onGroupFinished);
    eventSource.removeListener(
      event_types.GENERATION_STOPPED,
      onGenerationStopped,
    );
  };

  // Fires once per character turn. Closes their stream on Discord.
  // In solo chat (GROUP_WRAPPER_FINISHED never fires) also triggers the final
  // ai_reply after a brief delay to let the chat array settle.
  const onGenerationEnded = () => {
    sendStreamEnd();
    if (!SillyTavern.getContext().groupId) {
      removeAllListeners();
      setTimeout(collectAndSendReplies, 100);
    }
  };
  eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

  // Fires once after all group members have finished generating.
  const onGroupFinished = () => {
    removeAllListeners();
    setTimeout(collectAndSendReplies, 100);
  };
  eventSource.on(GROUP_WRAPPER_FINISHED, onGroupFinished);

  // User aborted - clean up without sending a reply.
  const onGenerationStopped = () => {
    removeAllListeners();
    sendStreamEnd();
  };
  eventSource.once(event_types.GENERATION_STOPPED, onGenerationStopped);

  try {
    const abortController = new AbortController();
    setExternalAbortController(abortController);
    await Generate("normal", { signal: abortController.signal });
  } catch (error) {
    console.error("[Discord Bridge] Generation error:", error);
    await deleteLastMessage();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "error_message",
          chatId: messageState.chatId,
          text: `Generation failed. Your message was retracted - try again.\n\nError: ${error.message || "Unknown"}`,
        }),
      );
    }
    removeAllListeners();
    sendStreamEnd();
  }
}

// ---------------------------------------------------------------------------
// Chat recap
//
// After a successful character, group, or chat switch, a recap_message packet
// is sent to the bridge once the new chat has fully loaded. The bridge renders
// it as a styled embed on Discord and plain text on other platforms.
// ---------------------------------------------------------------------------

const RECAP_MAX_AI_MESSAGES = 10;

/**
 * Walks the chat array backwards to find the last user message and all AI
 * messages that follow it (the last complete exchange). Returns an object
 * with the entries array and the user's display name, or null if the chat
 * has no user messages yet (e.g. only a greeting).
 *
 * @param {Array} chat
 * @returns {{entries: Array<{name: string, text: string, isUser: boolean}>, userLabel: string}|null}
 */
function buildLastExchange(chat) {
  if (!Array.isArray(chat) || chat.length === 0) return null;

  // Collect trailing AI messages first (everything after the last user turn).
  const aiMessages = [];
  let i = chat.length - 1;
  while (i >= 0 && !chat[i].is_user) {
    const msg = chat[i];
    if (msg.mes?.trim())
      aiMessages.unshift({
        name: msg.name || "",
        text: msg.mes.trim(),
        isUser: false,
      });
    i--;
  }

  // i now points at the last user message, or -1 if there is none.
  if (i < 0) return null;

  const userMsg = chat[i];
  if (!userMsg.mes?.trim()) return null;

  const userLabel = userMsg.name?.trim() || "You";

  // Cap AI messages to avoid flooding on very large groups.
  const cappedAi = aiMessages.slice(-RECAP_MAX_AI_MESSAGES);
  const truncated = aiMessages.length > RECAP_MAX_AI_MESSAGES;

  const entries = [
    { name: userLabel, text: userMsg.mes.trim(), isUser: true },
    ...cappedAi,
  ];

  if (truncated) {
    entries.push({
      name: "",
      text: `_${aiMessages.length - RECAP_MAX_AI_MESSAGES} earlier message(s) not shown — use /history to see more._`,
      isUser: false,
    });
  }

  return { entries, userLabel };
}

/**
 * Walks the chat array to collect the last n exchanges (user message + all
 * following AI messages), oldest first. Skips the greeting (index 0 if it's
 * an AI message with no preceding user message). Returns an entries array
 * ready for a recap_message packet, or null if there is nothing to show.
 *
 * @param {Array} chat
 * @param {number} n  Number of exchanges to collect (0 = all).
 * @returns {Array<{name: string, text: string, isUser: boolean}>|null}
 */
function buildHistory(chat, n) {
  if (!Array.isArray(chat) || chat.length === 0) return null;

  // Walk backwards collecting complete exchanges (user msg + trailing AI msgs).
  const exchanges = [];
  let i = chat.length - 1;

  while (i >= 0) {
    // Collect trailing AI messages for this exchange.
    const aiMessages = [];
    while (i >= 0 && !chat[i].is_user) {
      const msg = chat[i];
      if (msg.mes?.trim())
        aiMessages.unshift({ name: msg.name || "", text: msg.mes.trim(), isUser: false });
      i--;
    }

    // Now i should point at a user message.
    if (i < 0) break;

    const userMsg = chat[i];
    i--;

    if (!userMsg.mes?.trim()) continue;

    const userLabel = userMsg.name?.trim() || "You";
    exchanges.unshift([
      { name: userLabel, text: userMsg.mes.trim(), isUser: true },
      ...aiMessages,
    ]);

    if (n > 0 && exchanges.length >= n) break;
  }

  if (exchanges.length === 0) return null;
  return exchanges.flat();
}

/**
 * Registers a one-shot chatLoaded listener and sends a recap_message packet
 * to the bridge once the new chat's context is available.
 * Called immediately after a successful switch so the listener is scoped
 * tightly to the chat load we just triggered.
 *
 * @param {string} chatId
 */
function scheduleRecap(chatId) {
  eventSource.once(event_types.CHAT_LOADED, () => {
    const { chat } = SillyTavern.getContext();
    const result = buildLastExchange(chat);
    if (!result) return;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "recap_message",
          chatId,
          entries: result.entries,
        }),
      );
    }
  });
}

/**
 * Handles execute_command: runs the requested slash command against
 * SillyTavern's APIs and sends an ai_reply with the result text.
 */
async function handleExecuteCommand(data) {
  lastActiveChatId = data.chatId || lastActiveChatId;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "typing_action", chatId: data.chatId }));
  }

  let replyText = "Command execution failed, try again later.";
  const context = SillyTavern.getContext();

  try {
    switch (data.command) {
      case "newchat":
        await doNewChat({ deleteCurrentChat: false });
        invalidateChatCache();
        captureAndSendIntroMessage(data.chatId);
        replyText = "New chat started.";
        break;

      case "listchars": {
        const characters = context.characters.filter((c) => c.name?.trim());
        replyText =
          characters.length === 0
            ? "No available characters found."
            : "Available characters:\n\n" +
              characters
                .map((c, i) => `${i + 1}. /switchchar_${i + 1} - ${c.name}`)
                .join("\n") +
              "\n\nUse /switchchar_number or /switchchar character_name to switch.";
        break;
      }

      case "switchchar": {
        if (!data.args?.length) {
          replyText = "Usage: /switchchar <n> or /switchchar_number";
          break;
        }
        const targetName = data.args.join(" ");
        const target = context.characters.find((c) => c.name === targetName);
        if (target) {
          scheduleRecap(data.chatId);
          await selectCharacterById(context.characters.indexOf(target));
          invalidateChatCache();
          replyText = `Switched to "${targetName}".`;
        } else {
          replyText = `Character "${targetName}" not found.`;
        }
        break;
      }

      case "listgroups": {
        const allGroups = context.groups || [];
        replyText =
          allGroups.length === 0
            ? "No groups found."
            : "Available groups:\n\n" +
              allGroups
                .map((g, i) => `${i + 1}. /switchgroup_${i + 1} - ${g.name}`)
                .join("\n") +
              "\n\nUse /switchgroup_number or /switchgroup group_name to switch.";
        break;
      }

      case "switchgroup": {
        if (!data.args?.length) {
          replyText = "Usage: /switchgroup <n> or /switchgroup_number";
          break;
        }
        const targetName = data.args.join(" ");
        const target = (context.groups || []).find(
          (g) => g.name === targetName,
        );
        if (target) {
          scheduleRecap(data.chatId);
          await executeSlashCommandsWithOptions(`/go ${target.name}`);
          invalidateChatCache();
          replyText = `Switched to group "${targetName}".`;
        } else {
          replyText = `Group "${targetName}" not found.`;
        }
        break;
      }

      case "listchats": {
        if (context.characterId === undefined) {
          replyText = "Please select a character first.";
          break;
        }
        const chatFiles = await getPastCharacterChats(context.characterId);
        replyText =
          chatFiles.length === 0
            ? "No chat history for current character."
            : "Chat history:\n\n" +
              chatFiles
                .map(
                  (c, i) =>
                    `${i + 1}. /switchchat_${i + 1} - ${c.file_name.replace(".jsonl", "")}`,
                )
                .join("\n") +
              "\n\nUse /switchchat_number or /switchchat chat_name to switch.";
        break;
      }

      case "switchchat": {
        if (!data.args?.length) {
          replyText = "Usage: /switchchat <n>";
          break;
        }
        const targetChatFile = data.args.join(" ");
        try {
          scheduleRecap(data.chatId);
          await openCharacterChat(targetChatFile);
          replyText = `Loaded chat: ${targetChatFile}`;
        } catch {
          replyText = `Failed to load chat "${targetChatFile}". Check the name is exact.`;
        }
        break;
      }

      case "charimage": {
        // In solo chat, no argument needed - active character's avatar is sent.
        // In group chat, an argument selects which member to show; if omitted,
        // lists the group members instead.
        const ctx = SillyTavern.getContext();
        const isGroup = !!ctx.groupId;
        const targetName = data.args?.join(" ").trim() || null;

        if (targetName) {
          const target = ctx.characters.find(
            (c) => c.name?.toLowerCase() === targetName.toLowerCase(),
          );
          if (!target) {
            replyText = `Character "${targetName}" not found.`;
            break;
          }
          sendCharacterAvatar(data.chatId, target); // async, not awaited
          replyText = `Sending avatar for **${target.name}**…`;
        } else if (isGroup) {
          const activeGroup = (ctx.groups || []).find(
            (g) => g.id === ctx.groupId,
          );
          const memberNames = (activeGroup?.members || [])
            .map(
              (id) =>
                ctx.characters.find((ch) => ch.id === id)?.name?.trim() || null,
            )
            .filter(Boolean);
          replyText = memberNames.length
            ? "Group members:\n\n" +
              memberNames.map((n) => `\u2022 ${n}`).join("\n") +
              "\n\nUse /charimage <n> to see a member's avatar."
            : "No members found in the current group.";
        } else {
          if (
            ctx.characterId === undefined ||
            !ctx.characters?.[ctx.characterId]
          ) {
            replyText = "No character is currently selected.";
            break;
          }
          sendCharacterAvatar(data.chatId, ctx.characters[ctx.characterId]); // async, not awaited
          replyText = `Sending avatar for **${ctx.characters[ctx.characterId].name}**…`;
        }
        break;
      }

      case "mood": {
        const requestedName = data.args?.join(" ").trim() || null;
        let snapshot = await getCurrentExpressionSnapshot(true);
        let usedCachedSnapshot = false;
        if (!snapshot) {
          if (requestedName) {
            const cached = getCachedExpressionSnapshot(requestedName);
            if (!cached) {
              replyText =
                "No active expression is available right now, and no stored mood exists for that character yet.";
              break;
            }
            snapshot = cached;
            usedCachedSnapshot = true;
          } else {
            replyText =
              "No active expression is available right now. Make sure expressions are enabled in SillyTavern.";
            break;
          }
        }

        if (requestedName) {
          const owner = snapshot.ownerName || "(unknown)";
          if (
            !snapshot.ownerName ||
            snapshot.ownerName.toLowerCase() !== requestedName.toLowerCase()
          ) {
            const cached = getCachedExpressionSnapshot(requestedName);
            if (!cached) {
              replyText =
                `Current visible mood is for **${owner}** (` +
                `**${snapshot.expression}**). ` +
                `Mood for **${requestedName}** is not currently visible in SillyTavern and has not been seen yet.`;
              break;
            }
            snapshot = cached;
            usedCachedSnapshot = true;
          }
        }

        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "expression_update",
              expression: snapshot.expression,
              ownerName: snapshot.ownerName || null,
              chatId: data.chatId,
              image: snapshot.image,
            }),
          );
        }

        const ownerPrefix = snapshot.ownerName
          ? `**${snapshot.ownerName}**: `
          : "";
        const cachedNote = usedCachedSnapshot ? " (last known mood)" : "";
        replyText = snapshot.image
          ? `Current mood: ${ownerPrefix}**${snapshot.expression}**${cachedNote} (image sent).`
          : `Current mood: ${ownerPrefix}**${snapshot.expression}**${cachedNote} (no expression image available).`;
        break;
      }

      case "reaction": {
        if (!data.args?.length) {
          replyText = "Usage: /reaction <mode>\nModes: off, status, full";
          break;
        }

        const mode = String(data.args[0] || "")
          .trim()
          .toLowerCase();
        if (!EXPRESSION_MODE_VALUES.has(mode)) {
          replyText = "Invalid mode. Use one of: off, status, full.";
          break;
        }

        getSettings().expressionMode = mode;
        saveSettingsDebounced();
        lastExpressionSignature = "";
        scheduleExpressionUpdate(data.chatId);

        const modeLabel =
          mode === "off"
            ? "Off"
            : mode === "status"
              ? "Discord status only"
              : "Discord status + expression images";
        replyText = `Reaction mode set to: **${modeLabel}**.`;
        break;
      }

      case "image": {
        if (!data.args?.length) {
          replyText =
            "Usage: /image <prompt> or /image <keyword>\nKeywords: you, face, me, scene, last, raw_last, background\nUse /image cancel to stop an active generation.";
          break;
        }

        const prompt = data.args.join(" ").trim();
        const lowerPrompt = prompt.toLowerCase();

        if (lowerPrompt === "cancel") {
          const activeJob = activeImageJobs.get(data.chatId);
          if (!activeJob) {
            replyText = "No active image generation to cancel.";
            break;
          }

          activeJob.cancel();
          imageMetrics.canceled += 1;
          replyText = "Cancelled active image generation.";
          break;
        }

        const breakerState = getBreakerState(data.chatId);
        if (breakerState) {
          imageMetrics.breakerRejected += 1;
          const seconds = Math.ceil(
            (breakerState.openUntil - Date.now()) / 1000,
          );
          replyText = `Image generation is temporarily paused after repeated failures. Try again in ~${seconds}s.`;
          break;
        }

        const requestHistory = pruneImageRateHistory(data.chatId);
        if (requestHistory.length >= IMAGE_RATE_LIMIT_MAX_REQUESTS) {
          imageMetrics.rateLimited += 1;
          replyText =
            "Too many image requests in a short time. Please wait a minute and try again.";
          break;
        }

        requestHistory.push(Date.now());
        imageRateHistory.set(data.chatId, requestHistory);

        const requestId = makeImageRequestId();
        imageMetrics.totalRequests += 1;

        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "image_placeholder",
              chatId: data.chatId,
              requestId,
              text: "🎨 Generating image… (timeout: 3 minutes; use /image cancel to abort)",
            }),
          );
        }

        // Queue and return early - generate_image_result/error sends its own packets.
        enqueueImageGeneration(data.chatId, async () => {
          imageMetrics.inFlight += 1;
          imageMetrics.maxConcurrentInFlight = Math.max(
            imageMetrics.maxConcurrentInFlight,
            imageMetrics.inFlight,
          );

          const result = await generateAndSendImage(
            data.chatId,
            requestId,
            prompt,
          );
          imageMetrics.inFlight = Math.max(0, imageMetrics.inFlight - 1);

          if (result?.status === "success") {
            imageMetrics.succeeded += 1;
            markImageSuccess(data.chatId);
          } else if (result?.status === "timed_out") {
            imageMetrics.timedOut += 1;
            markImageFailure(data.chatId, "Image generation timed out");
          } else if (result?.status === "cancelled") {
            // /image cancel increments canceled immediately for user feedback.
          } else {
            imageMetrics.failed += 1;
            markImageFailure(
              data.chatId,
              result?.reason || "Image generation failed unexpectedly",
            );
          }
        });
        return;
      }

      case "continue": {
        const { chat: chatBefore } = SillyTavern.getContext();
        const lastMsgBefore = [...chatBefore]
          .reverse()
          .find((m) => !m.is_user && m.mes?.trim());
        const textBefore = lastMsgBefore?.mes?.trim() ?? "";

        await executeSlashCommandsWithOptions("/continue await=true");

        const { chat: chatAfter } = SillyTavern.getContext();
        const lastMsgAfter = [...chatAfter]
          .reverse()
          .find((m) => !m.is_user && m.mes?.trim());
        const textAfter = lastMsgAfter?.mes?.trim() ?? "";

        const newText = textAfter.startsWith(textBefore)
          ? textAfter.slice(textBefore.length).trim()
          : textAfter;

        replyText = newText || "Continuation returned nothing.";
        break;
      }

      case "impersonate": {
        const prompt = data.args?.[0] ?? "";
        await executeSlashCommandsWithOptions(
          prompt
            ? `/impersonate await=true ${prompt}`
            : "/impersonate await=true",
        );
        const impersonatedText = String($("#send_textarea").val()).trim();
        if (impersonatedText) {
          $("#send_textarea").val("").trigger("input");
          replyText = `💭 *Suggested response* _(feel free to copy, edit and send as your own)_:\n${impersonatedText}`;
        } else {
          replyText = "Impersonation returned nothing.";
        }
        break;
      }

      case "listpersonas": {
        const personas = Object.values(
          SillyTavern.getContext().powerUserSettings?.personas ?? {},
        ).filter((n) => n?.trim());
        replyText =
          personas.length > 0
            ? "Available personas:\n\n" +
              personas.map((n, i) => `${i + 1}. ${n}`).join("\n")
            : "No personas found.";
        break;
      }

      case "persona": {
        const personaName = data.args?.[0] ?? "";
        if (!personaName) {
          replyText = "Please provide a persona name. Example: `/persona Aria`";
          break;
        }
        await executeSlashCommandsWithOptions(`/persona-set ${personaName}`);
        replyText = `Persona set to: _${personaName}_`;
        break;
      }

      case "note": {
        const noteText = data.args?.[0] ?? "";
        if (noteText) {
          await executeSlashCommandsWithOptions(`/note ${noteText}`);
          replyText = `Author's note set to: _${noteText}_`;
        } else {
          const current =
            SillyTavern.getContext().chatMetadata?.note_prompt ?? "";
          replyText = current
            ? `Current author's note: _${current}_`
            : "No author's note is currently set.";
        }
        break;
      }

      case "status": {
        const breakerState = getBreakerState(data.chatId);
        const activeCharacter =
          context.characterId !== undefined
            ? context.characters?.[context.characterId]?.name || "(unknown)"
            : "(none)";
        const activeGroup = context.groupId
          ? (context.groups || []).find((g) => g.id === context.groupId)
              ?.name || "(unknown)"
          : "(none)";

        let lastErrorText = "";
        if (imageMetrics.lastError) {
          const errorTime = new Date(imageMetrics.lastErrorAt);
          const minutesAgo = Math.floor(
            (Date.now() - imageMetrics.lastErrorAt) / 60000,
          );
          const timeString =
            minutesAgo < 1
              ? "Just now"
              : minutesAgo < 60
                ? `${minutesAgo}m ago`
                : minutesAgo < 1440
                  ? `${Math.floor(minutesAgo / 60)}h ${minutesAgo % 60}m ago`
                  : errorTime.toLocaleString();
          lastErrorText = `\n**⚠️ Last error:**\n> \`${imageMetrics.lastError}\`\n> _${timeString}_`;
        }

        const PLATFORM_LABELS = {
          discord: "Discord",
          telegram: "Telegram",
          signal: "Signal",
        };
        const PLATFORM_ICONS = {
          active: "🟢",
          not_loaded: "⚫",
          inactive: "🔴",
        };
        const platformLine = bridgePlugins
          ? Object.entries(bridgePlugins)
              .map(
                ([p, s]) =>
                  `${PLATFORM_LABELS[p] || p} ${PLATFORM_ICONS[s] || "⚫"}`,
              )
              .join(" | ")
          : "Unknown";

        replyText =
          "## 🐲 __Bridge Status:__\n" +
          `**Connection:** ${ws?.readyState === WebSocket.OPEN ? "🟢 Online" : "🔴 Offline"}\n` +
          `**Plugins:** ${platformLine}\n` +
          `**Active:** ${activeGroup !== "(none)" ? `👥 Group: ${activeGroup}` : activeCharacter !== "(none)" ? `👤 ${activeCharacter}` : "_Nothing loaded_"}\n` +
          `**Mood snapshots cached:** ${expressionCache.size}\n\n` +
          "**🖼️ Image Generation**\n" +
          `> **Status:** ${!breakerState ? "✅ Ready" : `⏸️ Paused - cooling down (${Math.ceil((breakerState.openUntil - Date.now()) / 1000)}s left, will resume automatically)`}\n` +
          `> **Queue:** ${imageQueues.has(data.chatId) ? "⏳ Pending images" : "✅ Empty"}\n` +
          `> **Currently generating:** ${activeImageJobs.has(data.chatId) ? "⚙️ Yes" : "-"}\n\n` +
          "**📊 Image Stats** _(since last restart)_\n" +
          `> ✅ Succeeded: **${imageMetrics.succeeded}** / ✨ Total requested: **${imageMetrics.totalRequests}**\n` +
          `> ❌ Failed: **${imageMetrics.failed}** | ⏱️ Timed out: **${imageMetrics.timedOut}** | 🚫 Rate limited: **${imageMetrics.rateLimited}**\n` +
          `> 🛑 Canceled: **${imageMetrics.canceled}** | ⚡ Concurrent now: **${imageMetrics.inFlight}** (peak: **${imageMetrics.maxConcurrentInFlight}**)\n` +
          `> 🔁 Overload trips: **${imageMetrics.breakerTrips}** | 🚧 Requests blocked during cooldown: **${imageMetrics.breakerRejected}**\n` +
          lastErrorText;
        break;
      }

      case "sthelp":
        replyText =
          "## 🐲 __Bridge Commands:__\n" +
          "**System & Status**\n" +
          "> `/sthelp` - Show this menu\n" +
          "> `/status` - Check bridge and image pipeline health\n" +
          "> `/reaction <mode>` - Set mode (`off`, `status`, `full`)\n\n" +
          "**Management**\n" +
          "> `/listchars` | `/listgroups` - List available characters/groups\n" +
          "> `/switchchar` | `/switchgroup` - Switch character/group\n" +
          "> `/newchat` - Start a new chat with the active character or group\n" +
          "> `/listchats` | `/switchchat` - List and switch to previous chat\n" +
          "> `/history [n]` - Show last n exchanges (default: 5, omit n for all)\n" +
          "> *💡 Tip: You can also use `_#` (e.g., `/switchchar_3`) to select by index.*\n\n" +
          "**Immersion & Mood**\n" +
          "> `/mood` - Show character expression\n" +
          "> `/charimage` - Show character's avatar\n" +
          "> `/note <text>` - Set the author's note for the current chat; omit text to read the current note\n" +
          "> `/persona <name>` - Switch your active persona by name\n" +
          "> `/listpersonas` - List your available personas\n" +
          "> `/impersonate [prompt]` - Have the AI write your next response in character, with an optional guiding prompt\n" +
          "> `/continue` - Continue the last AI message\n\n" +
          "**Image Generation**\n" +
          "> `/image <prompt or keyword>` - Generate AI image (Keywords: `you`, `face`, `me`, `scene`, `last`, `raw_last`, `background`)\n" +
          "> `/image cancel` - Abort active image generation\n\n" +
          "~~                                                                                                                                          ~~\n" +
          "*Developed by **Senjin the Dragon** - <https://github.com/senjinthedragon>*\n" +
          "*Please support my work:* <https://github.com/sponsors/senjinthedragon>";
        break;

      case "history": {
        const { chat } = SillyTavern.getContext();
        const n = data.args?.length ? Math.max(0, parseInt(data.args[0]) || 0) : 5;
        const entries = buildHistory(chat, n);
        if (!entries) {
          replyText = "No chat history found.";
          break;
        }
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "recap_message",
            chatId: data.chatId,
            entries,
          }));
        }
        replyText = `Showing last ${n > 0 ? n : "all"} exchange(s).`;
        break;
      }

      default: {
        const charMatch = data.command.match(/^switchchar_(\d+)$/);
        if (charMatch) {
          const index = parseInt(charMatch[1]) - 1;
          const characters = context.characters.filter((c) => c.name?.trim());
          if (index >= 0 && index < characters.length) {
            const target = characters[index];
            scheduleRecap(data.chatId);
            await selectCharacterById(context.characters.indexOf(target));
            invalidateChatCache();
            replyText = `Switched to "${target.name}".`;
          } else {
            replyText = `Invalid number: ${index + 1}. Use /listchars to see options.`;
          }
          break;
        }

        const chatMatch = data.command.match(/^switchchat_(\d+)$/);
        if (chatMatch) {
          if (context.characterId === undefined) {
            replyText = "Please select a character first.";
            break;
          }
          const index = parseInt(chatMatch[1]) - 1;
          const chatFiles = await getPastCharacterChats(context.characterId);
          if (index >= 0 && index < chatFiles.length) {
            const chatName = chatFiles[index].file_name.replace(".jsonl", "");
            try {
              scheduleRecap(data.chatId);
              await openCharacterChat(chatName);
              replyText = `Loaded chat: ${chatName}`;
            } catch {
              replyText = "Failed to load chat.";
            }
          } else {
            replyText = `Invalid number: ${index + 1}. Use /listchats to see options.`;
          }
          break;
        }

        const groupMatch = data.command.match(/^switchgroup_(\d+)$/);
        if (groupMatch) {
          const index = parseInt(groupMatch[1]) - 1;
          const groups = context.groups || [];
          if (index >= 0 && index < groups.length) {
            scheduleRecap(data.chatId);
            await executeSlashCommandsWithOptions(`/go ${groups[index].name}`);
            invalidateChatCache();
            replyText = `Switched to group "${groups[index].name}".`;
          } else {
            replyText = `Invalid number: ${index + 1}. Use /listgroups to see options.`;
          }
          break;
        }

        replyText = `Unknown command: /${data.command}. Try /sthelp for available commands.`;
      }
    }
  } catch (error) {
    console.error("[Discord Bridge] Command error:", error);
    replyText = `Error executing command: ${error.message || "Unknown error"}`;
  }

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "ai_reply",
        chatId: data.chatId,
        text: replyText,
      }),
    );
  }
}

/**
 * Handles get_autocomplete: queries ST's live context for the requested list
 * type, filters by the user's partial input, and replies with up to 25 choices.
 *
 * Character/group lists are served from a TTL cache. Chat lists are served from
 * a per-character cache that's invalidated by chat-state-changing commands.
 */
async function handleGetAutocomplete(data) {
  let allNames = [];
  try {
    const context = SillyTavern.getContext();
    const now = Date.now();

    // Sorts a name list alphabetically, ignoring leading emoji and non-letter
    // characters so that e.g. "🌟 Alice" sorts alongside "Alice" rather than
    // after all plain-ASCII names.
    const sortAlpha = (names) =>
      [...names].sort((a, b) =>
        a
          .replace(/^[^\p{L}]+/u, "")
          .localeCompare(b.replace(/^[^\p{L}]+/u, ""), undefined, {
            sensitivity: "base",
          }),
      );

    if (data.list === "characters") {
      if (
        autocompleteCache.characters &&
        now - autocompleteCache.characters.cachedAt < AUTOCOMPLETE_CACHE_TTL_MS
      ) {
        allNames = autocompleteCache.characters.names;
      } else {
        allNames = context.characters
          .map((c) => c.name)
          .filter((n) => n?.trim());
        autocompleteCache.characters = { names: allNames, cachedAt: now };
      }
    } else if (data.list === "groups") {
      if (
        autocompleteCache.groups &&
        now - autocompleteCache.groups.cachedAt < AUTOCOMPLETE_CACHE_TTL_MS
      ) {
        allNames = autocompleteCache.groups.names;
      } else {
        allNames = (context.groups || [])
          .map((g) => g.name)
          .filter((n) => n?.trim());
        autocompleteCache.groups = { names: allNames, cachedAt: now };
      }
    } else if (data.list === "chats") {
      // Only meaningful when a character is selected; empty list otherwise.
      // Sorted newest-first using the raw filename (which is lexicographically
      // ordered by timestamp), then reformatted for display using the timezone
      // pushed from the bridge on connect.
      if (context.characterId !== undefined) {
        if (chatCache[context.characterId]) {
          allNames = chatCache[context.characterId].names;
        } else {
          const chatFiles = await getPastCharacterChats(context.characterId);

          // Parse "Name - YYYY-MM-DD@HHhMMmSSsXXXms" into a Date for display.
          // Returns null if the filename doesn't match the expected pattern.
          const parseChatFilename = (name) => {
            const m = name.match(
              /(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m(\d{2})s(\d+)ms$/,
            );
            if (!m) return null;
            const [, yr, mo, dy, hr, mn, sc, ms] = m;
            return new Date(Date.UTC(+yr, +mo - 1, +dy, +hr, +mn, +sc, +ms));
          };

          const fmt = (() => {
            const tz = bridgeTimezone;
            const opts = {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
              ...(tz ? { timeZone: tz } : {}),
            };
            try {
              return new Intl.DateTimeFormat(bridgeLocale || undefined, opts);
            } catch {
              return new Intl.DateTimeFormat(undefined, {
                ...opts,
                timeZone: undefined,
              });
            }
          })();

          // Produce {name, value} pairs: name is the human-readable label
          // shown in Discord's dropdown; value is the raw filename that ST
          // uses to actually load the chat.
          allNames = chatFiles
            .map((c) => c.file_name.replace(".jsonl", ""))
            .filter((n) => n?.trim())
            // Sort newest-first by raw filename - the timestamp suffix is
            // lexicographically ordered so no date parsing is needed here.
            .sort((a, b) => b.localeCompare(a))
            .map((raw) => {
              const date = parseChatFilename(raw);
              if (!date) return { name: raw, value: raw };
              // Replace the raw timestamp suffix with a human-readable label,
              // keeping the raw filename as the value ST receives on selection.
              const prefix = raw.replace(
                / - \d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d+ms$/,
                "",
              );
              return { name: `${prefix} - ${fmt.format(date)}`, value: raw };
            });

          chatCache[context.characterId] = { names: allNames };
        }
      }
    } else if (data.list === "image_prompts") {
      // Static keyword list - no caching needed.
      allNames = [
        "you",
        "face",
        "me",
        "scene",
        "last",
        "raw_last",
        "background",
        "cancel",
      ];
    } else if (data.list === "personas") {
      // Always fresh - persona list is small and changes rarely.
      allNames = Object.values(
        context.powerUserSettings?.personas ?? {},
      ).filter((n) => n?.trim());
    } else if (data.list === "group_members") {
      if (!context.groupId) {
        // Solo chat - offer the active character's name as the only option.
        const soloChar =
          context.characters?.[context.characterId]?.name?.trim();
        if (soloChar) allNames = [soloChar];
      } else {
        // Read directly from the rendered group members panel and sort
        // alphabetically, consistent with the other name lists.
        const memberEls = document.querySelectorAll(
          "#rm_group_members .group_member .ch_name",
        );
        allNames = sortAlpha(
          Array.from(memberEls)
            .map((el) => el.textContent.trim())
            .filter(Boolean),
        );
      }
    }
  } catch (err) {
    // Fall through with empty choices rather than leaving Discord's dropdown on a spinner.
    console.error("[Discord Bridge] Autocomplete error:", err);
  }

  const query = (data.query || "").toLowerCase();
  // allNames entries are either plain strings (all lists except chats) or
  // {name, value} objects (chats, where the display label differs from the
  // raw filename that SillyTavern needs to load the chat). Normalise here so
  // websocket.js always receives a consistent {name, value} array.
  const choices = allNames
    .filter((entry) => {
      const label = typeof entry === "string" ? entry : entry.name;
      return label.toLowerCase().includes(query);
    })
    .slice(0, 25)
    .map((entry) =>
      typeof entry === "string" ? { name: entry, value: entry } : entry,
    );

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "autocomplete_response",
        requestId: data.requestId,
        choices,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connect() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  )
    return;

  shouldReconnect = true;

  const settings = getSettings();
  if (!settings.bridgeUrl) {
    updateStatus("URL not set!", "red");
    return;
  }

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  updateStatus("Connecting...", "orange");
  ws = new WebSocket(settings.bridgeUrl);

  ws.onopen = () => {
    updateStatus("Connected", "green");
    console.log("[Discord Bridge] Connected to bridge server");
    lastExpressionSignature = "";
    setupExpressionObserver();
    scheduleExpressionUpdate(lastActiveChatId);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "heartbeat" }));
    }, 30000);
  };

  ws.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);

      if (data.type === "heartbeat") return;

      if (data.type === "bridge_config") {
        // Validate timezone and locale before storing - invalid values would
        // cause Intl.DateTimeFormat to throw at autocomplete time.
        if (data.timezone) {
          try {
            Intl.DateTimeFormat(undefined, { timeZone: data.timezone });
            bridgeTimezone = data.timezone;
          } catch {
            console.warn(
              `[Discord Bridge] Invalid timezone in bridge config: "${data.timezone}" - falling back to local time`,
            );
            bridgeTimezone = null;
          }
        } else {
          bridgeTimezone = null;
        }
        if (data.locale) {
          try {
            Intl.DateTimeFormat(data.locale);
            bridgeLocale = data.locale;
          } catch {
            console.warn(
              `[Discord Bridge] Invalid locale in bridge config: "${data.locale}" - falling back to browser locale`,
            );
            bridgeLocale = null;
          }
        } else {
          bridgeLocale = null;
        }
        bridgePlugins = data.plugins || null;
        return;
      }

      if (data.type === "user_message") {
        await handleUserMessage(data);
        return;
      }

      if (data.type === "system_command") {
        if (data.command === "reload_ui_only")
          setTimeout(() => window.location.reload(), 500);
        return;
      }

      if (data.type === "get_autocomplete") {
        await handleGetAutocomplete(data);
        return;
      }

      if (data.type === "execute_command") {
        await handleExecuteCommand(data);
        return;
      }
    } catch (error) {
      console.error("[Discord Bridge] Message handling error:", error);
      if (data?.chatId && ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "error_message",
            chatId: data.chatId,
            text: "Internal error processing request.",
          }),
        );
      }
    }
  };

  ws.onclose = () => {
    updateStatus("Disconnected", "red");
    ws = null;

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    const settings = getSettings();
    if (settings.autoConnect && shouldReconnect) {
      updateStatus("Reconnecting...", "orange");
      if (!reconnectTimeout) {
        reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null;
          connect();
        }, 5000);
      }
    }
  };

  ws.onerror = (error) => {
    console.error("[Discord Bridge] WebSocket error:", error);
    updateStatus("Connection error", "red");
  };
}

function disconnect() {
  shouldReconnect = false;
  if (ws) ws.close();
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  updateStatus("Disconnected", "red");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

jQuery(async () => {
  try {
    const settingsHtml = await $.get(
      `/scripts/extensions/third-party/${MODULE_NAME}/settings.html`,
    );
    $("#extensions_settings").append(settingsHtml);

    const settings = getSettings();
    $("#discord_bridge_url").val(settings.bridgeUrl);
    $("#discord_auto_connect").prop("checked", settings.autoConnect);
    $("#discord_expression_mode").val(settings.expressionMode);

    $("#discord_bridge_url").on("input", () => {
      getSettings().bridgeUrl = $("#discord_bridge_url").val();
      saveSettingsDebounced();
    });

    $("#discord_auto_connect").on("change", () => {
      getSettings().autoConnect = $("#discord_auto_connect").prop("checked");
      saveSettingsDebounced();
    });

    $("#discord_expression_mode").on("change", () => {
      getSettings().expressionMode = $("#discord_expression_mode").val();
      lastExpressionSignature = "";
      saveSettingsDebounced();
      scheduleExpressionUpdate(lastActiveChatId);
    });

    $("#discord_connect_button").on("click", connect);
    $("#discord_disconnect_button").on("click", disconnect);

    if (settings.autoConnect) connect();
  } catch (error) {
    console.error("[Discord Bridge] Failed to load settings UI:", error);
  }
});
