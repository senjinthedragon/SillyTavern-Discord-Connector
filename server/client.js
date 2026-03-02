/**
 * client.js - SillyTavern Discord Connector: Discord Client Instance
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 *
 * Creates and exports the Discord.js Client instance. Kept as its own module
 * so discord.js and websocket.js can both import it without depending on each
 * other, which would create a circular reference.
 */

"use strict";

const { Client, GatewayIntentBits } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

module.exports = { client };
