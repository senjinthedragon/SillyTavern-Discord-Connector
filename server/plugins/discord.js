/**
 * plugins/discord.js - SillyTavern Connector: Discord Frontend Plugin
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Wraps the existing Discord transport module behind the same interface used
 * by other frontend plugins. This keeps plugin-loader.js consistent: all
 * frontends are now loaded from server/plugins/*.js.
 */

"use strict";

const discord = require("../discord");

function createDiscordPlugin() {
  return {
    platform: "discord",

    // Discord bootstraps when ../discord is imported and the plugin is enabled
    // in config.enabledPlugins. start() exists for interface consistency.
    async start() {},

    async sendText(chatId, text) {
      await discord.sendText(chatId, text);
    },

    async sendTyping(chatId) {
      await discord.sendTyping(chatId);
    },

    async sendImages(chatId, images, caption) {
      await discord.sendImages(chatId, images, caption);
    },

    async sendImagePlaceholder(chatId, text) {
      await discord.sendImagePlaceholder(chatId, text);
    },

    async sendGeneratedImage(chatId, images, caption) {
      await discord.sendGeneratedImage(chatId, images, caption);
    },

    async sendExpression(chatId, expression, image, ownerName, userLocale) {
      await discord.sendExpression(
        chatId,
        expression,
        image,
        ownerName,
        userLocale,
      );
    },

    async streamChunk(chatId, payload) {
      await discord.streamChunk(chatId, payload);
    },

    async streamEnd(chatId, payload) {
      return discord.streamEnd(chatId, payload);
    },

    async sendRecap(chatId, entries, userId, userLocale) {
      await discord.sendRecap(chatId, entries, userId, userLocale);
    },

    async deleteRoleplayMessages(chatId, count) {
      await discord.deleteRoleplayMessages(chatId, count);
    },
  };
}

module.exports = { createDiscordPlugin };
