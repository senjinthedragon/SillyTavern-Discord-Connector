// config.example.js (copy or rename this file to config.js and fill in your settings)
module.exports = {
  // Your Discord Bot Token - obtain this from the Discord Developer Portal.
  // Make sure the "Message Content" Privileged Intent is enabled for your bot.
  discordToken: "YOUR_DISCORD_BOT_TOKEN_HERE",

  // The port the WebSocket server will listen on.
  // This must match the port in the bridge URL set in the SillyTavern extension settings.
  wssPort: 2333,

  // Allowlist of Discord user IDs permitted to interact with the bot.
  // Leave as an empty array to allow all users.
  // To get a user ID: enable Developer Mode in Discord, then right-click a user and select "Copy ID".
  allowedUserIds: [], // e.g., ['123456789012345678', '987654321098765432']

  // Allowlist of Discord channel IDs permitted to interact with the bot.
  // Leave as an empty array to allow all channels.
  // To get a channel ID: enable Developer Mode in Discord, then right-click a channel and select "Copy ID".
  allowedChannelIds: [], // e.g., ['123456789012345678', '987654321098765432']

  // Advanced timing settings (milliseconds)
  // How long a queued Discord send/edit task may run before it is released.
  queueTaskTimeoutMs: 30000,

  // How long the "Generating image…" placeholder waits before switching to
  // a timeout message when no result comes back.
  imagePlaceholderTimeoutMs: 180000,

  // Set to true to enable verbose terminal logging
  debug: false,

  // Timezone for log timestamps and chat date formatting in Discord autocomplete.
  // Use IANA timezone names e.g. "Europe/Amsterdam", "America/New_York", "Asia/Tokyo".
  timezone: "America/New_York",

  // Locale for date/time formatting in Discord autocomplete chat lists.
  // Use BCP 47 language tags e.g. "nl-NL", "en-GB", "en-US", "de-DE".
  // Leave unset or set to null to use the SillyTavern browser's default locale.
  locale: "en-US",
};
