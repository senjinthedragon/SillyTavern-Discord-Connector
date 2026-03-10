/**
 * websocket-router.js - SillyTavern Connector: WebSocket Packet Router
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 *
 * Pure-ish packet router used by websocket.js. It centralises per-packet
 * behavior so flow tests can run with mocked frontends and state.
 */

"use strict";

async function handleBridgePacket(data, deps) {
  const {
    ws,
    fanout,
    getRoutes,
    getFrontend,
    parseRoute,
    streamSessions,
    streamHandled,
    streamReceived,
    pendingImageMessages,
    setBridgeActivity,
    getPendingAutocompletes,
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
    await pending.interaction.respond((data.choices || []).slice(0, 25)).catch(() => {});
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
      await fanout(conversationId, "sendText", data?.text || "🎨 Generating image…");
      break;

    case "generate_image_result":
      delete pendingImageMessages[data.requestId || conversationId];
      // Use sendGeneratedImage rather than sendImages so each platform's plugin
      // can delete its own placeholder before posting the real image. Plugins
      // that have no placeholder concept (Telegram, Signal) should alias
      // sendGeneratedImage to sendImages in their plugin implementation.
      if (data.image) await fanout(conversationId, "sendGeneratedImage", [data.image], null);
      break;

    case "generate_image_error":
      delete pendingImageMessages[data.requestId || conversationId];
      await fanout(conversationId, "sendText", data.text || "Image generation failed.");
      break;

    case "stream_chunk": {
      const streamId = data.streamId || conversationId;
      streamReceived.add(conversationId);
      streamSessions[streamId] = {
        pendingText: data.text || "",
        characterName: data.characterName || null,
      };
      await fanout(conversationId, "streamChunk", {
        streamId,
        text: data.text || "",
        characterName: data.characterName || null,
      });
      break;
    }

    case "stream_end": {
      const streamId = data.streamId || conversationId;
      const s = streamSessions[streamId];
      const finalText = data.finalText != null ? data.finalText : s?.pendingText || "";

      const streamPayload = {
        streamId,
        finalText,
        characterName: data.characterName || null,
      };

      const streamedRoutes = new Set(await fanout(conversationId, "streamEnd", streamPayload));

      if (finalText.trim()) {
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

      delete streamSessions[streamId];
      streamHandled.add(conversationId);
      setTimeout(() => streamHandled.delete(conversationId), 10000);
      break;
    }

    case "ai_reply": {
      if (streamReceived.has(conversationId) || streamHandled.has(conversationId)) {
        streamHandled.delete(conversationId);
        streamReceived.delete(conversationId);
        break;
      }

      const messages = data?.messages || (data?.text ? [{ name: "", text: data.text }] : []);
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
      if (data?.text?.trim()) await fanout(conversationId, "sendText", data.text.trim());
      break;

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
      if (expression) setBridgeActivity(expression);
      await fanout(conversationId, "sendExpression", expression, data.image || null);
      break;
    }

    default:
      log("warn", `[Bridge] Unknown message type: ${data.type}`);
  }
}

module.exports = { handleBridgePacket };
