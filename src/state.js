/**
 * Shared mutable bridge state.
 * Using a single object avoids circular imports when multiple modules need the
 * same mutable values (chatId, timezone, locale, plugins).
 */
export const sharedState = {
  lastActiveChatId: null,
  bridgeTimezone: null,
  bridgeLocale: null,
  bridgePlugins: null,
};
