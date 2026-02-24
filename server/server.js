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
// Per-channel queue — used ONLY for message sends and deletes (ordering ops).
// Stream edits bypass this entirely and use a per-session debounce timer.
// ---------------------------------------------------------------------------
const channelQueues = {};

function enqueue(channelId, fn) {
  const prev = channelQueues[channelId] || Promise.resolve();
  const next = prev
    .then(() => fn())
    .catch((err) => {
      logWithTimestamp(
        "error",
        `[QUEUE] Error for channel ${channelId}:`,
        err.message,
      );
    });
  channelQueues[channelId] = next;
  next.then(() => {
    if (channelQueues[channelId] === next) delete channelQueues[channelId];
  });
  return next;
}

// ---------------------------------------------------------------------------
// Stream sessions — keyed by streamId (unique per character turn).
//
// Each session:
//   streamMessage  Discord Message being edited in-place (null until first send)
//   pendingText    Latest text to show; updated on every incoming chunk
//   editInFlight   True while an async edit API call is running
//   nextEdit       Pending edit scheduled for after the in-flight one completes
//   streamDone     True once stream_end has taken over
// ---------------------------------------------------------------------------
const streamSessions = {};

// Minimum ms between Discord edit API calls per stream session.
// Discord allows ~5 edits/5s per message. 1200ms gives comfortable headroom
// while still showing visible streaming progress to the user.
const STREAM_THROTTLE_MS = 1200;

// Channels where stream_end already posted the final reply.
const streamHandled = new Set();

// ---------------------------------------------------------------------------
// sendLong: splits text across multiple Discord messages at word/newline
// boundaries if it exceeds Discord's 2000-character hard limit.
// ---------------------------------------------------------------------------
async function sendLong(channel, text) {
  const MAX = 1900;
  if (text.length <= MAX) {
    await channel.send(text);
    return;
  }
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      await channel.send(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MAX);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", MAX);
    if (splitAt <= 0) splitAt = MAX;
    await channel.send(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
}

// ---------------------------------------------------------------------------
// scheduleEdit: throttled Discord edit for a stream session.
//
// Called on every incoming chunk. Uses a self-chaining throttle pattern:
//   - If no edit is in flight, fires immediately.
//   - If an edit IS in flight, schedules exactly one follow-up to run when
//     the current edit completes — using whatever the latest text is at that
//     moment. This prevents queue buildup while ensuring the final state is
//     always shown.
// ---------------------------------------------------------------------------
function scheduleEdit(session, channel, streamId) {
  // Always update pendingText — caller does this before calling us,
  // but nextEdit closure needs to capture it at execution time via session ref.

  if (session.editInFlight) {
    // An edit is already running. Mark that we want another one after it,
    // but don't stack more than one pending — the next one will pick up
    // whatever text is current when it runs.
    session.nextEdit = true;
    return;
  }

  const now = Date.now();
  const msSinceLast = now - (session.lastEditAt || 0);
  const delay = Math.max(0, STREAM_THROTTLE_MS - msSinceLast);

  session.editInFlight = true;

  setTimeout(async () => {
    if (session.streamDone) {
      session.editInFlight = false;
      return;
    }

    const text = session.pendingText;
    session.lastEditAt = Date.now();

    try {
      if (session.streamMessage) {
        // Editing: name header is already in the message, just update the body.
        // Re-prepend the header so it stays present through every edit.
        const editText = session.characterName
          ? `**${session.characterName}**\n${text}`
          : text;
        await session.streamMessage.edit(editText);
        logWithTimestamp(
          "log",
          `[STREAM] Edited ${session.streamMessage.id} (${editText.length} chars)`,
        );
      } else {
        // First send: prepend bold name header for group chat
        const sendText = session.characterName
          ? `**${session.characterName}**\n${text}`
          : text;
        const sent = await channel.send(sendText);
        session.streamMessage = sent;
        logWithTimestamp(
          "log",
          `[STREAM] Created stream message ${sent.id} for ${streamId}`,
        );
      }
    } catch (err) {
      logWithTimestamp(
        "warn",
        `[STREAM] Edit/send failed for ${streamId}: ${err.message}`,
      );
    }

    session.editInFlight = false;

    // If new chunks arrived while we were editing, fire one more edit now
    if (session.nextEdit && !session.streamDone) {
      session.nextEdit = false;
      scheduleEdit(session, channel, streamId);
    }
  }, delay);
}

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
      // stream_chunk: store latest text and schedule a debounced Discord edit.
      // Multiple rapid tokens collapse into a single edit when they go quiet.
      // -----------------------------------------------------------------------
      case "stream_chunk": {
        const rawChunk = (data?.text || "").trim();
        const streamId = data?.streamId || channelId;
        if (!rawChunk) break;

        // Strip "CharacterName: " prefix if present in group chat streaming
        const chunkText = rawChunk.replace(/^[A-Za-z0-9 ]{1,50}: /, "");
        const characterName = data.characterName || null;

        if (!streamSessions[streamId]) {
          streamSessions[streamId] = {
            streamMessage: null,
            pendingText: "",
            characterName, // stored once; used to prefix the first message
            editInFlight: false,
            nextEdit: false,
            lastEditAt: 0,
            streamDone: false,
          };
        }

        const session = streamSessions[streamId];
        if (session.streamDone) break;

        session.pendingText = chunkText;
        scheduleEdit(session, channel, streamId);
        break;
      }

      // -----------------------------------------------------------------------
      // stream_end: generation for this character is complete.
      // Cancel any pending debounce timer, then delete the stream message and
      // post the final text as a clean fresh message (no [edited] marker).
      // Goes through the channel queue to keep character order consistent.
      // -----------------------------------------------------------------------
      case "stream_end": {
        const streamId = data?.streamId || channelId;

        // Signal the throttle to stop scheduling new edits — stream_end takes over
        const preSession = streamSessions[streamId];
        if (preSession) {
          preSession.nextEdit = false; // discard any pending follow-up edit
        }

        enqueue(channelId, async () => {
          const s = streamSessions[streamId];
          if (!s) return;

          s.streamDone = true;
          s.nextEdit = false;

          // Wait for any in-flight throttle edit to complete before we touch the message
          if (s.editInFlight) {
            await new Promise((resolve) => {
              const poll = setInterval(() => {
                if (!s.editInFlight) {
                  clearInterval(poll);
                  resolve();
                }
              }, 50);
            });
          }

          const rawFinal = (s.pendingText || "").replace(
            /^[A-Za-z0-9 ]{1,50}: /,
            "",
          );
          const charName = data.characterName || null;
          const keepMessage = !!data.keepMessage; // solo chat: keep stream message as-is

          // Both solo and group: delete the stream message (which has the [edited]
          // marker) and repost as a clean final message. Group chat also prepends
          // the bold character name header.
          const finalText =
            charName && rawFinal ? `**${charName}**\n${rawFinal}` : rawFinal;
          if (s.streamMessage && finalText) {
            logWithTimestamp(
              "log",
              `[STREAM] stream_end ${streamId} — replacing with clean final`,
            );
            await s.streamMessage.delete().catch((err) => {
              logWithTimestamp(
                "warn",
                `[STREAM] Could not delete stream message: ${err.message}`,
              );
            });
            await sendLong(channel, finalText);
          } else if (finalText) {
            // Throttle never fired (very short response) — send fresh
            await sendLong(channel, finalText);
          }

          delete streamSessions[streamId];
          streamHandled.add(channelId);
        });
        break;
      }

      // -----------------------------------------------------------------------
      // ai_reply: complete text(s) sent by SillyTavern after generation ends.
      //
      // Streaming path: stream_end already posted each character's message and
      // flagged the channel — skip entirely.
      //
      // Non-streaming path: post each character as a separate Discord message,
      // with a bold name header in group chats.
      // -----------------------------------------------------------------------
      case "ai_reply": {
        const messages =
          data?.messages || (data?.text ? [{ name: "", text: data.text }] : []);
        const validMessages = messages.filter((m) => m?.text?.trim());

        if (validMessages.length === 0) {
          channel
            .send("...the wolf lost his words for a second. Try again?")
            .catch(() => {});
          break;
        }

        enqueue(channelId, async () => {
          if (streamHandled.has(channelId)) {
            logWithTimestamp(
              "log",
              `[AI_REPLY] Streaming already handled ${channelId} — skipping`,
            );
            streamHandled.delete(channelId);
            return;
          }

          const isGroup = validMessages.length > 1;
          for (const msg of validMessages) {
            const text = msg.text.trim();
            const formatted =
              isGroup && msg.name ? `**${msg.name}**\n${text}` : text;
            logWithTimestamp(
              "log",
              `[AI_REPLY] Sending${isGroup ? ` (${msg.name})` : ""} to ${channelId}`,
            );
            await sendLong(channel, formatted);
          }
          logWithTimestamp("log", `[AI_REPLY] Done for ${channelId}`);
        });
        break;
      }

      // -----------------------------------------------------------------------
      case "error_message": {
        const errorText = (data?.text || "").trim();
        if (!errorText) break;
        enqueue(channelId, async () => {
          await sendLong(channel, errorText);
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
