/**
 * messaging.js - SillyTavern Discord Connector: Message and Image Delivery
 * Copyright (c) 2026 Senjin the Dragon. MIT License.
 *
 * Handles posting content to Discord channels:
 *   - sendLong splits text that exceeds Discord's 2000-character limit,
 *     preferring paragraph then word boundaries.
 *   - sendImagesToChannel accepts a mixed array of image descriptors produced
 *     by the browser extension and uploads them as Discord attachments.
 *
 * Image descriptors come in two forms:
 *   { type: "inline", data, mimeType, filename }  — base64 data already fetched
 *     by the extension inside the browser (local ST resources, avatars, etc.).
 *     Decoded here and uploaded without any outbound HTTP request.
 *   { type: "url", url }  — a publicly reachable external URL fetched directly
 *     by this server.
 *
 * Images are sent in batches of up to 10 (Discord's per-message limit).
 * Oversized images are scaled down by processImageForDiscord before upload.
 */

"use strict";

const https = require("https");
const http = require("http");
const path = require("path");
const { AttachmentBuilder } = require("discord.js");
const { Jimp } = require("jimp");
const { log } = require("./logger");

/**
 * Splits text exceeding Discord's 2000-char limit across multiple messages,
 * preferring paragraph then word boundaries.
 *
 * @param {import("discord.js").TextChannel} channel
 * @param {string} text
 */
async function sendLong(channel, text) {
  const MAX = 1900;
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      await channel.send(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MAX);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", MAX);
    if (splitAt <= 0) splitAt = MAX;
    await channel.send(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
}

/**
 * Scales down images that exceed Discord's 8 MB upload limit.
 * Resizes to max 2048 px wide and re-encodes as JPEG at 80% quality.
 *
 * @param {Buffer} buffer
 * @returns {Promise<Buffer>}
 */
async function processImageForDiscord(buffer) {
  const DISCORD_LIMIT = 7.8 * 1024 * 1024;
  if (buffer.length <= DISCORD_LIMIT) return buffer;

  log(
    "log",
    `[Images] Optimising oversized image (${(buffer.length / 1024 / 1024).toFixed(2)} MB)...`,
  );

  try {
    const image = await Jimp.read(buffer);
    if (image.bitmap.width > 2048) image.resize({ w: 2048 });
    const optimized = await image.getBuffer("image/jpeg", { quality: 80 });
    log(
      "log",
      `[Images] Optimised to ${(optimized.length / 1024).toFixed(0)} KB`,
    );
    return optimized;
  } catch (err) {
    log("error", "[Images] Failed to optimise image:", err);
    return buffer;
  }
}

/**
 * Fetches a remote image URL into a Buffer. Follows up to 5 redirects.
 * Times out after 15 seconds.
 *
 * @param {string} url
 * @param {number} [redirectsLeft=5]
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
function fetchImageBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https://") ? https : http;
    lib
      .get(url, { timeout: 15000 }, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects"));
            return;
          }
          resolve(fetchImageBuffer(res.headers.location, redirectsLeft - 1));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const contentType = res.headers["content-type"] || "image/png";
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ buffer: Buffer.concat(chunks), contentType }),
        );
        res.on("error", reject);
      })
      .on("error", reject)
      .on("timeout", () => reject(new Error(`Timeout fetching ${url}`)));
  });
}

/**
 * Derives a safe filename from a URL. Falls back to "image.png".
 *
 * @param {string} url
 * @param {string} [contentType]
 * @returns {string}
 */
function imageFilename(url, contentType) {
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    if (base && /\.[a-z]{2,5}$/i.test(base)) return base;
  } catch {
    /* ignore */
  }
  const ext = (contentType || "").includes("jpeg")
    ? "jpg"
    : (contentType || "").includes("gif")
      ? "gif"
      : (contentType || "").includes("webp")
        ? "webp"
        : "png";
  return `image.${ext}`;
}

/**
 * Posts images to a Discord channel. Accepts the mixed descriptor array
 * produced by the extension. Failures on individual images are logged and
 * skipped rather than aborting the batch.
 *
 * @param {import("discord.js").TextChannel} channel
 * @param {Array} images
 * @param {string|null} [caption]
 */
async function sendImagesToChannel(channel, images, caption) {
  if (!images?.length) return;

  const attachments = (
    await Promise.all(
      images.map(async (img) => {
        try {
          let buffer, filename;
          if (img.type === "inline") {
            buffer = Buffer.from(img.data, "base64");
            filename = img.filename || "image.png";
          } else if (img.type === "url") {
            const { buffer: fetched, contentType } = await fetchImageBuffer(
              img.url,
            );
            buffer = fetched;
            filename = imageFilename(img.url, contentType);
          } else {
            log("warn", `[Images] Unknown descriptor type: ${img.type}`);
            return null;
          }

          const safeBuffer = await processImageForDiscord(buffer);
          const finalFilename =
            safeBuffer.length !== buffer.length
              ? filename.replace(/\.[^/.]+$/, "") + ".jpg"
              : filename;

          return new AttachmentBuilder(safeBuffer, { name: finalFilename });
        } catch (err) {
          const label = img.type === "url" ? img.url : img.filename || "inline";
          log("warn", `[Images] Failed to process "${label}": ${err.message}`);
          return null;
        }
      }),
    )
  ).filter(Boolean);

  if (attachments.length === 0) {
    log("warn", "[Images] All images failed to process; nothing sent.");
    return;
  }

  const BATCH = 10;
  for (let i = 0; i < attachments.length; i += BATCH) {
    const batch = attachments.slice(i, i + BATCH);
    const payload = { files: batch };
    if (i === 0 && caption) payload.content = caption;
    await channel.send(payload);
  }
}

module.exports = { sendLong, sendImagesToChannel };
