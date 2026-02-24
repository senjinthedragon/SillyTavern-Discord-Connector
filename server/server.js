// server.js
const { Client, GatewayIntentBits } = require("discord.js");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { setGlobalDispatcher, Agent } = require("undici");
setGlobalDispatcher(
  new Agent({
    connect: {
      timeout: 60000,
      family: 4,
      autoSelectFamily: false,
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

// Restart loop protection
const RESTART_PROTECTION_FILE = path.join(__dirname, ".restart_protection");
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000;
function checkRestartProtection() {
  try {
    if (fs.existsSync(RESTART_PROTECTION_FILE)) {
      const data = JSON.parse(fs.readFileSync(RESTART_PROTECTION_FILE, "utf8"));
      const now = Date.now();
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

if (token === "YOUR_DISCORD_BOT_TOKEN_HERE") {
  logWithTimestamp("error", "Set your Discord Bot Token in config.js!");
  process.exit(1);
}

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
client.on("ready", () =>
  logWithTimestamp("log", `Discord Bot logged in as ${client.user.tag}`),
);
client.on("error", (error) =>
  logWithTimestamp("error", "Discord client error:", error),
);

// ---------------------------------------------------------------------------
// Per-channel operation queue
// Ensures all Discord API calls for a channel run one at a time, preventing
// race conditions where concurrent sends/edits create duplicate messages.
// ---------------------------------------------------------------------------
const channelQueues = {}; // { channelId: Promise }

function enqueue(channelId, fn) {
  const prev = channelQueues[channelId] || Promise.resolve();
  const next = prev
    .then(() => fn())
    .catch((err) => {
      logWithTimestamp(
        "error",
        `[QUEUE] Error in queued operation for ${channelId}:`,
        err.message,
      );
    });
  channelQueues[channelId] = next;
  // Clean up resolved queue reference to avoid memory leak on idle channels
  next.then(() => {
    if (channelQueues[channelId] === next) delete channelQueues[channelId];
  });
  return next;
}

// ---------------------------------------------------------------------------
// Stream session state
// { channelId: { streamMessage: Message|null, lastText: string, streamDone: boolean } }
// ---------------------------------------------------------------------------
const streamSessions = {};
const streamHandled = new Set(); // channels where stream_end already posted the final reply

// Minimum ms between Discord edit calls per channel.
// Discord's rate limit is ~5 edits/5s per message; 1200ms gives comfortable headroom.
const STREAM_THROTTLE_MS = 1200;

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocket.Server({ port: wssPort });
logWithTimestamp("log", `WS server listening on port ${wssPort}...`);

let sillyTavernClient = null;

wss.on("connection", (ws) => {
  logWithTimestamp("log", "SillyTavern connected via WS");
  sillyTavernClient = ws;

  ws.on("message", async (message) => {
    const data = JSON.parse(message);
    const channelId = data.chatId;
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;

    switch (data.type) {
      // -----------------------------------------------------------------------
      case "typing_action":
        channel.sendTyping().catch(() => {});
        break;

      // -----------------------------------------------------------------------
      // stream_chunk: throttle edits and always edit-in-place.
      // We only ever create ONE message per stream session (on the very first
      // chunk), then edit it on every subsequent chunk.
      // -----------------------------------------------------------------------
      case "stream_chunk": {
        const chunkText = (data?.text || "").trim();
        if (!chunkText) break;

        // Initialise session if this is the first chunk for this channel
        if (!streamSessions[channelId]) {
          streamSessions[channelId] = {
            streamMessage: null,
            lastText: "",
            lastEditAt: 0,
            streamDone: false,
          };
        }

        const session = streamSessions[channelId];

        // If the session was already finalised by ai_reply, ignore stale chunks
        if (session.streamDone) break;

        // Store the latest text; the queued operation below will use whatever
        // is current at the time it actually runs (skips intermediate states
        // if Discord is falling behind — avoids piling up a queue of edits).
        session.lastText = chunkText;

        // Throttle: skip scheduling a new edit if one was dispatched very recently
        const now = Date.now();
        if (
          now - session.lastEditAt < STREAM_THROTTLE_MS &&
          session.streamMessage
        ) {
          break;
        }
        session.lastEditAt = now;

        enqueue(channelId, async () => {
          // Re-read session state at execution time (it may have been finalised)
          const s = streamSessions[channelId];
          if (!s || s.streamDone) return;

          const textToShow = s.lastText;
          if (!textToShow) return;

          if (s.streamMessage) {
            // Edit the single existing message
            await s.streamMessage.edit(textToShow);
            logWithTimestamp(
              "log",
              `[STREAM] Edited message ${s.streamMessage.id} (${textToShow.length} chars)`,
            );
          } else {
            // First chunk — create the one and only stream message
            const sent = await channel.send(textToShow);
            s.streamMessage = sent;
            logWithTimestamp(
              "log",
              `[STREAM] Created stream message ${sent.id}`,
            );
          }
        });
        break;
      }

      // -----------------------------------------------------------------------
      // stream_end: all chunks have arrived — the last stored text IS the
      // complete message. Delete the stream-built message (which carries the
      // [edited] marker) and immediately post it as a clean, fresh message.
      // No need to wait for ai_reply; that event fires much later and would
      // cause the 20-30 second delay the user sees.
      // -----------------------------------------------------------------------
      case "stream_end":
        enqueue(channelId, async () => {
          const s = streamSessions[channelId];
          if (!s) return;

          s.streamDone = true;
          const finalText = s.lastText;

          if (s.streamMessage && finalText) {
            logWithTimestamp(
              "log",
              `[STREAM] stream_end — deleting stream message and posting clean final reply`,
            );
            await s.streamMessage.delete().catch((err) => {
              logWithTimestamp(
                "warn",
                `[STREAM] Could not delete stream message: ${err.message}`,
              );
            });
            await channel.send(finalText);
            logWithTimestamp(
              "log",
              `[STREAM] Clean final reply sent for channel ${channelId}`,
            );
          } else if (finalText) {
            // Stream ended but no message was ever sent (edge case) — send fresh
            await channel.send(finalText);
          }

          delete streamSessions[channelId];
          streamHandled.add(channelId); // mark so ai_reply knows not to send again
        });
        break;

      // -----------------------------------------------------------------------
      // ai_reply: the complete final text, sent by SillyTavern after generation.
      //
      // If streaming was used, stream_end already did the delete-and-replace,
      // so the session will be gone and there is nothing left to do here.
      // ai_reply only acts when there was no streaming (session never existed),
      // sending the reply as a plain fresh message.
      // -----------------------------------------------------------------------
      case "ai_reply": {
        const replyText = (data?.text || "").trim();
        if (!replyText) {
          channel
            .send("...the wolf lost his words for a second. Try again?")
            .catch(() => {});
          break;
        }

        enqueue(channelId, async () => {
          // If stream_end already posted the final reply, nothing to do here
          if (streamHandled.has(channelId)) {
            logWithTimestamp(
              "log",
              `[AI_REPLY] Streaming already handled channel ${channelId} — skipping`,
            );
            streamHandled.delete(channelId); // clean up the flag
            return;
          }

          const s = streamSessions[channelId];
          if (s) {
            // Session still alive — stream_end hasn't fired yet (very rare race).
            // Mark done and bail; stream_end will post the final reply.
            logWithTimestamp(
              "warn",
              `[AI_REPLY] Session still alive — deferring to stream_end`,
            );
            return;
          }

          // No session and not flagged — non-streaming mode, send fresh
          logWithTimestamp(
            "log",
            `[AI_REPLY] No stream session — sending fresh reply to channel ${channelId}`,
          );
          await channel.send(replyText);
          logWithTimestamp("log", `[AI_REPLY] Done for channel ${channelId}`);
        });
        break;
      }

      // -----------------------------------------------------------------------
      case "error_message": {
        const errorText = (data?.text || "").trim();
        if (!errorText) break;
        enqueue(channelId, async () => {
          await channel.send(errorText);
        });
        break;
      }

      default:
        logWithTimestamp("warn", "Unknown WS message type:", data.type);
    }
  });

  ws.on("close", () => {
    sillyTavernClient = null;
    logWithTimestamp("log", "SillyTavern WS disconnected");
  });
});

// ---------------------------------------------------------------------------
// Incoming Discord messages → forward to SillyTavern
// ---------------------------------------------------------------------------
client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (
    config.allowedUserIds.length > 0 &&
    !config.allowedUserIds.includes(message.author.id)
  )
    return;

  const chatId = message.channel.id;

  if (message.content.startsWith("/")) {
    const [command, ...args] = message.content.slice(1).split(" ");
    if (sillyTavernClient) {
      sillyTavernClient.send(
        JSON.stringify({ type: "execute_command", command, args, chatId }),
      );
    } else {
      message.reply("Bridge not connected to SillyTavern.");
    }
  } else {
    if (sillyTavernClient) {
      sillyTavernClient.send(
        JSON.stringify({ type: "user_message", text: message.content, chatId }),
      );
    } else {
      message.reply("Bridge not connected to SillyTavern.");
    }
  }
});
