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
const { createConfig } = require("./config-logic");

let config;
try {
  const result = createConfig(rawConfig);
  config = result.config;
  result.warnings.forEach((warning) => console.warn(warning));
} catch (err) {
  console.error(`[ERROR] ${err.message}`);
  process.exit(1);
}

module.exports = {
  config,
  token: config.discordToken,
  wssPort: config.wssPort,
};
