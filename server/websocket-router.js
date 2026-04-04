/**
 * websocket-router.js - SillyTavern Connector: WebSocket Packet Router
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Pure-ish packet router used by websocket.js. It centralises per-packet
 * behavior so flow tests can run with mocked frontends and state.
 */

"use strict";

const { t } = require("./i18n");

async function handleBridgePacket(data, deps) {
  const {
    ws,
    fanout,
    getRoutes,
    getFrontend,
    parseRoute,
    streamHandled,
    streamReceived,
    pendingImageMessages,
    cancelledImageRequests,
    timedOutImageRequests,
    setBridgeActivity,
    getPendingAutocompletes,
    setPersonaForUser,
    setLangForUser,
    setCurrentPersonaName,
    setCrossRelayEnabled,
    log,
  } = deps;

  if (data.type === "heartbeat") {
    ws.send(JSON.stringify({ type: "heartbeat" }));
    return;
  }

  if (data.type === "autocomplete_response") {
    const pendingAutocompletes = getPendingAutocompletes();
    const pending = pendingAutocompletes[data.requestId];
    if (!pending) return;
    clearTimeout(pending.timeout);
    delete pendingAutocompletes[data.requestId];
    await pending.interaction
      .respond((data.choices || []).slice(0, 25))
      .catch(() => {});
    return;
  }

  if (data.type === "client_info") {
    if (data.personaName) setCurrentPersonaName(String(data.personaName));
    if (data.crossPlatformRelay !== undefined)
      setCrossRelayEnabled(data.crossPlatformRelay);
    return;
  }

  const conversationId = data.chatId;
  if (!conversationId) return;

  switch (data.type) {
    case "typing_action":
      await fanout(conversationId, "sendTyping");
      break;

    case "image_placeholder":
      pendingImageMessages[data.requestId || conversationId] = true;
      await fanout(
        conversationId,
        "sendImagePlaceholder",
        data?.text || "🎨 Generating image…",
      );
      break;

    case "generate_image_result": {
      const key = data.requestId || conversationId;
      delete pendingImageMessages[key];

      if (cancelledImageRequests.has(key)) {
        // User explicitly cancelled - silently discard the late arrival.
        cancelledImageRequests.delete(key);
        break;
      }

      if (timedOutImageRequests.has(key)) {
        // Image arrived after the bridge gave up waiting - send it with a note
        // so the user gets their image and the manager knows the timeout is short.
        timedOutImageRequests.delete(key);
        if (data.image) {
          await fanout(conversationId, "sendText", t("disc.lateImage"));
          await fanout(conversationId, "sendImages", [data.image], null);
        }
        break;
      }

      // Use sendGeneratedImage rather than sendImages so each platform's plugin
      // can delete its own placeholder before posting the real image. Plugins
      // that have no placeholder concept (Telegram, Signal) should alias
      // sendGeneratedImage to sendImages in their plugin implementation.
      if (data.image)
        await fanout(conversationId, "sendGeneratedImage", [data.image], null);
      break;
    }

    case "generate_image_error": {
      const key = data.requestId || conversationId;
      delete pendingImageMessages[key];

      if (data.reason === "cancelled") {
        cancelledImageRequests.add(key);
        // Self-expiring after 30 minutes in case the image never arrives.
        // unref() so the timer does not keep the Node process alive (e.g. in tests).
        setTimeout(
          () => cancelledImageRequests.delete(key),
          30 * 60 * 1000,
        ).unref();
      } else if (data.reason === "timed_out") {
        timedOutImageRequests.add(key);
        setTimeout(
          () => timedOutImageRequests.delete(key),
          30 * 60 * 1000,
        ).unref();
      }

      await fanout(
        conversationId,
        "sendText",
        data.text || "Image generation failed.",
      );
      break;
    }

    case "stream_chunk": {
      const streamId = data.streamId || conversationId;
      streamReceived.add(conversationId);
      await fanout(conversationId, "streamChunk", {
        streamId,
        text: data.text || "",
        characterName: data.characterName || null,
      });
      break;
    }

    case "stream_end": {
      const streamId = data.streamId || conversationId;
      // Keep null as null so discord.streamEnd can fall back to s.pendingText
      // (the last streamed token) when the chat array hasn't flushed yet.
      // Converting null to "" here would cause "" != null to be true inside
      // streamEnd, bypassing the pendingText fallback and losing the message.
      const finalText = data.finalText ?? null;

      const streamPayload = {
        streamId,
        finalText,
        characterName: data.characterName || null,
      };

      const streamedRoutes = new Set(
        await fanout(conversationId, "streamEnd", streamPayload),
      );

      if (finalText?.trim()) {
        const text = data.characterName
          ? `**${data.characterName}**\n${finalText}`
          : finalText;

        for (const route of getRoutes(conversationId)) {
          if (streamedRoutes.has(route)) continue;
          const { platform, nativeChatId } = parseRoute(route);
          const frontend = getFrontend(platform);
          if (!frontend?.sendText) continue;
          await frontend.sendText(nativeChatId, text);
        }
      }

      streamHandled.add(conversationId);
      setTimeout(() => streamHandled.delete(conversationId), 10000);
      break;
    }

    case "ai_reply": {
      if (
        streamReceived.has(conversationId) ||
        streamHandled.has(conversationId)
      ) {
        streamHandled.delete(conversationId);
        streamReceived.delete(conversationId);
        break;
      }

      const messages =
        data?.messages || (data?.text ? [{ name: "", text: data.text }] : []);
      for (const msg of messages.filter((m) => m?.text?.trim())) {
        const text = msg.name
          ? `**${msg.name}**\n${msg.text.trim()}`
          : msg.text.trim();
        await fanout(conversationId, "sendText", text);
      }
      break;
    }

    case "error_message":
    case "intro_message":
      if (data?.text?.trim())
        await fanout(conversationId, "sendText", data.text.trim());
      break;

    case "recap_message":
      await fanout(
        conversationId,
        "sendRecap",
        data.entries || [],
        data.userId || null,
        data.userLocale || null,
      );
      break;

    case "save_user_persona": {
      setPersonaForUser(
        data.platform || "discord",
        data.userId || "",
        data.personaName ?? null,
      );
      break;
    }

    case "save_user_lang": {
      setLangForUser(
        data.platform || "discord",
        data.userId || "",
        data.localeCode ?? null,
      );
      break;
    }

    case "messages_deleted": {
      const count = Math.max(1, parseInt(data.count) || 1);
      const deleteMode = data.deleteMode === "ai_only" ? "ai_only" : "any";
      await fanout(conversationId, "deleteRoleplayMessages", count, deleteMode);
      break;
    }

    case "send_images":
      await fanout(
        conversationId,
        "sendImages",
        (data.images || []).filter(Boolean),
        data.caption || null,
      );
      break;

    case "expression_update": {
      const expression = (data.expression || "").trim().toLowerCase();
      const ownerName = data.ownerName || null;
      if (expression) setBridgeActivity(expression, ownerName);
      await fanout(
        conversationId,
        "sendExpression",
        expression,
        data.image || null,
        ownerName,
        data.userLocale || null,
      );
      break;
    }

    default:
      log("warn", `[Bridge] Unknown message type: ${data.type}`);
  }
}

module.exports = { handleBridgePacket };
