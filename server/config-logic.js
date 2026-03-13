/**
 * config-logic.js - SillyTavern Discord Connector: Configuration Validation
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Implements the "fail-fast" validation logic for the bridge configuration.
 * Processes raw user settings from config.js and ensures all required 
 * parameters are present and correctly typed before the server boots.
 *
 * Key responsibilities:
 * - Enforces the presence of essential credentials like the Discord Bot Token.
 * - Normalizes user-friendly time settings (seconds) into internal 
 * millisecond values used by the queue and watchdog timers.
 * - Validates plugin structures, ensuring that both built-in and external 
 * pro-plugins are formatted correctly to prevent runtime execution errors.
 * - Performs safety checks on circuit breaker thresholds to prevent 
 * misconfigurations from hammering external APIs.
 * - Sanitizes IANA timezones and BCP 47 locales, falling back to safe defaults 
 * (UTC/System) while collecting non-fatal warnings for the bridge logger.
 */

"use strict";

function createConfig(rawConfig) {
  const config = {
    queueTaskTimeoutSeconds: 30,
    imagePlaceholderTimeoutSeconds: 180,
    ...rawConfig,
  };

  config.queueTaskTimeoutMs = config.queueTaskTimeoutSeconds * 1_000;
  config.imagePlaceholderTimeoutMs =
    config.imagePlaceholderTimeoutSeconds * 1_000;

  if (config.discordToken === "YOUR_DISCORD_BOT_TOKEN_HERE") {
    throw new Error("Set your Discord Bot Token in config.js!");
  }

  if (
    config.enabledPlugins !== undefined &&
    (!Array.isArray(config.enabledPlugins) ||
      config.enabledPlugins.some(
        (p) => typeof p !== "string" || p.trim() === "",
      ))
  ) {
    throw new Error(
      'config.enabledPlugins entries must be non-empty strings (e.g. ["discord"]).',
    );
  }

  if (
    config.externalPlugins !== undefined &&
    !Array.isArray(config.externalPlugins)
  ) {
    throw new Error(
      "config.externalPlugins must be an array of plugin objects.",
    );
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

  for (const [platform, pluginCfg] of Object.entries(config.plugins || {})) {
    const breaker = pluginCfg?.circuitBreaker;
    if (!breaker) continue;
    if (
      !Number.isFinite(breaker.failureThreshold) ||
      breaker.failureThreshold <= 0
    ) {
      throw new Error(
        `config.plugins.${platform}.circuitBreaker.failureThreshold must be a positive number.`,
      );
    }
    if (
      breaker.cooldownSeconds !== undefined &&
      (!Number.isFinite(breaker.cooldownSeconds) ||
        breaker.cooldownSeconds <= 0)
    ) {
      throw new Error(
        `config.plugins.${platform}.circuitBreaker.cooldownSeconds must be a positive number.`,
      );
    }
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

module.exports = {
  createConfig,
};
