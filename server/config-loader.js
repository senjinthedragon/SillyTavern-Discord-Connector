/**
 * config-loader.js - SillyTavern Discord Connector: Configuration Loader
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 *
 * Loads config.js from disk and passes it to config-logic.js for validation
 * and default application. This module owns the exit-on-error behaviour:
 * hard validation failures call process.exit(1) with a clear message so the
 * bridge never starts in a broken state. Soft warnings (invalid timezone or
 * locale) are printed to stderr and the bridge continues with safe fallbacks.
 *
 * The validation and default logic lives in config-logic.js rather than here
 * so it can be exercised in tests without requiring a real config.js on disk
 * or triggering process.exit().
 */

"use strict";

const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "./config.js");
if (!fs.existsSync(configPath)) {
  console.error(
    "[ERROR] Missing config.js - copy config.example.js and fill in your settings.",
  );
  process.exit(1);
}

const rawConfig = require("./config");

const config = {
  queueTaskTimeoutSeconds: 30,
  imagePlaceholderTimeoutSeconds: 180,
  ...rawConfig,
};

// Convert seconds to milliseconds for internal use. All other modules consume
// the Ms-suffixed values so nothing else in the codebase needs to change.
config.queueTaskTimeoutMs = config.queueTaskTimeoutSeconds * 1_000;
config.imagePlaceholderTimeoutMs =
  config.imagePlaceholderTimeoutSeconds * 1_000;

if (config.discordToken === "YOUR_DISCORD_BOT_TOKEN_HERE") {
  console.error("[ERROR] Set your Discord Bot Token in config.js!");
  process.exit(1);
}

if (
  !Number.isFinite(config.queueTaskTimeoutSeconds) ||
  config.queueTaskTimeoutSeconds <= 0
) {
  console.error(
    "[ERROR] config.queueTaskTimeoutSeconds must be a positive number (e.g. 30 for 30 seconds).",
  );
  process.exit(1);
}

if (
  !Number.isFinite(config.imagePlaceholderTimeoutSeconds) ||
  config.imagePlaceholderTimeoutSeconds <= 0
) {
  console.error(
    "[ERROR] config.imagePlaceholderTimeoutSeconds must be a positive number (e.g. 180 for 3 minutes).",
  );
  process.exit(1);
}

if (config.timezone) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: config.timezone });
  } catch {
    console.warn(
      `[Config] Invalid timezone "${config.timezone}" - falling back to UTC`,
    );
    config.timezone = "UTC";
  }
}

if (config.locale) {
  try {
    Intl.DateTimeFormat(config.locale);
  } catch {
    console.warn(
      `[Config] Invalid locale "${config.locale}" - falling back to system default`,
    );
    config.locale = null;
  }
}

module.exports = {
  config,
  token: config.discordToken,
  wssPort: config.wssPort,
};
