/**
 * text-chunking.js - SillyTavern Connector: Cross-platform Text Splitting
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Splits long text into platform-safe chunks while preferring paragraph and
 * word boundaries so messages do not break mid-sentence when possible.
 */

"use strict";

/**
 * Split text into safe chunks for chat platforms.
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]}
 */
function splitLongText(text, maxLen) {
  const chunks = [];
  let remaining = String(text || "");

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

module.exports = { splitLongText };
