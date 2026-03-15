/**
 * activity-format.test.js - SillyTavern Discord Connector: Activity Format Tests
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Tests for expression normalisation and Discord activity string formatting
 * in activity-format.js.
 * Run with: npm test (from the server folder)
 */

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
  // Verify the map contains the expected emoji for a known expression,
  // then confirm formatBridgeActivity produces the correct activity string.
  assert.equal(EXPRESSION_EMOJI_MAP.joy, "😊");
  assert.equal(
    formatBridgeActivity("SillyTavern Bridge v1.2.5", "joy"),
    "😊 joy",
  );
});

test("formatBridgeActivity falls back to theater mask for unknown expressions", () => {
  // Expressions not in EXPRESSION_EMOJI_MAP should use 🎭 rather than
  // silently dropping the update or throwing.
  assert.equal(
    formatBridgeActivity("SillyTavern Bridge v1.2.5", "UnlistedMood"),
    "🎭 unlistedmood",
  );
});

test("formatBridgeActivity falls back to base activity for empty expression", () => {
  // Whitespace-only input should be treated as empty so the bot always shows
  // a meaningful status rather than a blank or emoji-only string.
  assert.equal(
    formatBridgeActivity("SillyTavern Bridge v1.2.5", "   "),
    "SillyTavern Bridge v1.2.5",
  );
});
