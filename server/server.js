/**
 * server.js - SillyTavern Discord Connector: Bridge Server
 *
 * Runs as a standalone Node.js process alongside SillyTavern. Serves two
 * roles simultaneously:
 *
 *   1. Discord bot - receives messages from Discord users and forwards them
 *      to SillyTavern, then posts AI responses back to the originating channel.
 *
 *   2. WebSocket server - maintains a persistent connection to the SillyTavern
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
 *
 * Slash command autocomplete uses an on-demand request/response pattern over
 * the existing WebSocket: the bridge sends a get_autocomplete packet when
 * Discord fires an autocomplete interaction, the extension responds with the
 * live list from SillyTavern's context, and the bridge forwards it to Discord
 * within the 3-second autocomplete window.
 *
 * Autocomplete requests are debounced per user per command: only the final
 * keystroke in a burst actually reaches SillyTavern. Earlier interactions in
 * the same burst are acknowledged immediately with an empty list so Discord
 * does not flag them as failed.
 */

"use strict";

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
} = require("discord.js");
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
    "[ERROR] Missing config.js - copy config.example.js and fill in your settings.",
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

// ---------------------------------------------------------------------------
// Slash command definitions
//
// Defines the commands that Discord will surface in the "/" autocomplete menu.
// The "name" of each entry is forwarded verbatim as the command field of an
// execute_command packet to the extension, so names must exactly match the
// cases in index.js's switch statement.
//
// Registered via a PUT to Routes.applicationCommands on every ClientReady.
// The PUT is a full overwrite (not an append), so this array is always the
// authoritative list - adding or removing an entry here takes effect on the
// next bot restart with no manual cleanup required.
//
// Numbered shortcut commands (/switchchar_1, /switchgroup_2, /switchchat_3,
// etc.) are intentionally absent. Discord requires all slash command names to
// be declared statically at registration time, but these variants are
// unbounded - their upper limit depends on how many characters, groups, or
// chat files the user has installed in SillyTavern. They remain fully usable
// as plain text messages: the messageCreate handler forwards any message
// starting with "/" as an execute_command regardless of whether a matching
// slash command was registered. Users can type "/switchchar_3" directly;
// /listchars, /listgroups, and /listchats each include the numbered shortcuts
// in their output to guide users to the right number.
// ---------------------------------------------------------------------------

const SLASH_COMMANDS = [
  {
    name: "sthelp",
    description: "Show all available bridge commands",
  },
  {
    name: "newchat",
    description: "Start a fresh chat with the current character",
  },
  {
    name: "listchars",
    description:
      "List all characters (includes numbered shortcuts for text use)",
  },
  {
    name: "switchchar",
    description: "Switch to a character by exact name",
    options: [
      {
        name: "name",
        type: 3, // STRING
        description: "The exact character name to switch to",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "listgroups",
    description: "List all groups (includes numbered shortcuts for text use)",
  },
  {
    name: "switchgroup",
    description: "Switch to a group by exact name",
    options: [
      {
        name: "name",
        type: 3, // STRING
        description: "The exact group name to switch to",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "listchats",
    description:
      "List chat history for the current character (includes numbered shortcuts)",
  },
  {
    name: "switchchat",
    description: "Load a past chat by name (without the .jsonl extension)",
    options: [
      {
        name: "name",
        type: 3, // STRING
        description: "The exact chat filename to load (omit .jsonl)",
        required: true,
        autocomplete: true,
      },
    ],
  },
];

client.login(token);

client.on(Events.ClientReady, async (c) => {
  console.log(`[Discord] Ready! Logged in as ${c.user.tag}`);

  // Push the slash command list to Discord on every startup. Using PUT with
  // Routes.applicationCommands does a full overwrite of the bot's global
  // command set, which is safe to run repeatedly - it's idempotent and fast
  // (one API call). Global commands propagate to all servers the bot is in
  // but can take up to an hour to appear in Discord clients.
  //
  // For instant registration scoped to a single server during development,
  // replace the route with:
  //   Routes.applicationGuildCommands(c.user.id, "YOUR_GUILD_ID_HERE")
  // Guild commands appear immediately but only work in that one server.
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("[Discord] Registering slash commands...");
    await rest.put(Routes.applicationCommands(c.user.id), {
      body: SLASH_COMMANDS,
    });
    console.log("[Discord] Slash commands registered successfully.");
  } catch (err) {
    log("error", "[Discord] Failed to register slash commands:", err);
  }
});

client.on("error", (err) => log("error", "[Discord] Client error:", err));

// ---------------------------------------------------------------------------
// Per-channel async queue
//
// Serialises message sends and deletes within a channel to preserve arrival
// order. Each entry is a link in a Promise chain; the slot is freed
// automatically once the tail resolves.
//
// Stream edits do NOT go through this queue - they fire directly to remain
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
const channelCount = config.allowedChannelIds?.length || 0;

if (userCount > 0) {
  log("log", `[Security] Restricted to ${userCount} authorized user(s).`);
} else {
  log(
    "warn",
    "[Security] No allowedUserIds set - bot accepts messages from any user.",
  );
}

if (channelCount > 0) {
  log("log", `[Security] Restricted to ${channelCount} authorized channel(s).`);
} else {
  log(
    "warn",
    "[Security] No allowedChannelIds set - bot accepts messages from any channel.",
  );
}

let sillyTavernClient = null;

// ---------------------------------------------------------------------------
// Autocomplete debouncing and pending request tracking
//
// Discord fires an autocomplete interaction on every keystroke while the user
// is typing. Forwarding each one to SillyTavern would cause unnecessary disk
// reads (especially for chat lists) and could back up the extension's message
// queue faster than it can drain. Debouncing collapses each burst of keystrokes
// into a single request: only the final keystroke within AUTOCOMPLETE_DEBOUNCE_MS
// is forwarded. Earlier interactions in the same burst are acknowledged
// immediately with an empty list so Discord does not mark them as failed.
//
// Debounce state is tracked per (userId, commandName) pair so concurrent users
// or concurrent commands do not interfere with each other.
//
// Once a debounced request fires, the interaction is parked in
// pendingAutocompletes until the extension responds. Each entry holds the
// interaction object and a safety timeout. The timeout fires at
// AUTOCOMPLETE_TIMEOUT_MS and responds with an empty list rather than letting
// the interaction expire silently, which would leave the user's dropdown
// permanently stuck on a loading spinner.
//
// Entries are deleted on response or timeout, whichever comes first.
// ---------------------------------------------------------------------------

const AUTOCOMPLETE_DEBOUNCE_MS = 250;
const AUTOCOMPLETE_TIMEOUT_MS = 2800;
const autocompleteDebouncers = {}; // keyed by `${userId}:${commandName}`
const pendingAutocompletes = {}; // keyed by requestId

wss.on("connection", (ws) => {
  console.log("[Bridge] SillyTavern connected");
  sillyTavernClient = ws;

  ws.on("message", async (message) => {
    const data = JSON.parse(message);

    if (data.type === "heartbeat") {
      ws.send(JSON.stringify({ type: "heartbeat" })); // Echo back
      return;
    }

    // autocomplete_response carries a requestId rather than a chatId so it
    // needs no channel object. It is handled here, before the channel lookup,
    // to avoid being silently swallowed by the `if (!channel) return` guard.
    if (data.type === "autocomplete_response") {
      const pending = pendingAutocompletes[data.requestId];
      if (!pending) return; // Already timed out; the timeout already responded.

      clearTimeout(pending.timeout);
      delete pendingAutocompletes[data.requestId];

      // Discord requires each choice to be { name, value }. name is the label
      // shown in the dropdown; value is what gets submitted when the user picks
      // it. For our purposes they are always the same string. The 25-entry cap
      // is applied again here as a safety net in case the extension sends more
      // than expected, since Discord will reject the entire respond() call if
      // the array exceeds 25 entries.
      const choices = (data.choices || []).slice(0, 25).map((name) => ({
        name,
        value: name,
      }));

      await pending.interaction.respond(choices).catch((err) => {
        log("warn", `[Autocomplete] respond() failed: ${err.message}`);
      });
      return;
    }

    // All remaining message types are tied to a specific Discord channel.
    const channelId = data.chatId;
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;

    switch (data.type) {
      // Show the Discord typing indicator while SillyTavern is generating.
      case "typing_action":
        channel.sendTyping().catch(() => {});
        break;

      // -----------------------------------------------------------------------
      // stream_chunk - a cumulative token update from an active generation.
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
          const escapedName = activeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const namePrefixRegex = new RegExp(`^${escapedName}:\\s*`, "i");
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
      // stream_end - generation for this character is complete.
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
            const escapedName = activeName.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&",
            );
            const namePrefixRegex = new RegExp(`^${escapedName}:\\s*`, "i");
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
          // Safety valve: if ai_reply never arrives to consume this flag
          // (e.g. non-streaming mode was off, or the message was dropped),
          // remove it after a short window so future replies aren't silently swallowed.
          setTimeout(() => streamHandled.delete(channelId), 10_000);
        });
        break;
      }

      // -----------------------------------------------------------------------
      // ai_reply - the complete response(s) received after generation ends.
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

    // Clean up any state left over from the broken session so it doesn't
    // interfere with the next connection. Orphaned stream sessions (where
    // stream_end never arrived) would otherwise block future edits, and a
    // stale streamHandled entry would silently swallow the next ai_reply
    // for that channel.
    for (const streamId of Object.keys(streamSessions)) {
      const s = streamSessions[streamId];
      if (s.editTimer) clearTimeout(s.editTimer);
      delete streamSessions[streamId];
    }
    streamHandled.clear();

    // Drain the channel queues by replacing each with a resolved promise.
    // Any tasks still pending in them will never complete since the WS is
    // gone, so holding onto them would just waste memory.
    for (const channelId of Object.keys(channelQueues)) {
      delete channelQueues[channelId];
    }

    // Flush all debounce timers first. Any interaction still waiting in a
    // debounce slot will never fire since the WS is gone; respond with an
    // empty list now so Discord closes the dropdown cleanly rather than
    // leaving it on a loading spinner until the debounce timer fires.
    for (const [key, debouncer] of Object.entries(autocompleteDebouncers)) {
      clearTimeout(debouncer.timer);
      delete autocompleteDebouncers[key];
      debouncer.interaction.respond([]).catch(() => {});
    }

    // Resolve all pending autocomplete interactions immediately. If left
    // alone, each would wait for its timeout before responding - but once the
    // 3-second Discord window expires the interaction token becomes invalid
    // and respond() will throw, leaving the user's dropdown permanently stuck
    // on a loading spinner. Responding with an empty list now closes them
    // cleanly. The safety timeouts are cancelled first to prevent a double
    // respond() once they eventually fire.
    for (const [requestId, pending] of Object.entries(pendingAutocompletes)) {
      clearTimeout(pending.timeout);
      delete pendingAutocompletes[requestId];
      pending.interaction.respond([]).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Incoming Discord interactions → slash commands and autocomplete
//
// Both slash command executions and autocomplete requests arrive as
// InteractionCreate events; the handler branches on interaction type first.
//
// AUTOCOMPLETE path: fired while the user is still typing into a switchchar,
// switchgroup, or switchchat option field. Interactions are debounced per
// user per command: intermediate keystrokes are dismissed with an empty
// respond() immediately, and only the final keystroke within
// AUTOCOMPLETE_DEBOUNCE_MS actually reaches SillyTavern as a get_autocomplete
// packet. The resulting interaction is parked in pendingAutocompletes with a
// safety timeout. When the extension replies, the ws.on("message") handler
// above calls interaction.respond() with the live list. If the extension
// doesn't reply in time the timeout responds with an empty list rather than
// letting Discord show an indefinite spinner.
//
// COMMAND EXECUTION path: the slash-command counterpart to the messageCreate
// handler below. Both paths converge on the same execute_command packet sent
// to the extension, keeping the extension unaware of how a command was
// invoked. Access is gated by the same allowedUserIds and allowedChannelIds
// rules as regular messages. Blocked interactions receive an ephemeral error
// reply visible only to the invoking user.
//
// Discord requires every interaction to be acknowledged within 3 seconds or
// it permanently fails with a "This interaction failed" error visible to all
// channel members. Because SillyTavern's actual response arrives
// asynchronously as a separate ai_reply packet, command interactions are
// acknowledged immediately with a brief ephemeral echo. The ephemeral flag
// also prevents messageCreate from seeing the acknowledgement as a new "/"
// message and firing a duplicate execute_command.
// ---------------------------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
  // ------------------------------------------------------------------
  // Autocomplete interactions
  // ------------------------------------------------------------------
  if (interaction.isAutocomplete()) {
    // Silently ignore if the bridge is not connected - Discord will show
    // an empty list, which is preferable to an unhandled promise rejection.
    if (!sillyTavernClient) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const command = interaction.commandName;
    const focusedValue = interaction.options.getFocused();

    // Map each autocomplete-enabled command to the list type the extension
    // needs to query. Any command not in this map is ignored.
    const listMap = {
      switchchar: "characters",
      switchgroup: "groups",
      switchchat: "chats",
    };
    const list = listMap[command];
    if (!list) return;

    // Debounce: cancel any previous timer for this user+command pair and
    // acknowledge the interaction immediately with an empty list. This
    // satisfies Discord's 3-second requirement without forwarding every
    // keystroke to SillyTavern. Only the final keystroke in a burst - when
    // the timer actually fires - results in a real get_autocomplete request.
    const debounceKey = `${interaction.user.id}:${command}`;
    if (autocompleteDebouncers[debounceKey]) {
      clearTimeout(autocompleteDebouncers[debounceKey].timer);
      autocompleteDebouncers[debounceKey].interaction
        .respond([])
        .catch(() => {});
    }

    autocompleteDebouncers[debounceKey] = {
      interaction,
      timer: setTimeout(async () => {
        delete autocompleteDebouncers[debounceKey];

        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        // Safety timeout: respond with an empty list if the extension doesn't
        // reply within AUTOCOMPLETE_TIMEOUT_MS, preventing Discord from
        // showing an indefinite spinner to the user.
        const timeout = setTimeout(async () => {
          if (!pendingAutocompletes[requestId]) return;
          delete pendingAutocompletes[requestId];
          log("warn", `[Autocomplete] Request ${requestId} timed out`);
          await interaction.respond([]).catch(() => {});
        }, AUTOCOMPLETE_TIMEOUT_MS);

        pendingAutocompletes[requestId] = { interaction, timeout };

        sillyTavernClient.send(
          JSON.stringify({
            type: "get_autocomplete",
            requestId,
            list,
            query: focusedValue,
          }),
        );
      }, AUTOCOMPLETE_DEBOUNCE_MS),
    };
    return;
  }

  // ------------------------------------------------------------------
  // Slash command execution interactions
  // ------------------------------------------------------------------
  if (!interaction.isChatInputCommand()) return;

  if (
    config.allowedUserIds?.length > 0 &&
    !config.allowedUserIds.includes(interaction.user.id)
  ) {
    await interaction
      .reply({
        content: "You are not authorised to use this bot.",
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  if (
    config.allowedChannelIds?.length > 0 &&
    !config.allowedChannelIds.includes(interaction.channelId)
  ) {
    await interaction
      .reply({
        content: "This bot is not enabled in this channel.",
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  if (!sillyTavernClient) {
    await interaction
      .reply({
        content: "Bridge is not connected to SillyTavern.",
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  const command = interaction.commandName;
  // Extract all STRING-type options in declaration order. Currently every
  // command has at most one ("name"), but filtering by type rather than by
  // key name means future options added to SLASH_COMMANDS are picked up
  // automatically without changes here.
  const args = interaction.options.data
    .filter((opt) => opt.type === 3)
    .map((opt) => String(opt.value));

  const chatId = interaction.channelId;

  sillyTavernClient.send(
    JSON.stringify({ type: "execute_command", command, args, chatId }),
  );

  // Acknowledge within the 3-second window. The reply is ephemeral (visible
  // only to the invoking user) for two reasons: it prevents messageCreate from
  // seeing the echo as a new "/" message and firing a second execute_command,
  // and it keeps command noise out of the channel. The real response arrives as
  // a normal channel message once SillyTavern processes the command.
  await interaction
    .reply({
      content: `✓ ${command}${args.length ? " " + args.join(" ") : ""}`,
      ephemeral: true,
    })
    .catch(() => {});
});

// ---------------------------------------------------------------------------
// Incoming Discord messages → forward to SillyTavern
//
// Regular text becomes a user_message (triggers AI generation).
// Messages starting with "/" become execute_command (handled by the extension).
//
// Access is gated by allowedUserIds and allowedChannelIds in config.js.
// Either list can be left empty to allow all users / all channels respectively,
// but leaving both empty means the bot is fully public.
// ---------------------------------------------------------------------------

client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (
    config.allowedUserIds?.length > 0 &&
    !config.allowedUserIds.includes(message.author.id)
  )
    return;
  if (
    config.allowedChannelIds?.length > 0 &&
    !config.allowedChannelIds.includes(message.channel.id)
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
