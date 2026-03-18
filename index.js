/**
 * SillyTavern-Discord-Connector - Bridge Extension for SillyTavern
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * Runs inside SillyTavern as a third-party extension. Connects to the bridge
 * server (server.js) over WebSocket and acts as the intermediary between
 * Discord and SillyTavern's internals.
 *
 * Streaming:
 *   Each character turn gets a unique streamId at GENERATION_STARTED.
 *   STREAM_TOKEN_RECEIVED forwards cumulative text to the bridge for throttled
 *   Discord edits. GENERATION_ENDED sends stream_end, which tells the bridge to
 *   replace the live-edit message with a clean final post. Group chats include
 *   the character name; solo chats do not. All per-message listeners are
 *   registered and cleaned up inside handleUserMessage to prevent leaks.
 *
 * Image relay:
 *   Local ST images (thumbnails, generated art, avatars) are fetched here in
 *   the browser - where same-origin access is always available - and sent as
 *   base64 inline data. External URLs are passed through for the bridge to
 *   fetch directly. This split works regardless of whether the bridge runs on
 *   the same machine as SillyTavern.
 *
 * Intro messages:
 *   /newchat greetings are written directly into the chat DOM before any
 *   generation events fire. A MutationObserver on #chat captures them and
 *   forwards them as intro_message packets.
 *
 * AI image generation:
 *   /image sends an image_placeholder immediately, then fires /sd and watches
 *   the DOM for a new img.mes_img element. On success the image is sent as
 *   generate_image_result; on timeout or failure as generate_image_error.
 *   Requests are serialised per Discord channel with a hard watchdog so a
 *   stalled task can never permanently block retries.
 *
 * Autocomplete:
 *   Character and group lists are cached with a 60-second TTL. Chat lists are
 *   keyed by characterId and invalidated on newchat/switchchar/switchgroup
 *   rather than by TTL, keeping them perfectly current.
 *
 * Reactions:
 *   Watches #expression-image in the ST DOM and forwards expression updates.
 *   Depending on extension settings, updates Discord activity only (default)
 *   or activity plus expression image posts to the last active Discord channel.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { setWs, getWs, safeSend } from "./src/ws.js";
import { MODULE_NAME, getSettings, updateStatus } from "./src/settings.js";
import { sharedState } from "./src/state.js";
import {
  resetExpressionSignature,
  setupExpressionObserver,
  scheduleExpressionUpdate,
} from "./src/expression-relay.js";
import { setImageGenerationTimeoutMs } from "./src/image-generation.js";
import {
  handleUserMessage,
  handleExecuteCommand,
  handleGetAutocomplete,
} from "./src/commands.js";

// ---------------------------------------------------------------------------
// Connection state (WebSocket lifecycle only - all other state is in src/)
// ---------------------------------------------------------------------------

let shouldReconnect = true;
let reconnectTimeout = null;
let heartbeatInterval = null;

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connect() {
  const ws = getWs();
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  )
    return;

  shouldReconnect = true;

  const settings = getSettings();
  if (!settings.bridgeUrl) {
    updateStatus("URL not set!", "red");
    return;
  }

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  updateStatus("Connecting...", "orange");
  const socket = new WebSocket(settings.bridgeUrl);
  setWs(socket);

  socket.onopen = () => {
    updateStatus("Connected", "green");
    console.log("[Discord Bridge] Connected to bridge server");
    resetExpressionSignature();
    setupExpressionObserver();
    scheduleExpressionUpdate(sharedState.lastActiveChatId);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      safeSend({ type: "heartbeat" });
    }, 30000);
  };

  socket.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);

      if (data.type === "heartbeat") return;

      if (data.type === "bridge_config") {
        // Validate timezone and locale before storing - invalid values would
        // cause Intl.DateTimeFormat to throw at autocomplete time.
        if (data.timezone) {
          try {
            Intl.DateTimeFormat(undefined, { timeZone: data.timezone });
            sharedState.bridgeTimezone = data.timezone;
          } catch {
            console.warn(
              `[Discord Bridge] Invalid timezone in bridge config: "${data.timezone}" - falling back to local time`,
            );
            sharedState.bridgeTimezone = null;
          }
        } else {
          sharedState.bridgeTimezone = null;
        }
        if (data.locale) {
          try {
            Intl.DateTimeFormat(data.locale);
            sharedState.bridgeLocale = data.locale;
          } catch {
            console.warn(
              `[Discord Bridge] Invalid locale in bridge config: "${data.locale}" - falling back to browser locale`,
            );
            sharedState.bridgeLocale = null;
          }
        } else {
          sharedState.bridgeLocale = null;
        }
        sharedState.bridgePlugins = data.plugins || null;
        if (
          typeof data.imagePlaceholderTimeoutMs === "number" &&
          data.imagePlaceholderTimeoutMs > 0
        ) {
          setImageGenerationTimeoutMs(data.imagePlaceholderTimeoutMs);
        }
        // Tell the server the active persona name so it can label cross-relay
        // messages correctly without requiring a /mypersona setup first.
        // powerUserSettings.persona is the active persona ID; fall back to
        // default_persona if no per-chat override is set.
        const pSettings = SillyTavern.getContext().powerUserSettings;
        const personaId = pSettings?.default_persona || pSettings?.persona;
        const personaName = personaId
          ? pSettings?.personas?.[personaId]
          : null;
        if (personaName) safeSend({ type: "client_info", personaName });
        return;
      }

      if (data.type === "user_message") {
        await handleUserMessage(data);
        return;
      }

      if (data.type === "system_command") {
        if (data.command === "reload_ui_only")
          setTimeout(() => window.location.reload(), 500);
        return;
      }

      if (data.type === "get_autocomplete") {
        await handleGetAutocomplete(data);
        return;
      }

      if (data.type === "execute_command") {
        await handleExecuteCommand(data);
        return;
      }
    } catch (error) {
      console.error("[Discord Bridge] Message handling error:", error);
      if (data?.chatId) {
        safeSend({
          type: "error_message",
          chatId: data.chatId,
          text: "Internal error processing request.",
        });
      }
    }
  };

  socket.onclose = () => {
    updateStatus("Disconnected", "red");
    setWs(null);

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    const settings = getSettings();
    if (settings.autoConnect && shouldReconnect) {
      updateStatus("Reconnecting...", "orange");
      if (!reconnectTimeout) {
        reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null;
          connect();
        }, 5000);
      }
    }
  };

  socket.onerror = (error) => {
    console.error("[Discord Bridge] WebSocket error:", error);
    updateStatus("Connection error", "red");
  };
}

function disconnect() {
  shouldReconnect = false;
  const ws = getWs();
  if (ws) ws.close();
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  updateStatus("Disconnected", "red");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

jQuery(async () => {
  try {
    const settingsHtml = await $.get(
      `/scripts/extensions/third-party/${MODULE_NAME}/settings.html`,
    );
    $("#extensions_settings").append(settingsHtml);

    const settings = getSettings();
    $("#discord_bridge_url").val(settings.bridgeUrl);
    $("#discord_auto_connect").prop("checked", settings.autoConnect);
    $("#discord_expression_mode").val(settings.expressionMode);
    $("#discord_allow_user_persona_save").prop(
      "checked",
      settings.allowUserPersonaSave,
    );

    $("#discord_bridge_url").on("input", () => {
      getSettings().bridgeUrl = $("#discord_bridge_url").val();
      SillyTavern.getContext().saveSettingsDebounced();
    });

    $("#discord_auto_connect").on("change", () => {
      getSettings().autoConnect = $("#discord_auto_connect").prop("checked");
      SillyTavern.getContext().saveSettingsDebounced();
    });

    $("#discord_expression_mode").on("change", () => {
      getSettings().expressionMode = $("#discord_expression_mode").val();
      resetExpressionSignature();
      SillyTavern.getContext().saveSettingsDebounced();
      scheduleExpressionUpdate(sharedState.lastActiveChatId);
    });

    $("#discord_allow_user_persona_save").on("change", () => {
      getSettings().allowUserPersonaSave = $(
        "#discord_allow_user_persona_save",
      ).prop("checked");
      SillyTavern.getContext().saveSettingsDebounced();
    });

    $("#discord_connect_button").on("click", connect);
    $("#discord_disconnect_button").on("click", disconnect);

    // -----------------------------------------------------------------------
    // Global tooltip for .dc-info elements
    //
    // Uses position:fixed so it escapes ST's overflow:hidden extensions panel.
    // Handles mouse, keyboard (focus/blur), and touch (tap to toggle).
    // -----------------------------------------------------------------------
    const $tip = $('<div id="dc-tooltip"></div>').appendTo("body");
    let tipTarget = null;

    function showTip(el) {
      const text = el.getAttribute("data-tooltip");
      if (!text) return;
      tipTarget = el;
      $tip.text(text);

      // Position above the icon, centered horizontally, clamped to viewport
      const r = el.getBoundingClientRect();
      const tipW = 240; // max-width from CSS
      let left = r.left + r.width / 2 - tipW / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));

      $tip.css({ left: left + "px", top: "", bottom: "" });

      // Measure actual rendered height after setting text/position
      $tip.addClass("dc-tooltip-visible");
      const tipH = $tip.outerHeight();
      $tip.removeClass("dc-tooltip-visible");

      // Prefer above; fall back to below if it would clip the top
      if (r.top - tipH - 10 >= 8) {
        $tip.css({ top: r.top - tipH - 10 + "px" });
      } else {
        $tip.css({ top: r.bottom + 8 + "px" });
      }

      $tip.addClass("dc-tooltip-visible");
    }

    function hideTip() {
      tipTarget = null;
      $tip.removeClass("dc-tooltip-visible");
    }

    // Mouse
    $(document).on("mouseenter", ".dc-info", function () {
      showTip(this);
    });
    $(document).on("mouseleave", ".dc-info", hideTip);

    // Keyboard (tabindex="0" on each .dc-info)
    $(document).on("focus", ".dc-info", function () {
      showTip(this);
    });
    $(document).on("blur", ".dc-info", hideTip);

    // Touch - tap to toggle, tap anywhere else to hide
    $(document).on("touchstart", ".dc-info", function (e) {
      e.preventDefault();
      if (tipTarget === this) {
        hideTip();
      } else {
        showTip(this);
      }
    });
    $(document).on("touchstart", function (e) {
      if (tipTarget && !$(e.target).closest(".dc-info").length) hideTip();
    });

    if (settings.autoConnect) connect();
  } catch (error) {
    console.error("[Discord Bridge] Failed to load settings UI:", error);
  }
});
