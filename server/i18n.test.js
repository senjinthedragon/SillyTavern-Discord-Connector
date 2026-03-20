/**
 * i18n.test.js - SillyTavern Discord Connector: Server i18n Tests
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Tests for server/i18n.js covering locale loading, fallback chain,
 * key lookup, and {{variable}} interpolation.
 * Run with: npm test (from the server folder)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLocale, t, getLocaleId } = require("./i18n");

// A key known to exist in en.json with a {{variable}} placeholder.
const KNOWN_KEY = "setlang.success";
const KNOWN_KEY_NOVARS = "setlang.usage";
// A key that will never exist in any locale file.
const MISSING_KEY = "__test_missing_key__";

test("t() returns the raw key for an unknown key", () => {
  loadLocale("en");
  assert.equal(t(MISSING_KEY), MISSING_KEY);
});

test("t() returns the English string for a known key (not the key itself)", () => {
  loadLocale("en");
  const result = t(KNOWN_KEY_NOVARS);
  assert.notEqual(result, KNOWN_KEY_NOVARS);
  assert.ok(result.length > 0);
});

test("t() interpolates {{variable}} placeholders", () => {
  loadLocale("en");
  const result = t(KNOWN_KEY, { name: "Japanese", code: "ja" });
  assert.ok(result.includes("Japanese"));
  assert.ok(result.includes("ja"));
  assert.ok(!result.includes("{{name}}"));
  assert.ok(!result.includes("{{code}}"));
});

test("t() leaves unresolved {{placeholders}} intact when vars is omitted", () => {
  loadLocale("en");
  const result = t(KNOWN_KEY);
  assert.ok(result.includes("{{name}}") || result.includes("{{code}}"));
});

test("t() leaves unknown {{placeholders}} intact when var is not supplied", () => {
  loadLocale("en");
  const result = t(KNOWN_KEY, { name: "Dutch" }); // code not supplied
  assert.ok(result.includes("{{code}}"));
  assert.ok(!result.includes("{{name}}"));
});

test("loadLocale('en') keeps English strings active", () => {
  loadLocale("en");
  assert.equal(getLocaleId(), "en");
  assert.notEqual(t(KNOWN_KEY_NOVARS), KNOWN_KEY_NOVARS);
});

test("loadLocale(undefined) falls back to English", () => {
  loadLocale(undefined);
  assert.equal(getLocaleId(), "en");
  assert.notEqual(t(KNOWN_KEY_NOVARS), KNOWN_KEY_NOVARS);
});

test("loadLocale with unknown locale falls back to English", () => {
  loadLocale("xx-FAKEFAKE");
  assert.equal(getLocaleId(), "en");
  const enValue = t(KNOWN_KEY_NOVARS);
  assert.notEqual(enValue, KNOWN_KEY_NOVARS);
});

test("loadLocale loads a non-English locale and changes t() output", () => {
  loadLocale("en");
  const enValue = t(KNOWN_KEY_NOVARS);

  loadLocale("ja");
  assert.equal(getLocaleId(), "ja");
  const jaValue = t(KNOWN_KEY_NOVARS);

  assert.notEqual(jaValue, enValue);
  assert.notEqual(jaValue, KNOWN_KEY_NOVARS);
});

test("loadLocale falls back to English for keys missing from the target locale", () => {
  // Load Japanese, then ask for a key that definitely won't exist in any locale.
  loadLocale("ja");
  assert.equal(t(MISSING_KEY), MISSING_KEY);
  // A key that exists in English should survive even if not in Japanese.
  const result = t(KNOWN_KEY_NOVARS);
  assert.notEqual(result, KNOWN_KEY_NOVARS);
});

test("loadLocale('en') after loading another locale resets to English strings", () => {
  loadLocale("ja");
  const jaValue = t(KNOWN_KEY_NOVARS);

  loadLocale("en");
  const enValue = t(KNOWN_KEY_NOVARS);

  assert.notEqual(jaValue, enValue);
  assert.equal(getLocaleId(), "en");
});
