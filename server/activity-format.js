/**
 * activity-format.js - SillyTavern Discord Connector: Activity Formatting
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Encapsulates expression normalisation and Discord activity string formatting.
 * Extracted from discord.js so the logic can be tested in isolation and reused
 * without pulling in the full Discord client.
 *
 * The EXPRESSION_EMOJI_MAP covers all default SillyTavern expression labels.
 * Expressions not found in the map fall back to the 🎭 theatre mask emoji rather
 * than silently dropping the update, so custom or unexpected expressions still
 * produce a visible status change on Discord.
 */

"use strict";

// Maps SillyTavern's default expression labels to representative emoji.
// Used to set the bot's Discord activity status when an expression update
// arrives. Unknown expressions fall back to 🎭 in formatBridgeActivity.
const EXPRESSION_EMOJI_MAP = {
  admiration: "😍",
  amusement: "😄",
  anger: "😠",
  annoyance: "😒",
  approval: "👍",
  caring: "🤗",
  confusion: "😕",
  curiosity: "🤔",
  desire: "💘",
  disappointment: "😞",
  disapproval: "👎",
  disgust: "🤢",
  embarrassment: "😳",
  excitement: "🤩",
  fear: "😨",
  gratitude: "🙏",
  grief: "😢",
  joy: "😊",
  love: "❤️",
  nervousness: "😬",
  optimism: "🌤️",
  pride: "😌",
  realization: "💡",
  relief: "😮‍💨",
  remorse: "🥺",
  sadness: "😔",
  surprise: "😲",
  neutral: "😐",
};

/**
 * Normalises an expression string to the lowercase trimmed form used as a key
 * in EXPRESSION_EMOJI_MAP. Returns an empty string for null/undefined/empty input.
 *
 * @param {any} expression
 * @returns {string}
 */
function normalizeExpression(expression) {
  return String(expression || "")
    .trim()
    .toLowerCase();
}

/**
 * Builds the Discord activity string for a given expression.
 * Returns the base activity string when the expression is empty so the bot
 * always shows something meaningful rather than a blank status.
 *
 * When ownerName is provided it is appended in parentheses after the mood text
 * so the emoji and mood word stay at the front where they are always visible,
 * even if the name is long or decorated and gets clipped by Discord.
 *
 * @param {string} activityBase - The fallback activity text (e.g. "SillyTavern Bridge v1.3.1").
 * @param {any} expression - The raw expression value from SillyTavern.
 * @param {string|null} ownerName - Optional character name to append.
 * @returns {string}
 */
function formatBridgeActivity(activityBase, expression, ownerName) {
  const normalized = normalizeExpression(expression);

  // Empty expression - show the base activity string instead.
  if (!normalized) return activityBase;

  // Known expression → mapped emoji; unknown → 🎭 as a visible fallback.
  const base = `${EXPRESSION_EMOJI_MAP[normalized] || "🎭"} ${normalized}`;
  return ownerName?.trim() ? `${base} (${ownerName.trim()})` : base;
}

module.exports = {
  EXPRESSION_EMOJI_MAP,
  normalizeExpression,
  formatBridgeActivity,
};
