/**
 * config-logic.js - SillyTavern Connector: Configuration Logic
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 *
 * Pure configuration logic: applies defaults, validates required fields,
 * derives millisecond timeout fields, and sanitises timezone/locale.
 */

"use strict";

function validateCircuitBreaker(pluginName, pluginConfig) {
  const breaker = pluginConfig?.circuitBreaker;
  if (!breaker) return;

  if (breaker.failureThreshold != null) {
    if (
      !Number.isFinite(breaker.failureThreshold) ||
      breaker.failureThreshold < 1
    ) {
      throw new Error(
        `config.plugins.${pluginName}.circuitBreaker.failureThreshold must be a positive number.`,
      );
    }
  }

  if (breaker.cooldownMs != null) {
    if (!Number.isFinite(breaker.cooldownMs) || breaker.cooldownMs <= 0) {
      throw new Error(
        `config.plugins.${pluginName}.circuitBreaker.cooldownMs must be a positive number.`,
      );
    }
  }
}

function createConfig(rawConfig) {
  const config = {
    queueTaskTimeoutSeconds: 30,
    imagePlaceholderTimeoutSeconds: 180,
    enabledPlugins: ["discord"],
    externalPlugins: [],
    plugins: {
      discord: {},
    },
    conversationLinks: [],
    ...rawConfig,
  };

  config.queueTaskTimeoutMs = config.queueTaskTimeoutSeconds * 1_000;
  config.imagePlaceholderTimeoutMs =
    config.imagePlaceholderTimeoutSeconds * 1_000;

  if (
    !Array.isArray(config.enabledPlugins) ||
    config.enabledPlugins.length === 0
  ) {
    throw new Error(
      "config.enabledPlugins must contain at least one plugin name.",
    );
  }

  for (const pluginName of config.enabledPlugins) {
    if (typeof pluginName !== "string" || !pluginName.trim()) {
      throw new Error(
        "config.enabledPlugins entries must be non-empty strings.",
      );
    }
  }

  const enabled = new Set(config.enabledPlugins);
  if (enabled.has("discord")) {
    if (
      !config.discordToken ||
      config.discordToken === "YOUR_DISCORD_BOT_TOKEN_HERE"
    ) {
      throw new Error(
        "Set your Discord Bot Token in config.js when Discord plugin is enabled.",
      );
    }
  }

  if (!Array.isArray(config.externalPlugins)) {
    throw new Error("config.externalPlugins must be an array.");
  }

  if (
    !Number.isFinite(config.queueTaskTimeoutSeconds) ||
    config.queueTaskTimeoutSeconds <= 0
  ) {
    throw new Error(
      "config.queueTaskTimeoutSeconds must be a positive number (e.g. 30 for 30 seconds).",
    );
  }

  if (
    !Number.isFinite(config.imagePlaceholderTimeoutSeconds) ||
    config.imagePlaceholderTimeoutSeconds <= 0
  ) {
    throw new Error(
      "config.imagePlaceholderTimeoutSeconds must be a positive number (e.g. 180 for 3 minutes).",
    );
  }

  for (const [pluginName, pluginCfg] of Object.entries(config.plugins || {})) {
    validateCircuitBreaker(pluginName, pluginCfg || {});
  }

  const warnings = [];

  if (config.timezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: config.timezone });
    } catch {
      warnings.push(
        `[Config] Invalid timezone "${config.timezone}" - falling back to UTC`,
      );
      config.timezone = "UTC";
    }
  }

  if (config.locale) {
    try {
      Intl.DateTimeFormat(config.locale);
    } catch {
      warnings.push(
        `[Config] Invalid locale "${config.locale}" - falling back to system default`,
      );
      config.locale = null;
    }
  }

  return { config, warnings };
}

module.exports = { createConfig };
