/**
 * persona-map.test.js - SillyTavern Discord Connector: Persona Map Tests
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Tests for persona-map.js covering the two-source merge logic, priority
 * rules, file resilience, and cleanup behavior.
 * Run with: npm test (from the server folder)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { createPersonaMapStore } = require("./persona-map");

function tmpFile() {
  return path.join(
    os.tmpdir(),
    `persona-map-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

function makeStore(configData = {}) {
  return createPersonaMapStore({
    filePath: tmpFile(),
    getConfig: () => configData,
    getLog: () => () => {},
  });
}

test("getPersonaForUser returns null for empty userId", () => {
  const store = makeStore();
  assert.equal(store.getPersonaForUser("discord", ""), null);
  assert.equal(store.getPersonaForUser("discord", null), null);
});

test("getPersonaForUser returns null when no mapping exists", () => {
  const store = makeStore();
  assert.equal(store.getPersonaForUser("discord", "user1"), null);
});

test("setPersonaForUser and getPersonaForUser round-trip", () => {
  const store = makeStore();
  store.setPersonaForUser("discord", "user1", "Alice");
  assert.equal(store.getPersonaForUser("discord", "user1"), "Alice");
});

test("setPersonaForUser persists across load", () => {
  const fp = tmpFile();
  const store = createPersonaMapStore({
    filePath: fp,
    getConfig: () => ({}),
    getLog: () => () => {},
  });
  store.setPersonaForUser("discord", "user1", "Alice");

  const store2 = createPersonaMapStore({
    filePath: fp,
    getConfig: () => ({}),
    getLog: () => () => {},
  });
  store2.load();
  assert.equal(store2.getPersonaForUser("discord", "user1"), "Alice");

  fs.unlinkSync(fp);
});

test("getPersonaForUser falls back to config map when no runtime entry", () => {
  const store = makeStore({ discordPersonaMap: { user1: "ConfigAlice" } });
  assert.equal(store.getPersonaForUser("discord", "user1"), "ConfigAlice");
});

test("runtime entry takes priority over config map entry", () => {
  const store = makeStore({ discordPersonaMap: { user1: "ConfigAlice" } });
  store.setPersonaForUser("discord", "user1", "RuntimeAlice");
  assert.equal(store.getPersonaForUser("discord", "user1"), "RuntimeAlice");
});

test("config map lookup is platform-generic", () => {
  const store = makeStore({
    telegramPersonaMap: { 123: "TelegramAlice" },
    signalPersonaMap: { "+31612345678": "SignalBob" },
  });
  assert.equal(store.getPersonaForUser("telegram", "123"), "TelegramAlice");
  assert.equal(store.getPersonaForUser("signal", "+31612345678"), "SignalBob");
  assert.equal(store.getPersonaForUser("discord", "123"), null);
});

test("setPersonaForUser null removes entry", () => {
  const store = makeStore();
  store.setPersonaForUser("discord", "user1", "Alice");
  store.setPersonaForUser("discord", "user1", null);
  assert.equal(store.getPersonaForUser("discord", "user1"), null);
});

test("setPersonaForUser null cleans up empty platform key", () => {
  const fp = tmpFile();
  const store = createPersonaMapStore({
    filePath: fp,
    getConfig: () => ({}),
    getLog: () => () => {},
  });
  store.setPersonaForUser("discord", "user1", "Alice");
  store.setPersonaForUser("discord", "user1", null);

  const saved = JSON.parse(fs.readFileSync(fp, "utf8"));
  assert.equal(Object.keys(saved).includes("discord"), false);

  fs.unlinkSync(fp);
});

test("load handles missing file without throwing", () => {
  const store = createPersonaMapStore({
    filePath: path.join(os.tmpdir(), "definitely-does-not-exist-abc123.json"),
    getConfig: () => ({}),
    getLog: () => () => {},
  });
  assert.doesNotThrow(() => store.load());
  assert.equal(store.getPersonaForUser("discord", "anyone"), null);
});

test("load ignores a runtime entry after clearing with null", () => {
  const store = makeStore({ discordPersonaMap: { user1: "ConfigAlice" } });
  store.setPersonaForUser("discord", "user1", "RuntimeAlice");
  store.setPersonaForUser("discord", "user1", null);
  // Runtime entry removed - should fall back to config
  assert.equal(store.getPersonaForUser("discord", "user1"), "ConfigAlice");
});
