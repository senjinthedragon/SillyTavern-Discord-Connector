/**
 * lang-map.test.js - SillyTavern Discord Connector: Lang Map Tests
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Tests for lang-map.js covering the two-source merge logic, priority
 * rules, file resilience, and cleanup behavior.
 * Run with: npm test (from the server folder)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { createLangMapStore } = require("./lang-map");

function tmpFile() {
  return path.join(
    os.tmpdir(),
    `lang-map-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

function makeStore(configData = {}) {
  return createLangMapStore({
    filePath: tmpFile(),
    getConfig: () => configData,
    getLog: () => () => {},
  });
}

test("getLangForUser returns null for empty userId", () => {
  const store = makeStore();
  assert.equal(store.getLangForUser("discord", ""), null);
  assert.equal(store.getLangForUser("discord", null), null);
});

test("getLangForUser returns null when no mapping exists", () => {
  const store = makeStore();
  assert.equal(store.getLangForUser("discord", "user1"), null);
});

test("setLangForUser and getLangForUser round-trip", () => {
  const store = makeStore();
  store.setLangForUser("discord", "user1", "ja");
  assert.equal(store.getLangForUser("discord", "user1"), "ja");
});

test("setLangForUser persists across load", () => {
  const fp = tmpFile();
  const store = createLangMapStore({
    filePath: fp,
    getConfig: () => ({}),
    getLog: () => () => {},
  });
  store.setLangForUser("discord", "user1", "nl");

  const store2 = createLangMapStore({
    filePath: fp,
    getConfig: () => ({}),
    getLog: () => () => {},
  });
  store2.load();
  assert.equal(store2.getLangForUser("discord", "user1"), "nl");

  fs.unlinkSync(fp);
});

test("getLangForUser falls back to config map when no runtime entry", () => {
  const store = makeStore({ discordLanguageMap: { user1: "de" } });
  assert.equal(store.getLangForUser("discord", "user1"), "de");
});

test("runtime entry takes priority over config map entry", () => {
  const store = makeStore({ discordLanguageMap: { user1: "de" } });
  store.setLangForUser("discord", "user1", "ja");
  assert.equal(store.getLangForUser("discord", "user1"), "ja");
});

test("config map lookup is platform-generic", () => {
  const store = makeStore({
    telegramLanguageMap: { 123456789: "fr" },
    signalLanguageMap: { "+31612345678": "nl" },
  });
  assert.equal(store.getLangForUser("telegram", "123456789"), "fr");
  assert.equal(store.getLangForUser("signal", "+31612345678"), "nl");
  assert.equal(store.getLangForUser("discord", "123456789"), null);
});

test("setLangForUser null removes the runtime entry", () => {
  const store = makeStore();
  store.setLangForUser("discord", "user1", "ja");
  store.setLangForUser("discord", "user1", null);
  assert.equal(store.getLangForUser("discord", "user1"), null);
});

test("setLangForUser null cleans up empty platform key from saved file", () => {
  const fp = tmpFile();
  const store = createLangMapStore({
    filePath: fp,
    getConfig: () => ({}),
    getLog: () => () => {},
  });
  store.setLangForUser("discord", "user1", "ja");
  store.setLangForUser("discord", "user1", null);

  const saved = JSON.parse(fs.readFileSync(fp, "utf8"));
  assert.equal(Object.keys(saved).includes("discord"), false);

  fs.unlinkSync(fp);
});

test("load handles missing file without throwing", () => {
  const store = createLangMapStore({
    filePath: path.join(os.tmpdir(), "definitely-does-not-exist-lang123.json"),
    getConfig: () => ({}),
    getLog: () => () => {},
  });
  assert.doesNotThrow(() => store.load());
  assert.equal(store.getLangForUser("discord", "anyone"), null);
});

test("removing runtime entry falls back to config map entry", () => {
  const store = makeStore({ discordLanguageMap: { user1: "de" } });
  store.setLangForUser("discord", "user1", "ja");
  store.setLangForUser("discord", "user1", null);
  assert.equal(store.getLangForUser("discord", "user1"), "de");
});

test("setLangForUser undefined behaves like null (removes entry)", () => {
  const store = makeStore();
  store.setLangForUser("discord", "user1", "ja");
  store.setLangForUser("discord", "user1", undefined);
  assert.equal(store.getLangForUser("discord", "user1"), null);
});
