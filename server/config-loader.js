/**
 * config-loader.js - SillyTavern Discord Connector: Configuration
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 *
 * Loads and validates config.js, then exits early with a clear error message
 * if required fields are missing or still set to their placeholder values.
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
