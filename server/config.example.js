/**
 * config.example.js - SillyTavern Discord Connector: Configuration Template
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * This is a template for the bridge configuration. To get started:
 * 1. Copy or rename this file to 'config.js' in the same directory.
 * 2. Fill in your Discord Bot Token and user/channel restrictions.
 * 3. Adjust advanced settings only if your environment requires it.
 *
 * Note: Essential settings (Discord token, access control) are at the top,
 * followed by general environment preferences and advanced logic for 
 * circuit breakers and pro-plugin routing.
 */

module.exports = {
  // =========================================================================
  // ESSENTIAL SETTINGS - fill these in to get the bridge running
  // =========================================================================

  // Your Discord Bot Token.
  // Obtain this from the Discord Developer Portal (discord.com/developers/applications).
  discordToken: "YOUR_DISCORD_BOT_TOKEN_HERE",

  // Restrict which Discord users can talk to the bot.
  // Add your own Discord User ID here to keep the bot private to yourself.
  // Leave empty to allow anyone - not recommended unless your server is private.
  // To get a User ID: enable Developer Mode in Discord settings, then right-click
  // a user and select "Copy User ID".
  allowedUserIds: [], // e.g. ["123456789012345678", "987654321098765432"]

  // Restrict which Discord channels the bot will respond in.
  // Leave empty to allow all channels in your server.
  // To get a Channel ID: enable Developer Mode in Discord settings, then
  // right-click a channel and select "Copy Channel ID".
  allowedChannelIds: [], // e.g. ["123456789012345678"]

  // =========================================================================
  // GENERAL SETTINGS - safe to leave as-is, but worth a look
  // =========================================================================

  // The port number the bridge listens on.
  // The URL in the SillyTavern extension settings should read: ws://127.0.0.1:2333
  // If you change this number, update just the number at the end of that URL to match.
  // Only change this if port 2333 is already in use on your machine.
  wssPort: 2333,

  // Timezone for log timestamps and chat date formatting in Discord autocomplete.
  // Use IANA timezone names e.g. "Europe/Amsterdam", "America/New_York", "Asia/Tokyo".
  timezone: "America/New_York",

  // Locale for date/time formatting in Discord autocomplete chat lists.
  // Use BCP 47 language tags e.g. "nl-NL", "en-GB", "en-US", "de-DE".
  // Remove this line entirely to use your browser's default locale.
  locale: "en-US",

  // Set to true to enable verbose terminal logging for troubleshooting.
  debug: false,

  // =========================================================================
  // ADVANCED SETTINGS - no need to touch these unless you know what you're
  // doing. Defaults are sensible for most setups.
  // =========================================================================

  // How long a queued message send task may run before it is abandoned (seconds).
  queueTaskTimeoutSeconds: 30,

  // How long the "🎨 Generating image…" placeholder waits before giving up
  // and showing a timeout message (seconds).
  imagePlaceholderTimeoutSeconds: 180,

  // Which frontend plugins to load. "discord" is the built-in free plugin.
  // Add "telegram" or "signal" here only if you have purchased the pro plugins.
  enabledPlugins: ["discord"],

  // External plugin modules (pro plugins only).
  // Pro plugins are purchased separately and not included in this free release.
  // See https://github.com/senjinthedragon for more information.
  externalPlugins: [
    // {
    //   name: "telegram",
    //   module: "external-plugins/telegram-pro/telegram.js",
    //   config: {
    //     botToken: "YOUR_TELEGRAM_BOT_TOKEN",
    //   },
    // },
    // {
    //   name: "signal",
    //   module: "external-plugins/signal-pro/signal.js",
    //   config: {
    //     baseUrl: "http://127.0.0.1:8080",
    //     account: "+31123456789",
    //   },
    // },
  ],

  // Conversation links let one SillyTavern chat continue across platforms.
  // Only relevant if you are using pro plugins with multiple frontends active.
  conversationLinks: [
    // {
    //   conversationId: "main-chat",
    //   discordChannelId: "123456789012345678",
    //   telegramChatId: "987654321",
    //   signalChatId: "+31123456789",
    // },
  ],

  // Per-plugin circuit breaker settings.
  // When enabled, the bridge will temporarily stop sending to a plugin if it
  // keeps failing, rather than hammering a broken connection on every message.
  // failureThreshold: how many consecutive failures before pausing.
  // cooldownSeconds: how long to pause before trying again (in seconds).
  plugins: {
    discord: {
      circuitBreaker: {
        enabled: false,
        failureThreshold: 5,
        cooldownSeconds: 30,
      },
    },
    // telegram: {
    //   circuitBreaker: {
    //     enabled: false,
    //     failureThreshold: 5,
    //     cooldownSeconds: 30,
    //   },
    // },
    // signal: {
    //   circuitBreaker: {
    //     enabled: false,
    //     failureThreshold: 5,
    //     cooldownSeconds: 30,
    //   },
    // },
  },
};
