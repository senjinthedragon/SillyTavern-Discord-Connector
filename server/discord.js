/**
 * discord.js - SillyTavern Discord Connector: Discord Client
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Manages the Discord.js client: slash command registration, incoming message
 * routing, and interaction handling (slash commands + autocomplete).
 *
 * All user messages and slash commands are normalised into execute_command /
 * user_message packets and forwarded to SillyTavern via the WebSocket client
 * from websocket.js. That module is required lazily (inside handlers) to avoid
 * a circular dependency at load time.
 *
 * Autocomplete interactions are debounced per (userId, commandName): intermediate
 * keystrokes are dismissed immediately with an empty list; only the final
 * keystroke within AUTOCOMPLETE_DEBOUNCE_MS reaches SillyTavern. The resolved
 * interaction is parked in pendingAutocompletes with a safety timeout so
 * Discord's dropdown is never left on an indefinite spinner.
 *
 * Numbered shortcut commands (/switchchar_1 etc.) are not registered as slash
 * commands - their upper bound depends on the user's ST library and Discord
 * requires static registration. They remain fully usable as plain text messages
 * starting with "/", which messageCreate forwards as execute_command.
 */

"use strict";

const {
  Events,
  REST,
  Routes,
  MessageFlags,
  ActivityType,
  EmbedBuilder,
} = require("discord.js");

const { log } = require("./logger");
const { config, token } = require("./config-loader");
const { t, makeTranslator } = require("./i18n");
const { client } = require("./client");
const { sendLong, sendImagesToChannel } = require("./messaging");
const { splitLongText } = require("./text-chunking");
const { enqueue } = require("./queue");
const {
  addRoute,
  resolveConversationId,
  getRoutes,
  getFrontend,
  parseRoute,
} = require("./frontend-manager");
const { streamSessions, scheduleEdit } = require("./streaming");
const {
  getPersonaForUser,
  getDefaultPersonaName,
  isCrossRelayEnabled,
} = require("./persona-map");
const { getLangForUser } = require("./lang-map");
const { AVAILABLE_LANGUAGES, LANGUAGE_NAMES } = require("./locales-manifest");
const version = require("./package.json").version;

const DISCORD_PLUGIN_ENABLED = (config.enabledPlugins || ["discord"]).includes(
  "discord",
);

const ACTIVITY_BASE = `SillyTavern Bridge v${version}`;
const { formatBridgeActivity } = require("./activity-format");

let lastActivityText = "";

function setBridgeActivity(expression, ownerName) {
  if (!client?.user) return;
  const activityText = formatBridgeActivity(
    ACTIVITY_BASE,
    expression,
    ownerName,
  );

  if (activityText === lastActivityText) return;
  lastActivityText = activityText;
  client.user.setActivity(activityText, { type: ActivityType.Playing });
}

// Required lazily inside handlers to break the discord.js ↔ websocket.js
// circular dependency. By the time any handler fires, both modules are
// fully initialised and getSillyTavernClient is available.
function getSillyTavernClient() {
  return require("./websocket").getSillyTavernClient();
}

function dispatchCommand(platform, chatId, command, args, userId) {
  require("./websocket").dispatchCommand(
    platform,
    chatId,
    command,
    args,
    userId,
  );
}

// ---------------------------------------------------------------------------
// Slash command definitions
//
// Registered via a full PUT overwrite on every ClientReady, so adding or
// removing an entry here takes effect on the next restart with no manual
// cleanup. Global commands can take up to an hour to propagate; for instant
// dev registration in a single server, swap Routes.applicationCommands for
// Routes.applicationGuildCommands(clientId, "YOUR_GUILD_ID_HERE").
// ---------------------------------------------------------------------------

const SLASH_COMMANDS = [
  {
    name: "image",
    description: "Generate or cancel an AI image task.",
    options: [
      {
        name: "prompt",
        type: 3,
        description: "Prompt, keyword, or 'cancel'",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "mood",
    description: "Show the current expression for this character",
    options: [
      {
        name: "name",
        type: 3,
        description:
          "Character name (optional in solo chat; autocompletes group members in group chat)",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "reaction",
    description: "Set how expressions are shown on Discord",
    options: [
      {
        name: "mode",
        type: 3,
        description: "off, status, or full",
        required: true,
        choices: [
          { name: "Off", value: "off" },
          { name: "Status only", value: "status" },
          {
            name: "Status and image updates",
            value: "full",
          },
        ],
      },
    ],
  },
  {
    name: "status",
    description: "Show bridge health and image pipeline stats",
  },
  { name: "sthelp", description: "Show all available bridge commands" },
  {
    name: "newchat",
    description: "Start a fresh chat with the current character",
  },
  {
    name: "listchars",
    description: "List all characters (includes numbered shortcuts)",
  },
  {
    name: "note",
    description: "Set or read the author's note for the current chat",
    options: [
      {
        name: "text",
        type: 3,
        description: "The author's note text (omit to read the current note)",
        required: false,
      },
    ],
  },
  {
    name: "continue",
    description: "Continue the last AI message",
  },
  {
    name: "impersonate",
    description: "Have the AI write your next response in character",
    options: [
      {
        name: "prompt",
        type: 3,
        description: "Optional prompt to guide the impersonation",
        required: false,
      },
    ],
  },
  {
    name: "persona",
    description: "Switch your active persona by name",
    options: [
      {
        name: "name",
        type: 3,
        description: "The name of the persona to switch to",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "listpersonas",
    description: "List your available personas",
  },
  {
    name: "mypersona",
    description: "Save your persona so it switches automatically when you chat",
    options: [
      {
        name: "name",
        type: 3,
        description:
          "Persona name to save, or 'clear' to remove your saved preference",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "switchchar",
    description: "Switch to a character by exact name",
    options: [
      {
        name: "name",
        type: 3,
        description: "Character name",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "listgroups",
    description: "List all groups (includes numbered shortcuts)",
  },
  {
    name: "switchgroup",
    description: "Switch to a group by exact name",
    options: [
      {
        name: "name",
        type: 3,
        description: "Group name",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "listchats",
    description: "List chat history for the current character",
  },
  {
    name: "history",
    description: "Show past chat exchanges in this channel",
    options: [
      {
        name: "exchanges",
        type: 4,
        description: "Number of exchanges to show (default: 5)",
        required: false,
      },
    ],
  },
  {
    name: "switchchat",
    description: "Load a past chat by name (omit .jsonl)",
    options: [
      {
        name: "name",
        type: 3,
        description: "Chat filename (omit .jsonl)",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "charimage",
    description: "Show a character's avatar",
    options: [
      {
        name: "name",
        type: 3,
        description:
          "Character name (optional in solo chat; autocompletes group members in group chat)",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "setlang",
    description: "Set your preferred language for bot responses",
    options: [
      {
        name: "language",
        type: 3,
        description: "Language name, or 'clear' to reset to server default",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "delete",
    description: "Delete the last message(s) from the chat",
    options: [
      {
        name: "count",
        type: 4,
        description: "Number of messages to delete (1-5, default: 1)",
        required: false,
        min_value: 1,
        max_value: 5,
      },
    ],
  },
  {
    name: "swipe",
    description: "Delete the last AI response and generate a new one",
  },
];

// ---------------------------------------------------------------------------
// Autocomplete debouncing
// ---------------------------------------------------------------------------

const AUTOCOMPLETE_DEBOUNCE_MS = 250;
const AUTOCOMPLETE_TIMEOUT_MS = 2800;
const autocompleteDebouncers = {};
const pendingAutocompletes = {};

// ---------------------------------------------------------------------------
// Roleplay message tracking
//
// Tracks Discord message IDs that are real roleplay messages (AI replies or
// streamed responses), keyed by channelId. Used to:
//   1. Delete corresponding Discord messages when /delete or /swipe is used.
//   2. Detect when a user manually deletes a Discord message and mirror that
//      deletion into SillyTavern (only the most recent tracked message).
//
// Ring buffer capped at ROLEPLAY_MESSAGE_LIMIT per channel to bound memory use.
// ---------------------------------------------------------------------------

const ROLEPLAY_MESSAGE_LIMIT = 50;
// messageId -> channelId (fast lookup for MessageDelete events)
const recentRoleplayMessages = new Map();
// channelId -> messageId[] (ordered oldest→newest, for deleteRoleplayMessages)
const channelMessageHistory = new Map();

function trackRoleplayMessage(channelId, msg) {
  if (!msg?.id) return;
  recentRoleplayMessages.set(msg.id, channelId);
  if (!channelMessageHistory.has(channelId)) {
    channelMessageHistory.set(channelId, []);
  }
  const history = channelMessageHistory.get(channelId);
  history.push(msg.id);
  if (history.length > ROLEPLAY_MESSAGE_LIMIT) {
    const evicted = history.shift();
    recentRoleplayMessages.delete(evicted);
  }
}

async function deleteRoleplayMessages(channelId, count) {
  const history = channelMessageHistory.get(channelId);
  if (!history?.length) return;
  const n = Math.min(Math.max(1, count), history.length);
  const toDelete = history.splice(-n);
  for (const msgId of toDelete) {
    recentRoleplayMessages.delete(msgId);
  }
  if (!history.length) channelMessageHistory.delete(channelId);
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;
  for (const msgId of toDelete) {
    try {
      const msg = await channel.messages.fetch(msgId);
      await msg.delete();
    } catch {
      // Already deleted or inaccessible - skip silently.
    }
  }
}

// Tracks the Discord message sent as an image placeholder ("🎨 Generating image…")
// keyed by channelId. Each entry is { msg, timerId } - msg is the Discord Message
// object and timerId is the handle for the live countdown timer. Cleared by
// sendGeneratedImage when the real image arrives.
const placeholderMessages = {};

// Edits the placeholder message on a self-rescheduling timer to show how much
// generation time remains. Updates every 60 seconds while more than one minute
// remains, then every 10 seconds during the final minute.
function startPlaceholderCountdown(channelId, msg, timeoutMs) {
  const endTime = Date.now() + timeoutMs;

  function formatRemaining(ms) {
    if (ms <= 60_000) {
      return t("disc.countdownSeconds", { n: Math.ceil(ms / 1_000) });
    }
    return t("disc.countdownMinutes", { n: Math.ceil(ms / 60_000) });
  }

  function scheduleNext() {
    const remaining = endTime - Date.now();
    if (remaining <= 0) return null;
    const delay = remaining > 60_000 ? 60_000 : 10_000;
    return setTimeout(async () => {
      if (!placeholderMessages[channelId]) return;
      const rem = endTime - Date.now();
      if (rem <= 0) return;
      try {
        await msg.edit(
          t("disc.imagePlaceholderUpdate", { remaining: formatRemaining(rem) }),
        );
      } catch {
        // Message was deleted or inaccessible - stop the countdown.
        return;
      }
      if (!placeholderMessages[channelId]) return;
      placeholderMessages[channelId].timerId = scheduleNext();
    }, delay);
  }

  return scheduleNext();
}

// Maps each autocomplete-enabled command to the list type the extension queries.
// charimage uses "group_members" (active group only, not the full library).
// image uses "image_prompts" (a static keyword list built inline by the extension).
const AUTOCOMPLETE_LIST_MAP = {
  persona: "personas",
  switchchar: "characters",
  switchgroup: "groups",
  switchchat: "chats",
  charimage: "group_members",
  mood: "group_members",
  image: "image_prompts",
  mypersona: "personas",
  setlang: "languages",
};

function getPendingAutocompletes() {
  return pendingAutocompletes;
}

function getAutocompleteDebouncers() {
  return autocompleteDebouncers;
}

if (DISCORD_PLUGIN_ENABLED) {
  client.login(token);

  client.on(Events.ClientReady, async (c) => {
    setBridgeActivity(null);

    log("log", `[Discord] Ready! Logged in as ${c.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(token);
    try {
      log("log", "[Discord] Registering slash commands...");
      await rest.put(Routes.applicationCommands(c.user.id), {
        body: SLASH_COMMANDS,
      });
      log("log", "[Discord] Slash commands registered.");
    } catch (err) {
      log("error", "[Discord] Failed to register slash commands:", err);
    }
  });

  client.on("error", (err) => log("error", "[Discord] Client error:", err));

  // ---------------------------------------------------------------------------
  // Interaction handler (autocomplete + slash commands)
  // ---------------------------------------------------------------------------

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      const command = interaction.commandName;

      // setlang autocomplete is served locally - no ST connection needed.
      if (command === "setlang") {
        const query = interaction.options.getFocused().toLowerCase();
        const userLocale = (
          getLangForUser("discord", interaction.user.id) ||
          config.userLocale ||
          "en"
        ).toLowerCase();
        const choices = AVAILABLE_LANGUAGES.filter(
          (l) =>
            !query ||
            l.names.some((n) => n.toLowerCase().includes(query)) ||
            l.code.includes(query),
        )
          .slice(0, 25)
          .map((l) => {
            const langNames = LANGUAGE_NAMES[l.code] || {};
            const localizedName =
              langNames[userLocale] ||
              langNames[userLocale.split("-")[0]] ||
              l.name;
            const display =
              l.nativeName === localizedName
                ? l.nativeName
                : `${l.nativeName} (${localizedName})`;
            return { name: display, value: l.code };
          });
        await interaction.respond(choices).catch(() => {});
        return;
      }

      const stClient = getSillyTavernClient();
      if (!stClient) {
        await interaction.respond([]).catch(() => {});
        return;
      }

      const focusedValue = interaction.options.getFocused();
      const list = AUTOCOMPLETE_LIST_MAP[command];
      if (!list) return;

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

          const timeout = setTimeout(async () => {
            if (!pendingAutocompletes[requestId]) return;
            delete pendingAutocompletes[requestId];
            log("warn", `[Autocomplete] Request ${requestId} timed out`);
            await interaction.respond([]).catch(() => {});
          }, AUTOCOMPLETE_TIMEOUT_MS);

          pendingAutocompletes[requestId] = { interaction, timeout };

          stClient.send(
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

    if (!interaction.isChatInputCommand()) return;

    if (
      config.allowedUserIds?.length > 0 &&
      !config.allowedUserIds.includes(interaction.user.id)
    ) {
      await interaction
        .reply({
          content: t("disc.notAuthorized"),
          flags: [MessageFlags.Ephemeral],
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
          content: t("disc.notAllowedChannel"),
          flags: [MessageFlags.Ephemeral],
        })
        .catch(() => {});
      return;
    }

    const command = interaction.commandName;
    const args = interaction.options.data
      .filter((opt) => opt.type === 3 || opt.type === 4)
      .map((opt) => String(opt.value));

    const cappedArgs =
      command === "delete" && config.triggerPrefix
        ? [String(Math.min(1, parseInt(args[0]) || 1))]
        : args;

    dispatchCommand(
      "discord",
      interaction.channelId,
      command,
      cappedArgs,
      interaction.user.id,
    );

    // Acknowledge immediately (ephemeral) to satisfy Discord's 3-second window.
    // Ephemeral also prevents messageCreate from seeing this echo as a new "/" message.
    await interaction
      .reply({
        content: `✓ ${command}${args.length ? " " + args.join(" ") : ""}`,
        flags: [MessageFlags.Ephemeral],
      })
      .catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // Incoming Discord messages → SillyTavern
  // ---------------------------------------------------------------------------

  // Mirror manual Discord message deletions into SillyTavern.
  // Only the most recently tracked roleplay message per channel triggers a
  // delete command - deleting older messages out of order is ambiguous.
  client.on(Events.MessageDelete, (message) => {
    const channelId = message.channelId;
    const history = channelMessageHistory.get(channelId);
    if (!history?.length) return;
    const isNewest = history[history.length - 1] === message.id;
    const idx = isNewest ? history.length - 1 : history.indexOf(message.id);
    if (idx === -1) return;
    // Remove from tracking regardless.
    history.splice(idx, 1);
    if (!history.length) channelMessageHistory.delete(channelId);
    recentRoleplayMessages.delete(message.id);
    // Only dispatch to ST when the deleted message was the most recent one.
    if (isNewest) dispatchCommand("discord", channelId, "delete", ["1"], null);
  });

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

    let content = message.content;

    if (config.triggerPrefix) {
      if (!content.startsWith(config.triggerPrefix)) return;
      content = content.slice(config.triggerPrefix.length).trimStart();
    }

    if (content.startsWith("/")) {
      const [command, ...args] = content.slice(1).split(" ");
      const cappedArgs =
        command === "delete" && config.triggerPrefix
          ? [String(Math.min(1, parseInt(args[0]) || 1))]
          : args;
      dispatchCommand(
        "discord",
        message.channel.id,
        command,
        cappedArgs,
        message.author.id,
      );
      return;
    }

    const stClient = getSillyTavernClient();
    if (!stClient) {
      message.reply(t("disc.notConnected")).catch(() => {});
      return;
    }

    const conversationId = resolveConversationId("discord", message.channel.id);
    addRoute(conversationId, "discord", message.channel.id);
    const mappedPersona = getPersonaForUser("discord", message.author.id);
    const userLocale = getLangForUser("discord", message.author.id) || null;
    stClient.send(
      JSON.stringify({
        type: "user_message",
        text: content,
        chatId: conversationId,
        userId: message.author.id,
        platform: "discord",
        ...(mappedPersona ? { mappedPersona } : {}),
        ...(userLocale ? { userLocale } : {}),
      }),
    );

    // Cross-relay to other platforms in the same conversation.
    if (!isCrossRelayEnabled()) return;
    const senderLabel = mappedPersona || getDefaultPersonaName() || `[discord]`;
    const relayText = `${senderLabel}: ${content}`;
    const originKey = `discord:${message.channel.id}`;
    for (const route of getRoutes(conversationId)) {
      if (route === originKey) continue;
      const { platform: targetPlatform, nativeChatId: targetChatId } =
        parseRoute(route);
      const frontend = getFrontend(targetPlatform);
      if (!frontend?.sendText) continue;
      frontend.sendText(targetChatId, relayText).catch((err) => {
        log("warn", `[Bridge] Cross-relay to ${route} failed: ${err.message}`);
      });
    }
  });
}

async function sendText(channelId, text) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;
  enqueue(channelId, async () => {
    // If a placeholder countdown is still running, clear it before sending any
    // non-placeholder message (e.g. an error or cancel reply).
    if (placeholderMessages[channelId]) {
      clearTimeout(placeholderMessages[channelId].timerId);
      await placeholderMessages[channelId].msg.delete().catch(() => {});
      delete placeholderMessages[channelId];
    }
    const msg = await sendLong(channel, text);
    trackRoleplayMessage(channelId, msg);
  });
}

// Dedicated path for image_placeholder packets. Stores the message reference
// for the countdown timer and for deletion when the real image arrives.
// Using a separate function avoids text-sniffing to detect placeholders, which
// would break when bot messages are translated.
async function sendImagePlaceholder(channelId, text) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;
  enqueue(channelId, async () => {
    const msg = await sendLong(channel, text);
    const timerId = startPlaceholderCountdown(
      channelId,
      msg,
      config.imagePlaceholderTimeoutMs,
    );
    placeholderMessages[channelId] = { msg, timerId };
  });
}
async function sendTyping(channelId) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;
  channel.sendTyping().catch(() => {});
}

async function sendImages(channelId, images, caption) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;
  enqueue(channelId, () => sendImagesToChannel(channel, images, caption));
}

// Dedicated path for generate_image_result packets. Deletes the placeholder
// message before posting the real image. All other image sends (expressions,
// charimage, inline images in messages) use sendImages and never touch the
// placeholder - only a generated image result should clear it.
async function sendGeneratedImage(channelId, images, caption) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;
  enqueue(channelId, async () => {
    if (placeholderMessages[channelId]) {
      clearTimeout(placeholderMessages[channelId].timerId);
      await placeholderMessages[channelId].msg.delete().catch((err) => {
        log("warn", `[Images] Could not delete placeholder: ${err.message}`);
      });
      delete placeholderMessages[channelId];
    }
    await sendImagesToChannel(channel, images, caption);
  });
}

async function sendExpression(
  channelId,
  expression,
  image,
  ownerName,
  userLocale,
) {
  if (expression) setBridgeActivity(expression, ownerName);
  if (image) {
    if (ownerName) {
      const channel = client.channels.cache.get(channelId);
      if (channel) {
        const tl = userLocale ? makeTranslator(userLocale) : t;
        const exprKey = `expr.${expression}`;
        const translatedExpr =
          tl(exprKey) !== exprKey ? tl(exprKey) : expression;
        enqueue(channelId, async () => {
          await channel.send(
            tl("disc.expressionMessage", {
              name: ownerName,
              expression: translatedExpr,
            }),
          );
        });
      }
    }
    await sendImages(channelId, [image], null);
  }
}

// Discord embed colour for recap messages - a muted indigo that reads as
// "context / system" rather than a live message.
const RECAP_EMBED_COLOR = 0x5865f2;

// Discord limits: 4096 chars per embed description, 2000 per plain message.
const RECAP_EMBED_MAX = 4000;

/**
 * Sends a chat recap to a Discord channel as a series of styled embeds.
 * Each entry in the entries array becomes one or more embeds (split at word
 * boundaries if the text exceeds the embed description limit). The first embed
 * carries the 📜 Last exchange header; subsequent embeds are continuations.
 *
 * @param {string} channelId
 * @param {Array<{name: string, text: string, isUser: boolean}>} entries
 */
async function sendRecap(channelId, entries, userId, userLocale) {
  if (!entries?.length) return;
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  const tl = userLocale ? makeTranslator(userLocale) : t;

  enqueue(channelId, async () => {
    let isFirst = true;
    for (const entry of entries) {
      const label = entry.name ? `**${entry.name}**` : null;
      const chunks = splitLongText(entry.text, RECAP_EMBED_MAX);

      for (let i = 0; i < chunks.length; i++) {
        const isContinuation = i > 0;
        const description =
          label && !isContinuation ? `${label}\n${chunks[i]}` : chunks[i];

        const embed = new EmbedBuilder()
          .setColor(RECAP_EMBED_COLOR)
          .setDescription(description);

        if (isFirst) {
          embed.setTitle(tl("disc.recapTitle"));
          isFirst = false;
        }

        await channel.send({ embeds: [embed] });
      }
    }
  });
}

async function streamChunk(channelId, payload) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  const streamId = `${channelId}:${payload?.streamId || channelId}`;
  const rawText = payload?.text || "";
  if (!rawText.trim()) return;

  const activeName = payload.characterName || null;
  let processedText = rawText;
  if (activeName) {
    const escaped = activeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    processedText = rawText.replace(new RegExp(`^${escaped}:\\s*`, "i"), "");
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
  if (session.streamDone) return;
  session.pendingText = processedText;
  session.characterName = activeName;
  scheduleEdit(session, channel, streamId);
}

async function streamEnd(channelId, payload) {
  const streamId = `${channelId}:${payload?.streamId || channelId}`;
  const s = streamSessions[streamId];
  if (!s) return false;

  s.streamDone = true;
  s.nextEdit = false;

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

  const rawText =
    payload?.finalText != null ? payload.finalText : s.pendingText || "";
  const activeName = payload?.characterName || null;
  let processedText = rawText;
  if (activeName) {
    const escaped = activeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    processedText = rawText.replace(new RegExp(`^${escaped}:\\s*`, "i"), "");
  }

  const finalText = activeName
    ? `**${activeName}**\n${processedText}`
    : processedText;
  const channel = client.channels.cache.get(channelId);
  if (channel && finalText.trim()) {
    if (s.streamMessage) {
      await s.streamMessage.delete().catch(() => {});
    }
    const msg = await sendLong(channel, finalText);
    trackRoleplayMessage(channelId, msg);
  }

  delete streamSessions[streamId];
  return true;
}

module.exports = {
  getPendingAutocompletes,
  getAutocompleteDebouncers,
  setBridgeActivity,
  sendText,
  sendImagePlaceholder,
  sendTyping,
  sendImages,
  sendGeneratedImage,
  sendExpression,
  sendRecap,
  streamChunk,
  streamEnd,
  deleteRoleplayMessages,
};
