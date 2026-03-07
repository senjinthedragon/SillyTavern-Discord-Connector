"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatBridgeActivity,
  normalizeExpression,
  EXPRESSION_EMOJI_MAP,
} = require("./activity-format");

test("normalizeExpression trims and lowercases expression names", () => {
  assert.equal(normalizeExpression("  JoY  "), "joy");
  assert.equal(normalizeExpression(null), "");
});

test("formatBridgeActivity uses known expression emoji mapping", () => {
  assert.equal(EXPRESSION_EMOJI_MAP.joy, "😊");
  assert.equal(
    formatBridgeActivity("SillyTavern Bridge v1.2.5", "joy"),
    "😊 joy",
  );
});

test("formatBridgeActivity falls back to theater mask for unknown expressions", () => {
  assert.equal(
    formatBridgeActivity("SillyTavern Bridge v1.2.5", "UnlistedMood"),
    "🎭 unlistedmood",
  );
});

test("formatBridgeActivity falls back to base activity for empty expression", () => {
  assert.equal(
    formatBridgeActivity("SillyTavern Bridge v1.2.5", "   "),
    "SillyTavern Bridge v1.2.5",
  );
});
