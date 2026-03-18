/**
 * Image relay helpers.
 *
 * Local ST images (thumbnails, generated art, avatars) are fetched here in
 * the browser - where same-origin access is always available - and sent as
 * base64 inline data. External URLs are passed through for the bridge to
 * fetch directly. This split works regardless of whether the bridge runs on
 * the same machine as SillyTavern.
 *
 * Classification operates on the raw src string before any URL resolution.
 */

import { safeSend } from "./ws.js";

// ---------------------------------------------------------------------------
// Classification and fetching
// ---------------------------------------------------------------------------

/**
 * Classifies an image src as "local" (served by ST) or "external".
 * Relative paths and same-origin absolute URLs are local; everything else
 * (protocol-relative, different-origin http/https) is external.
 *
 * @param {string} src
 * @returns {"local"|"external"|null}
 */
export function classifyImageSrc(src) {
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
 * send_images packet. Returns null on failure or if the image exceeds 50 MB.
 *
 * @param {string} src
 * @returns {Promise<{data: string, mimeType: string, filename: string}|null>}
 */
export async function fetchLocalImageAsBase64(src) {
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

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Returns the raw src values of all images in a .mes_text element.
 * Unresolved so classifyImageSrc can operate on the original strings.
 *
 * @param {Element} mesTextEl
 * @returns {string[]}
 */
export function extractImageSrcsFromMesText(mesTextEl) {
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
export function extractTextFromMesText(mesTextEl) {
  if (!mesTextEl) return "";
  const clone = mesTextEl.cloneNode(true);
  for (const p of clone.querySelectorAll("p"))
    p.insertAdjacentText("afterend", "\n\n");
  for (const br of clone.querySelectorAll("br")) br.replaceWith("\n");
  return clone.innerText?.replace(/\n{3,}/g, "\n\n").trim() || "";
}

// ---------------------------------------------------------------------------
// Image collection and sending
// ---------------------------------------------------------------------------

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
export function sendCollectedImages(chatId, images, caption) {
  if (!images?.length) return;
  safeSend({ type: "send_images", chatId, images, caption: caption || null });
}

/**
 * Extracts, classifies, and sends all images found in a .mes_text element.
 *
 * @param {string} chatId
 * @param {Element} mesTextEl
 * @param {string|null} [caption]
 */
export async function sendImagesFromMesText(chatId, mesTextEl, caption) {
  const srcs = extractImageSrcsFromMesText(mesTextEl);
  if (!srcs.length) return;
  const images = await collectImages(srcs);
  if (images.length > 0) sendCollectedImages(chatId, images, caption);
}

/**
 * Fetches and sends the avatar for a character.
 * Avatars are always local ST resources served via /characters/.
 *
 * @param {string} chatId
 * @param {object} character
 */
export async function sendCharacterAvatar(chatId, character) {
  if (!character?.avatar) return;
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
export async function sendLastMessageImages(chatId) {
  const messages = document.querySelectorAll("#chat .mes");
  if (!messages.length) return;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage.getAttribute("is_user") === "true") return;
  await sendImagesFromMesText(chatId, lastMessage.querySelector(".mes_text"));
}
