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

test("createConfig throws for placeholder Discord token", () => {
  assert.throws(
    () =>
      createConfig({
        discordToken: "YOUR_DISCORD_BOT_TOKEN_HERE",
      }),
    /Set your Discord Bot Token in config\.js!/,
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
  assert.match(warnings[0], /Invalid timezone/);
  assert.match(warnings[1], /Invalid locale/);
});
