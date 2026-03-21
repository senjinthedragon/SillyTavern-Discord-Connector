/**
 * lang-map.js - SillyTavern Discord Connector: User Language Map
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Manages the mapping from platform user IDs to BCP 47 locale codes.
 * Two sources are merged at runtime:
 *
 *   1. config.<platform>LanguageMap - static owner-configured maps in config.js
 *      (e.g. discordLanguageMap, telegramLanguageMap, signalLanguageMap).
 *      Useful for assigning a language to users without them needing /setlang.
 *   2. server/lang-map.json - runtime file updated by /setlang commands.
 *      User-saved preferences take priority over the owner config.
 *
 * The JSON file is written atomically on every save so a crash mid-write
 * cannot corrupt it.
 *
 * createLangMapStore(options) is exported for use in tests, allowing
 * injection of a custom file path and config object.
 */

"use strict";

const path = require("path");
const fs = require("fs");

const DEFAULT_MAP_FILE = path.join(__dirname, "lang-map.json");

function createLangMapStore(options = {}) {
  const filePath = options.filePath || DEFAULT_MAP_FILE;
  const getConfig =
    options.getConfig || (() => require("./config-loader").config);
  const getLog = options.getLog || (() => require("./logger").log);

  let runtimeMap = {};

  function load() {
    const log = getLog();
    let fileCount = 0;
    try {
      runtimeMap = JSON.parse(fs.readFileSync(filePath, "utf8"));
      fileCount = Object.values(runtimeMap).reduce(
        (n, m) => n + Object.keys(m).length,
        0,
      );
    } catch (err) {
      runtimeMap = {};
      if (err.code !== "ENOENT") {
        // ENOENT is expected on first run - no file yet, nothing to warn about.
        log("warn", `[LangMap] Could not read lang-map.json: ${err.message}`);
      }
    }

    const cfg = getConfig();
    const configCount = ["discord", "telegram", "signal"].reduce(
      (n, p) => n + Object.keys(cfg[p + "LanguageMap"] || {}).length,
      0,
    );
    const total = fileCount + configCount;
    log(
      "log",
      `[LangMap] ${total} language mapping${total !== 1 ? "s" : ""} loaded` +
        (total > 0
          ? ` (${fileCount} user-saved, ${configCount} from config.js)`
          : " - none configured yet"),
    );
  }

  /**
   * Returns the BCP 47 locale code for the given user, or null if none.
   * Runtime (user-saved) entries take priority over the owner config.
   *
   * @param {string} platform  e.g. "discord"
   * @param {string} userId    platform-native user ID
   * @returns {string|null}
   */
  function getLangForUser(platform, userId) {
    if (!userId) return null;

    const platformMap = runtimeMap[platform];
    if (
      platformMap &&
      Object.prototype.hasOwnProperty.call(platformMap, userId)
    ) {
      return platformMap[userId] || null;
    }

    const cfg = getConfig();
    return cfg[platform + "LanguageMap"]?.[userId] ?? null;
  }

  /**
   * Saves or removes a user-language mapping and writes the updated map to disk.
   *
   * @param {string}      platform    e.g. "discord"
   * @param {string}      userId      platform-native user ID
   * @param {string|null} localeCode  BCP 47 code to save, or null to remove
   */
  function setLangForUser(platform, userId, localeCode) {
    const log = getLog();
    if (!userId) return;

    if (!runtimeMap[platform]) runtimeMap[platform] = {};

    if (localeCode === null || localeCode === undefined) {
      delete runtimeMap[platform][userId];
      if (Object.keys(runtimeMap[platform]).length === 0) {
        delete runtimeMap[platform];
      }
    } else {
      runtimeMap[platform][userId] = localeCode;
    }

    try {
      const tmp = filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(runtimeMap, null, 2), "utf8");
      fs.renameSync(tmp, filePath);
    } catch (err) {
      log("error", `[LangMap] Failed to save lang map: ${err.message}`);
    }
  }

  return { load, getLangForUser, setLangForUser };
}

// Default singleton used by the rest of the application.
const defaultStore = createLangMapStore();

module.exports = {
  load: () => defaultStore.load(),
  getLangForUser: (p, u) => defaultStore.getLangForUser(p, u),
  setLangForUser: (p, u, c) => defaultStore.setLangForUser(p, u, c),
  createLangMapStore,
};
