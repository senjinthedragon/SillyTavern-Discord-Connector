/**
 * i18n.js - SillyTavern Discord Connector: Server-side Localisation
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Loads a locale file at startup (from config.userLocale) and provides t()
 * for translating user-facing strings sent to Discord. Falls back to English
 * for any key not present in the target locale, and falls back to the raw key
 * if the string is missing from English too.
 *
 * Call loadLocale() once at startup. After that, t() is synchronous and
 * safe to call from any module.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const LOCALES_DIR = path.join(__dirname, "locales");

let _localeId = "en";

// Eagerly load English at require-time so t() always returns meaningful strings
// even when loadLocale() has not yet been called (e.g. in unit tests).
let _fallback = (() => {
  try {
    const p = path.join(LOCALES_DIR, "en.json");
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  } catch {
    return {};
  }
})();
let _strings = _fallback;

/**
 * Resolves a locale ID to an existing locale file path, trying:
 *   1. Exact match  (e.g. "pt-BR" → pt-BR.json)
 *   2. Language-only (e.g. "pt-BR" → pt.json)
 *   3. English fallback
 *
 * @param {string} localeId - BCP 47 tag (e.g. "ja-JP", "nl-NL", "en-US")
 * @returns {string|null} Absolute file path, or null if nothing found.
 */
function resolveLocalePath(localeId) {
  if (!localeId) return null;
  const candidates = [
    localeId.toLowerCase(),
    localeId.split("-")[0].toLowerCase(),
  ];
  for (const id of candidates) {
    const file = path.join(LOCALES_DIR, `${id}.json`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Loads locale strings from a JSON file. Returns {} on any error.
 *
 * @param {string} filePath
 * @returns {object}
 */
function loadFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Loads the locale for the given ID on top of the English fallback.
 * Safe to call multiple times. If localeId is English or absent, resets
 * to the English strings without re-reading the file.
 *
 * @param {string} localeId - BCP 47 language tag from config.userLocale
 */
function loadLocale(localeId) {
  if (!localeId || /^en(-|$)/i.test(localeId)) {
    _strings = _fallback;
    _localeId = "en";
    return;
  }

  const target = resolveLocalePath(localeId);
  if (target) {
    _strings = { ..._fallback, ...loadFile(target) };
    _localeId = localeId;
  } else {
    _strings = _fallback;
    _localeId = "en";
  }
}

/**
 * Interpolates {{variable}} placeholders in a string.
 *
 * @param {string} str
 * @param {object} [vars]
 * @returns {string}
 */
function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    k in vars ? String(vars[k]) : `{{${k}}}`,
  );
}

/**
 * Returns the translated string for key, with optional variable substitution.
 * Falls back to the English string, then to the raw key if nothing is found.
 *
 * @param {string} key
 * @param {object} [vars] - Named variables for {{placeholder}} substitution
 * @returns {string}
 */
function t(key, vars) {
  const str = _strings[key] ?? key;
  return interpolate(str, vars);
}

/**
 * Returns the currently loaded locale ID.
 *
 * @returns {string}
 */
function getLocaleId() {
  return _localeId;
}

/**
 * Returns a t() function bound to the given locale, resolved synchronously.
 * Use for per-request or per-user translation when the global locale does not apply.
 *
 * @param {string|null|undefined} localeId - BCP 47 tag, or falsy for English
 * @returns {function(string, object=): string}
 */
function makeTranslator(localeId) {
  if (!localeId || /^en(-|$)/i.test(localeId)) {
    return (key, vars) => interpolate(_fallback[key] ?? key, vars);
  }
  const target = resolveLocalePath(localeId);
  const strings = target ? { ..._fallback, ...loadFile(target) } : _fallback;
  return (key, vars) => interpolate(strings[key] ?? key, vars);
}

module.exports = { loadLocale, t, getLocaleId, makeTranslator };
