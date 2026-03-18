/**
 * Chat recap.
 *
 * After a successful character, group, or chat switch, a recap_message packet
 * is sent to the bridge once the new chat has fully loaded. The bridge renders
 * it as a styled embed on Discord and plain text on other platforms.
 */

import { eventSource, event_types } from "../../../../../script.js";
import { safeSend } from "./ws.js";
import { clearExpressionCache } from "./expression-relay.js";

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
