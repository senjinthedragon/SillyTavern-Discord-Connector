/**
 * config-logic.js - SillyTavern Discord Connector: Configuration Logic
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 *
 * Pure configuration logic: applies defaults, derives millisecond timeout
 * fields from their seconds-based counterparts, validates required fields,
 * and sanitises timezone and locale with graceful fallbacks.
 *
 * Kept separate from config-loader.js so the logic can be exercised in tests
 * without triggering process.exit() or requiring a real config.js file on disk.
 * config-loader.js calls createConfig() and handles the exit-on-error behaviour.
 *
 * Validation:
 *   Hard errors (throws)  — missing or placeholder token, non-positive timeouts.
 *   Soft warnings (array) — invalid timezone or locale; both fall back gracefully
 *                           rather than crashing so a misconfigured optional field
 *                           never prevents the bridge from starting.
 */

"use strict";

/**
 * Applies defaults, derives internal millisecond fields, validates required
 * settings, and sanitises timezone/locale.
 *
 * @param {object} rawConfig - The raw object loaded from config.js.
 * @returns {{ config: object, warnings: string[] }}
 * @throws {Error} If any required field is missing or invalid.
 */
function createConfig(rawConfig) {
  // Merge caller-supplied values over the built-in defaults so omitted optional
  // fields always have a sensible value without the caller needing to know them.
  const config = {
    queueTaskTimeoutSeconds: 30,
    imagePlaceholderTimeoutSeconds: 180,
    ...rawConfig,
  };

  // Derive millisecond variants for internal use. All runtime modules (queue.js,
  // websocket.js) consume these Ms-suffixed fields so the conversion only ever
  // happens in one place.
  config.queueTaskTimeoutMs = config.queueTaskTimeoutSeconds * 1_000;
  config.imagePlaceholderTimeoutMs =
    config.imagePlaceholderTimeoutSeconds * 1_000;

  // Hard validation — these are unrecoverable: the bridge cannot run without a
  // real token or with nonsensical timeout values.
  if (config.discordToken === "YOUR_DISCORD_BOT_TOKEN_HERE") {
    throw new Error("Set your Discord Bot Token in config.js!");
  }

  if (
    !Number.isFinite(config.queueTaskTimeoutSeconds) ||
    config.queueTaskTimeoutSeconds <= 0
  ) {
    throw new Error(
      "config.queueTaskTimeoutSeconds must be a positive number (e.g. 30 for 30 seconds).",
    );
  }

  if (
    !Number.isFinite(config.imagePlaceholderTimeoutSeconds) ||
    config.imagePlaceholderTimeoutSeconds <= 0
  ) {
    throw new Error(
      "config.imagePlaceholderTimeoutSeconds must be a positive number (e.g. 180 for 3 minutes).",
    );
  }

  // Soft validation — timezone and locale are optional conveniences. An invalid
  // value produces a warning and falls back to a safe default rather than
  // preventing the bridge from starting.
  const warnings = [];

  if (config.timezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: config.timezone });
    } catch {
      warnings.push(
        `[Config] Invalid timezone "${config.timezone}" - falling back to UTC`,
      );
      config.timezone = "UTC";
    }
  }

  if (config.locale) {
    try {
      Intl.DateTimeFormat(config.locale);
    } catch {
      warnings.push(
        `[Config] Invalid locale "${config.locale}" - falling back to system default`,
      );
      config.locale = null;
    }
  }

  return { config, warnings };
}

module.exports = {
  createConfig,
};
