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
 * WebSocket message handlers and command dispatch.
 *
 * handleUserMessage   - injects a Discord message into ST, streams the reply back
 * handleExecuteCommand - runs slash commands (/switchchar, /image, /status, etc.)
 * handleGetAutocomplete - serves cached name lists for Discord's dropdown menus
 * captureAndSendIntroMessage - forwards /newchat greeting messages via DOM observer
 * invalidateChatCache - clears the per-character chat file cache after state changes
 */

import {
  eventSource,
  event_types,
  getPastCharacterChats,
  sendMessageAsUser,
  doNewChat,
  selectCharacterById,
  openCharacterChat,
  Generate,
  setExternalAbortController,
  deleteLastMessage,
} from "../../../../../script.js";

import { executeSlashCommandsWithOptions } from "../../../../../scripts/slash-commands.js";

import { safeSend, getWs } from "./ws.js";
import { getSettings } from "./settings.js";
import { sharedState } from "./state.js";
import { sanitizeSlashArg } from "./utils.js";
import {
  sendImagesFromMesText,
  sendLastMessageImages,
  sendCharacterAvatar,
  extractTextFromMesText,
} from "./image-relay.js";
import {
  EXPRESSION_MODE_VALUES,
  getCurrentExpressionSnapshot,
  getCachedExpressionSnapshot,
  clearExpressionCache,
  resetExpressionSignature,
  scheduleExpressionUpdate,
  getExpressionCacheSize,
} from "./expression-relay.js";
import {
  getBreakerState,
  hasActiveImageJob,
  hasPendingImageQueue,
  getImageMetrics,
  makeImageRequestId,
  getImageGenerationTimeoutMs,
  checkAndRecordRateLimit,
  cancelActiveImageJob,
  recordBreakerRejected,
  enqueueAndGenerateImage,
} from "./image-generation.js";
import { buildLastExchange, buildHistory, scheduleRecap } from "./recap.js";

// String fallback covers older ST versions that don't export this event type.
const GROUP_WRAPPER_FINISHED =
  event_types.GROUP_WRAPPER_FINISHED ?? "group_wrapper_finished";

// ---------------------------------------------------------------------------
// Autocomplete cache
//
// Character and group lists: TTL-based (60 s). Cheap to rebuild and change
// infrequently, so a short TTL is the right fit.
//
// Chat list: keyed by characterId, invalidated on newchat/switchchar/
// switchgroup. Switching characters is automatically a cache miss; the
// explicit invalidation handles chats added within the same character session.
// ---------------------------------------------------------------------------

const AUTOCOMPLETE_CACHE_TTL_MS = 60_000;

const autocompleteCache = {
  characters: null, // { names: string[], cachedAt: number } | null
  groups: null, // { names: string[], cachedAt: number } | null
};

const chatCache = {}; // { [characterId]: { names: string[] } }

/**
 * Invalidates the chat cache for the active character (or entirely if none
 * is selected). Call after any operation that changes chat state.
 */
export function invalidateChatCache() {
  const ctx = SillyTavern.getContext();
  if (ctx.characterId !== undefined) {
    delete chatCache[ctx.characterId];
  } else {
    for (const key of Object.keys(chatCache)) delete chatCache[key];
  }
}

// ---------------------------------------------------------------------------
// Intro message capture
//
// /newchat greetings are inserted into the chat DOM before any generation
// events fire, so the normal streaming path never sees them. A
// MutationObserver on #chat collects AI .mes elements as they appear and
// forwards each one (text + images) as an intro_message packet.
//
// In group chat every member may have a greeting, so the observer stays
// connected until either the expected member count is reached or a short
// settling timer (INTRO_SETTLE_MS) fires after the DOM goes quiet.
// A 10-second hard timeout prevents a permanent listener leak if ST never
// adds any messages at all.
// ---------------------------------------------------------------------------

/**
 * Captures /newchat greeting messages from the DOM and forwards them to the
 * bridge as intro_message packets. Uses a MutationObserver so greetings that
 * are written synchronously by doNewChat are caught before any generation
 * events fire. In group chats, waits until all members' greetings have
 * appeared or a 600ms settle timer fires after the DOM goes quiet. A 10s
 * hard timeout disconnects the observer if ST never produces messages.
 *
 * @param {string} chatId
 */
export function captureAndSendIntroMessage(chatId) {
  const chatEl = document.getElementById("chat");
  if (!chatEl || !chatId) return;

  const ctx = SillyTavern.getContext();
  const activeGroup = ctx.groupId
    ? (ctx.groups || []).find((g) => g.id === ctx.groupId)
    : null;
  const expectedCount = activeGroup?.members?.length ?? 1;

  const seen = new Set();
  const INTRO_SETTLE_MS = 600;

  const isIntroMessage = (el) =>
    el.classList.contains("mes") && el.getAttribute("is_user") !== "true";

  const collectNew = () => {
    const fresh = [];
    for (const el of chatEl.querySelectorAll(".mes")) {
      if (isIntroMessage(el) && !seen.has(el)) {
        seen.add(el);
        fresh.push(el);
      }
    }
    return fresh;
  };

  const sendOne = async (mesEl) => {
    const mesText = mesEl.querySelector(".mes_text");
    if (!mesText) return;
    const text = extractTextFromMesText(mesText);
    if (text) safeSend({ type: "intro_message", chatId, text });
    await sendImagesFromMesText(chatId, mesText);
  };

  let settleTimeoutId = null;
  let hardTimeoutId = null;
  let observer = null;

  const flush = async (settleId) => {
    observer.disconnect();
    clearTimeout(hardTimeoutId);
    clearTimeout(settleId);
    for (const el of collectNew()) await sendOne(el);
  };

  const onMutation = async () => {
    const fresh = collectNew();
    if (!fresh.length) return;

    for (const el of fresh) await sendOne(el);

    if (seen.size >= expectedCount) {
      flush(settleTimeoutId);
      return;
    }

    clearTimeout(settleTimeoutId);
    settleTimeoutId = setTimeout(() => flush(null), INTRO_SETTLE_MS);
  };

  observer = new MutationObserver(onMutation);
  observer.observe(chatEl, { childList: true, subtree: true });

  hardTimeoutId = setTimeout(() => {
    observer.disconnect();
    clearTimeout(settleTimeoutId);
    console.warn("[Discord Bridge] Intro message capture timed out");
  }, 10_000);

  // Run immediately in case doNewChat populated the DOM synchronously.
  onMutation();
}

// ---------------------------------------------------------------------------
// handleUserMessage
// ---------------------------------------------------------------------------

/**
 * Handles user_message: injects the text into ST, hooks generation lifecycle
 * events to stream tokens to the bridge, and sends the final reply.
 *
 * All event listeners are registered here and removed in every exit path
 * (normal completion, user stop, error) to prevent leaks across sessions.
 */
export async function handleUserMessage(data) {
  sharedState.lastActiveChatId = data.chatId || sharedState.lastActiveChatId;

  // Auto-switch to the user's saved persona before injecting their message.
  if (data.mappedPersona) {
    try {
      await executeSlashCommandsWithOptions(
        `/persona-set ${sanitizeSlashArg(data.mappedPersona)}`,
      );
    } catch (err) {
      console.warn(
        `[Discord Bridge] Failed to auto-switch persona to "${data.mappedPersona}":`,
        err,
      );
    }
  }

  const messageState = { chatId: data.chatId, isStreaming: false };

  safeSend({ type: "typing_action", chatId: messageState.chatId });

  await sendMessageAsUser(data.text);

  let currentStreamId = null;
  let currentCharacterName = null;

  const streamCallback = (cumulativeText) => {
    if (!currentStreamId) return;
    messageState.isStreaming = true;
    safeSend({
      type: "stream_chunk",
      chatId: messageState.chatId,
      streamId: currentStreamId,
      characterName: currentCharacterName,
      text: cumulativeText,
    });
  };
  eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

  const sendStreamEnd = () => {
    if (messageState.isStreaming && currentStreamId) {
      const isGroup = !!SillyTavern.getContext().groupId;

      // Read chat[i].mes rather than relying on the server's pendingText (last
      // raw streaming token). ST applies sentence-completion trimming to mes
      // after generation ends, so pendingText may contain a trailing fragment
      // that ST discarded. Null if the chat array hasn't flushed yet; the server
      // falls back to pendingText in that case.
      let finalText = null;
      try {
        const { chat } = SillyTavern.getContext();
        if (chat?.length) {
          for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg.is_user) break;
            if (
              !isGroup ||
              !currentCharacterName ||
              msg.name === currentCharacterName
            ) {
              if (msg.mes?.trim()) {
                finalText = msg.mes.trim();
                break;
              }
            }
          }
        }
      } catch (err) {
        console.warn(
          "[Discord Bridge] Could not read final text from chat array:",
          err,
        );
      }

      safeSend({
        type: "stream_end",
        chatId: messageState.chatId,
        streamId: currentStreamId,
        characterName: isGroup ? currentCharacterName : null,
        finalText,
      });
    }
    messageState.isStreaming = false;
    currentStreamId = null;
  };

  // Walks the chat array backwards to collect all consecutive AI messages
  // since the last user turn, then sends them as a single ai_reply payload.
  // Also forwards any images embedded in the last AI message (post-generation
  // art, etc.). Not awaited so text replies reach Discord first.
  const collectAndSendReplies = () => {
    if (!messageState.chatId) return;
    const { chat } = SillyTavern.getContext();
    if (!chat || chat.length < 2) return;

    const aiMessages = [];
    for (let i = chat.length - 1; i >= 0; i--) {
      const msg = chat[i];
      if (msg.is_user) break;
      if (msg.mes?.trim())
        aiMessages.unshift({ name: msg.name || "", text: msg.mes.trim() });
    }

    if (aiMessages.length > 0) {
      safeSend({
        type: "ai_reply",
        chatId: messageState.chatId,
        messages: aiMessages,
      });
    } else {
      safeSend({
        type: "error_message",
        chatId: messageState.chatId,
        text: "Something went wrong and no response was found. Try again?",
      });
    }

    sendLastMessageImages(messageState.chatId);
  };

  // Assigns a new streamId at the start of each character turn so the bridge
  // maintains separate streaming messages per character in group chat.
  const onGenerationStarted = () => {
    currentStreamId = `${messageState.chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const ctx = SillyTavern.getContext();
    currentCharacterName = ctx.groupId ? ctx.name2 || null : null;
  };
  eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

  const removeAllListeners = () => {
    eventSource.removeListener(
      event_types.STREAM_TOKEN_RECEIVED,
      streamCallback,
    );
    eventSource.removeListener(
      event_types.GENERATION_STARTED,
      onGenerationStarted,
    );
    eventSource.removeListener(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.removeListener(GROUP_WRAPPER_FINISHED, onGroupFinished);
    eventSource.removeListener(
      event_types.GENERATION_STOPPED,
      onGenerationStopped,
    );
  };

  // Fires once per character turn. Closes their stream on Discord.
  // In solo chat (GROUP_WRAPPER_FINISHED never fires) also triggers the final
  // ai_reply after a brief delay to let the chat array settle.
  const onGenerationEnded = () => {
    sendStreamEnd();
    if (!SillyTavern.getContext().groupId) {
      removeAllListeners();
      collectAndSendReplies();
    }
  };
  eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

  // Fires once after all group members have finished generating.
  const onGroupFinished = () => {
    removeAllListeners();
    collectAndSendReplies();
  };
  eventSource.on(GROUP_WRAPPER_FINISHED, onGroupFinished);

  // User aborted - clean up without sending a reply.
  const onGenerationStopped = () => {
    removeAllListeners();
    sendStreamEnd();
  };
  eventSource.once(event_types.GENERATION_STOPPED, onGenerationStopped);

  try {
    const abortController = new AbortController();
    setExternalAbortController(abortController);
    await Generate("normal", { signal: abortController.signal });
  } catch (error) {
    console.error("[Discord Bridge] Generation error:", error);
    await deleteLastMessage();
    safeSend({
      type: "error_message",
      chatId: messageState.chatId,
      text: `Generation failed. Your message was retracted - try again.\n\nError: ${error.message || "Unknown"}`,
    });
    removeAllListeners();
    sendStreamEnd();
  }
}

// ---------------------------------------------------------------------------
// handleExecuteCommand
// ---------------------------------------------------------------------------

/**
 * Handles execute_command: runs the requested slash command against
 * SillyTavern's APIs and sends an ai_reply with the result text.
 */
export async function handleExecuteCommand(data) {
  sharedState.lastActiveChatId = data.chatId || sharedState.lastActiveChatId;
  safeSend({ type: "typing_action", chatId: data.chatId });

  let replyText = "Command execution failed, try again later.";
  const context = SillyTavern.getContext();

  try {
    switch (data.command) {
      case "newchat":
        await doNewChat({ deleteCurrentChat: false });
        clearExpressionCache();
        invalidateChatCache();
        captureAndSendIntroMessage(data.chatId);
        replyText = "New chat started.";
        break;

      case "listchars": {
        const characters = context.characters.filter((c) => c.name?.trim());
        replyText =
          characters.length === 0
            ? "No available characters found."
            : "Available characters:\n\n" +
              characters
                .map((c, i) => `${i + 1}. /switchchar_${i + 1} - ${c.name}`)
                .join("\n") +
              "\n\nUse /switchchar_number or /switchchar character_name to switch.";
        break;
      }

      case "switchchar": {
        if (!data.args?.length) {
          replyText = "Usage: /switchchar <n> or /switchchar_number";
          break;
        }
        const targetName = data.args.join(" ");
        const target = context.characters.find((c) => c.name === targetName);
        if (target) {
          scheduleRecap(data.chatId);
          await selectCharacterById(context.characters.indexOf(target));
          invalidateChatCache();
          replyText = `Switched to "${targetName}".`;
        } else {
          replyText = `Character "${targetName}" not found.`;
        }
        break;
      }

      case "listgroups": {
        const allGroups = context.groups || [];
        replyText =
          allGroups.length === 0
            ? "No groups found."
            : "Available groups:\n\n" +
              allGroups
                .map((g, i) => `${i + 1}. /switchgroup_${i + 1} - ${g.name}`)
                .join("\n") +
              "\n\nUse /switchgroup_number or /switchgroup group_name to switch.";
        break;
      }

      case "switchgroup": {
        if (!data.args?.length) {
          replyText = "Usage: /switchgroup <n> or /switchgroup_number";
          break;
        }
        const targetName = data.args.join(" ");
        const target = (context.groups || []).find(
          (g) => g.name === targetName,
        );
        if (target) {
          scheduleRecap(data.chatId);
          await executeSlashCommandsWithOptions(
            `/go ${sanitizeSlashArg(target.name)}`,
          );
          invalidateChatCache();
          replyText = `Switched to group "${targetName}".`;
        } else {
          replyText = `Group "${targetName}" not found.`;
        }
        break;
      }

      case "listchats": {
        if (context.characterId === undefined) {
          replyText = "Please select a character first.";
          break;
        }
        const chatFiles = await getPastCharacterChats(context.characterId);
        replyText =
          chatFiles.length === 0
            ? "No chat history for current character."
            : "Chat history:\n\n" +
              chatFiles
                .map(
                  (c, i) =>
                    `${i + 1}. /switchchat_${i + 1} - ${c.file_name.replace(".jsonl", "")}`,
                )
                .join("\n") +
              "\n\nUse /switchchat_number or /switchchat chat_name to switch.";
        break;
      }

      case "switchchat": {
        if (!data.args?.length) {
          replyText = "Usage: /switchchat <n>";
          break;
        }
        const targetChatFile = data.args.join(" ");
        try {
          scheduleRecap(data.chatId);
          await openCharacterChat(targetChatFile);
          replyText = `Loaded chat: ${targetChatFile}`;
        } catch {
          replyText = `Failed to load chat "${targetChatFile}". Check the name is exact.`;
        }
        break;
      }

      case "charimage": {
        // In solo chat, no argument needed - active character's avatar is sent.
        // In group chat, an argument selects which member to show; if omitted,
        // lists the group members instead.
        const ctx = SillyTavern.getContext();
        const isGroup = !!ctx.groupId;
        const targetName = data.args?.join(" ").trim() || null;

        if (targetName) {
          const target = ctx.characters.find(
            (c) => c.name?.toLowerCase() === targetName.toLowerCase(),
          );
          if (!target) {
            replyText = `Character "${targetName}" not found.`;
            break;
          }
          sendCharacterAvatar(data.chatId, target); // async, not awaited
          replyText = `Sending avatar for **${target.name}**\u2026`;
        } else if (isGroup) {
          const activeGroup = (ctx.groups || []).find(
            (g) => g.id === ctx.groupId,
          );
          const memberNames = (activeGroup?.members || [])
            .map(
              (id) =>
                ctx.characters.find((ch) => ch.id === id)?.name?.trim() || null,
            )
            .filter(Boolean);
          replyText = memberNames.length
            ? "Group members:\n\n" +
              memberNames.map((n) => `\u2022 ${n}`).join("\n") +
              "\n\nUse /charimage <n> to see a member's avatar."
            : "No members found in the current group.";
        } else {
          if (
            ctx.characterId === undefined ||
            !ctx.characters?.[ctx.characterId]
          ) {
            replyText = "No character is currently selected.";
            break;
          }
          sendCharacterAvatar(data.chatId, ctx.characters[ctx.characterId]); // async, not awaited
          replyText = `Sending avatar for **${ctx.characters[ctx.characterId].name}**\u2026`;
        }
        break;
      }

      case "mood": {
        const requestedName = data.args?.join(" ").trim() || null;
        let snapshot = await getCurrentExpressionSnapshot(true);
        let usedCachedSnapshot = false;
        if (!snapshot) {
          if (requestedName) {
            const cached = getCachedExpressionSnapshot(requestedName);
            if (!cached) {
              replyText =
                "No active expression is available right now, and no stored mood exists for that character yet.";
              break;
            }
            snapshot = cached;
            usedCachedSnapshot = true;
          } else {
            replyText =
              "No active expression is available right now. Make sure expressions are enabled in SillyTavern.";
            break;
          }
        }

        if (requestedName) {
          const owner = snapshot.ownerName || "(unknown)";

          if (
            !snapshot.ownerName ||
            snapshot.ownerName.toLowerCase() !== requestedName.toLowerCase()
          ) {
            const cached = getCachedExpressionSnapshot(requestedName);
            if (!cached) {
              replyText =
                `Current visible mood is for **${owner}** (` +
                `**${snapshot.expression}**). ` +
                `Mood for **${requestedName}** is not currently visible in SillyTavern and has not been seen yet.`;
              break;
            }
            snapshot = cached;
            usedCachedSnapshot = true;
          }
        }

        safeSend({
          type: "expression_update",
          expression: snapshot.expression,
          ownerName: snapshot.ownerName || null,
          chatId: data.chatId,
          image: snapshot.image,
        });

        const ownerPrefix = snapshot.ownerName
          ? `**${snapshot.ownerName}**: `
          : "";
        const cachedNote = usedCachedSnapshot ? " (last known mood)" : "";
        replyText = snapshot.image
          ? `Current mood: ${ownerPrefix}**${snapshot.expression}**${cachedNote} (image sent).`
          : `Current mood: ${ownerPrefix}**${snapshot.expression}**${cachedNote} (no expression image available).`;
        break;
      }

      case "reaction": {
        if (!data.args?.length) {
          replyText = "Usage: /reaction <mode>\nModes: off, status, full";
          break;
        }

        const mode = String(data.args[0] || "")
          .trim()
          .toLowerCase();
        if (!EXPRESSION_MODE_VALUES.has(mode)) {
          replyText = "Invalid mode. Use one of: off, status, full.";
          break;
        }

        getSettings().expressionMode = mode;
        SillyTavern.getContext().saveSettingsDebounced();
        resetExpressionSignature();
        scheduleExpressionUpdate(data.chatId);

        const modeLabel =
          mode === "off"
            ? "Off"
            : mode === "status"
              ? "Discord status only"
              : "Discord status + expression images";
        replyText = `Reaction mode set to: **${modeLabel}**.`;
        break;
      }

      case "image": {
        if (!data.args?.length) {
          replyText =
            "Usage: /image <prompt> or /image <keyword>\nKeywords: you, face, me, scene, last, raw_last, background\nUse /image cancel to stop an active generation.";
          break;
        }

        const prompt = data.args.join(" ").trim();
        const lowerPrompt = prompt.toLowerCase();

        if (lowerPrompt === "cancel") {
          const cancelled = cancelActiveImageJob(data.chatId);
          replyText = cancelled
            ? "Cancelled active image generation."
            : "No active image generation to cancel.";
          break;
        }

        const breakerState = getBreakerState(data.chatId);
        if (breakerState) {
          recordBreakerRejected();
          const seconds = Math.ceil(
            (breakerState.openUntil - Date.now()) / 1000,
          );
          replyText = `Image generation is temporarily paused after repeated failures. Try again in ~${seconds}s.`;
          break;
        }

        const rateCheck = checkAndRecordRateLimit(data.chatId);
        if (!rateCheck.allowed) {
          replyText =
            "Too many image requests in a short time. Please wait a minute and try again.";
          break;
        }

        const requestId = makeImageRequestId();
        const timeoutMinutes = getImageGenerationTimeoutMs() / 60_000;

        safeSend({
          type: "image_placeholder",
          chatId: data.chatId,
          requestId,
          text: `\uD83C\uDFA8 Generating image\u2026 (timeout: ${timeoutMinutes} minutes; use /image cancel to abort)`,
        });

        // Queue and return early - generate_image_result/error sends its own packets.
        enqueueAndGenerateImage(data.chatId, requestId, prompt);
        return;
      }

      case "continue": {
        const { chat: chatBefore } = SillyTavern.getContext();
        const lastMsgBefore = [...chatBefore]
          .reverse()
          .find((m) => !m.is_user && m.mes?.trim());
        const textBefore = lastMsgBefore?.mes?.trim() ?? "";

        await executeSlashCommandsWithOptions("/continue await=true");

        const { chat: chatAfter } = SillyTavern.getContext();
        const lastMsgAfter = [...chatAfter]
          .reverse()
          .find((m) => !m.is_user && m.mes?.trim());
        const textAfter = lastMsgAfter?.mes?.trim() ?? "";

        const newText = textAfter.startsWith(textBefore)
          ? textAfter.slice(textBefore.length).trim()
          : textAfter;

        replyText = newText || "Continuation returned nothing.";
        break;
      }

      case "impersonate": {
        const impPrompt = sanitizeSlashArg(data.args?.[0] ?? "");
        await executeSlashCommandsWithOptions(
          impPrompt
            ? `/impersonate await=true ${impPrompt}`
            : "/impersonate await=true",
        );
        const impersonatedText = String($("#send_textarea").val()).trim();
        if (impersonatedText) {
          $("#send_textarea").val("").trigger("input");
          replyText = `\uD83D\uDCAD *Suggested response* _(feel free to copy, edit and send as your own)_:\n${impersonatedText}`;
        } else {
          replyText = "Impersonation returned nothing.";
        }
        break;
      }

      case "listpersonas": {
        const personas = Object.values(
          SillyTavern.getContext().powerUserSettings?.personas ?? {},
        ).filter((n) => n?.trim());
        replyText =
          personas.length > 0
            ? "Available personas:\n\n" +
              personas.map((n, i) => `${i + 1}. ${n}`).join("\n")
            : "No personas found.";
        break;
      }

      case "persona": {
        const personaName = sanitizeSlashArg(data.args?.[0] ?? "");
        if (!personaName) {
          replyText = "Please provide a persona name. Example: `/persona Aria`";
          break;
        }
        await executeSlashCommandsWithOptions(`/persona-set ${personaName}`);
        replyText = `Persona set to: _${personaName}_`;
        break;
      }

      case "mypersona": {
        if (!getSettings().allowUserPersonaSave) {
          replyText =
            "Saving persona preferences is disabled by the server administrator. Use `/persona <name>` to switch manually.";
          break;
        }
        const personaArg = sanitizeSlashArg(data.args?.[0] ?? "");
        if (!personaArg) {
          replyText =
            "Usage: `/mypersona <name>` - save your persona so it switches automatically each time you chat.\n" +
            "Use `/mypersona clear` to remove your saved preference.\n" +
            "Use `/listpersonas` to see available personas.";
          break;
        }
        if (personaArg.toLowerCase() === "clear") {
          safeSend({
            type: "save_user_persona",
            chatId: data.chatId,
            platform: data.platform || "discord",
            userId: data.userId || "",
            personaName: null,
          });
          replyText =
            "Your persona preference has been cleared. Messages will use whatever persona is currently active.";
          break;
        }
        await executeSlashCommandsWithOptions(`/persona-set ${personaArg}`);
        safeSend({
          type: "save_user_persona",
          chatId: data.chatId,
          platform: data.platform || "discord",
          userId: data.userId || "",
          personaName: personaArg,
        });
        replyText = `Persona _${personaArg}_ saved. It will be set automatically each time you send a message.`;
        break;
      }

      case "note": {
        const noteText = sanitizeSlashArg(data.args?.[0] ?? "");
        if (noteText) {
          await executeSlashCommandsWithOptions(`/note ${noteText}`);
          replyText = `Author's note set to: _${noteText}_`;
        } else {
          const current =
            SillyTavern.getContext().chatMetadata?.note_prompt ?? "";
          replyText = current
            ? `Current author's note: _${current}_`
            : "No author's note is currently set.";
        }
        break;
      }

      case "status": {
        const breakerState = getBreakerState(data.chatId);
        const metrics = getImageMetrics();
        const activeCharacter =
          context.characterId !== undefined
            ? context.characters?.[context.characterId]?.name || "(unknown)"
            : "(none)";
        const activeGroup = context.groupId
          ? (context.groups || []).find((g) => g.id === context.groupId)
              ?.name || "(unknown)"
          : "(none)";
        const pSettings = context.powerUserSettings;
        const personaId = pSettings?.default_persona || pSettings?.persona;
        const activePersona = personaId
          ? pSettings?.personas?.[personaId] || personaId
          : "(none)";

        let lastErrorText = "";
        if (metrics.lastError) {
          const minutesAgo = Math.floor(
            (Date.now() - metrics.lastErrorAt) / 60000,
          );
          const errorTime = new Date(metrics.lastErrorAt);
          const timeString =
            minutesAgo < 1
              ? "Just now"
              : minutesAgo < 60
                ? `${minutesAgo}m ago`
                : minutesAgo < 1440
                  ? `${Math.floor(minutesAgo / 60)}h ${minutesAgo % 60}m ago`
                  : errorTime.toLocaleString();
          lastErrorText = `\n**\u26A0\uFE0F Last error:**\n> \`${metrics.lastError}\`\n> _${timeString}_`;
        }

        const PLATFORM_LABELS = {
          discord: "Discord",
          telegram: "Telegram",
          signal: "Signal",
        };
        const PLATFORM_ICONS = {
          active: "\uD83D\uDFE2",
          not_loaded: "\u26AB",
          inactive: "\uD83D\uDD34",
        };
        const platformLine = sharedState.bridgePlugins
          ? Object.entries(sharedState.bridgePlugins)
              .map(
                ([p, s]) =>
                  `${PLATFORM_LABELS[p] || p} ${PLATFORM_ICONS[s] || "\u26AB"}`,
              )
              .join(" | ")
          : "Unknown";

        replyText =
          "## \uD83D\uDC32 __Bridge Status:__\n" +
          `**Connection:** ${getWs()?.readyState === WebSocket.OPEN ? "\uD83D\uDFE2 Online" : "\uD83D\uDD34 Offline"}\n` +
          `**Plugins:** ${platformLine}\n` +
          `**Active:** ${activeGroup !== "(none)" ? `\uD83D\uDC65 Group: ${activeGroup}` : activeCharacter !== "(none)" ? `\uD83D\uDC64 ${activeCharacter}` : "_Nothing loaded_"}\n` +
          `**Persona:** ${activePersona !== "(none)" ? `\uD83C\uDFAD ${activePersona}` : "_None set_"}\n` +
          `**Mood snapshots cached:** ${getExpressionCacheSize()}\n\n` +
          "**\uD83D\uDDBC\uFE0F Image Generation**\n" +
          `> **Status:** ${!breakerState ? "\u2705 Ready" : `\u23F8\uFE0F Paused - cooling down (${Math.ceil((breakerState.openUntil - Date.now()) / 1000)}s left, will resume automatically)`}\n` +
          `> **Queue:** ${hasPendingImageQueue(data.chatId) ? "\u23F3 Pending images" : "\u2705 Empty"}\n` +
          `> **Currently generating:** ${hasActiveImageJob(data.chatId) ? "\u2699\uFE0F Yes" : "-"}\n\n` +
          "**\uD83D\uDCCA Image Stats** _(since last restart)_\n" +
          `> \u2705 Succeeded: **${metrics.succeeded}** / \u2728 Total requested: **${metrics.totalRequests}**\n` +
          `> \u274C Failed: **${metrics.failed}** | \u23F1\uFE0F Timed out: **${metrics.timedOut}** | \uD83D\uDEAB Rate limited: **${metrics.rateLimited}**\n` +
          `> \uD83D\uDED1 Canceled: **${metrics.canceled}** | \u26A1 Concurrent now: **${metrics.inFlight}** (peak: **${metrics.maxConcurrentInFlight}**)\n` +
          `> \uD83D\uDD01 Overload trips: **${metrics.breakerTrips}** | \uD83D\uDEA7 Requests blocked during cooldown: **${metrics.breakerRejected}**\n` +
          lastErrorText;
        break;
      }

      case "sthelp":
        replyText =
          "## \uD83D\uDC32 __Bridge Commands:__\n" +
          "**System & Status**\n" +
          "> `/sthelp` - Show this menu\n" +
          "> `/status` - Check connection and image stats\n" +
          "> `/reaction <mode>` - Set mood display: `off`, `status`, or `full`\n\n" +
          "**Management**\n" +
          "> `/listchars` | `/listgroups` - List characters / groups\n" +
          "> `/switchchar` | `/switchgroup` - Switch character / group\n" +
          "> `/newchat` - Start a fresh chat\n" +
          "> `/listchats` | `/switchchat` - List and load saved chats\n" +
          "> `/history [n]` - Show last n messages (default: 5)\n" +
          "> *\uD83D\uDCA1 `/switchchar_3`, `/switchgroup_2` etc. work as plain text messages*\n\n" +
          "**Mood & Persona**\n" +
          "> `/mood` - Show the character's current expression\n" +
          "> `/charimage` - Post the character's picture\n" +
          "> `/note <text>` - Set a hidden story note; omit text to read it\n" +
          "> `/persona <name>` - Switch your persona\n" +
          (getSettings().allowUserPersonaSave
            ? "> `/mypersona <name>` - Save your persona for automatic use; `clear` to remove\n"
            : "") +
          "> `/listpersonas` - List your personas\n" +
          "> `/impersonate [prompt]` - Have the AI write your next message\n" +
          "> `/continue` - Continue the last AI message\n\n" +
          "**Image Generation**\n" +
          "> `/image <prompt or keyword>` - Generate an image (`you`, `face`, `me`, `scene`, `last`, `raw_last`, `background`)\n" +
          "> `/image cancel` - Cancel active image generation\n\n" +
          "~~                                                                                                                                          ~~\n" +
          "*Developed by **Senjin the Dragon** - <https://github.com/senjinthedragon>*\n" +
          "*Please support my work:* <https://github.com/sponsors/senjinthedragon>";
        break;

      case "history": {
        const { chat } = SillyTavern.getContext();
        const n = data.args?.length
          ? Math.max(0, parseInt(data.args[0]) || 0)
          : 5;
        const entries = buildHistory(chat, n);
        if (!entries) {
          replyText = "No chat history found.";
          break;
        }
        safeSend({ type: "recap_message", chatId: data.chatId, entries });
        replyText = `Showing last ${n > 0 ? n : "all"} exchange(s).`;
        break;
      }

      default: {
        const charMatch = data.command.match(/^switchchar_(\d+)$/);
        if (charMatch) {
          const index = parseInt(charMatch[1]) - 1;
          const characters = context.characters.filter((c) => c.name?.trim());
          if (index >= 0 && index < characters.length) {
            const target = characters[index];
            scheduleRecap(data.chatId);
            await selectCharacterById(context.characters.indexOf(target));
            invalidateChatCache();
            replyText = `Switched to "${target.name}".`;
          } else {
            replyText = `Invalid number: ${index + 1}. Use /listchars to see options.`;
          }
          break;
        }

        const chatMatch = data.command.match(/^switchchat_(\d+)$/);
        if (chatMatch) {
          if (context.characterId === undefined) {
            replyText = "Please select a character first.";
            break;
          }
          const index = parseInt(chatMatch[1]) - 1;
          const chatFiles = await getPastCharacterChats(context.characterId);
          if (index >= 0 && index < chatFiles.length) {
            const chatName = chatFiles[index].file_name.replace(".jsonl", "");
            try {
              scheduleRecap(data.chatId);
              await openCharacterChat(chatName);
              replyText = `Loaded chat: ${chatName}`;
            } catch {
              replyText = "Failed to load chat.";
            }
          } else {
            replyText = `Invalid number: ${index + 1}. Use /listchats to see options.`;
          }
          break;
        }

        const groupMatch = data.command.match(/^switchgroup_(\d+)$/);
        if (groupMatch) {
          const index = parseInt(groupMatch[1]) - 1;
          const groups = context.groups || [];
          if (index >= 0 && index < groups.length) {
            scheduleRecap(data.chatId);
            await executeSlashCommandsWithOptions(
              `/go ${sanitizeSlashArg(groups[index].name)}`,
            );
            invalidateChatCache();
            replyText = `Switched to group "${groups[index].name}".`;
          } else {
            replyText = `Invalid number: ${index + 1}. Use /listgroups to see options.`;
          }
          break;
        }

        replyText = `Unknown command: /${data.command}. Try /sthelp for available commands.`;
      }
    }
  } catch (error) {
    console.error("[Discord Bridge] Command error:", error);
    replyText = `Error executing command: ${error.message || "Unknown error"}`;
  }

  safeSend({ type: "ai_reply", chatId: data.chatId, text: replyText });
}

// ---------------------------------------------------------------------------
// handleGetAutocomplete
// ---------------------------------------------------------------------------

/**
 * Handles get_autocomplete: queries ST's live context for the requested list
 * type, filters by the user's partial input, and replies with up to 25 choices.
 *
 * Character/group lists are served from a TTL cache. Chat lists are served from
 * a per-character cache that's invalidated by chat-state-changing commands.
 */
export async function handleGetAutocomplete(data) {
  let allNames = [];
  try {
    const context = SillyTavern.getContext();
    const now = Date.now();

    // Sorts a name list alphabetically, ignoring leading emoji and non-letter
    // characters so that e.g. "\uD83C\uDF1F Alice" sorts alongside "Alice" rather than
    // after all plain-ASCII names.
    const sortAlpha = (names) =>
      [...names].sort((a, b) =>
        a
          .replace(/^[^\p{L}]+/u, "")
          .localeCompare(b.replace(/^[^\p{L}]+/u, ""), undefined, {
            sensitivity: "base",
          }),
      );

    if (data.list === "characters") {
      if (
        autocompleteCache.characters &&
        now - autocompleteCache.characters.cachedAt < AUTOCOMPLETE_CACHE_TTL_MS
      ) {
        allNames = autocompleteCache.characters.names;
      } else {
        allNames = context.characters
          .map((c) => c.name)
          .filter((n) => n?.trim());
        autocompleteCache.characters = { names: allNames, cachedAt: now };
      }
    } else if (data.list === "groups") {
      if (
        autocompleteCache.groups &&
        now - autocompleteCache.groups.cachedAt < AUTOCOMPLETE_CACHE_TTL_MS
      ) {
        allNames = autocompleteCache.groups.names;
      } else {
        allNames = (context.groups || [])
          .map((g) => g.name)
          .filter((n) => n?.trim());
        autocompleteCache.groups = { names: allNames, cachedAt: now };
      }
    } else if (data.list === "chats") {
      // Only meaningful when a character is selected; empty list otherwise.
      // Sorted newest-first using the raw filename (which is lexicographically
      // ordered by timestamp), then reformatted for display using the timezone
      // pushed from the bridge on connect.
      if (context.characterId !== undefined) {
        if (chatCache[context.characterId]) {
          allNames = chatCache[context.characterId].names;
        } else {
          const chatFiles = await getPastCharacterChats(context.characterId);

          // Parse "Name - YYYY-MM-DD@HHhMMmSSsXXXms" into a Date for display.
          // Returns null if the filename doesn't match the expected pattern.
          const parseChatFilename = (name) => {
            const m = name.match(
              /(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m(\d{2})s(\d+)ms$/,
            );
            if (!m) return null;
            const [, yr, mo, dy, hr, mn, sc, ms] = m;
            return new Date(Date.UTC(+yr, +mo - 1, +dy, +hr, +mn, +sc, +ms));
          };

          const fmt = (() => {
            const tz = sharedState.bridgeTimezone;
            const opts = {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
              ...(tz ? { timeZone: tz } : {}),
            };
            try {
              return new Intl.DateTimeFormat(
                sharedState.bridgeLocale || undefined,
                opts,
              );
            } catch {
              return new Intl.DateTimeFormat(undefined, {
                ...opts,
                timeZone: undefined,
              });
            }
          })();

          // Produce {name, value} pairs: name is the human-readable label
          // shown in Discord's dropdown; value is the raw filename that ST
          // uses to actually load the chat.
          allNames = chatFiles
            .map((c) => c.file_name.replace(".jsonl", ""))
            .filter((n) => n?.trim())
            // Sort newest-first by raw filename - the timestamp suffix is
            // lexicographically ordered so no date parsing is needed here.
            .sort((a, b) => b.localeCompare(a))
            .map((raw) => {
              const date = parseChatFilename(raw);
              if (!date) return { name: raw, value: raw };
              // Replace the raw timestamp suffix with a human-readable label,
              // keeping the raw filename as the value ST receives on selection.
              const prefix = raw.replace(
                / - \d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d+ms$/,
                "",
              );
              return { name: `${prefix} - ${fmt.format(date)}`, value: raw };
            });

          chatCache[context.characterId] = { names: allNames };
        }
      }
    } else if (data.list === "image_prompts") {
      // Static keyword list - no caching needed.
      allNames = [
        "you",
        "face",
        "me",
        "scene",
        "last",
        "raw_last",
        "background",
        "cancel",
      ];
    } else if (data.list === "personas") {
      // Always fresh - persona list is small and changes rarely.
      allNames = Object.values(
        context.powerUserSettings?.personas ?? {},
      ).filter((n) => n?.trim());
    } else if (data.list === "group_members") {
      if (!context.groupId) {
        // Solo chat - offer the active character's name as the only option.
        const soloChar =
          context.characters?.[context.characterId]?.name?.trim();
        if (soloChar) allNames = [soloChar];
      } else {
        // Read directly from the rendered group members panel and sort
        // alphabetically, consistent with the other name lists.
        const memberEls = document.querySelectorAll(
          "#rm_group_members .group_member .ch_name",
        );
        allNames = sortAlpha(
          Array.from(memberEls)
            .map((el) => el.textContent.trim())
            .filter(Boolean),
        );
      }
    }
  } catch (err) {
    // Fall through with empty choices rather than leaving Discord's dropdown on a spinner.
    console.error("[Discord Bridge] Autocomplete error:", err);
  }

  const query = (data.query || "").toLowerCase();
  // allNames entries are either plain strings (all lists except chats) or
  // {name, value} objects (chats, where the display label differs from the
  // raw filename that SillyTavern needs to load the chat). Normalise here so
  // websocket.js always receives a consistent {name, value} array.
  const choices = allNames
    .filter((entry) => {
      const label = typeof entry === "string" ? entry : entry.name;
      return label.toLowerCase().includes(query);
    })
    .slice(0, 25)
    .map((entry) =>
      typeof entry === "string" ? { name: entry, value: entry } : entry,
    );

  safeSend({
    type: "autocomplete_response",
    requestId: data.requestId,
    choices,
  });
}
