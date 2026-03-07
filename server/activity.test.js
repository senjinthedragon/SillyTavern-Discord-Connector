"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildActivitySuffix,
  buildActivityText,
  normalizeExpression,
} = require("./activity");

test("normalizeExpression trims and lowercases", () => {
  assert.equal(normalizeExpression("  Curiosity  "), "curiosity");
  assert.equal(normalizeExpression(null), "");
});

test("buildActivitySuffix maps known expressions to emoji", () => {
  assert.equal(buildActivitySuffix("joy"), " 😊 joy");
  assert.equal(buildActivitySuffix("neutral"), " 😐 neutral");
});

test("buildActivitySuffix falls back for unknown expressions", () => {
  assert.equal(buildActivitySuffix("custom_mood"), " 🎭 custom_mood");
  assert.equal(buildActivitySuffix(""), "");
});

test("buildActivityText appends suffix to base", () => {
  const base = "SillyTavern Bridge v1.2.5";
  assert.equal(
    buildActivityText(base, "approval"),
    "SillyTavern Bridge v1.2.5 👍 approval",
  );
  assert.equal(buildActivityText(base, null), base);
});
