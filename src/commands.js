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
import { sanitizeSlashArg, sanitizeNoteArg } from "./utils.js";
import { t, makeT, getLocaleStrings } from "./i18n.js";
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
  sharedState.lastActiveUserLocale = data.userLocale || sharedState.lastActiveUserLocale;

  // Resolve per-user locale so error messages reach the user in their language.
  // eslint-disable-next-line no-shadow
  const t = makeT(await getLocaleStrings(data.userLocale));

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
        text: t("reply.noResponse"),
      });
    }

    sendLastMessageImages(messageState.chatId).catch((err) =>
      console.warn("[Discord Bridge] sendLastMessageImages failed:", err),
    );
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
      text: t("reply.generationFailed", { message: error.message || "Unknown" }),
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
  sharedState.lastActiveUserLocale = data.userLocale || sharedState.lastActiveUserLocale;
  safeSend({ type: "typing_action", chatId: data.chatId });

  // Resolve per-user locale so command replies reach the user in their language.
  // eslint-disable-next-line no-shadow
  const t = makeT(await getLocaleStrings(data.userLocale));

  let replyText = null;
  const context = SillyTavern.getContext();

  try {
    switch (data.command) {
      case "newchat":
        await doNewChat({ deleteCurrentChat: false });
        clearExpressionCache();
        invalidateChatCache();
        captureAndSendIntroMessage(data.chatId);
        replyText = t("newchat.success");
        break;

      case "listchars": {
        const characters = context.characters.filter((c) => c.name?.trim());
        replyText =
          characters.length === 0
            ? t("listchars.empty")
            : t("listchars.list", {
                list: characters
                  .map((c, i) => `${i + 1}. /switchchar_${i + 1} - ${c.name}`)
                  .join("\n"),
              });
        break;
      }

      case "switchchar": {
        if (!data.args?.length) {
          replyText = t("switchchar.usage");
          break;
        }
        const targetName = data.args.join(" ");
        const target = context.characters.find((c) => c.name === targetName);
        if (target) {
          safeSend({ type: "ai_reply", chatId: data.chatId, text: t("switchchar.success", { name: targetName }) });
          scheduleRecap(data.chatId, data.userId, data.userLocale);
          await selectCharacterById(context.characters.indexOf(target));
          invalidateChatCache();
        } else {
          replyText = t("switchchar.notFound", { name: targetName });
        }
        break;
      }

      case "listgroups": {
        const allGroups = context.groups || [];
        replyText =
          allGroups.length === 0
            ? t("listgroups.empty")
            : t("listgroups.list", {
                list: allGroups
                  .map((g, i) => `${i + 1}. /switchgroup_${i + 1} - ${g.name}`)
                  .join("\n"),
              });
        break;
      }

      case "switchgroup": {
        if (!data.args?.length) {
          replyText = t("switchgroup.usage");
          break;
        }
        const targetName = data.args.join(" ");
        const target = (context.groups || []).find(
          (g) => g.name === targetName,
        );
        if (target) {
          safeSend({ type: "ai_reply", chatId: data.chatId, text: t("switchgroup.success", { name: targetName }) });
          scheduleRecap(data.chatId, data.userId, data.userLocale);
          await executeSlashCommandsWithOptions(
            `/go ${sanitizeSlashArg(target.name)}`,
          );
          invalidateChatCache();
        } else {
          replyText = t("switchgroup.notFound", { name: targetName });
        }
        break;
      }

      case "listchats": {
        if (context.characterId === undefined) {
          replyText = t("listchats.noChar");
          break;
        }
        const chatFiles = await getPastCharacterChats(context.characterId);
        replyText =
          chatFiles.length === 0
            ? t("listchats.empty")
            : t("listchats.list", {
                list: chatFiles
                  .map(
                    (c, i) =>
                      `${i + 1}. /switchchat_${i + 1} - ${c.file_name.replace(".jsonl", "")}`,
                  )
                  .join("\n"),
              });
        break;
      }

      case "switchchat": {
        if (!data.args?.length) {
          replyText = t("switchchat.usage");
          break;
        }
        const targetChatFile = data.args.join(" ");
        try {
          safeSend({ type: "ai_reply", chatId: data.chatId, text: t("switchchat.success", { name: targetChatFile }) });
          scheduleRecap(data.chatId, data.userId, data.userLocale);
          await openCharacterChat(targetChatFile);
        } catch {
          replyText = t("switchchat.fail", { name: targetChatFile });
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
            replyText = t("charimage.notFound", { name: targetName });
            break;
          }
          sendCharacterAvatar(data.chatId, target); // async, not awaited
          replyText = t("charimage.sending", { name: target.name });
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
            ? t("charimage.groupList", {
                list: memberNames.map((n) => `\u2022 ${n}`).join("\n"),
              })
            : t("charimage.groupEmpty");
        } else {
          if (
            ctx.characterId === undefined ||
            !ctx.characters?.[ctx.characterId]
          ) {
            replyText = t("charimage.noChar");
            break;
          }
          sendCharacterAvatar(data.chatId, ctx.characters[ctx.characterId]); // async, not awaited
          replyText = t("charimage.sending", {
            name: ctx.characters[ctx.characterId].name,
          });
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
              replyText = t("mood.noExprCached");
              break;
            }
            snapshot = cached;
            usedCachedSnapshot = true;
          } else {
            replyText = t("mood.noExpr");
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
              replyText = t("mood.wrongChar", {
                owner,
                expression: snapshot.expression,
                name: requestedName,
              });
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
          userLocale: data.userLocale || null,
        });

        const exprKey = `expr.${snapshot.expression}`;
        const translatedExpr =
          t(exprKey) !== exprKey ? t(exprKey) : snapshot.expression;
        const ownerPrefix = snapshot.ownerName
          ? t("mood.ownerPrefix", { name: snapshot.ownerName })
          : "";
        const cachedNote = usedCachedSnapshot ? t("mood.cachedNote") : "";
        if (!snapshot.image) {
          replyText = t("mood.noImage", {
            ownerPrefix,
            expression: translatedExpr,
            cachedNote,
          });
        }
        break;
      }

      case "reaction": {
        if (!data.args?.length) {
          replyText = t("reaction.usage");
          break;
        }

        const mode = String(data.args[0] || "")
          .trim()
          .toLowerCase();
        if (!EXPRESSION_MODE_VALUES.has(mode)) {
          replyText = t("reaction.invalid");
          break;
        }

        getSettings().expressionMode = mode;
        SillyTavern.getContext().saveSettingsDebounced();
        resetExpressionSignature();
        scheduleExpressionUpdate(data.chatId);

        const modeLabel =
          mode === "off"
            ? t("reaction.modeOff")
            : mode === "status"
              ? t("reaction.modeStatus")
              : t("reaction.modeFull");
        replyText = t("reaction.success", { mode: modeLabel });
        break;
      }

      case "image": {
        if (!data.args?.length) {
          replyText = t("image.usage");
          break;
        }

        const prompt = data.args.join(" ").trim();
        const lowerPrompt = prompt.toLowerCase();

        if (lowerPrompt === "cancel") {
          const cancelled = cancelActiveImageJob(data.chatId);
          replyText = cancelled
            ? t("image.cancelled")
            : t("image.nothingToCancel");
          break;
        }

        const breakerState = getBreakerState(data.chatId);
        if (breakerState) {
          recordBreakerRejected();
          const seconds = Math.ceil(
            (breakerState.openUntil - Date.now()) / 1000,
          );
          replyText = t("image.breakerOpen", { seconds });
          break;
        }

        const rateCheck = checkAndRecordRateLimit(data.chatId);
        if (!rateCheck.allowed) {
          replyText = t("image.rateLimited");
          break;
        }

        const requestId = makeImageRequestId();
        const timeoutMinutes = getImageGenerationTimeoutMs() / 60_000;

        safeSend({
          type: "image_placeholder",
          chatId: data.chatId,
          requestId,
          text: t("image.placeholder", { minutes: timeoutMinutes }),
        });

        // Queue and return early - generate_image_result/error sends its own packets.
        enqueueAndGenerateImage(data.chatId, requestId, prompt, data.userLocale || null);
        return;
      }

      case "continue": {
        // Fire the continuation and let the normal generation event handlers
        // (collectAndSendReplies, streaming) deliver the result. Sending a
        // separate replyText would duplicate or race against that output.
        // Guard against synchronous throws (e.g. ST already generating).
        try {
          executeSlashCommandsWithOptions("/continue").catch(() => {});
        } catch (_) {}
        break;
      }

      case "impersonate": {
        const impPrompt = sanitizeNoteArg(data.args?.[0] ?? "");
        await executeSlashCommandsWithOptions(
          impPrompt
            ? `/impersonate await=true ${impPrompt}`
            : "/impersonate await=true",
        );
        const impersonatedText = String($("#send_textarea").val()).trim();
        if (impersonatedText) {
          $("#send_textarea").val("").trigger("input");
          replyText = t("impersonate.suggestion", { text: impersonatedText });
        } else {
          replyText = t("impersonate.empty");
        }
        break;
      }

      case "listpersonas": {
        const personas = Object.values(
          SillyTavern.getContext().powerUserSettings?.personas ?? {},
        ).filter((n) => n?.trim());
        replyText =
          personas.length > 0
            ? t("listpersonas.list", {
                list: personas.map((n, i) => `${i + 1}. ${n}`).join("\n"),
              })
            : t("listpersonas.empty");
        break;
      }

      case "persona": {
        const personaName = sanitizeSlashArg(data.args?.[0] ?? "");
        if (!personaName) {
          replyText = t("persona.usage");
          break;
        }
        await executeSlashCommandsWithOptions(`/persona-set ${personaName}`);
        replyText = t("persona.success", { name: personaName });
        break;
      }

      case "mypersona": {
        if (!getSettings().allowUserPersonaSave) {
          replyText = t("mypersona.disabled");
          break;
        }
        const personaArg = sanitizeSlashArg(data.args?.[0] ?? "");
        if (!personaArg) {
          replyText = t("mypersona.usage");
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
          replyText = t("mypersona.cleared");
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
        replyText = t("mypersona.saved", { name: personaArg });
        break;
      }

      case "setlang": {
        const langArg = sanitizeSlashArg(data.args?.[0] ?? "");
        if (!langArg) {
          replyText = t("setlang.usage");
          break;
        }
        if (langArg.toLowerCase() === "clear") {
          safeSend({
            type: "save_user_lang",
            chatId: data.chatId,
            platform: data.platform || "discord",
            userId: data.userId || "",
            localeCode: null,
          });
          replyText = t("setlang.reset");
          break;
        }
        const langs = sharedState.availableLanguages || [];
        const lower = langArg.toLowerCase();
        const match = langs.find(
          (l) =>
            l.code?.toLowerCase() === lower ||
            l.name?.toLowerCase() === lower ||
            l.nativeName?.toLowerCase() === lower ||
            (Array.isArray(l.names) &&
              l.names.some((n) => n.toLowerCase() === lower)),
        );
        if (!match) {
          replyText = t("setlang.unknown", { input: langArg });
          break;
        }
        safeSend({
          type: "save_user_lang",
          chatId: data.chatId,
          platform: data.platform || "discord",
          userId: data.userId || "",
          localeCode: match.code,
        });
        replyText = t("setlang.success", {
          name: match.nativeName || match.name,
          code: match.code,
        });
        break;
      }

      case "note": {
        const noteText = sanitizeNoteArg(data.args?.[0] ?? "");
        if (noteText) {
          await executeSlashCommandsWithOptions(`/note ${noteText}`);
          replyText = t("note.success", { text: noteText });
        } else {
          const current =
            SillyTavern.getContext().chatMetadata?.note_prompt ?? "";
          replyText = current
            ? t("note.current", { text: current })
            : t("note.none");
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
              ? t("status.timeNow")
              : minutesAgo < 60
                ? t("status.timeMinutes", { m: minutesAgo })
                : minutesAgo < 1440
                  ? t("status.timeHours", {
                      h: Math.floor(minutesAgo / 60),
                      m: minutesAgo % 60,
                    })
                  : errorTime.toLocaleString();
          lastErrorText = t("status.lastError", {
            error: metrics.lastError,
            time: timeString,
          });
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

        const connStatus =
          getWs()?.readyState === WebSocket.OPEN
            ? t("status.online")
            : t("status.offline");

        const activeDisplay =
          activeGroup !== "(none)"
            ? t("status.activeGroup", { name: activeGroup })
            : activeCharacter !== "(none)"
              ? t("status.activeChar", { name: activeCharacter })
              : t("status.activeNone");

        const personaDisplay =
          activePersona !== "(none)"
            ? t("status.personaSet", { name: activePersona })
            : t("status.personaNone");

        const imageStatusDisplay = !breakerState
          ? t("status.imageReady")
          : t("status.imagePaused", {
              seconds: Math.ceil((breakerState.openUntil - Date.now()) / 1000),
            });

        const lines = [
          t("status.title"),
          t("status.connection", { value: connStatus }),
          t("status.plugins", { value: platformLine }),
          t("status.active", { value: activeDisplay }),
          t("status.persona", { value: personaDisplay }),
          "",
          t("status.imageGen"),
          t("status.imageStatus", { value: imageStatusDisplay }),
          t("status.imageQueue", {
            value: hasPendingImageQueue(data.chatId)
              ? t("status.imageQueuePending")
              : t("status.imageQueueEmpty"),
          }),
          t("status.imageGenerating", {
            value: hasActiveImageJob(data.chatId)
              ? t("status.imageGeneratingYes")
              : "-",
          }),
          "",
          t("status.stats"),
          t("status.statsLine1", {
            succeeded: metrics.succeeded,
            total: metrics.totalRequests,
          }),
          t("status.statsLine2", {
            failed: metrics.failed,
            timedOut: metrics.timedOut,
            rateLimited: metrics.rateLimited,
          }),
          t("status.statsLine3", {
            canceled: metrics.canceled,
            inFlight: metrics.inFlight,
            peak: metrics.maxConcurrentInFlight,
          }),
          t("status.statsLine4", {
            trips: metrics.breakerTrips,
            blocked: metrics.breakerRejected,
          }),
        ];
        if (lastErrorText) lines.push(lastErrorText);
        replyText = lines.join("\n");
        break;
      }

      case "sthelp": {
        const sections = [
          t("help.title"),
          t("help.info"),
          "",
          t("help.chars"),
          "",
          t("help.chats"),
          "",
          t("help.persona"),
          ...(getSettings().allowUserPersonaSave
            ? [t("help.persona.mypersona")]
            : []),
          "",
          t("help.convo"),
          "",
          t("help.expr"),
          "",
          t("help.image"),
          "",
          t("help.lang"),
          "",
          t("help.footer"),
        ];
        replyText = sections.join("\n");
        break;
      }

      case "history": {
        const { chat } = SillyTavern.getContext();
        const n = data.args?.length
          ? Math.max(0, parseInt(data.args[0]) || 0)
          : 5;
        const entries = buildHistory(chat, n);
        if (!entries) {
          replyText = t("history.empty");
          break;
        }
        safeSend({
          type: "recap_message",
          chatId: data.chatId,
          entries,
          ...(data.userId ? { userId: data.userId } : {}),
          ...(data.userLocale ? { userLocale: data.userLocale } : {}),
        });
        replyText = t("history.showing", { n: n > 0 ? n : t("history.all") });
        break;
      }

      default: {
        const charMatch = data.command.match(/^switchchar_(\d+)$/);
        if (charMatch) {
          const index = parseInt(charMatch[1]) - 1;
          const characters = context.characters.filter((c) => c.name?.trim());
          if (index >= 0 && index < characters.length) {
            const target = characters[index];
            safeSend({ type: "ai_reply", chatId: data.chatId, text: t("switchchar.success", { name: target.name }) });
            scheduleRecap(data.chatId, data.userId, data.userLocale);
            await selectCharacterById(context.characters.indexOf(target));
            invalidateChatCache();
          } else {
            replyText = t("switchchar.invalidIndex", { n: index + 1 });
          }
          break;
        }

        const chatMatch = data.command.match(/^switchchat_(\d+)$/);
        if (chatMatch) {
          if (context.characterId === undefined) {
            replyText = t("listchats.noChar");
            break;
          }
          const index = parseInt(chatMatch[1]) - 1;
          const chatFiles = await getPastCharacterChats(context.characterId);
          if (index >= 0 && index < chatFiles.length) {
            const chatName = chatFiles[index].file_name.replace(".jsonl", "");
            try {
              safeSend({ type: "ai_reply", chatId: data.chatId, text: t("switchchat.success", { name: chatName }) });
              scheduleRecap(data.chatId, data.userId, data.userLocale);
              await openCharacterChat(chatName);
            } catch {
              replyText = t("switchchat.failGeneric");
            }
          } else {
            replyText = t("switchchat.invalidIndex", { n: index + 1 });
          }
          break;
        }

        const groupMatch = data.command.match(/^switchgroup_(\d+)$/);
        if (groupMatch) {
          const index = parseInt(groupMatch[1]) - 1;
          const groups = context.groups || [];
          if (index >= 0 && index < groups.length) {
            safeSend({ type: "ai_reply", chatId: data.chatId, text: t("switchgroup.success", { name: groups[index].name }) });
            scheduleRecap(data.chatId, data.userId, data.userLocale);
            await executeSlashCommandsWithOptions(
              `/go ${sanitizeSlashArg(groups[index].name)}`,
            );
            invalidateChatCache();
          } else {
            replyText = t("switchgroup.invalidIndex", { n: index + 1 });
          }
          break;
        }

        replyText = t("unknown.cmd", { cmd: data.command });
      }
    }
  } catch (error) {
    console.error("[Discord Bridge] Command error:", error);
    const msg =
      error instanceof Error
        ? error.message
        : String(error ?? "Unknown error");
    replyText = t("cmd.error", { message: msg });
  }

  if (replyText) safeSend({ type: "ai_reply", chatId: data.chatId, text: replyText });
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
    } else if (data.list === "languages") {
      // Available languages come from the server via bridge_config.
      // Return all known names (every translation) so matching works regardless
      // of which language the user types in.
      allNames = (sharedState.availableLanguages || []).flatMap((l) =>
        Array.isArray(l.names) ? l.names : [l.name],
      );
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
