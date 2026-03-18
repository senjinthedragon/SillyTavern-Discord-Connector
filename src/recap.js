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
 */

/**
 * Chat recap and history.
 *
 * buildLastExchange and buildHistory extract message entries from ST's chat
 * array in the format expected by recap_message packets. scheduleRecap wires
 * them to the CHAT_LOADED event so a recap fires automatically after any
 * character, group, or chat switch.
 */

import { eventSource, event_types } from "../../../../../script.js";
import { safeSend } from "./ws.js";
import { clearExpressionCache } from "./expression-relay.js";

// Cap on AI messages included in a single recap to avoid flooding in large groups.
const RECAP_MAX_AI_MESSAGES = 10;

// ---------------------------------------------------------------------------
// Chat history builders
// ---------------------------------------------------------------------------

/**
 * Walks the chat array backwards to find the last user message and all AI
 * messages that follow it (the last complete exchange). Returns an object
 * with the entries array and the user's display name, or null if the chat
 * has no user messages yet (e.g. only a greeting).
 *
 * @param {Array} chat
 * @returns {{entries: Array<{name: string, text: string, isUser: boolean}>, userLabel: string}|null}
 */
export function buildLastExchange(chat) {
  if (!Array.isArray(chat) || chat.length === 0) return null;

  // Collect trailing AI messages first (everything after the last user turn).
  const aiMessages = [];
  let i = chat.length - 1;
  while (i >= 0 && !chat[i].is_user) {
    const msg = chat[i];
    if (msg.mes?.trim())
      aiMessages.unshift({
        name: msg.name || "",
        text: msg.mes.trim(),
        isUser: false,
      });
    i--;
  }

  // i now points at the last user message, or -1 if there is none.
  if (i < 0) return null;

  const userMsg = chat[i];
  if (!userMsg.mes?.trim()) return null;

  const userLabel = userMsg.name?.trim() || "You";

  // Cap AI messages to avoid flooding on very large groups.
  const cappedAi = aiMessages.slice(-RECAP_MAX_AI_MESSAGES);
  const truncated = aiMessages.length > RECAP_MAX_AI_MESSAGES;

  const entries = [
    { name: userLabel, text: userMsg.mes.trim(), isUser: true },
    ...cappedAi,
  ];

  if (truncated) {
    entries.push({
      name: "",
      text: `_${aiMessages.length - RECAP_MAX_AI_MESSAGES} earlier message(s) not shown - use /history to see more._`,
      isUser: false,
    });
  }

  return { entries, userLabel };
}

/**
 * Walks the chat array to collect the last n exchanges (user message + all
 * following AI messages), oldest first. Skips the greeting (index 0 if it's
 * an AI message with no preceding user message). Returns an entries array
 * ready for a recap_message packet, or null if there is nothing to show.
 *
 * @param {Array} chat
 * @param {number} n  Number of exchanges to collect (0 = all).
 * @returns {Array<{name: string, text: string, isUser: boolean}>|null}
 */
export function buildHistory(chat, n) {
  if (!Array.isArray(chat) || chat.length === 0) return null;

  // Walk backwards collecting complete exchanges (user msg + trailing AI msgs).
  const exchanges = [];
  let i = chat.length - 1;

  while (i >= 0) {
    // Collect trailing AI messages for this exchange.
    const aiMessages = [];
    while (i >= 0 && !chat[i].is_user) {
      const msg = chat[i];
      if (msg.mes?.trim())
        aiMessages.unshift({
          name: msg.name || "",
          text: msg.mes.trim(),
          isUser: false,
        });
      i--;
    }

    // Now i should point at a user message.
    if (i < 0) break;

    const userMsg = chat[i];
    i--;

    if (!userMsg.mes?.trim()) continue;

    const userLabel = userMsg.name?.trim() || "You";
    exchanges.unshift([
      { name: userLabel, text: userMsg.mes.trim(), isUser: true },
      ...aiMessages,
    ]);

    if (n > 0 && exchanges.length >= n) break;
  }

  if (exchanges.length === 0) return null;
  return exchanges.flat();
}

// ---------------------------------------------------------------------------
// scheduleRecap
// ---------------------------------------------------------------------------

let _pendingRecapListener = null;

/**
 * Registers a one-shot chatLoaded listener and sends a recap_message packet
 * to the bridge once the new chat's context is available.
 * Called immediately after a successful switch so the listener is scoped
 * tightly to the chat load we just triggered.
 *
 * Any previously pending recap listener is removed before registering a new
 * one so rapid successive switches don't stack up multiple listeners that all
 * fire on the same CHAT_LOADED event and send duplicate recaps.
 *
 * @param {string} chatId
 */
export function scheduleRecap(chatId) {
  clearExpressionCache();
  if (_pendingRecapListener) {
    eventSource.removeListener(event_types.CHAT_LOADED, _pendingRecapListener);
  }
  _pendingRecapListener = () => {
    _pendingRecapListener = null;
    const { chat } = SillyTavern.getContext();
    const result = buildLastExchange(chat);
    if (!result) return;
    safeSend({ type: "recap_message", chatId, entries: result.entries });
  };
  eventSource.once(event_types.CHAT_LOADED, _pendingRecapListener);
}
