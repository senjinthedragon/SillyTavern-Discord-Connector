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
  // 36 chars total; \n at index 29 is within the 30-char limit so the first
  // chunk breaks there, leaving "Short." (6 chars) as the second chunk.
  const msg = "First long paragraph line ok.\nShort.";
  const chunks = splitLongText(msg, 30);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "First long paragraph line ok.");
  assert.equal(chunks[1], "Short.");
});

test("splitLongText hard-splits when no whitespace exists", () => {
  const msg = "x".repeat(25);
  const chunks = splitLongText(msg, 10);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [10, 10, 5],
  );
  assert.equal(chunks.join(""), msg);
});

test("splitLongText returns single chunk when text fits", () => {
  const msg = "Short text.";
  const chunks = splitLongText(msg, 100);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], msg);
});

test("splitLongText returns empty array for empty string", () => {
  const chunks = splitLongText("", 100);
  assert.equal(chunks.length, 0);
});

test("splitLongText text at exact boundary splits into two", () => {
  const msg = "a".repeat(10);
  const chunks = splitLongText(msg, 10);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], msg);
});

test("splitLongText chunks never exceed the limit", () => {
  const msg = "word ".repeat(40);
  const limit = 50;
  const chunks = splitLongText(msg.trim(), limit);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= limit, `chunk too long: ${chunk.length}`);
  }
  assert.equal(chunks.join(" "), msg.trim());
});
