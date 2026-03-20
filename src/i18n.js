/**
 * SillyTavern-Discord-Connector - Bridge Extension for SillyTavern
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Browser-side i18n for the Discord Connector extension.
 *
 * Two separate string stores:
 *   - user strings  (t)  - what Discord users see: command replies, bot messages
 *   - UI strings    (ts) - what the maintainer sees: SillyTavern settings panel
 *
 * loadUserLocale(id)  - called when bridge_config arrives with userLocale
 * loadUiLocale(id)    - called once at startup using SillyTavern's active language
 * applyUiTranslations(root) - walks DOM and replaces data-i18n content
 */

import { MODULE_NAME } from "./settings.js";

const LOCALE_BASE = `/scripts/extensions/third-party/${MODULE_NAME}/server/locales`;

let _userStrings = {};
let _uiStrings = {};
let _fallback = {};
let _fallbackLoaded = false;

// Cache of fully-merged locale string objects, keyed by normalised locale ID.
// Populated lazily by getLocaleStrings() so per-user locales are only fetched
// on first use and then reused for every subsequent request from that user.
const _localeCache = new Map();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a BCP 47 locale ID to a fetchable URL, trying:
 *   1. Exact lowercased match   (e.g. "pt-BR" → pt-br.json)
 *   2. Language-only prefix     (e.g. "pt-BR" → pt.json)
 *   Returns null if localeId is falsy or English (caller uses _fallback).
 */
function candidateUrls(localeId) {
  if (!localeId) return [];
  const lower = localeId.toLowerCase();
  const lang = lower.split("-")[0];
  const urls = [];
  if (lower !== "en" && lower !== "en-us" && lower !== "en-gb")
    urls.push(`${LOCALE_BASE}/${lower}.json`);
  if (lang !== "en" && lang !== lower.split("-")[0])
    urls.push(`${LOCALE_BASE}/${lang}.json`);
  else if (lang !== "en" && !urls.includes(`${LOCALE_BASE}/${lang}.json`))
    urls.push(`${LOCALE_BASE}/${lang}.json`);
  return urls;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (res.ok) return await res.json();
  } catch {
    // ignore
  }
  return null;
}

async function ensureFallback() {
  if (_fallbackLoaded) return;
  const data = await fetchJson(`${LOCALE_BASE}/en.json`);
  _fallback = data || {};
  _fallbackLoaded = true;
}

async function fetchLocale(localeId) {
  await ensureFallback();

  if (!localeId || /^en(-|$)/i.test(localeId)) return _fallback;

  for (const url of candidateUrls(localeId)) {
    const data = await fetchJson(url);
    if (data) return { ..._fallback, ...data };
  }

  return _fallback;
}

function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    k in vars ? String(vars[k]) : `{{${k}}}`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads the locale used for Discord user-facing strings (command replies, bot
 * messages). Called when the bridge_config packet arrives with userLocale.
 *
 * @param {string} localeId - BCP 47 tag from config.userLocale
 */
export async function loadUserLocale(localeId) {
  _userStrings = await fetchLocale(localeId);
}

/**
 * Returns the fully-merged locale string object for a given locale ID.
 * Results are cached after the first fetch so per-user locale lookups are
 * cheap from the second request onward.
 *
 * If localeId is falsy, returns the currently active user strings (the
 * globally loaded locale from bridge_config.userLocale).
 *
 * @param {string|null|undefined} localeId - BCP 47 tag, or null/undefined for server default
 * @returns {Promise<object>}
 */
export async function getLocaleStrings(localeId) {
  if (!localeId) {
    // No per-user override - use whatever the global user locale is.
    return Object.keys(_userStrings).length > 0 ? _userStrings : _fallback;
  }
  const normalised = localeId.toLowerCase();
  if (_localeCache.has(normalised)) return _localeCache.get(normalised);
  const strings = await fetchLocale(localeId);
  _localeCache.set(normalised, strings);
  return strings;
}

/**
 * Returns a t() function bound to the given locale string object.
 * Use this to create a per-request translator so different users can receive
 * responses in different languages within the same session.
 *
 * @param {object} strings - Locale string object from getLocaleStrings()
 * @returns {function(string, object=): string}
 */
export function makeT(strings) {
  return function tBound(key, vars) {
    const str = strings[key] ?? key;
    return interpolate(str, vars);
  };
}

/**
 * Loads the locale used for the SillyTavern settings panel UI strings.
 * Called once at extension startup using SillyTavern's current language.
 *
 * @param {string} localeId - BCP 47 tag from SillyTavern's i18n system
 */
export async function loadUiLocale(localeId) {
  _uiStrings = await fetchLocale(localeId);
}

/**
 * Returns the translated string for a user-facing key (Discord responses).
 * Falls back to the English string, then to the raw key.
 *
 * @param {string} key
 * @param {object} [vars]
 * @returns {string}
 */
export function t(key, vars) {
  const str = _userStrings[key] ?? _fallback[key] ?? key;
  return interpolate(str, vars);
}

/**
 * Returns the translated string for a UI key (settings panel labels).
 * Falls back to the English string, then to the raw key.
 *
 * @param {string} key
 * @param {object} [vars]
 * @returns {string}
 */
export function ts(key, vars) {
  const str = _uiStrings[key] ?? key;
  return interpolate(str, vars);
}

/**
 * Walks the DOM from root and applies translations to all elements with a
 * data-i18n attribute. Supports:
 *   data-i18n="key"               → sets element textContent
 *   data-i18n="[attr]key"         → sets element attribute (e.g. [placeholder])
 *   data-i18n="key;[attr]key2"    → multiple operations, semicolon-separated
 *
 * @param {Element} root
 */
export function applyUiTranslations(root) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const raw = el.getAttribute("data-i18n");
    const parts = raw.split(";");
    for (const part of parts) {
      const attrMatch = part.match(/^\[([^\]]+)\](.+)$/);
      if (attrMatch) {
        const [, attr, key] = attrMatch;
        const translated = ts(key.trim());
        if (translated !== key.trim()) el.setAttribute(attr, translated);
      } else {
        const key = part.trim();
        const translated = ts(key);
        if (translated !== key) el.textContent = translated;
      }
    }
  });
}
