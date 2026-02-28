/**
 * index.js - SillyTavern Discord Connector: Browser Extension
 *
 * Runs inside SillyTavern as a third-party extension. Bridges the SillyTavern
 * UI and the bridge server (server.js) over a WebSocket connection.
 *
 * Responsibilities:
 *   - Receives user messages from Discord (via the bridge) and injects them
 *     into SillyTavern as if typed by the user.
 *   - Hooks SillyTavern's generation lifecycle events to forward streaming
 *     tokens and final replies back to the bridge for posting on Discord.
 *   - Handles slash commands from Discord (/sthelp, /listchars, /switchchar, etc.)
 *     by interacting with SillyTavern's character and chat APIs.
 *
 * Autocomplete requests (get_autocomplete) are handled separately from normal
 * commands. The bridge sends a requestId and the list type ("characters",
 * "groups", or "chats"); the extension queries SillyTavern's live context,
 * filters by the user's partial input, and replies with autocomplete_response.
 * Chat lists require an async getPastCharacterChats call; all other lists are
 * read synchronously from context. Results are capped at 25 entries, which is
 * Discord's hard limit for autocomplete choices.
 *
 * To avoid redundant work on every keystroke, autocomplete results are cached.
 * Character and group lists use a 60-second TTL: they change infrequently but
 * unpredictably (a user may add one in the ST UI at any time), so a short
 * time-based expiry is the right fit. Chat lists are invalidated on specific
 * known events instead: newchat, switchchar, switchgroup, and their numbered
 * variants are the only operations that change which chats exist or which
 * character's chats should be shown. This means chat autocomplete is always
 * perfectly current without ever hitting disk more than once per relevant action.
 *
 * Streaming architecture:
 *   Each character turn is assigned a unique streamId at GENERATION_STARTED.
 *   STREAM_TOKEN_RECEIVED events forward cumulative text to the bridge, which
 *   throttles Discord edits to respect rate limits. When GENERATION_ENDED fires,
 *   a stream_end message tells the bridge to replace the streaming message with
 *   a clean final copy. Group chats include the character's name; solo chats do not.
 *
 * Image relay:
 *   SillyTavern messages can contain embedded images (AI-generated art, intro
 *   scene images, external links). Because the bridge server may run on a
 *   different machine than SillyTavern, local ST images are fetched here in
 *   the browser (same-origin access is always available) and base64-encoded
 *   before being sent to the bridge as inline data. External URLs are passed
 *   through as-is for the bridge to fetch directly. This split means image
 *   delivery works regardless of network topology.
 *
 * Intro messages:
 *   When /newchat starts a fresh chat, SillyTavern inserts a character greeting
 *   into the chat DOM before any generation occurs. This is not surfaced by the
 *   normal generation events, so a MutationObserver watches #chat for the first
 *   AI message and forwards it (text + images) as an intro_message packet.
 *
 * AI image generation (/image command):
 *   The /image slash command forwards a prompt or keyword to SillyTavern's /sd
 *   command (stable diffusion; /image and /img are aliases). Because generation
 *   can take seconds to minutes depending on hardware, the flow is:
 *     1. An image_placeholder packet is sent immediately so the bridge can post
 *        a "🎨 Generating image…" message in Discord while the user waits.
 *     2. A MutationObserver on #chat watches for any new img.mes_img element
 *        whose src was not present before the command fired. This works for both
 *        DOM layouts ST may use (image in a new .mes, or injected into an
 *        existing one).
 *     3. When the image appears it is fetched via fetchLocalImageAsBase64 (same
 *        path as all other local ST images) and sent as generate_image_result.
 *        The bridge then deletes the placeholder and posts the image.
 *     4. On failure or timeout (20 minutes) a generate_image_error packet is
 *        sent instead, and the bridge edits the placeholder to show the error.
 *   Requests are serialised through imageQueue so concurrent /image calls and
 *   overlapping chat generations never fire /sd into ST simultaneously.
 *
 * Listener hygiene:
 *   All per-message event listeners are registered inside the user_message
 *   handler and removed in every exit path (normal completion, stop, error)
 *   to prevent leaking across conversation switches or chat mode changes.
 */

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

const MODULE_NAME = "SillyTavern-Discord-Connector";

// Resolved once at load time. The string fallback covers older ST versions
// that don't export this event type by name.
const GROUP_WRAPPER_FINISHED =
  event_types.GROUP_WRAPPER_FINISHED ?? "group_wrapper_finished";
const DEFAULT_SETTINGS = {
  bridgeUrl: "ws://127.0.0.1:2333",
  autoConnect: true,
};

let ws = null;
let shouldReconnect = true;
let reconnectTimeout = null;
let heartbeatInterval = null;

// ---------------------------------------------------------------------------
// Autocomplete cache
//
// Caches the full (unfiltered) name lists used by autocomplete so that repeated
// keystrokes don't re-query SillyTavern's context or disk on every request.
//
// Character and group lists are cached with a time-to-live of
// AUTOCOMPLETE_CACHE_TTL_MS. They change infrequently - a user might add a
// character or group occasionally - so a 60-second window means at most a
// minute of staleness after a change made in the ST UI, which is acceptable.
//
// The chat list is not TTL-based. It is keyed by characterId (so switching
// characters automatically yields a cache miss) and is invalidated explicitly
// after any command that changes the chat state: newchat creates a new chat,
// switchchar and switchgroup change which character's chats are relevant, and
// their numbered variants do the same. This keeps the cache perfectly in sync
// with the bot's own actions without any TTL guesswork.
//
// Each entry: { names: string[], cachedAt: number }
// chatCache entry: { names: string[] }  (no TTL - invalidation is event-driven)
// ---------------------------------------------------------------------------

const AUTOCOMPLETE_CACHE_TTL_MS = 60_000;

const autocompleteCache = {
  characters: null, // { names: string[], cachedAt: number } | null
  groups: null, // { names: string[], cachedAt: number } | null
};

// Keyed by characterId so a character switch is automatically a cache miss.
const chatCache = {}; // { [characterId]: { names: string[] } }

/** Clears the chat cache for the currently selected character, or entirely
 *  if no character is selected. Called after any command that creates a new
 *  chat or changes which character is active. */
function invalidateChatCache() {
  const ctx = SillyTavern.getContext();
  if (ctx.characterId !== undefined) {
    delete chatCache[ctx.characterId];
  } else {
    // No character selected - wipe everything to be safe.
    for (const key of Object.keys(chatCache)) delete chatCache[key];
  }
}

// ---------------------------------------------------------------------------
// Image relay and intro-message helpers
//
// SillyTavern messages may embed images in two ways: local resources served
// by the ST web process itself (thumbnails, AI-generated art saved to disk,
// character avatars via /thumbnail?...) and external URLs pointing to CDNs
// or image hosts like imgur.
//
// The bridge server may run on a different machine than SillyTavern, so it
// cannot be relied upon to reach ST-local URLs. The extension, however,
// always runs inside the ST browser page and has unrestricted same-origin
// access. The strategy is therefore:
//
//   Local images  → fetched here in the browser, base64-encoded, sent to
//                   the bridge as { type: "inline", data, mimeType, filename }.
//                   The bridge decodes and uploads to Discord without making
//                   any outbound HTTP request of its own.
//
//   External URLs → passed through as { type: "url", url }. The bridge
//                   fetches them directly; they are publicly reachable and
//                   may be large enough that routing them through the
//                   WebSocket would be wasteful.
//
// Classification happens on the raw src value before any resolution, so the
// original string is preserved for accurate same-origin comparison.
// ---------------------------------------------------------------------------

/**
 * Classifies an image src as local (served by ST itself) or external.
 *
 * Local means: relative paths, protocol-relative, or absolute URLs that share
 * the same origin as the ST web UI. These are only reachable from the browser
 * running the extension - the bridge server may be on a different machine and
 * cannot fetch them.
 *
 * External means: absolute http(s):// URLs pointing to a different origin
 * (e.g. imgur, CDNs). The bridge can fetch these directly.
 *
 * @param {string} src - Raw src attribute value.
 * @returns {"local"|"external"|null}
 */
function classifyImageSrc(src) {
  if (!src) return null;
  if (/^data:/i.test(src)) return "local"; // inline data URI - treat as local blob
  if (src.startsWith("//")) return "external"; // protocol-relative → always external CDN
  if (/^https?:\/\//i.test(src)) {
    // Same origin means local; anything else is external.
    try {
      return new URL(src).origin === window.location.origin
        ? "local"
        : "external";
    } catch {
      return "external";
    }
  }
  // Relative or root-relative path → local ST resource.
  return "local";
}

/**
 * Resolves a local ST image src to a full absolute URL on the same origin.
 *
 * Called only after classifyImageSrc has confirmed the src is local, so
 * protocol-relative and relative paths can be safely assumed to belong to
 * the ST origin. Keeping resolution separate from classification means
 * classification always operates on the original src value.
 *
 * @param {string} src
 * @returns {string}
 */
function resolveLocalUrl(src) {
  if (/^https?:\/\//i.test(src)) return src; // already absolute same-origin
  if (src.startsWith("//")) return window.location.protocol + src;
  return window.location.origin + (src.startsWith("/") ? "" : "/") + src;
}

/**
 * Fetches a local ST image and returns it as a base64-encoded object ready to
 * embed in a send_images WebSocket packet.
 *
 * The extension runs inside the ST browser page, so it has unrestricted
 * same-origin access regardless of whether ST is exposed to the network.
 * This lets us relay images to the bridge server even when the user is
 * remote (e.g. on a laptop away from home with only Discord access).
 *
 * @param {string} src - Raw image src (local).
 * @returns {Promise<{data: string, mimeType: string, filename: string}|null>}
 */
async function fetchLocalImageAsBase64(src) {
  try {
    // data: URIs don't need fetching - decode them directly.
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

    // Discord's file upload limit is 8 MB on standard servers (25 MB with
    // Nitro boost). Reject anything larger before wasting time encoding it
    // and potentially overflowing the WebSocket frame.
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    if (blob.size > MAX_IMAGE_BYTES) {
      console.warn(
        `[Discord Bridge] Image too large to relay ` +
          `(${(blob.size / 1024 / 1024).toFixed(1)} MB, limit 8 MB): ${url}`,
      );
      return null;
    }

    // Derive a filename from the URL path. /thumbnail?type=avatar&file=X.png
    // needs special handling because the path component is just "thumbnail"
    // with no extension; the meaningful name is in the file query parameter.
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

    // Convert blob → base64 via FileReader.
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
 * Extracts all image srcs from a .mes_text element.
 *
 * Returns the raw src attribute values without resolving them so that
 * classifyImageSrc can operate on the original strings. Resolution to
 * absolute URLs is deferred to fetchLocalImageAsBase64 for local images
 * and is not needed at all for external URLs.
 *
 * @param {Element} mesTextEl
 * @returns {string[]} Raw src attribute values (unresolved).
 */
function extractImageSrcsFromMesText(mesTextEl) {
  if (!mesTextEl) return [];
  return Array.from(mesTextEl.querySelectorAll("img"))
    .map((img) => img.getAttribute("src"))
    .filter(Boolean);
}

/**
 * Extracts the plain text content from a .mes_text element, stripping HTML
 * tags but preserving paragraph breaks.
 *
 * @param {Element} mesTextEl - The .mes_text DOM element.
 * @returns {string} Plain text.
 */
function extractTextFromMesText(mesTextEl) {
  if (!mesTextEl) return "";
  // Clone so we don't mutate the live DOM.
  const clone = mesTextEl.cloneNode(true);
  // Replace <p> and <br> with newlines before getting innerText so paragraph
  // structure is preserved.
  for (const p of clone.querySelectorAll("p")) {
    p.insertAdjacentText("afterend", "\n\n");
  }
  for (const br of clone.querySelectorAll("br")) {
    br.replaceWith("\n");
  }
  return clone.innerText?.replace(/\n{3,}/g, "\n\n").trim() || "";
}

/**
 * Collects images from a list of raw src values, fetching local ones via the
 * browser and passing external URLs through for the bridge to fetch itself.
 *
 * Returns a mixed array of:
 *   { type: "inline", data, mimeType, filename }  ← local, already fetched
 *   { type: "url",    url }                        ← external, bridge fetches
 *
 * @param {string[]} srcs - Raw src attribute values.
 * @returns {Promise<Array>}
 */
async function collectImages(srcs) {
  const results = await Promise.all(
    srcs.map(async (src) => {
      const kind = classifyImageSrc(src);
      if (!kind) return null;
      if (kind === "local") {
        const fetched = await fetchLocalImageAsBase64(src);
        if (!fetched) return null;
        return { type: "inline", ...fetched };
      }
      // External: hand the URL to the bridge.
      return { type: "url", url: src };
    }),
  );
  return results.filter(Boolean);
}

/**
 * Sends a collected image list to the bridge for posting on Discord.
 *
 * Kept as a standalone function so that sendCharacterAvatar can bypass
 * the collectImages pipeline and send a single pre-fetched inline image
 * without the overhead of src extraction and classification.
 *
 * @param {string} chatId
 * @param {Array} images - Output of collectImages(), or a manually constructed
 *   array of { type: "inline", ... } / { type: "url", ... } descriptors.
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
 * Extracts, classifies, and relays all images found in a .mes_text element.
 *
 * Composes extractImageSrcsFromMesText → collectImages → sendCollectedImages.
 * Local images are fetched by the browser before the packet is sent; external
 * URLs are passed through for the bridge to retrieve. Exits early if the
 * element contains no images so callers do not need to check first.
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
 * Sends the avatar image of a character to Discord.
 *
 * The avatar is served by ST via /thumbnail?type=avatar&file=<filename> and
 * is therefore always a local resource fetched by the extension.
 *
 * @param {string} chatId
 * @param {object} character - A SillyTavern character object.
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
 * Scans the last AI message in the chat DOM for images and sends them to Discord.
 *
 * Called at the tail of collectAndSendReplies to catch images that SillyTavern
 * adds to a message after generation: either automatically (if ST is configured
 * to generate art after each reply) or on demand when the user requests one.
 * In both cases ST inserts an <img> into the message HTML after the text has
 * already been sent to the chat array, so this DOM-based scan is the only
 * reliable way to detect them.
 *
 * The function is async because local images must be fetched via the browser,
 * but callers deliberately do not await it: text replies reach Discord first
 * and images trail behind independently without blocking the reply pipeline.
 *
 * @param {string} chatId
 */
async function sendLastMessageImages(chatId) {
  const messages = document.querySelectorAll("#chat .mes");
  if (!messages.length) return;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage.getAttribute("is_user") === "true") return;
  const mesText = lastMessage.querySelector(".mes_text");
  await sendImagesFromMesText(chatId, mesText);
}

/**
 * Captures all introductory greetings that SillyTavern places in the chat
 * after /newchat and forwards them (text + any embedded images) to Discord.
 *
 * In solo chat, one AI .mes element appears for the single character's
 * greeting. In group chat, SillyTavern inserts one .mes per group member in
 * sequence - each character's greeting is a separate DOM element and must
 * all be captured and forwarded individually.
 *
 * Intro messages are written directly into the chat DOM as pre-existing AI
 * turns; they are never produced by the generation pipeline and so fire none
 * of the GENERATION_STARTED/ENDED events the normal reply path depends on.
 * A MutationObserver on #chat is used to detect arrivals instead.
 *
 * Settling strategy:
 *   The observer stays connected after the first message arrives, accumulating
 *   all messages as they are added. A short settling timer (INTRO_SETTLE_MS)
 *   is (re)started on each new arrival and only fires when the DOM has been
 *   quiet for that window - at which point all intros are considered complete.
 *
 *   As an optimisation in group chat, the expected member count is read from
 *   context up front. If the collected message count reaches that number the
 *   observer disconnects immediately without waiting for the settling timer,
 *   giving a faster response when all members have greetings. The timer still
 *   provides the correct fallback when some members have no greeting defined.
 *
 * A hard 10-second timeout disconnects the observer regardless, preventing a
 * permanent listener leak if ST never adds any intro messages at all.
 *
 * @param {string} chatId
 */
function captureAndSendIntroMessage(chatId) {
  const chatEl = document.getElementById("chat");
  if (!chatEl || !chatId || ws?.readyState !== WebSocket.OPEN) return;

  // How many intro messages to expect. In group chat this is the number of
  // members in the active group; in solo chat it is 1. Used to short-circuit
  // the settling timer as soon as all greetings have arrived.
  const ctx = SillyTavern.getContext();
  const activeGroup = ctx.groupId
    ? (ctx.groups || []).find((g) => g.id === ctx.groupId)
    : null;
  const expectedCount = activeGroup?.members?.length ?? 1;

  // Track which .mes elements we have already seen so new arrivals can be
  // distinguished from messages that were present before /newchat ran.
  const seen = new Set();

  const isIntroMessage = (el) =>
    el.classList.contains("mes") && el.getAttribute("is_user") !== "true";

  // Collect all qualifying .mes elements currently in the DOM that have not
  // been seen yet. Returns the newly found elements.
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

  // Send one intro message element to Discord: text first, then images.
  const sendOne = async (mesEl) => {
    const mesText = mesEl.querySelector(".mes_text");
    if (!mesText) return;
    const text = extractTextFromMesText(mesText);
    if (text && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "intro_message", chatId, text }));
    }
    await sendImagesFromMesText(chatId, mesText);
  };

  // Flush all accumulated unsent messages and then shut down.
  // Called either when expectedCount is reached or when the settling timer
  // fires after a quiet period.
  //
  // Async so that each character's text and images are fully sent before the
  // next character's content is queued, keeping text and images interleaved
  // in the correct per-character order on Discord.
  const flush = async (observer, hardTimeoutId, settleTimeoutId) => {
    observer.disconnect();
    clearTimeout(hardTimeoutId);
    clearTimeout(settleTimeoutId);
    // collectNew() at flush time picks up anything added between the last
    // observer callback and this call, though in practice seen is already
    // current by the time either trigger fires.
    for (const el of collectNew()) await sendOne(el);
  };

  let settleTimeoutId = null;
  let hardTimeoutId = null;
  let observer = null;

  // How long to wait after the last new .mes before declaring all intros done.
  // 600 ms is enough to absorb ST's sequential group-intro rendering without
  // feeling sluggish to the Discord user.
  const INTRO_SETTLE_MS = 600;

  // Async so that each character's text is followed by its own images before
  // moving on to the next character. MutationObserver does not await its
  // callback, but that is fine - we only need sequential ordering within a
  // single invocation, not across separate mutation batches.
  const onMutation = async () => {
    const fresh = collectNew();
    if (!fresh.length) return;

    // Send each new message (text then images) in order so Discord output
    // stays correctly interleaved per character.
    for (const el of fresh) await sendOne(el);

    // Short-circuit: all expected greetings have arrived.
    if (seen.size >= expectedCount) {
      flush(observer, hardTimeoutId, settleTimeoutId);
      return;
    }

    // Reset the settling timer - more messages may still be coming.
    clearTimeout(settleTimeoutId);
    settleTimeoutId = setTimeout(
      () => flush(observer, hardTimeoutId, null),
      INTRO_SETTLE_MS,
    );
  };

  observer = new MutationObserver(onMutation);
  // subtree: true catches .mes elements whether ST adds them as direct
  // children of #chat or inside a wrapper element it inserts first.
  observer.observe(chatEl, { childList: true, subtree: true });

  // Hard timeout: disconnect even if no messages ever arrive (e.g. a character
  // with no greeting defined, or ST takes unexpectedly long to render).
  hardTimeoutId = setTimeout(() => {
    observer.disconnect();
    clearTimeout(settleTimeoutId);
    console.warn("[Discord Bridge] Intro message capture timed out");
  }, 10_000);

  // Run an immediate scan in case doNewChat populated messages synchronously
  // before the observer was installed.
  onMutation();
}

// ---------------------------------------------------------------------------
// Image generation queue
//
// Serialises /image requests so that two concurrent Discord users (or a rapid
// double-tap of the command) never fire overlapping /sd calls into SillyTavern.
// Each request is a link in a Promise chain; the next one only starts once the
// previous one has fully resolved or rejected (i.e. the image was sent or an
// error was reported).
//
// There is intentionally no separate check for "is chat generation in progress".
// Queuing here means the image request simply waits its turn in the Promise
// chain; if ST is already busy the /sd slash command will queue on ST's side
// as well, which is the correct behaviour.
// ---------------------------------------------------------------------------

let imageQueue = Promise.resolve();

/**
 * Wraps fn() in the image generation queue so requests never overlap.
 * @param {() => Promise<void>} fn
 */
function enqueueImageGeneration(fn) {
  imageQueue = imageQueue
    .then(() => fn())
    .catch((err) => {
      console.error("[Discord Bridge] Image generation queue error:", err);
    });
}

/**
 * Executes an /sd (image generation) command in SillyTavern and waits for the
 * resulting image to appear in the chat DOM, then relays it to the bridge.
 *
 * Detection strategy:
 *   A MutationObserver watches the entire #chat subtree for any new img.mes_img
 *   element. This works regardless of whether ST injects the image into a new
 *   .mes element or appends it to an existing one - both cases produce a new
 *   <img class="mes_img"> node in the subtree.
 *
 *   The observer records a snapshot of all existing img.mes_img srcs BEFORE the
 *   slash command fires so that only genuinely new images are forwarded, not ones
 *   that were already present from an earlier generation.
 *
 * Hard timeout:
 *   Image generation can take up to ~20 minutes on slow hardware. The observer
 *   is kept alive for IMAGE_GENERATION_TIMEOUT_MS and then abandoned, sending an
 *   error packet back to the bridge so the placeholder message can be updated.
 *
 * @param {string} chatId   - Discord channel ID, echoed in every response packet.
 * @param {string} prompt   - The prompt string or keyword passed to /sd.
 * @returns {Promise<void>}  Resolves when the image is sent or an error is reported.
 */
function generateAndSendImage(chatId, prompt) {
  return new Promise(async (resolve) => {
    // 20-minute hard timeout - generous enough for potato hardware.
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

    // Snapshot of img srcs already in the DOM before we fire the command.
    // Any img.mes_img whose src appears in this set is pre-existing and must
    // be ignored by the observer.
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

    // Called when a new img.mes_img appears in the DOM.
    const onNewImage = async (src) => {
      finish(() => {}); // Stop observing immediately - we have our image.

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

    // Watch the entire #chat subtree for new img.mes_img nodes.
    observer = new MutationObserver(() => {
      for (const img of chatEl.querySelectorAll("img.mes_img")) {
        const src = img.getAttribute("src");
        if (src && !existingSrcs.has(src)) {
          // Found a genuinely new generated image.
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

    // Hard timeout.
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

    // Fire the slash command. /sd, /image and /img are all aliases in ST.
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
// WebSocket connection
// ---------------------------------------------------------------------------

function connect() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

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

    // Start Heartbeat: Ping the server every 30 seconds to keep the connection alive
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 30000);
  };

  ws.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
      if (data.type === "heartbeat") return; // Ignore heartbeat responses

      // ------------------------------------------------------------------
      // user_message - a Discord user sent a message; generate a response.
      // ------------------------------------------------------------------
      if (data.type === "user_message") {
        // Per-message state object prevents race conditions between overlapping
        // requests (e.g. a slow generation and a fast follow-up message).
        const messageState = {
          chatId: data.chatId,
          isStreaming: false,
        };

        // Show the typing indicator in Discord immediately.
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "typing_action",
              chatId: messageState.chatId,
            }),
          );
        }

        await sendMessageAsUser(data.text);

        // Unique ID for this character's streaming session. Assigned fresh at
        // GENERATION_STARTED so each character in a group gets their own slot.
        let currentStreamId = null;
        let currentCharacterName = null;

        // Forward every cumulative token update to the bridge for throttled Discord edits.
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

        // Tell the bridge that this character's generation is done. The bridge
        // will delete the streaming message and repost it cleanly. In group chat
        // the character name is included so it can be shown as a bold header;
        // solo chat omits it.
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

        // Walk the chat array backwards to collect all consecutive AI messages
        // since the last user turn. Sends them as an ai_reply payload so the
        // bridge can post them on Discord (non-streaming path only).
        // Also checks the last AI message in the DOM for any embedded images
        // (AI-generated or character images) and forwards them to Discord.
        const collectAndSendReplies = () => {
          if (!messageState.chatId || ws?.readyState !== WebSocket.OPEN) return;
          const { chat } = SillyTavern.getContext();
          if (!chat || chat.length < 2) return;

          const aiMessages = [];
          for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg.is_user) break;
            if (msg.mes?.trim())
              aiMessages.unshift({
                name: msg.name || "",
                text: msg.mes.trim(),
              });
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

          // Forward any images embedded in the last AI message to Discord.
          // This covers both automatically generated images (when SillyTavern
          // is configured to auto-generate after each reply) and images the
          // user requested manually – in both cases ST inserts an <img> into
          // the message HTML which we detect and relay here.
          //
          // sendLastMessageImages is async (it fetches local images via the
          // browser) but we deliberately do not await it here: text replies
          // should reach Discord immediately, and image delivery can trail
          // behind without blocking anything.
          sendLastMessageImages(messageState.chatId);
        };

        // Assign a new streamId at the start of each character's turn so the
        // bridge can maintain separate streaming messages per character.
        const onGenerationStarted = () => {
          currentStreamId = `${messageState.chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const ctx = SillyTavern.getContext();
          // Only capture the name in group chat; solo messages have no name header.
          currentCharacterName = ctx.groupId ? ctx.name2 || null : null;
        };
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

        // Fires once per character turn. Closes their stream message on Discord.
        // In solo chat (GROUP_WRAPPER_FINISHED never fires) also triggers the
        // final ai_reply after a brief delay to let the chat array settle.
        const onGenerationEnded = () => {
          sendStreamEnd();

          const isGroup = !!SillyTavern.getContext().groupId;
          if (!isGroup) {
            eventSource.removeListener(
              event_types.GENERATION_STARTED,
              onGenerationStarted,
            );
            eventSource.removeListener(
              event_types.GENERATION_ENDED,
              onGenerationEnded,
            );
            eventSource.removeListener(GROUP_WRAPPER_FINISHED, onGroupFinished);
            eventSource.removeListener(
              event_types.GENERATION_STOPPED,
              onGenerationStopped,
            );
            setTimeout(collectAndSendReplies, 100);
          }
        };
        eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

        // Fires once after all group members have finished. Collects all replies
        // and sends them as a single ai_reply payload.
        const onGroupFinished = () => {
          eventSource.removeListener(
            event_types.GENERATION_STARTED,
            onGenerationStarted,
          );
          eventSource.removeListener(
            event_types.GENERATION_ENDED,
            onGenerationEnded,
          );
          eventSource.removeListener(GROUP_WRAPPER_FINISHED, onGroupFinished);
          eventSource.removeListener(
            event_types.GENERATION_STOPPED,
            onGenerationStopped,
          );
          setTimeout(collectAndSendReplies, 100);
        };
        eventSource.on(GROUP_WRAPPER_FINISHED, onGroupFinished);

        // Removes all listeners and closes any open stream. Defined after all
        // handler consts so their bindings are in scope when this runs.
        const cleanup = () => {
          eventSource.removeListener(
            event_types.STREAM_TOKEN_RECEIVED,
            streamCallback,
          );
          eventSource.removeListener(
            event_types.GENERATION_STARTED,
            onGenerationStarted,
          );
          eventSource.removeListener(
            event_types.GENERATION_ENDED,
            onGenerationEnded,
          );
          eventSource.removeListener(GROUP_WRAPPER_FINISHED, onGroupFinished);
          eventSource.removeListener(
            event_types.GENERATION_STOPPED,
            onGenerationStopped,
          );
          sendStreamEnd();
        };

        // User aborted generation - clean up without sending a reply.
        const onGenerationStopped = () => {
          eventSource.removeListener(
            event_types.GENERATION_STARTED,
            onGenerationStarted,
          );
          eventSource.removeListener(
            event_types.GENERATION_ENDED,
            onGenerationEnded,
          );
          eventSource.removeListener(GROUP_WRAPPER_FINISHED, onGroupFinished);
          eventSource.removeListener(
            event_types.GENERATION_STOPPED,
            onGenerationStopped,
          );
          cleanup();
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
          cleanup();
        }
        return;
      }

      // ------------------------------------------------------------------
      // system_command - internal signals from the bridge server.
      // ------------------------------------------------------------------
      if (data.type === "system_command") {
        if (data.command === "reload_ui_only") {
          setTimeout(() => window.location.reload(), 500);
        }
        return;
      }

      // ------------------------------------------------------------------
      // get_autocomplete - the bridge is asking for a live list to populate
      // a Discord autocomplete dropdown while the user is typing.
      //
      // data.list    "characters" | "groups" | "chats" | "group_members" |
      //              "image_prompts"
      // data.query   The partial string the user has typed so far. Used to
      //              filter results so the most relevant names appear first.
      //              An empty string returns all entries (up to 25).
      // data.requestId  Echoed back in the response so the bridge can match
      //              this reply to the correct parked interaction.
      //
      // Results are filtered case-insensitively against query and truncated
      // to 25 entries before sending, since Discord rejects any autocomplete
      // response with more than 25 choices.
      // ------------------------------------------------------------------
      if (data.type === "get_autocomplete") {
        let allNames = [];
        try {
          const context = SillyTavern.getContext();
          const now = Date.now();

          if (data.list === "characters") {
            // Serve from cache if fresh; otherwise rebuild from context and cache.
            if (
              autocompleteCache.characters &&
              now - autocompleteCache.characters.cachedAt <
                AUTOCOMPLETE_CACHE_TTL_MS
            ) {
              allNames = autocompleteCache.characters.names;
            } else {
              allNames = context.characters
                .map((c) => c.name)
                .filter((name) => name?.trim());
              autocompleteCache.characters = { names: allNames, cachedAt: now };
            }
          } else if (data.list === "groups") {
            // Same TTL-based strategy as characters.
            if (
              autocompleteCache.groups &&
              now - autocompleteCache.groups.cachedAt <
                AUTOCOMPLETE_CACHE_TTL_MS
            ) {
              allNames = autocompleteCache.groups.names;
            } else {
              allNames = (context.groups || [])
                .map((g) => g.name)
                .filter((name) => name?.trim());
              autocompleteCache.groups = { names: allNames, cachedAt: now };
            }
          } else if (data.list === "chats") {
            // Chat history is per-character, so the list is only meaningful
            // when a character is currently selected. If none is selected,
            // allNames stays empty and the dropdown will show nothing, which
            // is the correct behaviour - there is nothing to switch to.
            //
            // The chat cache is keyed by characterId so switching characters
            // is automatically a cache miss. Invalidation (via invalidateChatCache)
            // is triggered after newchat, switchchar, and switchgroup rather than
            // using a TTL, because those are the only operations that change
            // which chats exist or which character is active.
            if (context.characterId !== undefined) {
              if (chatCache[context.characterId]) {
                allNames = chatCache[context.characterId].names;
              } else {
                const chatFiles = await getPastCharacterChats(
                  context.characterId,
                );
                allNames = chatFiles
                  .map((c) => c.file_name.replace(".jsonl", ""))
                  .filter((name) => name?.trim());
                chatCache[context.characterId] = { names: allNames };
              }
            }
          } else if (data.list === "image_prompts") {
            // Returns the fixed set of ST image generation keywords for the
            // /image autocomplete dropdown. These are the special-purpose
            // arguments that /sd (and its /image, /img aliases) recognises:
            //   you        - full body portrait of the current character
            //   face       - close-up portrait of the current character
            //   me         - full body portrait of the player character
            //   scene      - image based on the entire chat history
            //   last       - image based on the last AI message
            //   raw_last   - last AI message used verbatim as the prompt
            //   background - backdrop image for the ST interface
            //
            // The list is static and never changes, so no caching or TTL is
            // applied - it is always built inline on every request. The user
            // can also type a free-form custom prompt; the keyword list
            // appears as a convenient starting point in the dropdown.
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
            // Returns the names of characters participating in the currently
            // active group so the /charimage autocomplete dropdown shows only
            // the relevant members rather than the full character library.
            //
            // In solo chat groupId is undefined and the list stays empty,
            // which is correct: the dropdown will not appear for that case
            // because the bridge only requests group_members when a group is
            // active (see the charimage command handler).
            //
            // Group membership is read synchronously from context on every
            // request. No caching is applied: the list is cheap to build and
            // changes whenever the user switches group, so a stale cache would
            // cause more problems than the negligible cost of rebuilding it.
            const activeGroup = (context.groups || []).find(
              (g) => g.id === context.groupId,
            );
            if (activeGroup?.members?.length) {
              allNames = activeGroup.members
                .map((id) => {
                  const char = context.characters.find((c) => c.id === id);
                  return char?.name?.trim() || null;
                })
                .filter(Boolean);
            }
          }
        } catch (err) {
          // On any unexpected error, fall through with an empty choices array.
          // The bridge will respond to Discord with an empty dropdown rather
          // than timing out, which is a better user experience than a spinner.
          console.error("[Discord Bridge] Autocomplete error:", err);
        }

        // Filter the full cached list against the user's partial input and
        // truncate to 25. Filtering happens here (not at cache-build time) so
        // the cache always holds the complete list and any query can use it.
        const query = (data.query || "").toLowerCase();
        const choices = allNames
          .filter((name) => name.toLowerCase().includes(query))
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
        return;
      }

      // ------------------------------------------------------------------
      // execute_command - slash commands forwarded from Discord.
      // ------------------------------------------------------------------
      if (data.type === "execute_command") {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: "typing_action", chatId: data.chatId }),
          );
        }

        let replyText = "Command execution failed, try again later.";
        const context = SillyTavern.getContext();

        try {
          switch (data.command) {
            case "newchat":
              await doNewChat({ deleteCurrentChat: false });
              // A new chat has been created for the current character;
              // invalidate the chat cache so it is rebuilt on the next
              // autocomplete request.
              invalidateChatCache();
              // Capture the introductory/greeting message that SillyTavern
              // places in the chat after a new chat is started, and forward
              // it (text + any embedded images) to Discord.
              captureAndSendIntroMessage(data.chatId);
              replyText = "New chat started.";
              break;

            case "listchars": {
              const characters = context.characters.filter((c) =>
                c.name?.trim(),
              );
              replyText =
                characters.length === 0
                  ? "No available characters found."
                  : "Available characters:\n\n" +
                    characters
                      .map(
                        (c, i) => `${i + 1}. /switchchar_${i + 1} - ${c.name}`,
                      )
                      .join("\n") +
                    "\n\nUse /switchchar_number or /switchchar character_name to switch.";
              break;
            }

            case "switchchar": {
              if (!data.args?.length) {
                replyText = "Usage: /switchchar <name> or /switchchar_number";
                break;
              }
              const targetName = data.args.join(" ");
              const target = context.characters.find(
                (c) => c.name === targetName,
              );
              if (target) {
                await selectCharacterById(context.characters.indexOf(target));
                // Active character has changed; invalidate the chat cache so
                // switchchat autocomplete reflects the new character's history.
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
                      .map(
                        (g, i) => `${i + 1}. /switchgroup_${i + 1} - ${g.name}`,
                      )
                      .join("\n") +
                    "\n\nUse /switchgroup_number or /switchgroup group_name to switch.";
              break;
            }

            case "switchgroup": {
              if (!data.args?.length) {
                replyText = "Usage: /switchgroup <name> or /switchgroup_number";
                break;
              }
              const targetName = data.args.join(" ");
              const target = (context.groups || []).find(
                (g) => g.name === targetName,
              );
              if (target) {
                await executeSlashCommandsWithOptions(`/go ${target.name}`);
                // Active group has changed; invalidate the chat cache so
                // switchchat autocomplete reflects the new context.
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
              const chatFiles = await getPastCharacterChats(
                context.characterId,
              );
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
                replyText = "Usage: /switchchat <name>";
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
              // Sends a character's avatar to Discord.
              //
              // In solo chat, no argument is needed - the active character's
              // avatar is sent automatically. An explicit name may still be
              // provided and will be matched against the full character list.
              //
              // In group chat, the optional name argument selects which group
              // member to show. If omitted in group context, the command lists
              // the participating members so the user knows what to pick.
              //
              // sendCharacterAvatar is async (it fetches the image via the
              // browser) but is not awaited here so the text reply reaches
              // Discord immediately while image delivery follows behind it.
              const ctx = SillyTavern.getContext();
              const isGroup = !!ctx.groupId;
              const targetName = data.args?.join(" ").trim() || null;

              if (targetName) {
                // Explicit name provided: search the full character list.
                // In group context this is still valid - a user may type the
                // name manually rather than using the autocomplete dropdown.
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
                // Group chat, no name given: list the group members so the
                // user knows which names to use with the autocomplete option.
                const activeGroup = (ctx.groups || []).find(
                  (g) => g.id === ctx.groupId,
                );
                const memberNames = (activeGroup?.members || [])
                  .map((id) => {
                    const c = ctx.characters.find((ch) => ch.id === id);
                    return c?.name?.trim() || null;
                  })
                  .filter(Boolean);
                replyText = memberNames.length
                  ? "Group members:\n\n" +
                    memberNames.map((n) => `\u2022 ${n}`).join("\n") +
                    "\n\nUse /charimage <n> to see a member's avatar."
                  : "No members found in the current group.";
              } else {
                // Solo chat, no name given: send the active character.
                if (
                  ctx.characterId === undefined ||
                  !ctx.characters?.[ctx.characterId]
                ) {
                  replyText = "No character is currently selected.";
                  break;
                }
                sendCharacterAvatar(
                  data.chatId,
                  ctx.characters[ctx.characterId],
                ); // async, not awaited
                replyText = `Sending avatar for **${ctx.characters[ctx.characterId].name}**…`;
              }
              break;
            }

            case "image": {
              if (!data.args?.length) {
                replyText =
                  "Usage: /image <prompt> or /image <keyword>\n" +
                  "Keywords: you, face, me, scene, last, raw_last, background";
                break;
              }
              const prompt = data.args.join(" ").trim();

              // Acknowledge the command immediately - generation may take minutes.
              // The bridge stores this message reference and will delete it when
              // the image arrives (generate_image_result) or edit it on failure.
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "image_placeholder",
                    chatId: data.chatId,
                    text: "🎨 Generating image…",
                  }),
                );
              }

              // Queue the generation so concurrent /image requests and ongoing
              // chat generations do not overlap. The Promise resolves once the
              // image packet (generate_image_result or generate_image_error)
              // has been sent to the bridge.
              enqueueImageGeneration(() =>
                generateAndSendImage(data.chatId, prompt),
              );

              // Return early - the queued work sends its own WebSocket packets.
              // We must NOT fall through to the ai_reply send at the bottom of
              // the execute_command block because the placeholder was already sent
              // above and replyText is still the default failure string.
              return;
            }

            case "sthelp":
              replyText =
                "Available commands:\n" +
                "/sthelp - Show this help message\n" +
                "/newchat - Start a new chat\n" +
                "/listchars - List all characters\n" +
                "/switchchar <name> or /switchchar_# - Switch character\n" +
                "/listgroups - List all groups\n" +
                "/switchgroup <name> or /switchgroup_# - Switch group\n" +
                "/listchats - List chat history for current character\n" +
                "/switchchat <name> or /switchchat_# - Load a past chat\n" +
                "/charimage [name] - Show a character's avatar (name optional in solo chat, autocompletes in group chat)\n" +
                "/image <prompt or keyword> - Generate an AI image. Keywords: you, face, me, scene, last, raw_last, background";
              break;

            default: {
              // Handle numbered shortcuts: switchchar_1, switchchat_2, etc.
              const charMatch = data.command.match(/^switchchar_(\d+)$/);
              if (charMatch) {
                const index = parseInt(charMatch[1]) - 1;
                const characters = context.characters.filter((c) =>
                  c.name?.trim(),
                );
                if (index >= 0 && index < characters.length) {
                  const target = characters[index];
                  await selectCharacterById(context.characters.indexOf(target));
                  // Active character has changed; invalidate the chat cache.
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
                const chatFiles = await getPastCharacterChats(
                  context.characterId,
                );
                if (index >= 0 && index < chatFiles.length) {
                  const chatName = chatFiles[index].file_name.replace(
                    ".jsonl",
                    "",
                  );
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
                  await executeSlashCommandsWithOptions(
                    `/go ${groups[index].name}`,
                  );
                  // Active group has changed; invalidate the chat cache.
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

    // Stop Heartbeat
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    // Auto-reconnect logic
    const settings = getSettings();
    // Only reconnect if autoConnect is enabled AND we didn't manually disconnect
    if (settings.autoConnect && shouldReconnect) {
      console.log("[Discord Bridge] Connection lost. Retrying in 5 seconds...");
      updateStatus("Reconnecting...", "orange");

      // Prevent multiple parallel reconnect loops
      if (!reconnectTimeout) {
        reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null;
          connect();
        }, 5000);
      }
    } else if (!shouldReconnect) {
      console.log(
        "[Discord Bridge] Manual disconnect. Auto-reconnect suppressed.",
      );
    }
  };

  ws.onerror = (error) => {
    console.error("[Discord Bridge] WebSocket error:", error);
    updateStatus("Connection error", "red");
  };
}

function disconnect() {
  shouldReconnect = false;
  if (ws) {
    ws.close();
  }
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
