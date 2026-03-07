/**
 * discord.js - SillyTavern Discord Connector: Discord Client
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
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
} = require("discord.js");

const { log } = require("./logger");
const { config, token } = require("./config-loader");
const { client } = require("./client");
const version = require("./package.json").version;

const ACTIVITY_BASE = `SillyTavern Bridge v${version}`;
const EXPRESSION_EMOJI_MAP = {
  admiration: "😍",
  amusement: "😄",
  anger: "😠",
  annoyance: "😒",
  approval: "👍",
  caring: "🤗",
  confusion: "😕",
  curiosity: "🤔",
  desire: "💘",
  disappointment: "😞",
  disapproval: "👎",
  disgust: "🤢",
  embarrassment: "😳",
  excitement: "🤩",
  fear: "😨",
  gratitude: "🙏",
  grief: "😢",
  joy: "😊",
  love: "❤️",
  nervousness: "😬",
  optimism: "🌤️",
  pride: "😌",
  realization: "💡",
  relief: "😮‍💨",
  remorse: "🥺",
  sadness: "😔",
  surprise: "😲",
  neutral: "😐",
};

let lastActivityText = "";

function setBridgeActivity(expression) {
  if (!client?.user) return;
  const normalized = String(expression || "")
    .trim()
    .toLowerCase();

  const activityText = normalized
    ? `${EXPRESSION_EMOJI_MAP[normalized] || "🎭"} ${normalized}`
    : ACTIVITY_BASE;

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
        description: "Character name (optional in solo chat; autocompletes group members in group chat)",
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
];

client.login(token);

client.on(Events.ClientReady, async (c) => {
  setBridgeActivity(null);

  console.log(`[Discord] Ready! Logged in as ${c.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("[Discord] Registering slash commands...");
    await rest.put(Routes.applicationCommands(c.user.id), {
      body: SLASH_COMMANDS,
    });
    console.log("[Discord] Slash commands registered.");
  } catch (err) {
    log("error", "[Discord] Failed to register slash commands:", err);
  }
});

client.on("error", (err) => log("error", "[Discord] Client error:", err));

// ---------------------------------------------------------------------------
// Autocomplete debouncing
// ---------------------------------------------------------------------------

const AUTOCOMPLETE_DEBOUNCE_MS = 250;
const AUTOCOMPLETE_TIMEOUT_MS = 2800;
const autocompleteDebouncers = {};
const pendingAutocompletes = {};

// Maps each autocomplete-enabled command to the list type the extension queries.
// charimage uses "group_members" (active group only, not the full library).
// image uses "image_prompts" (a static keyword list built inline by the extension).
const AUTOCOMPLETE_LIST_MAP = {
  switchchar: "characters",
  switchgroup: "groups",
  switchchat: "chats",
  charimage: "group_members",
  mood: "group_members",
  image: "image_prompts",
};

function getPendingAutocompletes() {
  return pendingAutocompletes;
}

function getAutocompleteDebouncers() {
  return autocompleteDebouncers;
}

// ---------------------------------------------------------------------------
// Interaction handler (autocomplete + slash commands)
// ---------------------------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const stClient = getSillyTavernClient();
    if (!stClient) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const command = interaction.commandName;
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
        content: "You are not authorised to use this bot.",
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
        content: "This bot is not enabled in this channel.",
        flags: [MessageFlags.Ephemeral],
      })
      .catch(() => {});
    return;
  }

  const stClient = getSillyTavernClient();
  if (!stClient) {
    await interaction
      .reply({
        content: "Bridge is not connected to SillyTavern.",
        flags: [MessageFlags.Ephemeral],
      })
      .catch(() => {});
    return;
  }

  const command = interaction.commandName;
  const args = interaction.options.data
    .filter((opt) => opt.type === 3)
    .map((opt) => String(opt.value));
  const chatId = interaction.channelId;

  stClient.send(
    JSON.stringify({ type: "execute_command", command, args, chatId }),
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

  const stClient = getSillyTavernClient();
  if (!stClient) {
    message.reply("Bridge is not connected to SillyTavern.").catch(() => {});
    return;
  }

  const chatId = message.channel.id;
  const content = message.content;

  if (content.startsWith("/")) {
    const [command, ...args] = content.slice(1).split(" ");
    stClient.send(
      JSON.stringify({ type: "execute_command", command, args, chatId }),
    );
  } else {
    stClient.send(
      JSON.stringify({ type: "user_message", text: content, chatId }),
    );
  }
});

module.exports = {
  getPendingAutocompletes,
  getAutocompleteDebouncers,
  setBridgeActivity,
};
