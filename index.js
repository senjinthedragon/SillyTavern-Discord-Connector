/**
 * index.js - SillyTavern Discord Connector: Browser Extension
 *
 * Runs inside SillyTavern as a third-party extension. Bridges the SillyTavern
 * UI and the bridge server (server.js) over a WebSocket connection.
 *
 * Responsibilities:
 *   - Receives user messages from Discord (via the bridge) and injects them
 *     into SillyTavern as if typed by the user.
 *   - Hooks SillyTavern's generation lifecycle events to forward streaming
 *     tokens and final replies back to the bridge for posting on Discord.
 *   - Handles slash commands from Discord (/sthelp, /listchars, /switchchar, etc.)
 *     by interacting with SillyTavern's character and chat APIs.
 *
 * Autocomplete requests (get_autocomplete) are handled separately from normal
 * commands. The bridge sends a requestId and the list type ("characters",
 * "groups", or "chats"); the extension queries SillyTavern's live context,
 * filters by the user's partial input, and replies with autocomplete_response.
 * Chat lists require an async getPastCharacterChats call; all other lists are
 * read synchronously from context. Results are capped at 25 entries, which is
 * Discord's hard limit for autocomplete choices.
 *
 * To avoid redundant work on every keystroke, autocomplete results are cached.
 * Character and group lists use a 60-second TTL: they change infrequently but
 * unpredictably (a user may add one in the ST UI at any time), so a short
 * time-based expiry is the right fit. Chat lists are invalidated on specific
 * known events instead: newchat, switchchar, switchgroup, and their numbered
 * variants are the only operations that change which chats exist or which
 * character's chats should be shown. This means chat autocomplete is always
 * perfectly current without ever hitting disk more than once per relevant action.
 *
 * Streaming architecture:
 *   Each character turn is assigned a unique streamId at GENERATION_STARTED.
 *   STREAM_TOKEN_RECEIVED events forward cumulative text to the bridge, which
 *   throttles Discord edits to respect rate limits. When GENERATION_ENDED fires,
 *   a stream_end message tells the bridge to replace the streaming message with
 *   a clean final copy. Group chats include the character's name; solo chats do not.
 *
 * Listener hygiene:
 *   All per-message event listeners are registered inside the user_message
 *   handler and removed in every exit path (normal completion, stop, error)
 *   to prevent leaking across conversation switches or chat mode changes.
 */

const { extensionSettings, deleteLastMessage, saveSettingsDebounced } =
  SillyTavern.getContext();

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
} from "../../../../script.js";

import { executeSlashCommandsWithOptions } from "../../../../scripts/slash-commands.js";

const MODULE_NAME = "SillyTavern-Discord-Connector";

// Resolved once at load time. The string fallback covers older ST versions
// that don't export this event type by name.
const GROUP_WRAPPER_FINISHED =
  event_types.GROUP_WRAPPER_FINISHED ?? "group_wrapper_finished";
const DEFAULT_SETTINGS = {
  bridgeUrl: "ws://127.0.0.1:2333",
  autoConnect: true,
};

let ws = null;
let reconnectTimeout = null;
let heartbeatInterval = null;

// ---------------------------------------------------------------------------
// Autocomplete cache
//
// Caches the full (unfiltered) name lists used by autocomplete so that repeated
// keystrokes don't re-query SillyTavern's context or disk on every request.
//
// Character and group lists are cached with a time-to-live of
// AUTOCOMPLETE_CACHE_TTL_MS. They change infrequently - a user might add a
// character or group occasionally - so a 60-second window means at most a
// minute of staleness after a change made in the ST UI, which is acceptable.
//
// The chat list is not TTL-based. It is keyed by characterId (so switching
// characters automatically yields a cache miss) and is invalidated explicitly
// after any command that changes the chat state: newchat creates a new chat,
// switchchar and switchgroup change which character's chats are relevant, and
// their numbered variants do the same. This keeps the cache perfectly in sync
// with the bot's own actions without any TTL guesswork.
//
// Each entry: { names: string[], cachedAt: number }
// chatCache entry: { names: string[] }  (no TTL - invalidation is event-driven)
// ---------------------------------------------------------------------------

const AUTOCOMPLETE_CACHE_TTL_MS = 60_000;

const autocompleteCache = {
  characters: null, // { names: string[], cachedAt: number } | null
  groups: null, // { names: string[], cachedAt: number } | null
};

// Keyed by characterId so a character switch is automatically a cache miss.
const chatCache = {}; // { [characterId]: { names: string[] } }

/** Clears the chat cache for the currently selected character, or entirely
 *  if no character is selected. Called after any command that creates a new
 *  chat or changes which character is active. */
function invalidateChatCache() {
  const ctx = SillyTavern.getContext();
  if (ctx.characterId !== undefined) {
    delete chatCache[ctx.characterId];
  } else {
    // No character selected - wipe everything to be safe.
    for (const key of Object.keys(chatCache)) delete chatCache[key];
  }
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getSettings() {
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
  }
  return extensionSettings[MODULE_NAME];
}

function updateStatus(message, color) {
  const el = document.getElementById("discord_connection_status");
  if (el) {
    el.textContent = `Status: ${message}`;
    el.style.color = color;
  }
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connect() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

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
  ws = new WebSocket(settings.bridgeUrl);

  ws.onopen = () => {
    updateStatus("Connected", "green");
    console.log("[Discord Bridge] Connected to bridge server");

    // Start Heartbeat: Ping the server every 30 seconds to keep the connection alive
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 30000);
  };

  ws.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
      if (data.type === "heartbeat") return; // Ignore heartbeat responses

      // ------------------------------------------------------------------
      // user_message - a Discord user sent a message; generate a response.
      // ------------------------------------------------------------------
      if (data.type === "user_message") {
        // Per-message state object prevents race conditions between overlapping
        // requests (e.g. a slow generation and a fast follow-up message).
        const messageState = {
          chatId: data.chatId,
          isStreaming: false,
        };

        // Show the typing indicator in Discord immediately.
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "typing_action",
              chatId: messageState.chatId,
            }),
          );
        }

        await sendMessageAsUser(data.text);

        // Unique ID for this character's streaming session. Assigned fresh at
        // GENERATION_STARTED so each character in a group gets their own slot.
        let currentStreamId = null;
        let currentCharacterName = null;

        // Forward every cumulative token update to the bridge for throttled Discord edits.
        const streamCallback = (cumulativeText) => {
          if (!currentStreamId || ws?.readyState !== WebSocket.OPEN) return;
          messageState.isStreaming = true;
          ws.send(
            JSON.stringify({
              type: "stream_chunk",
              chatId: messageState.chatId,
              streamId: currentStreamId,
              characterName: currentCharacterName,
              text: cumulativeText,
            }),
          );
        };
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

        // Tell the bridge that this character's generation is done. The bridge
        // will delete the streaming message and repost it cleanly. In group chat
        // the character name is included so it can be shown as a bold header;
        // solo chat omits it.
        const sendStreamEnd = () => {
          if (
            messageState.isStreaming &&
            currentStreamId &&
            ws?.readyState === WebSocket.OPEN
          ) {
            const isGroup = !!SillyTavern.getContext().groupId;
            ws.send(
              JSON.stringify({
                type: "stream_end",
                chatId: messageState.chatId,
                streamId: currentStreamId,
                characterName: isGroup ? currentCharacterName : null,
              }),
            );
          }
          messageState.isStreaming = false;
          currentStreamId = null;
        };

        // Walk the chat array backwards to collect all consecutive AI messages
        // since the last user turn. Sends them as an ai_reply payload so the
        // bridge can post them on Discord (non-streaming path only).
        const collectAndSendReplies = () => {
          if (!messageState.chatId || ws?.readyState !== WebSocket.OPEN) return;
          const { chat } = SillyTavern.getContext();
          if (!chat || chat.length < 2) return;

          const aiMessages = [];
          for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg.is_user) break;
            if (msg.mes?.trim())
              aiMessages.unshift({
                name: msg.name || "",
                text: msg.mes.trim(),
              });
          }

          if (aiMessages.length > 0) {
            ws.send(
              JSON.stringify({
                type: "ai_reply",
                chatId: messageState.chatId,
                messages: aiMessages,
              }),
            );
          } else {
            ws.send(
              JSON.stringify({
                type: "error_message",
                chatId: messageState.chatId,
                text: "Something went wrong and no response was found. Try again?",
              }),
            );
          }
        };

        // Assign a new streamId at the start of each character's turn so the
        // bridge can maintain separate streaming messages per character.
        const onGenerationStarted = () => {
          currentStreamId = `${messageState.chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const ctx = SillyTavern.getContext();
          // Only capture the name in group chat; solo messages have no name header.
          currentCharacterName = ctx.groupId ? ctx.name2 || null : null;
        };
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

        // Fires once per character turn. Closes their stream message on Discord.
        // In solo chat (GROUP_WRAPPER_FINISHED never fires) also triggers the
        // final ai_reply after a brief delay to let the chat array settle.
        const onGenerationEnded = () => {
          sendStreamEnd();

          const isGroup = !!SillyTavern.getContext().groupId;
          if (!isGroup) {
            eventSource.removeListener(
              event_types.GENERATION_STARTED,
              onGenerationStarted,
            );
            eventSource.removeListener(
              event_types.GENERATION_ENDED,
              onGenerationEnded,
            );
            eventSource.removeListener(GROUP_WRAPPER_FINISHED, onGroupFinished);
            eventSource.removeListener(
              event_types.GENERATION_STOPPED,
              onGenerationStopped,
            );
            setTimeout(collectAndSendReplies, 100);
          }
        };
        eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

        // Fires once after all group members have finished. Collects all replies
        // and sends them as a single ai_reply payload.
        const onGroupFinished = () => {
          eventSource.removeListener(
            event_types.GENERATION_STARTED,
            onGenerationStarted,
          );
          eventSource.removeListener(
            event_types.GENERATION_ENDED,
            onGenerationEnded,
          );
          eventSource.removeListener(GROUP_WRAPPER_FINISHED, onGroupFinished);
          eventSource.removeListener(
            event_types.GENERATION_STOPPED,
            onGenerationStopped,
          );
          setTimeout(collectAndSendReplies, 100);
        };
        eventSource.on(GROUP_WRAPPER_FINISHED, onGroupFinished);

        // Removes all listeners and closes any open stream. Defined after all
        // handler consts so their bindings are in scope when this runs.
        const cleanup = () => {
          eventSource.removeListener(
            event_types.STREAM_TOKEN_RECEIVED,
            streamCallback,
          );
          eventSource.removeListener(
            event_types.GENERATION_STARTED,
            onGenerationStarted,
          );
          eventSource.removeListener(
            event_types.GENERATION_ENDED,
            onGenerationEnded,
          );
          eventSource.removeListener(GROUP_WRAPPER_FINISHED, onGroupFinished);
          eventSource.removeListener(
            event_types.GENERATION_STOPPED,
            onGenerationStopped,
          );
          sendStreamEnd();
        };

        // User aborted generation - clean up without sending a reply.
        const onGenerationStopped = () => {
          eventSource.removeListener(
            event_types.GENERATION_STARTED,
            onGenerationStarted,
          );
          eventSource.removeListener(
            event_types.GENERATION_ENDED,
            onGenerationEnded,
          );
          eventSource.removeListener(GROUP_WRAPPER_FINISHED, onGroupFinished);
          eventSource.removeListener(
            event_types.GENERATION_STOPPED,
            onGenerationStopped,
          );
          cleanup();
        };
        eventSource.once(event_types.GENERATION_STOPPED, onGenerationStopped);

        try {
          const abortController = new AbortController();
          setExternalAbortController(abortController);
          await Generate("normal", { signal: abortController.signal });
        } catch (error) {
          console.error("[Discord Bridge] Generation error:", error);
          await deleteLastMessage();

          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "error_message",
                chatId: messageState.chatId,
                text: `Generation failed. Your message was retracted - try again.\n\nError: ${error.message || "Unknown"}`,
              }),
            );
          }
          cleanup();
        }
        return;
      }

      // ------------------------------------------------------------------
      // system_command - internal signals from the bridge server.
      // ------------------------------------------------------------------
      if (data.type === "system_command") {
        if (data.command === "reload_ui_only") {
          setTimeout(() => window.location.reload(), 500);
        }
        return;
      }

      // ------------------------------------------------------------------
      // get_autocomplete - the bridge is asking for a live list to populate
      // a Discord autocomplete dropdown while the user is typing.
      //
      // data.list    "characters" | "groups" | "chats"
      // data.query   The partial string the user has typed so far. Used to
      //              filter results so the most relevant names appear first.
      //              An empty string returns all entries (up to 25).
      // data.requestId  Echoed back in the response so the bridge can match
      //              this reply to the correct parked interaction.
      //
      // Results are filtered case-insensitively against query and truncated
      // to 25 entries before sending, since Discord rejects any autocomplete
      // response with more than 25 choices.
      // ------------------------------------------------------------------
      if (data.type === "get_autocomplete") {
        let allNames = [];
        try {
          const context = SillyTavern.getContext();
          const now = Date.now();

          if (data.list === "characters") {
            // Serve from cache if fresh; otherwise rebuild from context and cache.
            if (
              autocompleteCache.characters &&
              now - autocompleteCache.characters.cachedAt <
                AUTOCOMPLETE_CACHE_TTL_MS
            ) {
              allNames = autocompleteCache.characters.names;
            } else {
              allNames = context.characters
                .map((c) => c.name)
                .filter((name) => name?.trim());
              autocompleteCache.characters = { names: allNames, cachedAt: now };
            }
          } else if (data.list === "groups") {
            // Same TTL-based strategy as characters.
            if (
              autocompleteCache.groups &&
              now - autocompleteCache.groups.cachedAt <
                AUTOCOMPLETE_CACHE_TTL_MS
            ) {
              allNames = autocompleteCache.groups.names;
            } else {
              allNames = (context.groups || [])
                .map((g) => g.name)
                .filter((name) => name?.trim());
              autocompleteCache.groups = { names: allNames, cachedAt: now };
            }
          } else if (data.list === "chats") {
            // Chat history is per-character, so the list is only meaningful
            // when a character is currently selected. If none is selected,
            // allNames stays empty and the dropdown will show nothing, which
            // is the correct behaviour - there is nothing to switch to.
            //
            // The chat cache is keyed by characterId so switching characters
            // is automatically a cache miss. Invalidation (via invalidateChatCache)
            // is triggered after newchat, switchchar, and switchgroup rather than
            // using a TTL, because those are the only operations that change
            // which chats exist or which character is active.
            if (context.characterId !== undefined) {
              if (chatCache[context.characterId]) {
                allNames = chatCache[context.characterId].names;
              } else {
                const chatFiles = await getPastCharacterChats(
                  context.characterId,
                );
                allNames = chatFiles
                  .map((c) => c.file_name.replace(".jsonl", ""))
                  .filter((name) => name?.trim());
                chatCache[context.characterId] = { names: allNames };
              }
            }
          }
        } catch (err) {
          // On any unexpected error, fall through with an empty choices array.
          // The bridge will respond to Discord with an empty dropdown rather
          // than timing out, which is a better user experience than a spinner.
          console.error("[Discord Bridge] Autocomplete error:", err);
        }

        // Filter the full cached list against the user's partial input and
        // truncate to 25. Filtering happens here (not at cache-build time) so
        // the cache always holds the complete list and any query can use it.
        const query = (data.query || "").toLowerCase();
        const choices = allNames
          .filter((name) => name.toLowerCase().includes(query))
          .slice(0, 25);

        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "autocomplete_response",
              requestId: data.requestId,
              choices,
            }),
          );
        }
        return;
      }

      // ------------------------------------------------------------------
      // execute_command - slash commands forwarded from Discord.
      // ------------------------------------------------------------------
      if (data.type === "execute_command") {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: "typing_action", chatId: data.chatId }),
          );
        }

        let replyText = "Command execution failed, try again later.";
        const context = SillyTavern.getContext();

        try {
          switch (data.command) {
            case "newchat":
              await doNewChat({ deleteCurrentChat: false });
              // A new chat has been created for the current character;
              // invalidate the chat cache so it is rebuilt on the next
              // autocomplete request.
              invalidateChatCache();
              replyText = "New chat started.";
              break;

            case "listchars": {
              const characters = context.characters.filter((c) =>
                c.name?.trim(),
              );
              replyText =
                characters.length === 0
                  ? "No available characters found."
                  : "Available characters:\n\n" +
                    characters
                      .map(
                        (c, i) => `${i + 1}. /switchchar_${i + 1} - ${c.name}`,
                      )
                      .join("\n") +
                    "\n\nUse /switchchar_number or /switchchar character_name to switch.";
              break;
            }

            case "switchchar": {
              if (!data.args?.length) {
                replyText = "Usage: /switchchar <name> or /switchchar_number";
                break;
              }
              const targetName = data.args.join(" ");
              const target = context.characters.find(
                (c) => c.name === targetName,
              );
              if (target) {
                await selectCharacterById(context.characters.indexOf(target));
                // Active character has changed; invalidate the chat cache so
                // switchchat autocomplete reflects the new character's history.
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
                      .map(
                        (g, i) => `${i + 1}. /switchgroup_${i + 1} - ${g.name}`,
                      )
                      .join("\n") +
                    "\n\nUse /switchgroup_number or /switchgroup group_name to switch.";
              break;
            }

            case "switchgroup": {
              if (!data.args?.length) {
                replyText = "Usage: /switchgroup <name> or /switchgroup_number";
                break;
              }
              const targetName = data.args.join(" ");
              const target = (context.groups || []).find(
                (g) => g.name === targetName,
              );
              if (target) {
                await executeSlashCommandsWithOptions(`/go ${target.name}`);
                // Active group has changed; invalidate the chat cache so
                // switchchat autocomplete reflects the new context.
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
              const chatFiles = await getPastCharacterChats(
                context.characterId,
              );
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
                replyText = "Usage: /switchchat <name>";
                break;
              }
              const targetChatFile = data.args.join(" ");
              try {
                await openCharacterChat(targetChatFile);
                replyText = `Loaded chat: ${targetChatFile}`;
              } catch {
                replyText = `Failed to load chat "${targetChatFile}". Check the name is exact.`;
              }
              break;
            }

            case "sthelp":
              replyText =
                "Available commands:\n" +
                "/sthelp - Show this help message\n" +
                "/newchat - Start a new chat\n" +
                "/listchars - List all characters\n" +
                "/switchchar <name> or /switchchar_# - Switch character\n" +
                "/listgroups - List all groups\n" +
                "/switchgroup <name> or /switchgroup_# - Switch group\n" +
                "/listchats - List chat history for current character\n" +
                "/switchchat <name> or /switchchat_# - Load a past chat";
              break;

            default: {
              // Handle numbered shortcuts: switchchar_1, switchchat_2, etc.
              const charMatch = data.command.match(/^switchchar_(\d+)$/);
              if (charMatch) {
                const index = parseInt(charMatch[1]) - 1;
                const characters = context.characters.filter((c) =>
                  c.name?.trim(),
                );
                if (index >= 0 && index < characters.length) {
                  const target = characters[index];
                  await selectCharacterById(context.characters.indexOf(target));
                  // Active character has changed; invalidate the chat cache.
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
                const chatFiles = await getPastCharacterChats(
                  context.characterId,
                );
                if (index >= 0 && index < chatFiles.length) {
                  const chatName = chatFiles[index].file_name.replace(
                    ".jsonl",
                    "",
                  );
                  try {
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
                  await executeSlashCommandsWithOptions(
                    `/go ${groups[index].name}`,
                  );
                  // Active group has changed; invalidate the chat cache.
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

        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "ai_reply",
              chatId: data.chatId,
              text: replyText,
            }),
          );
        }
        return;
      }
    } catch (error) {
      console.error("[Discord Bridge] Message handling error:", error);
      if (data?.chatId && ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "error_message",
            chatId: data.chatId,
            text: "Internal error processing request.",
          }),
        );
      }
    }
  };

  ws.onclose = () => {
    updateStatus("Disconnected", "red");
    ws = null;

    // Stop Heartbeat
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    // Auto-reconnect logic
    const settings = getSettings();
    if (settings.autoConnect) {
      console.log("[Discord Bridge] Connection lost. Retrying in 5 seconds...");
      updateStatus("Reconnecting...", "orange");

      // Prevent multiple parallel reconnect loops
      if (!reconnectTimeout) {
        reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null;
          connect();
        }, 5000);
      }
    }
  };

  ws.onerror = (error) => {
    console.error("[Discord Bridge] WebSocket error:", error);
    updateStatus("Connection error", "red");
  };
}

function disconnect() {
  ws?.close();
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

    $("#discord_bridge_url").on("input", () => {
      getSettings().bridgeUrl = $("#discord_bridge_url").val();
      saveSettingsDebounced();
    });

    $("#discord_auto_connect").on("change", () => {
      getSettings().autoConnect = $("#discord_auto_connect").prop("checked");
      saveSettingsDebounced();
    });

    $("#discord_connect_button").on("click", connect);
    $("#discord_disconnect_button").on("click", disconnect);

    if (settings.autoConnect) connect();
  } catch (error) {
    console.error("[Discord Bridge] Failed to load settings UI:", error);
  }
});
