/**
 * index.js - SillyTavern Discord Connector: Browser Extension
 * Copyright (c) 2026 Senjin the Dragon. MIT License.
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
 *   the browser — where same-origin access is always available — and sent as
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
 *   Requests are serialised through imageQueue to prevent overlapping /sd calls.
 *
 * Autocomplete:
 *   Character and group lists are cached with a 60-second TTL. Chat lists are
 *   keyed by characterId and invalidated on newchat/switchchar/switchgroup
 *   rather than by TTL, keeping them perfectly current.
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
};

// String fallback covers older ST versions that don't export this event type.
const GROUP_WRAPPER_FINISHED =
  event_types.GROUP_WRAPPER_FINISHED ?? "group_wrapper_finished";

let ws = null;
let shouldReconnect = true;
let reconnectTimeout = null;
let heartbeatInterval = null;

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getSettings() {
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
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

    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    if (blob.size > MAX_IMAGE_BYTES) {
      console.warn(
        `[Discord Bridge] Image too large (${(blob.size / 1024 / 1024).toFixed(1)} MB, limit 8 MB): ${url}`,
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
  const src = `/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}`;
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
// Requests are serialised through imageQueue to prevent overlapping /sd calls.
// ---------------------------------------------------------------------------

let imageQueue = Promise.resolve();

/** Wraps fn() in the image queue so /sd calls never overlap. */
function enqueueImageGeneration(fn) {
  imageQueue = imageQueue
    .then(() => fn())
    .catch((err) => {
      console.error("[Discord Bridge] Image generation queue error:", err);
    });
}

/**
 * Executes /sd and relays the resulting image to the bridge.
 * Resolves after sending generate_image_result or generate_image_error.
 *
 * @param {string} chatId
 * @param {string} prompt
 * @returns {Promise<void>}
 */
function generateAndSendImage(chatId, prompt) {
  return new Promise(async (resolve) => {
    const IMAGE_GENERATION_TIMEOUT_MS = 20 * 60 * 1000;

    const chatEl = document.getElementById("chat");
    if (!chatEl || ws?.readyState !== WebSocket.OPEN) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "generate_image_error",
            chatId,
            text: "Could not find the SillyTavern chat element.",
          }),
        );
      }
      return resolve();
    }

    const existingSrcs = new Set(
      Array.from(chatEl.querySelectorAll("img.mes_img"))
        .map((img) => img.getAttribute("src"))
        .filter(Boolean),
    );

    let hardTimeoutId = null;
    let observer = null;
    let settled = false;

    const finish = (cleanupFn) => {
      if (settled) return;
      settled = true;
      if (observer) observer.disconnect();
      clearTimeout(hardTimeoutId);
      cleanupFn();
      resolve();
    };

    const onNewImage = async (src) => {
      finish(() => {});
      const fetched = await fetchLocalImageAsBase64(src);
      if (!fetched) {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "generate_image_error",
              chatId,
              text: "Image was generated but could not be fetched from SillyTavern.",
            }),
          );
        }
        return;
      }
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "generate_image_result",
            chatId,
            image: { type: "inline", ...fetched },
          }),
        );
      }
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
      finish(() => {
        console.warn(
          "[Discord Bridge] Image generation timed out after 20 minutes.",
        );
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "generate_image_error",
              chatId,
              text: "Image generation timed out (20 minutes). SillyTavern may still be processing.",
            }),
          );
        }
      });
    }, IMAGE_GENERATION_TIMEOUT_MS);

    try {
      await executeSlashCommandsWithOptions(`/sd ${prompt}`);
    } catch (err) {
      finish(() => {
        console.error("[Discord Bridge] /sd command failed:", err);
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "generate_image_error",
              chatId,
              text: `Image generation failed: ${err.message || "Unknown error"}`,
            }),
          );
        }
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
      ws.send(
        JSON.stringify({
          type: "stream_end",
          chatId: messageState.chatId,
          streamId: currentStreamId,
          characterName: isGroup ? currentCharacterName : null,
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

  // User aborted — clean up without sending a reply.
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

/**
 * Handles execute_command: runs the requested slash command against
 * SillyTavern's APIs and sends an ai_reply with the result text.
 */
async function handleExecuteCommand(data) {
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
          await openCharacterChat(targetChatFile);
          replyText = `Loaded chat: ${targetChatFile}`;
        } catch {
          replyText = `Failed to load chat "${targetChatFile}". Check the name is exact.`;
        }
        break;
      }

      case "charimage": {
        // In solo chat, no argument needed — active character's avatar is sent.
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

      case "image": {
        if (!data.args?.length) {
          replyText =
            "Usage: /image <prompt> or /image <keyword>\nKeywords: you, face, me, scene, last, raw_last, background";
          break;
        }
        const prompt = data.args.join(" ").trim();
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "image_placeholder",
              chatId: data.chatId,
              text: "🎨 Generating image…",
            }),
          );
        }
        // Queue and return early — generate_image_result/error sends its own packets.
        enqueueImageGeneration(() => generateAndSendImage(data.chatId, prompt));
        return;
      }

      case "sthelp":
        replyText =
          "Available commands:\n" +
          "/sthelp - Show this help message\n" +
          "/newchat - Start a new chat\n" +
          "/listchars - List all characters\n" +
          "/switchchar <n> or /switchchar_# - Switch character\n" +
          "/listgroups - List all groups\n" +
          "/switchgroup <n> or /switchgroup_# - Switch group\n" +
          "/listchats - List chat history for current character\n" +
          "/switchchat <n> or /switchchat_# - Load a past chat\n" +
          "/charimage [name] - Show a character's avatar (optional in solo chat, autocompletes in group chat)\n" +
          "/image <prompt or keyword> - Generate an AI image. Keywords: you, face, me, scene, last, raw_last, background";
        break;

      default: {
        const charMatch = data.command.match(/^switchchar_(\d+)$/);
        if (charMatch) {
          const index = parseInt(charMatch[1]) - 1;
          const characters = context.characters.filter((c) => c.name?.trim());
          if (index >= 0 && index < characters.length) {
            const target = characters[index];
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
      if (context.characterId !== undefined) {
        if (chatCache[context.characterId]) {
          allNames = chatCache[context.characterId].names;
        } else {
          const chatFiles = await getPastCharacterChats(context.characterId);
          allNames = chatFiles
            .map((c) => c.file_name.replace(".jsonl", ""))
            .filter((n) => n?.trim());
          chatCache[context.characterId] = { names: allNames };
        }
      }
    } else if (data.list === "image_prompts") {
      // Static keyword list — no caching needed.
      allNames = [
        "you",
        "face",
        "me",
        "scene",
        "last",
        "raw_last",
        "background",
      ];
    } else if (data.list === "group_members") {
      // Only active group members, not the full character library.
      // Empty in solo chat — correct, since the dropdown doesn't appear there.
      const activeGroup = (context.groups || []).find(
        (g) => g.id === context.groupId,
      );
      if (activeGroup?.members?.length) {
        allNames = activeGroup.members
          .map(
            (id) =>
              context.characters.find((c) => c.id === id)?.name?.trim() || null,
          )
          .filter(Boolean);
      }
    }
  } catch (err) {
    // Fall through with empty choices rather than leaving Discord's dropdown on a spinner.
    console.error("[Discord Bridge] Autocomplete error:", err);
  }

  const query = (data.query || "").toLowerCase();
  const choices = allNames
    .filter((n) => n.toLowerCase().includes(query))
    .slice(0, 25);

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

    $("#discord_bridge_url").on("input", () => {
      getSettings().bridgeUrl = $("#discord_bridge_url").val();
      saveSettingsDebounced();
    });

    $("#discord_auto_connect").on("change", () => {
      getSettings().autoConnect = $("#discord_auto_connect").prop("checked");
      saveSettingsDebounced();
    });

    $("#discord_connect_button").on("click", connect);
    $("#discord_disconnect_button").on("click", disconnect);

    if (settings.autoConnect) connect();
  } catch (error) {
    console.error("[Discord Bridge] Failed to load settings UI:", error);
  }
});
