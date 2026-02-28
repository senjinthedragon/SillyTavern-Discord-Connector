/**
 * server.js - SillyTavern Discord Connector: Entry Point
 * Copyright (c) 2026 Senjin the Dragon. MIT License.
 *
 * Bootstraps the bridge: validates config, runs crash-loop protection, and
 * loads the Discord client and WebSocket server. Actual logic lives in:
 *
 *   config-loader.js  — config validation and exports
 *   logger.js         — timestamped, level-filtered logging
 *   queue.js          — per-channel async message queue
 *   messaging.js      — sendLong, image fetching and posting
 *   streaming.js      — stream session state and throttled Discord edits
 *   discord.js        — Discord client, slash commands, interaction handler
 *   websocket.js      — WebSocket server and ST→Discord message routing
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { setGlobalDispatcher, Agent } = require("undici");

// Force IPv4 and extend the connection timeout for slow networks / large responses.
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 60000, family: 4, autoSelectFamily: false },
  }),
);

// ---------------------------------------------------------------------------
// Crash-loop protection
//
// Tracks restart timestamps in a local file. If the process restarts more than
// MAX_RESTARTS times within RESTART_WINDOW_MS it exits permanently, preventing
// runaway loops from spamming Discord or exhausting system resources.
// ---------------------------------------------------------------------------

const RESTART_PROTECTION_FILE = path.join(__dirname, ".restart_protection");
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

(function checkRestartProtection() {
  try {
    let data = { restarts: [] };
    if (fs.existsSync(RESTART_PROTECTION_FILE)) {
      data = JSON.parse(fs.readFileSync(RESTART_PROTECTION_FILE, "utf8"));
    }
    const now = Date.now();
    data.restarts = data.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    data.restarts.push(now);
    fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify(data));

    if (data.restarts.length > MAX_RESTARTS) {
      console.error(
        `[ERROR] Crash loop detected (${data.restarts.length} restarts in ${RESTART_WINDOW_MS / 1000}s). Exiting.`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error("[ERROR] Restart protection check failed:", err);
  }
})();

// Boot order matters: config-loader and logger have no dependencies; discord
// and websocket cross-reference each other via their exported getter functions,
// so both need to be required before either's module-level code runs fully.
require("./config-loader");
require("./logger");
require("./queue");
require("./messaging");
require("./streaming");
require("./client");
require("./discord");
require("./websocket");
