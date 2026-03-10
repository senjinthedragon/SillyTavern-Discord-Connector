/**
 * config-logic.test.js - SillyTavern Discord Connector: Config Logic Tests
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 *
 * Tests for configuration validation, defaults, derived millisecond fields,
 * timezone/locale fallback, and circuit breaker validation in config-logic.js.
 * Run with: npm test (from the server folder)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createConfig } = require("./config-logic");

test("createConfig applies timeout defaults and derived millisecond fields", () => {
  const { config, warnings } = createConfig({
    discordToken: "token",
    wssPort: 9000,
  });

  assert.equal(config.queueTaskTimeoutSeconds, 30);
  assert.equal(config.queueTaskTimeoutMs, 30000);
  assert.equal(config.imagePlaceholderTimeoutSeconds, 180);
  assert.equal(config.imagePlaceholderTimeoutMs, 180000);
  assert.deepEqual(warnings, []);
});

test("createConfig throws for placeholder Discord token when Discord plugin is enabled", () => {
  assert.throws(
    () =>
      createConfig({
        enabledPlugins: ["discord"],
        discordToken: "YOUR_DISCORD_BOT_TOKEN_HERE",
      }),
    /Discord plugin is enabled|Discord Bot Token/,
  );
});

test("createConfig allows non-discord enabled plugin names for external plugins", () => {
  const { config } = createConfig({
    enabledPlugins: ["discord", "telegram"],
    discordToken: "token",
    externalPlugins: [{ name: "telegram", module: "../private/telegram.js" }],
  });

  assert.deepEqual(config.enabledPlugins, ["discord", "telegram"]);
});

test("createConfig throws when enabledPlugins contains invalid entry", () => {
  assert.throws(
    () =>
      createConfig({
        enabledPlugins: ["discord", ""],
        discordToken: "token",
      }),
    /entries must be non-empty strings/,
  );
});

test("createConfig throws when externalPlugins is not an array", () => {
  assert.throws(
    () =>
      createConfig({
        enabledPlugins: ["discord"],
        discordToken: "token",
        externalPlugins: "not-array",
      }),
    /externalPlugins must be an array/,
  );
});

test("createConfig throws for invalid queue timeout", () => {
  assert.throws(
    () =>
      createConfig({
        discordToken: "token",
        queueTaskTimeoutSeconds: 0,
      }),
    /queueTaskTimeoutSeconds must be a positive number/,
  );
});

test("createConfig throws for invalid image placeholder timeout", () => {
  assert.throws(
    () =>
      createConfig({
        discordToken: "token",
        imagePlaceholderTimeoutSeconds: -1,
      }),
    /imagePlaceholderTimeoutSeconds must be a positive number/,
  );
});

test("createConfig falls back when timezone or locale are invalid", () => {
  const { config, warnings } = createConfig({
    discordToken: "token",
    timezone: "Bad/Timezone",
    locale: "bad_locale_value",
  });

  assert.equal(config.timezone, "UTC");
  assert.equal(config.locale, null);
  assert.equal(warnings.length, 2);
});

test("createConfig throws for invalid circuit breaker threshold", () => {
  assert.throws(
    () =>
      createConfig({
        discordToken: "token",
        plugins: {
          discord: {
            circuitBreaker: { enabled: true, failureThreshold: 0 },
          },
        },
      }),
    /circuitBreaker\.failureThreshold/,
  );
});

test("createConfig throws for invalid circuit breaker cooldown", () => {
  assert.throws(
    () =>
      createConfig({
        discordToken: "token",
        plugins: {
          discord: {
            circuitBreaker: { enabled: true, cooldownMs: -1 },
          },
        },
      }),
    /circuitBreaker\.cooldownMs/,
  );
});
