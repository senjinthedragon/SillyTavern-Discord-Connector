// server.js
const { Client, GatewayIntentBits } = require("discord.js");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { setGlobalDispatcher, Agent } = require("undici");
setGlobalDispatcher(
  new Agent({
    connect: {
      timeout: 60000, // 60 seconds — generous breathing room for slow connections
      family: 4, // Force IPv4 only, skipping IPv6 resolution issues
      autoSelectFamily: false, // Disable auto-fallback attempts that can cause hangs
    },
  }),
);
// Log a message with a human-readable local timestamp prefix
function logWithTimestamp(level, ...args) {
  const now = new Date();
  const timestamp = now.toLocaleString("en-US", {
    timeZone: "Europe/Amsterdam",
  });
  const prefix = `[${timestamp}]`;
  switch (level) {
    case "error":
      console.error(prefix, ...args);
      break;
    case "warn":
      console.warn(prefix, ...args);
      break;
    default:
      console.log(prefix, ...args);
  }
}
// Restart loop protection — if the process crashes and restarts more than
// MAX_RESTARTS times within RESTART_WINDOW_MS, it will exit to prevent an
// infinite crash loop.
const RESTART_PROTECTION_FILE = path.join(__dirname, ".restart_protection");
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000;
function checkRestartProtection() {
  try {
    if (fs.existsSync(RESTART_PROTECTION_FILE)) {
      const data = JSON.parse(fs.readFileSync(RESTART_PROTECTION_FILE, "utf8"));
      const now = Date.now();
      // Discard restart timestamps that fall outside the protection window
      data.restarts = data.restarts.filter(
        (time) => now - time < RESTART_WINDOW_MS,
      );
      data.restarts.push(now);
      if (data.restarts.length > MAX_RESTARTS) {
        logWithTimestamp(
          "error",
          `Restart loop detected! ${data.restarts.length} restarts in ${RESTART_WINDOW_MS / 1000}s. Exiting.`,
        );
        process.exit(1);
      }
      fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify(data));
    } else {
      // First run — create the protection file with the current timestamp
      fs.writeFileSync(
        RESTART_PROTECTION_FILE,
        JSON.stringify({ restarts: [Date.now()] }),
      );
    }
  } catch (error) {
    logWithTimestamp("error", "Restart protection check failed:", error);
  }
}
checkRestartProtection();
// Ensure config.js exists before attempting to load it
const configPath = path.join(__dirname, "./config.js");
if (!fs.existsSync(configPath)) {
  logWithTimestamp(
    "error",
    "Missing config.js! Copy config.example.js and fill in your settings.",
  );
  process.exit(1);
}
const config = require("./config");
const token = config.discordToken;
const wssPort = config.wssPort;
// Guard against an unconfigured bot token
if (token === "YOUR_DISCORD_BOT_TOKEN_HERE") {
  logWithTimestamp("error", "Set your Discord Bot Token in config.js!");
  process.exit(1);
}
// Initialize the Discord client with the required gateway intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});
client.login(token);
logWithTimestamp("log", "Logging into Discord...");
client.on("ready", () => {
  logWithTimestamp("log", `Discord Bot logged in as ${client.user.tag}`);
});
client.on("error", (error) => {
  logWithTimestamp("error", "Discord client error:", error);
});
// Start the WebSocket server that SillyTavern's extension connects to
const wss = new WebSocket.Server({ port: wssPort });
logWithTimestamp("log", `WS server listening on port ${wssPort}...`);
let sillyTavernClient = null;
const streamSessions = {}; // Tracks active streaming sessions per channel: { channelId: { lastMessage: Message } }
wss.on("connection", (ws) => {
  logWithTimestamp("log", "SillyTavern connected via WS");
  sillyTavernClient = ws;
  ws.on("message", async (message) => {
    const data = JSON.parse(message);
    const channelId = data.chatId; // Discord channel or DM channel ID
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;
    switch (data.type) {
      // Show a typing indicator in the Discord channel
      case "typing_action":
        channel.sendTyping();
        break;
      // Handle an incoming streaming text chunk — edit the last sent message
      // in place to simulate a live typing effect in Discord
      case "stream_chunk":
        console.log("[STREAM_CHUNK] Received for channel", channelId);
        console.log("[STREAM_CHUNK] Raw data:", JSON.stringify(data, null, 2));
        const chunkText = (data?.text || "").trim();
        if (!chunkText) {
          console.warn("[STREAM_CHUNK] Empty or missing text — ignoring");
          break;
        }
        // Create a new session for this channel if one doesn't already exist
        if (!streamSessions[channelId]) {
          streamSessions[channelId] = { lastMessage: null };
          console.log("[STREAM_CHUNK] New session created for", channelId);
        }
        const session = streamSessions[channelId];
        try {
          if (session.lastMessage) {
            // Edit the existing message with the latest cumulative text
            console.log(
              "[STREAM_CHUNK] Editing existing message ID:",
              session.lastMessage.id,
            );
            await session.lastMessage.edit(chunkText);
            console.log("[STREAM_CHUNK] Edit succeeded");
          } else {
            // Send the very first chunk as a new message
            console.log("[STREAM_CHUNK] Sending first chunk as new message");
            const sent = await channel.send(chunkText);
            session.lastMessage = sent;
            console.log(
              "[STREAM_CHUNK] Initial send succeeded, new msg ID:",
              sent.id,
            );
          }
        } catch (err) {
          console.error(
            "[STREAM_CHUNK] Failed to send/edit chunk:",
            err.message,
          );
          console.error("[STREAM_CHUNK] Full error:", err);
          // Emergency fallback: send as a fresh message if edit fails
          try {
            console.log("[STREAM_CHUNK] Fallback: sending new message instead");
            const fallbackSent = await channel.send(chunkText);
            session.lastMessage = fallbackSent;
            console.log("[STREAM_CHUNK] Fallback send succeeded");
          } catch (fallbackErr) {
            console.error(
              "[STREAM_CHUNK] Even fallback failed:",
              fallbackErr.message,
            );
          }
        }
        break;
      // Streaming is complete — clean up the session for this channel
      case "stream_end":
        if (streamSessions[channelId]) delete streamSessions[channelId];
        break;
      // Send the final, complete AI reply to the Discord channel
      case "ai_reply":
        console.log("[AI_REPLY] Received for channel", channelId);
        console.log("[AI_REPLY] Raw payload:", JSON.stringify(data, null, 2));
        const replyText = (data?.text || "").trim();
        if (typeof replyText !== "string" || replyText === "") {
          console.error(
            "[AI_REPLY] Invalid or empty text received:",
            data?.text,
          );
          channel
            .send("...the wolf lost his words for a second. Try again?")
            .catch((e) =>
              console.error("[AI_REPLY FALLBACK] Send failed:", e.message),
            );
          break;
        }
        try {
          console.log(
            "[AI_REPLY] Attempting to send:",
            replyText.substring(0, 80) + (replyText.length > 80 ? "..." : ""),
          );
          await channel.send(replyText);
          console.log("[AI_REPLY] Send succeeded");
        } catch (err) {
          console.error("[AI_REPLY] Send failed:", err.message);
          console.error("[AI_REPLY] Full error:", err);
          // Last-resort fallback attempt before giving up
          try {
            console.log("[AI_REPLY] Fallback send attempt");
            await channel.send(replyText);
            console.log("[AI_REPLY] Fallback succeeded");
          } catch (fallbackErr) {
            console.error(
              "[AI_REPLY] Even fallback failed:",
              fallbackErr.message,
            );
          }
        }
        break;
      // Forward an error message from SillyTavern to the Discord channel
      case "error_message":
        console.log(
          "[DEBUG] Received error_message for",
          channelId,
          "payload:",
          data,
        );
        const errorText = data?.text?.trim();
        if (typeof errorText !== "string" || errorText === "") {
          console.error("[ERROR] Invalid error_message text:", data?.text);
          break;
        }
        console.log(
          "[DEBUG] Sending error reply:",
          errorText.substring(0, 80) + "...",
        );
        channel.send(errorText).catch((e) => {
          console.error("[SEND ERROR] Failed to send error_message:", e);
        });
        break;
      default:
        logWithTimestamp("warn", "Unknown WS message type:", data.type);
    }
  });
  ws.on("close", () => {
    sillyTavernClient = null;
    logWithTimestamp("log", "SillyTavern WS disconnected");
  });
});
// Handle incoming Discord messages and route them to SillyTavern
client.on("messageCreate", (message) => {
  // Ignore messages from bots (including ourselves) to prevent feedback loops
  if (message.author.bot) return;
  // If an allowlist is configured, silently ignore users not on it
  if (
    config.allowedUserIds.length > 0 &&
    !config.allowedUserIds.includes(message.author.id)
  )
    return;
  const chatId = message.channel.id; // Use the channel ID as the chatId throughout the bridge
  if (message.content.startsWith("/")) {
    // Slash-prefixed messages are treated as commands and forwarded to SillyTavern
    const [command, ...args] = message.content.slice(1).split(" ");
    if (sillyTavernClient) {
      sillyTavernClient.send(
        JSON.stringify({ type: "execute_command", command, args, chatId }),
      );
    } else {
      message.reply("Bridge not connected to SillyTavern.");
    }
  } else {
    // All other messages are forwarded as standard user messages for AI response
    if (sillyTavernClient) {
      sillyTavernClient.send(
        JSON.stringify({ type: "user_message", text: message.content, chatId }),
      );
    } else {
      message.reply("Bridge not connected to SillyTavern.");
    }
  }
});
