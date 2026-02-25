/**
 * server.js — SillyTavern Discord Connector: Bridge Server
 *
 * Runs as a standalone Node.js process alongside SillyTavern. Serves two
 * roles simultaneously:
 *
 *   1. Discord bot — receives messages from Discord users and forwards them
 *      to SillyTavern, then posts AI responses back to the originating channel.
 *
 *   2. WebSocket server — maintains a persistent connection to the SillyTavern
 *      extension (index.js) running in the browser, acting as the transport
 *      layer between the two applications.
 *
 * Streaming uses a self-chaining throttle: edits fire at most once per
 * STREAM_THROTTLE_MS, naturally collapsing rapid token bursts without building
 * a backlog. When generation ends the streaming message is deleted and reposted
 * cleanly to remove Discord's [edited] marker.
 *
 * Message ordering for sends/deletes is preserved via a per-channel async queue.
 * Stream edits bypass this queue intentionally to stay real-time.
 */

"use strict";

const { Client, GatewayIntentBits } = require("discord.js");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { setGlobalDispatcher, Agent } = require("undici");

// Force IPv4 and extend the connection timeout for slow networks / large responses.
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 60000, family: 4, autoSelectFamily: false },
  }),
);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const configPath = path.join(__dirname, "./config.js");
if (!fs.existsSync(configPath)) {
  console.error(
    "[ERROR] Missing config.js — copy config.example.js and fill in your settings.",
  );
  process.exit(1);
}

const config = require("./config");
const DEBUG = !!config.debug;
const token = config.discordToken;
const wssPort = config.wssPort;

if (token === "YOUR_DISCORD_BOT_TOKEN_HERE") {
  console.error("[ERROR] Set your Discord Bot Token in config.js!");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Logging
//
// All output goes through log() rather than console.log() directly.
// In production (DEBUG = false) only warnings and errors are printed, keeping
// the terminal clean for end users. Debug-level messages are suppressed.
// ---------------------------------------------------------------------------

/**
 * @param {"log"|"warn"|"error"} level
 * @param {...any} args
 */
function log(level, ...args) {
  if (level === "log" && !DEBUG) return;

  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: config.timezone || "UTC",
  });

  switch (level) {
    case "error":
      console.error(`[${timestamp}]`, ...args);
      break;
    case "warn":
      console.warn(`[${timestamp}]`, ...args);
      break;
    default:
      console.log(`[${timestamp}]`, ...args);
  }
}

// ---------------------------------------------------------------------------
// Crash-loop protection
//
// Tracks restart timestamps in a local file. If the process restarts more than
// MAX_RESTARTS times within RESTART_WINDOW_MS it exits permanently, preventing
// runaway loops from spamming Discord or exhausting system resources.
// ---------------------------------------------------------------------------

const RESTART_PROTECTION_FILE = path.join(__dirname, ".restart_protection");
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

(function checkRestartProtection() {
  try {
    let data = { restarts: [] };
    if (fs.existsSync(RESTART_PROTECTION_FILE)) {
      data = JSON.parse(fs.readFileSync(RESTART_PROTECTION_FILE, "utf8"));
    }
    const now = Date.now();
    data.restarts = data.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    data.restarts.push(now);
    fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify(data));

    if (data.restarts.length > MAX_RESTARTS) {
      console.error(
        `[ERROR] Crash loop detected (${data.restarts.length} restarts in ${RESTART_WINDOW_MS / 1000}s). Exiting.`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error("[ERROR] Restart protection check failed:", err);
  }
})();

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.login(token);
client.on("ready", () =>
  console.log(`[Discord] Logged in as ${client.user.tag}`),
);
client.on("error", (err) => log("error", "[Discord] Client error:", err));

// ---------------------------------------------------------------------------
// Per-channel async queue
//
// Serialises message sends and deletes within a channel to preserve arrival
// order. Each entry is a link in a Promise chain; the slot is freed
// automatically once the tail resolves.
//
// Stream edits do NOT go through this queue — they fire directly to remain
// real-time. Only stream_end (final post) and ai_reply use the queue.
// ---------------------------------------------------------------------------

const channelQueues = {};

function enqueue(channelId, fn) {
  const prev = channelQueues[channelId] || Promise.resolve();
  const next = prev
    .then(() => fn())
    .catch((err) => {
      log("error", `[Queue] Error in channel ${channelId}:`, err.message);
    });
  channelQueues[channelId] = next;
  next.then(() => {
    if (channelQueues[channelId] === next) delete channelQueues[channelId];
  });
  return next;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Active stream sessions, keyed by streamId (a unique ID per character turn).
 *
 * Session properties:
 *   streamMessage  {Message|null}  The Discord message being edited in-place.
 *   pendingText    {string}        Latest cumulative text received from SillyTavern.
 *   characterName  {string|null}   Character's display name (group chat only; null for solo).
 *   editInFlight   {boolean}       True while a Discord API edit call is in progress.
 *   nextEdit       {boolean}       Signals that another edit should fire after the current one.
 *   lastEditAt     {number}        Timestamp of the last completed edit (ms since epoch).
 *   streamDone     {boolean}       Set by stream_end to prevent further edits.
 */
const streamSessions = {};

// Minimum interval between Discord edits per message.
// Discord allows roughly 5 edits per 5 seconds per message; 1200 ms is safe.
const STREAM_THROTTLE_MS = 1200;

// Channels where stream_end has already posted the final message. The
// subsequent ai_reply sent by SillyTavern is skipped for these channels.
const streamHandled = new Set();

/**
 * Splits text that exceeds Discord's 2000-character limit into multiple
 * sequential messages, preferring paragraph then word boundaries.
 *
 * @param {import("discord.js").TextChannel} channel
 * @param {string} text
 */
async function sendLong(channel, text) {
  const MAX = 1900;
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

/**
 * Schedules a throttled Discord edit for an active stream session.
 *
 * Self-chaining throttle pattern:
 *   - If no edit is in flight, one starts immediately (after the throttle delay).
 *   - If an edit is in flight, nextEdit is set so exactly one follow-up fires
 *     when the current one completes, using whatever text is current at that moment.
 *
 * This prevents stale intermediate edits from queuing up while still ensuring
 * the latest text is always shown after each burst of tokens.
 *
 * @param {object} session - Active stream session.
 * @param {import("discord.js").TextChannel} channel
 * @param {string} streamId
 */
function scheduleEdit(session, channel, streamId) {
  if (session.editInFlight) {
    session.nextEdit = true;
    return;
  }

  const delay = Math.max(
    0,
    STREAM_THROTTLE_MS - (Date.now() - session.lastEditAt),
  );
  session.editInFlight = true;

  setTimeout(async () => {
    if (session.streamDone) {
      session.editInFlight = false;
      return;
    }

    const text = session.pendingText;
    session.lastEditAt = Date.now();

    // In group chat, the character name header is prepended on every edit so
    // it remains visible throughout the entire streaming build-up.
    const displayText = session.characterName
      ? `**${session.characterName}**\n${text}`
      : text;

    try {
      if (session.streamMessage) {
        await session.streamMessage.edit(displayText);
        log(
          "log",
          `[Stream] Edited ${session.streamMessage.id} (${displayText.length} chars)`,
        );
      } else {
        session.streamMessage = await channel.send(displayText);
        log(
          "log",
          `[Stream] Created message ${session.streamMessage.id} for ${streamId}`,
        );
      }
    } catch (err) {
      log("warn", `[Stream] Edit failed for ${streamId}: ${err.message}`);
    }

    session.editInFlight = false;

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
console.log(`[Bridge] WebSocket server listening on port ${wssPort}`);

const userCount = config.allowedUserIds?.length || 0;
if (userCount > 0) {
  log("log", `[Security] Restricted to ${userCount} authorized user(s).`);
} else {
  log("warn", `[Security] No allowedUserIds specified. The bot is currently PUBLIC.`);
}

let sillyTavernClient = null;

wss.on("connection", (ws) => {
  console.log("[Bridge] SillyTavern connected");
  sillyTavernClient = ws;

  ws.on("message", async (message) => {
    const data = JSON.parse(message);
    const channelId = data.chatId;
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;

    if (data.type === "heartbeat") {
      ws.send(JSON.stringify({ type: "heartbeat" })); // Echo back
      return;
    }

    switch (data.type) {
      // Show the Discord typing indicator while SillyTavern is generating.
      case "typing_action":
        channel.sendTyping().catch(() => {});
        break;

      // -----------------------------------------------------------------------
      // stream_chunk — a cumulative token update from an active generation.
      //
      // The text field is the full response so far (not just the new token).
      // We store it as pendingText and schedule a throttled edit. A leading
      // "CharacterName: " prefix that SillyTavern injects in group chat mode
      // is stripped; the name is sourced from the explicit characterName field.
      // -----------------------------------------------------------------------
      case "stream_chunk": {
        const streamId = data?.streamId || channelId;
        const rawText = data?.text || "";
        if (!rawText.trim()) break;

        const activeName = data.characterName || null;
        let processedText = rawText;

        if (activeName) {
          const escapedName = activeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const namePrefixRegex = new RegExp(`^${escapedName}:\\s*`, 'i');
          processedText = rawText.replace(namePrefixRegex, "");
        }

        if (!streamSessions[streamId]) {
          streamSessions[streamId] = {
            streamMessage: null,
            pendingText: "",
            characterName: activeName,
            editInFlight: false,
            nextEdit: false,
            lastEditAt: 0,
            streamDone: false,
          };
        }

        const session = streamSessions[streamId];
        if (session.streamDone) break;

        session.pendingText = processedText;
        
        scheduleEdit(session, channel, streamId);
        break;
      }

      // -----------------------------------------------------------------------
      // stream_end — generation for this character is complete.
      //
      // Halts the throttle, waits for any in-flight edit to settle, then
      // deletes the streaming message and reposts the final text cleanly,
      // removing Discord's [edited] marker. Group chat replies include the
      // bold character name header.
      //
      // Routed through the channel queue so multi-character group replies
      // arrive in the correct turn order.
      // -----------------------------------------------------------------------
      case "stream_end": {
        const streamId = data?.streamId || channelId;

        // Halt the throttle immediately so no further edits are scheduled.
        const preSession = streamSessions[streamId];
        if (preSession) {
          preSession.streamDone = true;
          preSession.nextEdit = false;
        }

        enqueue(channelId, async () => {
          const s = streamSessions[streamId];
          if (!s) return;

          // Wait for any in-flight edit to complete before touching the message.
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

          // --- Dynamic Name Stripping Logic ---
          const rawText = s.pendingText || "";
          const activeName = data.characterName || null;
          let processedText = rawText;

          if (activeName) {
            const escapedName = activeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const namePrefixRegex = new RegExp(`^${escapedName}:\\s*`, 'i');
            processedText = rawText.replace(namePrefixRegex, "");
          }
          // ------------------------------------

          const finalText = activeName
            ? `**${activeName}**\n${processedText}`
            : processedText;

          if (finalText.trim()) {
            if (s.streamMessage) {
              await s.streamMessage.delete().catch((err) => {
                log(
                  "warn",
                  `[Stream] Could not delete stream message: ${err.message}`,
                );
              });
            }
            await sendLong(channel, finalText);
            log("log", `[Stream] Posted final message for ${streamId}`);
          }

          delete streamSessions[streamId];
          streamHandled.add(channelId);
        });
        break;
      }

      // -----------------------------------------------------------------------
      // ai_reply — the complete response(s) received after generation ends.
      //
      // Streaming path: stream_end already handled posting; skip this.
      // Non-streaming path: post each character's reply as a separate Discord
      // message, with a bold name header for group chats.
      // -----------------------------------------------------------------------
      case "ai_reply": {
        const messages =
          data?.messages || (data?.text ? [{ name: "", text: data.text }] : []);
        const validMessages = messages.filter((m) => m?.text?.trim());

        if (validMessages.length === 0) {
          channel
            .send(
              "...something went wrong and the response was empty. Try again?",
            )
            .catch(() => {});
          break;
        }

        enqueue(channelId, async () => {
          if (streamHandled.has(channelId)) {
            streamHandled.delete(channelId);
            return;
          }

          const isGroup = validMessages.length > 1;
          for (const msg of validMessages) {
            const formatted =
              isGroup && msg.name
                ? `**${msg.name}**\n${msg.text.trim()}`
                : msg.text.trim();
            await sendLong(channel, formatted);
          }
        });
        break;
      }

      // Forward error messages from the extension to Discord.
      case "error_message": {
        const errorText = (data?.text || "").trim();
        if (errorText) enqueue(channelId, () => sendLong(channel, errorText));
        break;
      }

      default:
        log("warn", "[Bridge] Unknown message type:", data.type);
    }
  });

  ws.on("close", () => {
    sillyTavernClient = null;
    console.log("[Bridge] SillyTavern disconnected");
  });
});

// ---------------------------------------------------------------------------
// Incoming Discord messages → forward to SillyTavern
//
// Regular text becomes a user_message (triggers AI generation).
// Messages starting with "/" become execute_command (handled by the extension).
// ---------------------------------------------------------------------------

client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (
    config.allowedUserIds?.length > 0 &&
    !config.allowedUserIds.includes(message.author.id)
  )
    return;

  if (!sillyTavernClient) {
    message.reply("Bridge is not connected to SillyTavern.").catch(() => {});
    return;
  }

  const chatId = message.channel.id;
  const content = message.content;

  if (content.startsWith("/")) {
    const [command, ...args] = content.slice(1).split(" ");
    sillyTavernClient.send(
      JSON.stringify({ type: "execute_command", command, args, chatId }),
    );
  } else {
    sillyTavernClient.send(
      JSON.stringify({ type: "user_message", text: content, chatId }),
    );
  }
});
