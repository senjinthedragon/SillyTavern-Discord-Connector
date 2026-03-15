/**
 * logger.js - SillyTavern Discord Connector: Logging
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Thin wrapper around console that suppresses debug-level output in production.
 * Set debug: true in config.js to enable verbose logging.
 */

"use strict";

const { config } = require("./config-loader");

/**
 * @param {"log"|"warn"|"error"} level
 * @param {...any} args
 */
function log(level, ...args) {
  if (level === "log" && !config.debug) return;

  const timestamp = new Date().toLocaleString(config.locale || undefined, {
    timeZone: config.timezone || "UTC",
  });

  switch (level) {
    case "error":
      console.error(`[${timestamp}]`, ...args);
      break;
    case "warn":
      console.warn(`[${timestamp}]`, ...args);
      break;
    default:
      console.log(`[${timestamp}]`, ...args);
  }
}

module.exports = { log };
