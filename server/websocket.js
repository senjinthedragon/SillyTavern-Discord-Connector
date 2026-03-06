/**
 * websocket.js - SillyTavern Discord Connector: WebSocket Server
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 *
 * Runs the WebSocket server that the SillyTavern browser extension connects to.
 * Routes incoming packets from the extension to the appropriate Discord actions.
 *
 * Message types handled here:
 *   heartbeat             - echo back to keep the connection alive
 *   autocomplete_response - resolve a pending Discord autocomplete interaction
 *   generate_image_result - delete placeholder, post generated image
 *   generate_image_error  - edit placeholder to show error
 *   typing_action         - show Discord typing indicator
 *   image_placeholder     - post "🎨 Generating image…" placeholder
 *   stream_chunk          - forward cumulative token text as a throttled edit
 *   stream_end            - finalise streaming: delete edit, repost cleanly
 *   ai_reply              - post complete response (non-streaming or fallback)
 *   error_message         - forward extension error to Discord channel
 *   intro_message         - post /newchat character greeting
 *   send_images           - post one or more images to a channel
 *
 * On disconnect, all in-flight state (stream sessions, image placeholders,
 * autocomplete debouncers, pending interactions, channel queues) is cleaned up
 * so the next connection starts from a known-good state.
 */

"use strict";

const WebSocket = require("ws");
const { log } = require("./logger");
const { wssPort } = require("./config-loader");
const { enqueue, clearAllQueues } = require("./queue");
const { sendLong, sendImagesToChannel } = require("./messaging");
const {
  streamSessions,
  streamHandled,
  pendingImageMessages,
  scheduleEdit,
} = require("./streaming");
const { client } = require("./client");
const {
  getPendingAutocompletes,
  getAutocompleteDebouncers,
} = require("./discord");

const version = require("./package.json").version;
const width = 70;

const canColor = process.stdout.isTTY && process.env.TERM !== "dumb";

const purple = canColor ? "\x1b[38;5;93m" : "";
const gold = canColor ? "\x1b[38;5;220m" : "";
const reset = canColor ? "\x1b[0m" : "";

const title = ` SILLYTAVERN DISCORD CONNECTOR - v${version}`;
const credit = ` Developed by: Senjin the Dragon https://github.com/senjinthedragon`;
const support = ` Please support my work: https://ko-fi.com/senjinthedragon`;

console.log(`
${purple}╔${"═".repeat(width)}╗
║${gold}${title.padEnd(width)}${purple}║
║${gold}${credit.padEnd(width)}${purple}║
║${gold}${support.padEnd(width)}${purple}║
╚${"═".repeat(width)}╝${reset}
`);

// ---------------------------------------------------------------------------
// WebSocket server
//
// maxPayload covers base64-encoded images: Discord caps uploads at 8 MB and
// base64 adds ~33% overhead, so 50 MB gives comfortable headroom.
// ---------------------------------------------------------------------------

const wss = new WebSocket.Server({
  port: wssPort,
  maxPayload: 50 * 1024 * 1024,
});
console.log(`[Bridge] WebSocket server listening on port ${wssPort}`);

let sillyTavernClient = null;
const IMAGE_PLACEHOLDER_TIMEOUT_MS = 3 * 60 * 1000;

function getSillyTavernClient() {
  return sillyTavernClient;
}

wss.on("connection", (ws) => {
  console.log("[Bridge] SillyTavern connected");
  sillyTavernClient = ws;

  ws.on("message", async (message) => {
    let data;
    try {
      const payload =
        typeof message === "string" ? message : message.toString("utf8");
      data = JSON.parse(payload);
    } catch (err) {
      log("warn", `[Bridge] Dropping invalid JSON packet: ${err.message}`);
      return;
    }

    if (data.type === "heartbeat") {
      ws.send(JSON.stringify({ type: "heartbeat" }));
      return;
    }

    // autocomplete_response carries a requestId rather than a chatId, so it
    // must be handled before the channel lookup below.
    if (data.type === "autocomplete_response") {
      const pendingAutocompletes = getPendingAutocompletes();
      const pending = pendingAutocompletes[data.requestId];
      if (!pending) return; // already timed out

      clearTimeout(pending.timeout);
      delete pendingAutocompletes[data.requestId];

      // Discord rejects respond() if the array exceeds 25 entries.
      const choices = (data.choices || [])
        .slice(0, 25)
        .map((name) => ({ name, value: name }));
      await pending.interaction.respond(choices).catch((err) => {
        log("warn", `[Autocomplete] respond() failed: ${err.message}`);
      });
      return;
    }

    if (data.type === "generate_image_result") {
      const channelId = data.chatId;
      const channel = client.channels.cache.get(channelId);
      if (!channel) return;

      const pendingKey = data.requestId || channelId;
      const pending = pendingImageMessages[pendingKey];
      delete pendingImageMessages[pendingKey];

      enqueue(channelId, async () => {
        if (pending)
          await pending
            .delete()
            .catch((err) =>
              log(
                "warn",
                `[Image] Could not delete placeholder: ${err.message}`,
              ),
            );
        if (data.image) await sendImagesToChannel(channel, [data.image], null);
      });
      return;
    }

    if (data.type === "generate_image_error") {
      const pendingKey = data.requestId || data.chatId;
      const pending = pendingImageMessages[pendingKey];
      delete pendingImageMessages[pendingKey];
      if (pending) {
        await pending
          .edit(data.text || "Image generation failed.")
          .catch((err) => {
            log("warn", `[Image] Could not edit placeholder: ${err.message}`);
          });
      } else {
        const channel = client.channels.cache.get(data.chatId);
        if (channel && data.text) {
          enqueue(data.chatId, () => sendLong(channel, data.text));
        }
      }
      return;
    }

    const channelId = data.chatId;
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;

    switch (data.type) {
      case "typing_action":
        channel.sendTyping().catch(() => {});
        break;

      case "image_placeholder": {
        const pendingKey = data.requestId || channelId;
        const placeholderText = data?.text || "🎨 Generating image…";
        enqueue(channelId, async () => {
          try {
            const msg = await channel.send(placeholderText);
            pendingImageMessages[pendingKey] = msg;

            setTimeout(() => {
              const pending = pendingImageMessages[pendingKey];
              if (!pending || pending.id !== msg.id) return;
              delete pendingImageMessages[pendingKey];
              pending
                .edit(
                  "⚠️ Image generation timed out. Please run /image again.",
                )
                .catch((err) => {
                  log(
                    "warn",
                    `[Image] Could not edit timed-out placeholder: ${err.message}`,
                  );
                });
            }, IMAGE_PLACEHOLDER_TIMEOUT_MS);
          } catch (err) {
            log("warn", `[Image] Could not send placeholder: ${err.message}`);
          }
        });
        break;
      }

      case "stream_chunk": {
        const streamId = data?.streamId || channelId;
        const rawText = data?.text || "";
        if (!rawText.trim()) break;

        const activeName = data.characterName || null;
        let processedText = rawText;
        if (activeName) {
          const escaped = activeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          processedText = rawText.replace(
            new RegExp(`^${escaped}:\\s*`, "i"),
            "",
          );
        }

        if (!streamSessions[streamId]) {
          streamSessions[streamId] = {
            streamMessage: null,
            pendingText: "",
            characterName: activeName,
            editInFlight: false,
            nextEdit: false,
            lastEditAt: 0,
            streamDone: false,
          };
        }

        const session = streamSessions[streamId];
        if (session.streamDone) break;
        session.pendingText = processedText;
        scheduleEdit(session, channel, streamId);
        break;
      }

      case "stream_end": {
        const streamId = data?.streamId || channelId;

        // Halt throttle immediately before entering the queue.
        const preSession = streamSessions[streamId];
        if (preSession) {
          preSession.streamDone = true;
          preSession.nextEdit = false;
        }

        enqueue(channelId, async () => {
          const s = streamSessions[streamId];
          if (!s) return;

          // Wait for any in-flight edit to settle before touching the message.
          if (s.editInFlight) {
            await new Promise((resolve) => {
              const poll = setInterval(() => {
                if (!s.editInFlight) {
                  clearInterval(poll);
                  resolve();
                }
              }, 50);
            });
          }

          // Use the ST-trimmed text from the extension when available; fall back
          // to pendingText (last raw streaming token) if finalText wasn't sent.
          const rawText =
            data.finalText != null ? data.finalText : s.pendingText || "";
          const activeName = data.characterName || null;
          let processedText = rawText;
          if (activeName) {
            const escaped = activeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            processedText = rawText.replace(
              new RegExp(`^${escaped}:\\s*`, "i"),
              "",
            );
          }

          const finalText = activeName
            ? `**${activeName}**\n${processedText}`
            : processedText;

          if (finalText.trim()) {
            if (s.streamMessage) {
              await s.streamMessage.delete().catch((err) => {
                log(
                  "warn",
                  `[Stream] Could not delete stream message: ${err.message}`,
                );
              });
            }
            await sendLong(channel, finalText);
            log("log", `[Stream] Posted final message for ${streamId}`);
          }

          delete streamSessions[streamId];
          streamHandled.add(channelId);
          // Safety valve: if ai_reply never arrives, clear the flag after 10s
          // so future replies aren't silently swallowed.
          setTimeout(() => streamHandled.delete(channelId), 10_000);
        });
        break;
      }

      case "ai_reply": {
        const messages =
          data?.messages || (data?.text ? [{ name: "", text: data.text }] : []);
        const validMessages = messages.filter((m) => m?.text?.trim());

        if (validMessages.length === 0) {
          channel
            .send(
              "...something went wrong and the response was empty. Try again?",
            )
            .catch(() => {});
          break;
        }

        enqueue(channelId, async () => {
          // Streaming path: stream_end already posted the final message.
          if (streamHandled.has(channelId)) {
            streamHandled.delete(channelId);
            return;
          }

          const isGroup = validMessages.length > 1;
          for (const msg of validMessages) {
            const formatted =
              isGroup && msg.name
                ? `**${msg.name}**\n${msg.text.trim()}`
                : msg.text.trim();
            await sendLong(channel, formatted);
          }
        });
        break;
      }

      case "error_message": {
        const errorText = (data?.text || "").trim();
        if (errorText) enqueue(channelId, () => sendLong(channel, errorText));
        break;
      }

      // intro_message is kept separate from ai_reply: it arrives outside the
      // normal generation lifecycle (no streamId, no stream_end handshake), so
      // reusing ai_reply would risk the streamHandled guard silently dropping it.
      case "intro_message": {
        const introText = (data?.text || "").trim();
        if (!introText) break;
        enqueue(channelId, () => sendLong(channel, introText));
        break;
      }

      case "send_images": {
        const images = (data?.images || []).filter(Boolean);
        if (!images.length) break;
        enqueue(channelId, () =>
          sendImagesToChannel(channel, images, data?.caption || null),
        );
        break;
      }

      default:
        log("warn", "[Bridge] Unknown message type:", data.type);
    }
  });

  ws.on("close", () => {
    sillyTavernClient = null;
    console.log("[Bridge] SillyTavern disconnected");

    // Clean up orphaned stream sessions. Left alone they would block future
    // edits; a stale streamHandled entry would silently drop the next ai_reply.
    for (const streamId of Object.keys(streamSessions)) {
      const s = streamSessions[streamId];
      if (s.editTimer) clearTimeout(s.editTimer);
      delete streamSessions[streamId];
    }
    streamHandled.clear();

    // Edit any outstanding image placeholders so they don't sit forever.
    for (const [pendingKey, msg] of Object.entries(pendingImageMessages)) {
      msg
        .edit("🎨 Image generation was interrupted - bridge disconnected.")
        .catch(() => {});
      delete pendingImageMessages[pendingKey];
    }

    clearAllQueues();

    // Flush debounce timers and respond to pending autocomplete interactions
    // with empty lists so Discord's dropdowns close cleanly rather than
    // spinning until Discord's own 3-second timeout kills them.
    const autocompleteDebouncers = getAutocompleteDebouncers();
    for (const [key, debouncer] of Object.entries(autocompleteDebouncers)) {
      clearTimeout(debouncer.timer);
      delete autocompleteDebouncers[key];
      debouncer.interaction.respond([]).catch(() => {});
    }

    const pendingAutocompletes = getPendingAutocompletes();
    for (const [requestId, pending] of Object.entries(pendingAutocompletes)) {
      clearTimeout(pending.timeout);
      delete pendingAutocompletes[requestId];
      pending.interaction.respond([]).catch(() => {});
    }
  });
});

module.exports = { getSillyTavernClient };
