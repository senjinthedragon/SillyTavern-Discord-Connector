/**
 * config-loader.js - SillyTavern Connector: Configuration Loader
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Loads config.js from disk and validates it through config-logic.js.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { createConfig } = require("./config-logic");

const configPath = path.join(__dirname, "./config.js");
if (!fs.existsSync(configPath)) {
  console.error(
    "[ERROR] Missing config.js - copy config.example.js and fill in your settings.",
  );
  process.exit(1);
}

const rawConfig = require("./config");

let config;
try {
  const result = createConfig(rawConfig);
  config = result.config;
  for (const warning of result.warnings) console.warn(warning);
} catch (err) {
  console.error(`[ERROR] ${err.message}`);
  process.exit(1);
}

module.exports = {
  config,
  token: config.discordToken,
  wssPort: config.wssPort,
};
