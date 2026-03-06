/**
 * streaming.js - SillyTavern Discord Connector: Streaming
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 *
 * Manages live-streaming AI responses to Discord via throttled message edits.
 *
 * Each character turn is tracked as a stream session keyed by streamId. Token
 * updates (stream_chunk) call scheduleEdit, which uses a self-chaining throttle
 * to fire at most once per STREAM_THROTTLE_MS: if an edit is already in flight,
 * nextEdit is set so exactly one follow-up fires with the latest text once the
 * current edit completes. This prevents stale intermediate edits from queuing
 * while still ensuring the most recent text is always shown.
 *
 * When stream_end arrives, the streaming message is deleted and the final text
 * is reposted cleanly - removing Discord's [edited] marker. The streamHandled
 * flag tells the subsequent ai_reply packet to skip re-posting for that channel.
 */

"use strict";

const { log } = require("./logger");

// Minimum interval between Discord edits per message.
// Discord allows roughly 5 edits per 5 seconds; 1200 ms provides a safe margin.
const STREAM_THROTTLE_MS = 1200;

/**
 * Active stream sessions, keyed by streamId.
 * @type {Record<string, {
 *   streamMessage: import("discord.js").Message|null,
 *   pendingText: string,
 *   characterName: string|null,
 *   editInFlight: boolean,
 *   nextEdit: boolean,
 *   lastEditAt: number,
 *   streamDone: boolean
 * }>}
 */
const streamSessions = {};

/** Channels where stream_end has already posted the final message.
 *  The subsequent ai_reply is skipped for these channels. */
const streamHandled = new Set();

/** Placeholder messages sent while an AI image is generating, keyed by requestId. */
const pendingImageMessages = {};

/**
 * Schedules a throttled Discord edit for an active stream session.
 * Uses a self-chaining pattern so only one edit is ever in flight at a time,
 * and exactly one follow-up fires if text arrived during the in-flight edit.
 *
 * @param {object} session
 * @param {import("discord.js").TextChannel} channel
 * @param {string} streamId
 */
function scheduleEdit(session, channel, streamId) {
  if (session.editInFlight) {
    session.nextEdit = true;
    return;
  }

  const delay = Math.max(
    0,
    STREAM_THROTTLE_MS - (Date.now() - session.lastEditAt),
  );
  session.editInFlight = true;

  setTimeout(async () => {
    if (session.streamDone) {
      session.editInFlight = false;
      return;
    }

    const text = session.pendingText;
    session.lastEditAt = Date.now();

    let displayText = session.characterName
      ? `**${session.characterName}**\n${text}`
      : text;

    // Live preview only: truncate at 2000 chars if mid-sentence. stream_end
    // posts the full final text via sendLong regardless of length.
    if (displayText.length > 2000) {
      displayText = displayText.slice(0, 1999) + "…";
    }

    try {
      if (session.streamMessage) {
        await session.streamMessage.edit(displayText);
        log(
          "log",
          `[Stream] Edited ${session.streamMessage.id} (${displayText.length} chars)`,
        );
      } else {
        session.streamMessage = await channel.send(displayText);
        log(
          "log",
          `[Stream] Created message ${session.streamMessage.id} for ${streamId}`,
        );
      }
    } catch (err) {
      log("warn", `[Stream] Edit failed for ${streamId}: ${err.message}`);
    }

    session.editInFlight = false;

    if (session.nextEdit && !session.streamDone) {
      session.nextEdit = false;
      scheduleEdit(session, channel, streamId);
    }
  }, delay);
}

module.exports = {
  STREAM_THROTTLE_MS,
  streamSessions,
  streamHandled,
  pendingImageMessages,
  scheduleEdit,
};
