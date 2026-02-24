/**
 * index.js — SillyTavern Discord Connector: Browser Extension
 *
 * Runs inside SillyTavern as a third-party extension. Bridges the SillyTavern
 * UI and the bridge server (server.js) over a WebSocket connection.
 *
 * Responsibilities:
 *   - Receives user messages from Discord (via the bridge) and injects them
 *     into SillyTavern as if typed by the user.
 *   - Hooks SillyTavern's generation lifecycle events to forward streaming
 *     tokens and final replies back to the bridge for posting on Discord.
 *   - Handles slash commands from Discord (/help, /listchars, /switchchar, etc.)
 *     by interacting with SillyTavern's character and chat APIs.
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

const MODULE_NAME = "SillyTavern-Discord-Connector";
const DEFAULT_SETTINGS = {
  bridgeUrl: "ws://127.0.0.1:2333",
  autoConnect: true,
};

let ws = null;

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
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const settings = getSettings();
  if (!settings.bridgeUrl) {
    updateStatus("URL not set!", "red");
    return;
  }

  updateStatus("Connecting...", "orange");
  ws = new WebSocket(settings.bridgeUrl);

  ws.onopen = () => updateStatus("Connected", "green");

  ws.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);

      // ------------------------------------------------------------------
      // user_message — a Discord user sent a message; generate a response.
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

        // String fallback in case this event isn't exported in older ST versions.
        const GROUP_WRAPPER_FINISHED =
          event_types.GROUP_WRAPPER_FINISHED ?? "group_wrapper_finished";

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

        // User aborted generation — clean up without sending a reply.
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
                text: `Generation failed. Your message was retracted — try again.\n\nError: ${error.message || "Unknown"}`,
              }),
            );
          }
          cleanup();
        }
        return;
      }

      // ------------------------------------------------------------------
      // system_command — internal signals from the bridge server.
      // ------------------------------------------------------------------
      if (data.type === "system_command") {
        if (data.command === "reload_ui_only") {
          setTimeout(() => window.location.reload(), 500);
        }
        return;
      }

      // ------------------------------------------------------------------
      // execute_command — slash commands forwarded from Discord.
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
            case "new":
              await doNewChat({ deleteCurrentChat: false });
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
                replyText = `Switched to "${targetName}".`;
              } else {
                replyText = `Character "${targetName}" not found.`;
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

            case "help":
              replyText =
                "Available commands:\n" +
                "/new — Start a new chat\n" +
                "/listchars — List all characters\n" +
                "/switchchar <name> or /switchchar_# — Switch character\n" +
                "/listchats — List chat history for current character\n" +
                "/switchchat <name> or /switchchat_# — Load a past chat";
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

              replyText = `Unknown command: /${data.command}. Try /help for available commands.`;
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
  };

  ws.onerror = (error) => {
    console.error("[Discord Bridge] WebSocket error:", error);
    updateStatus("Connection error", "red");
    ws = null;
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
