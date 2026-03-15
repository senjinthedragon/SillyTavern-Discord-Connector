/**
 * frontend-manager.test.js - SillyTavern Discord Connector: Frontend Manager Tests
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Tests for plugin-first config validation in config-logic.js, covering
 * external plugin registration and Discord token requirements.
 * Run with: npm test (from the server folder)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createConfig } = require("./config-logic");

test("createConfig accepts plugin-first config without discord token", () => {
  const { config } = createConfig({
    enabledPlugins: ["telegram"],
    plugins: { telegram: { enabled: true, botToken: "abc" } },
    wssPort: 2333,
  });

  assert.deepEqual(config.enabledPlugins, ["telegram"]);
});

test("createConfig requires discord token when discord plugin is enabled", () => {
  assert.throws(
    () =>
      createConfig({
        enabledPlugins: ["discord"],
        discordToken: "YOUR_DISCORD_BOT_TOKEN_HERE",
      }),
    /Discord Bot Token/,
  );
});
