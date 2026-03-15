/**
 * text-chunking.test.js - SillyTavern Discord Connector: Text Chunking Tests
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Tests for long-message splitting in text-chunking.js, covering paragraph
 * and word boundary preferences and hard-split fallback.
 * Run with: npm test (from the server folder)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { splitLongText } = require("./text-chunking");

test("splitLongText prefers paragraph/word boundaries", () => {
  const msg = "First paragraph line.\nSecond paragraph line with extra words.";
  const chunks = splitLongText(msg, 30);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].length <= 30);
  assert.ok(chunks[1].length <= 30);
});

test("splitLongText hard-splits when no whitespace exists", () => {
  const msg = "x".repeat(25);
  const chunks = splitLongText(msg, 10);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [10, 10, 5],
  );
});
