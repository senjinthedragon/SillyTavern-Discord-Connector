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
