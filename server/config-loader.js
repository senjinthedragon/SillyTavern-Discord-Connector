/**
 * config-loader.js - SillyTavern Discord Connector: Configuration
 * Copyright (c) 2026 Senjin the Dragon. MIT License.
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
    "[ERROR] Missing config.js — copy config.example.js and fill in your settings.",
  );
  process.exit(1);
}

const config = require("./config");

if (config.discordToken === "YOUR_DISCORD_BOT_TOKEN_HERE") {
  console.error("[ERROR] Set your Discord Bot Token in config.js!");
  process.exit(1);
}

module.exports = {
  config,
  token: config.discordToken,
  wssPort: config.wssPort,
};
