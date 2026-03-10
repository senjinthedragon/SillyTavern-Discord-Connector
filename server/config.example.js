// config.example.js (copy or rename this file to config.js and fill in your settings)
module.exports = {
  // Which frontend plugins should run.
  // Built-in frontend in this free edition: "discord"
  enabledPlugins: ["discord"],

  // Optional external plugin modules (for private/pro frontends).
  // Each entry must expose createPlugin(handlers, pluginConfig).
  externalPlugins: [
    // {
    //   name: "telegram",
    //   module: "../private-plugins/telegram-plugin.js",
    //   config: {
    //     botToken: "YOUR_TELEGRAM_TOKEN",
    //   },
    // },
    // {
    //   name: "signal",
    //   module: "../private-plugins/signal-plugin.js",
    //   config: {
    //     baseUrl: "http://127.0.0.1:8080",
    //     account: "+31123456789",
    //   },
    // },
  ],

  // Conversation links let one SillyTavern chat continue across platforms.
  conversationLinks: [
    // {
    //   conversationId: "main-chat",
    //   discordChannelId: "123456789012345678",
    //   telegramChatId: "987654321",
    //   signalChatId: "+31123456789",
    // },
  ],

  // Discord settings
  discordToken: "YOUR_DISCORD_BOT_TOKEN_HERE",
  allowedUserIds: [],
  allowedChannelIds: [],

  // Optional per-frontend advanced settings (circuit breaker).
  plugins: {
    discord: {
      circuitBreaker: {
        enabled: false,
        failureThreshold: 5,
        cooldownMs: 30000,
      },
    },
  },

  // Bridge server settings
  wssPort: 2333,
  queueTaskTimeoutSeconds: 30,
  imagePlaceholderTimeoutSeconds: 180,
  debug: false,
  timezone: "Europe/Amsterdam",
  locale: "nl-NL",
};
