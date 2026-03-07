"use strict";

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

function normalizeExpression(expression) {
  return String(expression || "").trim().toLowerCase();
}

function buildActivitySuffix(expression) {
  const normalized = normalizeExpression(expression);
  if (!normalized) return "";
  const emoji = EXPRESSION_EMOJI_MAP[normalized] || "🎭";
  return ` ${emoji} ${normalized}`;
}

function buildActivityText(base, expression) {
  return `${base}${buildActivitySuffix(expression)}`;
}

module.exports = {
  EXPRESSION_EMOJI_MAP,
  normalizeExpression,
  buildActivitySuffix,
  buildActivityText,
};
