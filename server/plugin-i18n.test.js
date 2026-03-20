/**
 * plugin-i18n.test.js - SillyTavern Discord Connector: Plugin i18n Tests
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Tests for server/plugin-i18n.js covering the factory pattern, locale
 * loading, fallback chain, interpolation, and instance isolation.
 * Run with: npm test (from the server folder)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { createPluginI18n } = require("./plugin-i18n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  const dir = path.join(
    os.tmpdir(),
    `plugin-i18n-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Creates a temp locales dir with the given locale files.
 * @param {Record<string, object>} files  e.g. { "en": { "key": "val" } }
 */
function makeLocalesDir(files) {
  const dir = tmpDir();
  for (const [locale, strings] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(dir, `${locale}.json`),
      JSON.stringify(strings),
      "utf8",
    );
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("t() returns the raw key when localesDir does not exist", () => {
  const { t } = createPluginI18n(path.join(os.tmpdir(), "no-such-dir-xyz"));
  assert.equal(t("some.key"), "some.key");
});

test("t() returns the raw key when en.json is missing", () => {
  const dir = tmpDir(); // empty dir, no en.json
  const { t } = createPluginI18n(dir);
  assert.equal(t("some.key"), "some.key");
});

test("t() returns English string for a known key before load() is called", () => {
  const dir = makeLocalesDir({ en: { "greet": "Hello" } });
  const { t } = createPluginI18n(dir);
  assert.equal(t("greet"), "Hello");
});

test("t() interpolates {{variable}} placeholders", () => {
  const dir = makeLocalesDir({ en: { "msg": "Hi {{name}}!" } });
  const { t } = createPluginI18n(dir);
  assert.equal(t("msg", { name: "Alice" }), "Hi Alice!");
});

test("t() leaves unresolved {{placeholders}} intact when var is not supplied", () => {
  const dir = makeLocalesDir({ en: { "msg": "Hi {{name}}!" } });
  const { t } = createPluginI18n(dir);
  assert.equal(t("msg"), "Hi {{name}}!");
});

test("t() returns raw key for key not in any locale", () => {
  const dir = makeLocalesDir({ en: { "known": "value" } });
  const { t } = createPluginI18n(dir);
  assert.equal(t("unknown.key"), "unknown.key");
});

test("load() with English locale keeps English strings", () => {
  const dir = makeLocalesDir({ en: { "greet": "Hello" } });
  const { load, t } = createPluginI18n(dir);
  load("en");
  assert.equal(t("greet"), "Hello");
});

test("load() with undefined locale keeps English strings", () => {
  const dir = makeLocalesDir({ en: { "greet": "Hello" } });
  const { load, t } = createPluginI18n(dir);
  load(undefined);
  assert.equal(t("greet"), "Hello");
});

test("load() with unknown locale falls back to English", () => {
  const dir = makeLocalesDir({ en: { "greet": "Hello" } });
  const { load, t } = createPluginI18n(dir);
  load("xx-FAKEFAKE");
  assert.equal(t("greet"), "Hello");
});

test("load() loads a non-English locale and overrides English strings", () => {
  const dir = makeLocalesDir({
    en: { "greet": "Hello" },
    ja: { "greet": "こんにちは" },
  });
  const { load, t } = createPluginI18n(dir);
  load("ja");
  assert.equal(t("greet"), "こんにちは");
});

test("load() merges non-English locale on top of English (fallback for missing keys)", () => {
  const dir = makeLocalesDir({
    en: { "greet": "Hello", "farewell": "Goodbye" },
    ja: { "greet": "こんにちは" }, // farewell not translated
  });
  const { load, t } = createPluginI18n(dir);
  load("ja");
  assert.equal(t("greet"), "こんにちは");
  assert.equal(t("farewell"), "Goodbye"); // English fallback
});

test("load() resolves BCP 47 tags to language-only file (pt-BR -> pt.json)", () => {
  const dir = makeLocalesDir({
    en: { "greet": "Hello" },
    pt: { "greet": "Olá" },
  });
  const { load, t } = createPluginI18n(dir);
  load("pt-BR");
  assert.equal(t("greet"), "Olá");
});

test("load() can switch locale after initial load", () => {
  const dir = makeLocalesDir({
    en: { "greet": "Hello" },
    de: { "greet": "Hallo" },
  });
  const { load, t } = createPluginI18n(dir);
  load("de");
  assert.equal(t("greet"), "Hallo");
  load("en");
  assert.equal(t("greet"), "Hello");
});

test("two instances from different dirs are independent", () => {
  const dirA = makeLocalesDir({ en: { "key": "A-value" } });
  const dirB = makeLocalesDir({ en: { "key": "B-value" } });
  const { t: tA } = createPluginI18n(dirA);
  const { t: tB } = createPluginI18n(dirB);
  assert.equal(tA("key"), "A-value");
  assert.equal(tB("key"), "B-value");
});

test("two instances with same dir but different loaded locales are independent", () => {
  const dir = makeLocalesDir({
    en: { "greet": "Hello" },
    de: { "greet": "Hallo" },
    fr: { "greet": "Bonjour" },
  });
  const instanceDe = createPluginI18n(dir);
  const instanceFr = createPluginI18n(dir);
  instanceDe.load("de");
  instanceFr.load("fr");
  assert.equal(instanceDe.t("greet"), "Hallo");
  assert.equal(instanceFr.t("greet"), "Bonjour");
});
