/**
 * plugin-i18n.js - SillyTavern Discord Connector: Per-Plugin i18n Factory
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Provides a lightweight i18n instance bound to a specific locales directory.
 * Intended for pro plugins that ship their own locale files separately from
 * the core locales/ folder (since plugins may be sold independently).
 *
 * Usage:
 *   const { createPluginI18n } = require("../../plugin-i18n");
 *   const { load, t } = createPluginI18n(path.join(__dirname, "locales"));
 *   // Call load(config.userLocale) once at plugin start.
 */

"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Creates a self-contained i18n instance for a plugin.
 *
 * @param {string} localesDir - Absolute path to the plugin's locales directory.
 * @returns {{ load: (localeId: string) => void, t: (key: string, vars?: object) => string }}
 */
function createPluginI18n(localesDir) {
  const enPath = path.join(localesDir, "en.json");
  let fallback = {};
  try {
    if (fs.existsSync(enPath))
      fallback = JSON.parse(fs.readFileSync(enPath, "utf8"));
  } catch {
    /* ignore - t() will fall back to raw keys */
  }

  let strings = fallback;

  /**
   * Loads the locale on top of the English fallback.
   * Safe to call multiple times. Falls back to English if the locale file
   * does not exist or the locale is English.
   *
   * @param {string} localeId - BCP 47 tag (e.g. "ja", "pt-BR")
   */
  function load(localeId) {
    if (!localeId || /^en(-|$)/i.test(localeId)) {
      strings = fallback;
      return;
    }
    const candidates = [
      localeId.toLowerCase(),
      localeId.split("-")[0].toLowerCase(),
    ];
    for (const id of candidates) {
      const file = path.join(localesDir, `${id}.json`);
      if (fs.existsSync(file)) {
        try {
          strings = { ...fallback, ...JSON.parse(fs.readFileSync(file, "utf8")) };
        } catch {
          strings = fallback;
        }
        return;
      }
    }
    strings = fallback;
  }

  /**
   * Returns the translated string for key, with optional {{variable}} substitution.
   *
   * @param {string} key
   * @param {object} [vars]
   * @returns {string}
   */
  function t(key, vars) {
    const str = strings[key] ?? key;
    if (!vars) return str;
    return str.replace(/\{\{(\w+)\}\}/g, (_, k) =>
      k in vars ? String(vars[k]) : `{{${k}}}`,
    );
  }

  return { load, t };
}

module.exports = { createPluginI18n };
