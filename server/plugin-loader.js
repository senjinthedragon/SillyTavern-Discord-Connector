/**
 * plugin-loader.js - SillyTavern Connector: Frontend Plugin Bootstrap
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Loads built-in frontends (currently Discord) plus optional external plugin
 * modules (for example private/pro plugins) declared in config.externalPlugins.
 */

"use strict";

const path = require("node:path");
const { config } = require("./config-loader");
const { log } = require("./logger");
const { registerFrontend } = require("./frontend-manager");

async function loadExternalPlugins(handlers) {
  const external = config.externalPlugins || [];
  for (const plugin of external) {
    try {
      if (!plugin?.name || !plugin?.module) {
        throw new Error("Each external plugin requires {name, module}.");
      }

      const resolvedPath = path.isAbsolute(plugin.module)
        ? plugin.module
        : path.resolve(__dirname, plugin.module);
      const mod = require(resolvedPath);
      if (typeof mod.createPlugin !== "function") {
        throw new Error(
          `External plugin "${plugin.name}" must export createPlugin(handlers, config).`,
        );
      }

      const instance = mod.createPlugin(handlers, plugin.config || {});
      registerFrontend(plugin.name, instance);
      if (typeof instance.start === "function") {
        await instance.start();
      }
      log("log", `[Plugins] External plugin loaded: ${plugin.name}`);
    } catch (err) {
      if (err.code === "MODULE_NOT_FOUND") {
        log(
          "warn",
          `[Plugins] Plugin "${plugin.name}" not found at: ${plugin.module}`,
        );
      } else {
        log(
          "warn",
          `[Plugins] Failed to load external plugin "${plugin.name}": ${err.message}`,
        );
      }
    }
  }
}

function createPluginLoader(handlers) {
  return {
    async start() {
      const enabled = config.enabledPlugins || ["discord"];

      if (enabled.includes("discord")) {
        const { createDiscordPlugin } = require("./plugins/discord");
        const discordPlugin = createDiscordPlugin(handlers);
        registerFrontend("discord", discordPlugin);
        await discordPlugin.start();
        log("log", "[Plugins] Discord plugin loaded.");
      }

      await loadExternalPlugins(handlers);
    },
  };
}

module.exports = { createPluginLoader };
