/**
 * frontend-manager.js - SillyTavern Connector: Frontend Route Manager
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 *
 * Maintains frontend plugin registrations and route mappings between a unified
 * conversationId (used on the ST bridge wire protocol) and native platform
 * chat IDs (Discord channel IDs, Telegram chat IDs, Signal numbers).
 */

"use strict";

const { config } = require("./config-loader");
const { log } = require("./logger");

const frontends = new Map();
const routesByConversation = new Map();
const circuitStateByPlatform = new Map();

function getCircuitPolicy(platform) {
  const pluginCfg = config.plugins?.[platform] || {};
  const breaker = pluginCfg.circuitBreaker || {};
  return {
    enabled: Boolean(breaker.enabled),
    failureThreshold: Number(breaker.failureThreshold || 5),
    cooldownMs: Number(breaker.cooldownSeconds ?? 30) * 1000,
  };
}

function getCircuitState(platform) {
  if (!circuitStateByPlatform.has(platform)) {
    circuitStateByPlatform.set(platform, {
      failures: 0,
      openedAt: 0,
      isOpen: false,
    });
  }
  return circuitStateByPlatform.get(platform);
}

function canAttemptPlatform(platform) {
  const policy = getCircuitPolicy(platform);
  if (!policy.enabled) return true;

  const state = getCircuitState(platform);
  if (!state.isOpen) return true;

  if (Date.now() - state.openedAt >= policy.cooldownMs) {
    state.isOpen = false;
    state.failures = 0;
    return true;
  }

  return false;
}

function recordFailure(platform) {
  const policy = getCircuitPolicy(platform);
  if (!policy.enabled) return;

  const state = getCircuitState(platform);
  state.failures += 1;
  if (state.failures >= policy.failureThreshold) {
    state.isOpen = true;
    state.openedAt = Date.now();
    log(
      "warn",
      `[Frontends] Circuit opened for ${platform} after ${state.failures} failures. Cooldown: ${policy.cooldownMs / 1000}s`,
    );
  }
}

function recordSuccess(platform) {
  const state = getCircuitState(platform);
  state.failures = 0;
  state.isOpen = false;
  state.openedAt = 0;
}

function addRoute(conversationId, platform, nativeChatId) {
  const key = `${platform}:${nativeChatId}`;
  if (!routesByConversation.has(conversationId)) {
    routesByConversation.set(conversationId, new Set());
  }
  routesByConversation.get(conversationId).add(key);
}

function resolveConversationId(platform, nativeChatId) {
  const links = config.conversationLinks || [];
  for (const link of links) {
    const match =
      (platform === "discord" &&
        String(link.discordChannelId || "") === String(nativeChatId)) ||
      (platform === "telegram" &&
        String(link.telegramChatId || "") === String(nativeChatId)) ||
      (platform === "signal" &&
        String(link.signalChatId || "") === String(nativeChatId));

    if (match && link.conversationId) {
      return String(link.conversationId);
    }
  }

  return `${platform}:${nativeChatId}`;
}

function registerFrontend(platform, frontend) {
  frontends.set(platform, frontend);
}

function getFrontend(platform) {
  return frontends.get(platform);
}

function parseRoute(route) {
  const idx = route.indexOf(":");
  if (idx <= 0) return { platform: route, nativeChatId: "" };
  return { platform: route.slice(0, idx), nativeChatId: route.slice(idx + 1) };
}

function getRoutes(conversationId) {
  const linked = routesByConversation.get(conversationId);
  if (linked?.size) return Array.from(linked);

  const routes = [];
  const links = config.conversationLinks || [];
  for (const link of links) {
    if (String(link.conversationId) !== String(conversationId)) continue;
    if (link.discordChannelId) routes.push(`discord:${link.discordChannelId}`);
    if (link.telegramChatId) routes.push(`telegram:${link.telegramChatId}`);
    if (link.signalChatId) routes.push(`signal:${link.signalChatId}`);
  }
  return routes;
}

async function fanout(conversationId, fnName, ...args) {
  const routes = getRoutes(conversationId);
  const invoked = [];
  for (const route of routes) {
    const { platform, nativeChatId } = parseRoute(route);
    const frontend = getFrontend(platform);
    if (!frontend || typeof frontend[fnName] !== "function") continue;

    if (!canAttemptPlatform(platform)) {
      log(
        "warn",
        `[Frontends] Circuit open for ${platform}; skipping ${fnName}.`,
      );
      continue;
    }

    try {
      await frontend[fnName](nativeChatId, ...args);
      recordSuccess(platform);
      invoked.push(route);
    } catch (err) {
      recordFailure(platform);
      log(
        "warn",
        `[Frontends] ${platform}.${fnName} failed for route ${route}: ${err.message}`,
      );
    }
  }
  return invoked;
}

function getRegisteredPlatforms() {
  return new Set(frontends.keys());
}

module.exports = {
  addRoute,
  resolveConversationId,
  registerFrontend,
  getFrontend,
  getRoutes,
  getRegisteredPlatforms,
  fanout,
  parseRoute,
  // Exported for tests.
  canAttemptPlatform,
  recordFailure,
  recordSuccess,
};
