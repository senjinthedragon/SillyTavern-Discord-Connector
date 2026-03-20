/**
 * locales-manifest.js - SillyTavern Discord Connector: Available Locales List
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Authoritative list of languages supported by the bot. Each entry maps a
 * human-readable language name (used in Discord autocomplete) to the BCP 47
 * locale code stored in config and locale files.
 *
 * Only languages that have a matching file in the locales/ directory should
 * appear here. The list is sent to the SillyTavern extension in the
 * bridge_config packet so /setlang autocomplete stays in sync with what the
 * server actually supports.
 *
 * LANGUAGE_NAMES[langCode][localeCode] gives the name of langCode as written
 * in localeCode. e.g. LANGUAGE_NAMES["de"]["ja"] === "ドイツ語".
 * Used to display "NativeName (LocalizedName)" in autocomplete and to match
 * user input regardless of which language they typed the name in.
 */

"use strict";

// Full 13×13 translation grid. Row = language being named, column = language
// it is named in. Keys are lowercase BCP 47 codes matching the locale files.
const LANGUAGE_NAMES = {
  en: {
    en: "English",
    de: "Englisch",
    nl: "Engels",
    fr: "Anglais",
    es: "Inglés",
    "pt-br": "Inglês",
    it: "Inglese",
    pl: "Angielski",
    ru: "Английский",
    ja: "英語",
    ko: "영어",
    "zh-cn": "英语",
    "zh-tw": "英語",
  },
  de: {
    en: "German",
    de: "Deutsch",
    nl: "Duits",
    fr: "Allemand",
    es: "Alemán",
    "pt-br": "Alemão",
    it: "Tedesco",
    pl: "Niemiecki",
    ru: "Немецкий",
    ja: "ドイツ語",
    ko: "독일어",
    "zh-cn": "德语",
    "zh-tw": "德語",
  },
  nl: {
    en: "Dutch",
    de: "Niederländisch",
    nl: "Nederlands",
    fr: "Néerlandais",
    es: "Neerlandés",
    "pt-br": "Holandês",
    it: "Olandese",
    pl: "Niderlandzki",
    ru: "Нидерландский",
    ja: "オランダ語",
    ko: "네덜란드어",
    "zh-cn": "荷兰语",
    "zh-tw": "荷蘭語",
  },
  fr: {
    en: "French",
    de: "Französisch",
    nl: "Frans",
    fr: "Français",
    es: "Francés",
    "pt-br": "Francês",
    it: "Francese",
    pl: "Francuski",
    ru: "Французский",
    ja: "フランス語",
    ko: "프랑스어",
    "zh-cn": "法语",
    "zh-tw": "法語",
  },
  es: {
    en: "Spanish",
    de: "Spanisch",
    nl: "Spaans",
    fr: "Espagnol",
    es: "Español",
    "pt-br": "Espanhol",
    it: "Spagnolo",
    pl: "Hiszpański",
    ru: "Испанский",
    ja: "スペイン語",
    ko: "스페인어",
    "zh-cn": "西班牙语",
    "zh-tw": "西班牙語",
  },
  "pt-br": {
    en: "Portuguese (Brazil)",
    de: "Portugiesisch (Brasilien)",
    nl: "Portugees (Brazilië)",
    fr: "Portugais (Brésil)",
    es: "Portugués (Brasil)",
    "pt-br": "Português (Brasil)",
    it: "Portoghese (Brasile)",
    pl: "Portugalski (Brazylia)",
    ru: "Португальский (Бразилия)",
    ja: "ポルトガル語（ブラジル）",
    ko: "포르투갈어 (브라질)",
    "zh-cn": "葡萄牙语（巴西）",
    "zh-tw": "葡萄牙語（巴西）",
  },
  it: {
    en: "Italian",
    de: "Italienisch",
    nl: "Italiaans",
    fr: "Italien",
    es: "Italiano",
    "pt-br": "Italiano",
    it: "Italiano",
    pl: "Włoski",
    ru: "Итальянский",
    ja: "イタリア語",
    ko: "이탈리아어",
    "zh-cn": "意大利语",
    "zh-tw": "義大利語",
  },
  pl: {
    en: "Polish",
    de: "Polnisch",
    nl: "Pools",
    fr: "Polonais",
    es: "Polaco",
    "pt-br": "Polonês",
    it: "Polacco",
    pl: "Polski",
    ru: "Польский",
    ja: "ポーランド語",
    ko: "폴란드어",
    "zh-cn": "波兰语",
    "zh-tw": "波蘭語",
  },
  ru: {
    en: "Russian",
    de: "Russisch",
    nl: "Russisch",
    fr: "Russe",
    es: "Ruso",
    "pt-br": "Russo",
    it: "Russo",
    pl: "Rosyjski",
    ru: "Русский",
    ja: "ロシア語",
    ko: "러시아어",
    "zh-cn": "俄语",
    "zh-tw": "俄語",
  },
  ja: {
    en: "Japanese",
    de: "Japanisch",
    nl: "Japans",
    fr: "Japonais",
    es: "Japonés",
    "pt-br": "Japonês",
    it: "Giapponese",
    pl: "Japoński",
    ru: "Японский",
    ja: "日本語",
    ko: "일본어",
    "zh-cn": "日语",
    "zh-tw": "日語",
  },
  ko: {
    en: "Korean",
    de: "Koreanisch",
    nl: "Koreaans",
    fr: "Coréen",
    es: "Coreano",
    "pt-br": "Coreano",
    it: "Coreano",
    pl: "Koreański",
    ru: "Корейский",
    ja: "韓国語",
    ko: "한국어",
    "zh-cn": "韩语",
    "zh-tw": "韓語",
  },
  "zh-cn": {
    en: "Chinese (Simplified)",
    de: "Chinesisch (Vereinfacht)",
    nl: "Chinees (Vereenvoudigd)",
    fr: "Chinois (Simplifié)",
    es: "Chino (Simplificado)",
    "pt-br": "Chinês (Simplificado)",
    it: "Cinese (Semplificato)",
    pl: "Chiński (Uproszczony)",
    ru: "Китайский (Упрощённый)",
    ja: "中国語（簡体字）",
    ko: "중국어 (간체)",
    "zh-cn": "中文（简体）",
    "zh-tw": "中文（簡體）",
  },
  "zh-tw": {
    en: "Chinese (Traditional)",
    de: "Chinesisch (Traditionell)",
    nl: "Chinees (Traditioneel)",
    fr: "Chinois (Traditionnel)",
    es: "Chino (Tradicional)",
    "pt-br": "Chinês (Tradicional)",
    it: "Cinese (Tradizionale)",
    pl: "Chiński (Tradycyjny)",
    ru: "Китайский (Традиционный)",
    ja: "中国語（繁体字）",
    ko: "중국어 (번체)",
    "zh-cn": "中文（繁体）",
    "zh-tw": "中文（繁體）",
  },
};

// Derive AVAILABLE_LANGUAGES from the grid so there is one source of truth.
// Each entry includes:
//   name       - English name (used as the canonical identifier)
//   nativeName - name in the language's own script
//   code       - lowercase BCP 47 tag matching the locale file
//   names      - deduplicated array of all translated names, for matching
const AVAILABLE_LANGUAGES = Object.entries(LANGUAGE_NAMES)
  .map(([code, names]) => ({
    code,
    name: names.en,
    nativeName: names[code],
    names: [...new Set(Object.values(names))],
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Finds a language entry by matching the input against all known names
 * (in every supported language), the native name, and the BCP 47 code.
 * Case-insensitive. Returns the matching entry or undefined.
 *
 * @param {string} input
 * @returns {{ code: string, name: string, nativeName: string, names: string[] }|undefined}
 */
function findLanguage(input) {
  if (!input) return undefined;
  const lower = input.toLowerCase();
  return AVAILABLE_LANGUAGES.find(
    (l) =>
      l.code === lower ||
      l.names.some((n) => n.toLowerCase() === lower),
  );
}

module.exports = { AVAILABLE_LANGUAGES, LANGUAGE_NAMES, findLanguage };
