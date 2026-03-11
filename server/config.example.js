// config.example.js
// Copy or rename this file to config.js and fill in your settings.
// You only need to change the top section to get started.

module.exports = {
  // =========================================================================
  // ESSENTIAL SETTINGS — fill these in to get the bridge running
  // =========================================================================

  // Your Discord Bot Token.
  // Obtain this from the Discord Developer Portal (discord.com/developers/applications).
  discordToken: "YOUR_DISCORD_BOT_TOKEN_HERE",

  // Restrict which Discord users can talk to the bot.
  // Add your own Discord user ID here to keep the bot private to yourself.
  // Leave empty to allow anyone — not recommended unless your server is private.
  // To get a user ID: enable Developer Mode in Discord settings, then right-click
  // a user and select "Copy User ID".
  allowedUserIds: [], // e.g. ["123456789012345678", "987654321098765432"]

  // Restrict which Discord channels the bot will respond in.
  // Leave empty to allow all channels in your server.
  // To get a channel ID: enable Developer Mode in Discord settings, then
  // right-click a channel and select "Copy Channel ID".
  allowedChannelIds: [], // e.g. ["123456789012345678"]

  // =========================================================================
  // GENERAL SETTINGS — safe to leave as-is, but worth a look
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
  // ADVANCED SETTINGS — no need to touch these unless you know what you're
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
    //   module: "plugins/telegram.js",
    //   config: {
    //     botToken: "YOUR_TELEGRAM_BOT_TOKEN",
    //   },
    // },
    // {
    //   name: "signal",
    //   module: "plugins/signal.js",
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
  // cooldownMs: how long to pause before trying again (milliseconds).
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
    //     cooldownMs: 30000,
    //   },
    // },
    // signal: {
    //   circuitBreaker: {
    //     enabled: false,
    //     failureThreshold: 5,
    //     cooldownMs: 30000,
    //   },
    // },
  },
};
