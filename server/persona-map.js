/**
 * persona-map.js - SillyTavern Discord Connector: User Persona Map
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Manages the mapping from platform user IDs to SillyTavern persona names.
 * Two sources are merged at runtime:
 *
 *   1. config.<platform>PersonaMap - static owner-configured maps in config.js
 *      (e.g. discordPersonaMap, telegramPersonaMap, signalPersonaMap).
 *      Useful for assigning personas that users cannot change themselves.
 *   2. server/persona-map.json  - runtime file updated by /mypersona commands.
 *      User-saved preferences take priority over the owner config.
 *
 * The JSON file is written atomically on every save so a crash mid-write
 * cannot corrupt it.
 */

"use strict";

const path = require("path");
const fs = require("fs");

const { config } = require("./config-loader");
const { log } = require("./logger");

const MAP_FILE = path.join(__dirname, "persona-map.json");

let runtimeMap = {};

function load() {
  let fileCount = 0;
  try {
    runtimeMap = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
    fileCount = Object.values(runtimeMap).reduce(
      (n, m) => n + Object.keys(m).length,
      0,
    );
  } catch (err) {
    runtimeMap = {};
    if (err.code !== "ENOENT") {
      // ENOENT is expected on first run - no file yet, nothing to warn about.
      log(
        "warn",
        `[PersonaMap] Could not read persona-map.json: ${err.message}`,
      );
    }
  }

  const configCount = ["discord", "telegram", "signal"].reduce(
    (n, p) => n + Object.keys(config[p + "PersonaMap"] || {}).length,
    0,
  );
  const total = fileCount + configCount;
  log(
    "log",
    `[PersonaMap] ${total} persona mapping${total !== 1 ? "s" : ""} loaded` +
      (total > 0
        ? ` (${fileCount} user-saved, ${configCount} from config.js)`
        : " - none configured yet"),
  );
}

/**
 * Returns the persona name mapped to the given user, or null if none.
 * Runtime (user-saved) entries take priority over the owner config.
 *
 * @param {string} platform  e.g. "discord"
 * @param {string} userId    platform-native user ID
 * @returns {string|null}
 */
function getPersonaForUser(platform, userId) {
  if (!userId) return null;

  const platformMap = runtimeMap[platform];
  if (
    platformMap &&
    Object.prototype.hasOwnProperty.call(platformMap, userId)
  ) {
    return platformMap[userId] || null;
  }

  return config[platform + "PersonaMap"]?.[userId] ?? null;
}

/**
 * Saves or removes a user-persona mapping and writes the updated map to disk.
 *
 * @param {string}      platform     e.g. "discord"
 * @param {string}      userId       platform-native user ID
 * @param {string|null} personaName  persona name to save, or null to remove
 */
function setPersonaForUser(platform, userId, personaName) {
  if (!userId) return;

  if (!runtimeMap[platform]) runtimeMap[platform] = {};

  if (personaName === null || personaName === undefined) {
    delete runtimeMap[platform][userId];
    if (Object.keys(runtimeMap[platform]).length === 0) {
      delete runtimeMap[platform];
    }
  } else {
    runtimeMap[platform][userId] = personaName;
  }

  try {
    const tmp = MAP_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(runtimeMap, null, 2), "utf8");
    fs.renameSync(tmp, MAP_FILE);
  } catch (err) {
    log("error", `[PersonaMap] Failed to save persona map: ${err.message}`);
  }
}

load();

module.exports = { getPersonaForUser, setPersonaForUser };
