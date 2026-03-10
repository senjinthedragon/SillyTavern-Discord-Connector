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
  assert.deepEqual(chunks.map((c) => c.length), [10, 10, 5]);
});
