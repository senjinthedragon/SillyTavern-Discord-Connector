// index.js
// Destructure only the properties that actually exist on the object returned by getContext()
const {
  extensionSettings,
  deleteLastMessage, // Import the function for deleting the last message in chat
  saveSettingsDebounced, // Import the debounced settings save function
} = SillyTavern.getContext();
// Import all required public API functions from SillyTavern's core script
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
let ws = null; // Active WebSocket instance

// --- Utility Functions ---
function getSettings() {
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
  }
  return extensionSettings[MODULE_NAME];
}
function updateStatus(message, color) {
  const statusEl = document.getElementById("discord_connection_status");
  if (statusEl) {
    statusEl.textContent = `Status: ${message}`;
    statusEl.style.color = color;
  }
}
function reloadPage() {
  window.location.reload();
}
// ---
// Establishes a WebSocket connection to the bridge server
function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log("[Discord Bridge] Already connected.");
    return;
  }
  const settings = getSettings();
  if (!settings.bridgeUrl) {
    updateStatus("URL not set!", "red");
    return;
  }
  updateStatus("Connecting...", "orange");
  console.log(`[Discord Bridge] Connecting to ${settings.bridgeUrl}...`);
  ws = new WebSocket(settings.bridgeUrl);
  ws.onopen = () => {
    console.log("[Discord Bridge] Connection established!");
    updateStatus("Connected", "green");
  };
  ws.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);

      if (data.type === "user_message") {
        console.log("[Discord Bridge] Received user message.", data);

        // Create per-message state (kills race condition)
        const messageState = {
          chatId: data.chatId,
          isStreaming: false,
        };

        // Send typing indicator immediately
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "typing_action",
              chatId: messageState.chatId,
            }),
          );
        }

        // Inject user message
        await sendMessageAsUser(data.text);
        console.log(
          "[BRIDGE DEBUG] User message sent to ST, starting generation",
        );

        // Each character turn gets a unique stream session ID so server.js
        // can track their Discord messages independently without overwriting.
        let currentStreamId = null;
        let currentCharacterName = null;

        // Stream forwarding callback — fires on every token during generation
        const streamCallback = (cumulativeText) => {
          if (!currentStreamId) return; // no active session yet, skip
          messageState.isStreaming = true;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "stream_chunk",
                chatId: messageState.chatId,
                streamId: currentStreamId,
                characterName: currentCharacterName, // null in solo, name in group
                text: cumulativeText,
              }),
            );
          }
        };

        // Register stream listener
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

        // sendStreamEnd: finalises the current character's streaming message.
        // In GROUP chat: sends stream_end so server.js deletes the stream message
        //   and reposts it clean (no [edited] marker) with the character's name.
        // In SOLO chat: sends stream_end WITHOUT delete/repost — the final debounce
        //   edit IS the message, and we don't want a name header on solo messages.
        const sendStreamEnd = () => {
          if (
            messageState.isStreaming &&
            currentStreamId &&
            ws &&
            ws.readyState === WebSocket.OPEN
          ) {
            const ctx = SillyTavern.getContext();
            const isGroup = !!ctx.groupId;
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

        // collectAndSendReplies: walks the chat array backwards from the end,
        // collecting all consecutive non-user messages, and sends them as the
        // final ai_reply payload. Works for both solo (1 message) and group (N).
        const collectAndSendReplies = () => {
          if (!messageState.chatId || !ws || ws.readyState !== WebSocket.OPEN)
            return;
          const context = SillyTavern.getContext();
          const chat = context.chat;
          if (!chat || chat.length < 2) return;

          const aiMessages = [];
          for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg.is_user) break;
            if (msg.mes && msg.mes.trim()) {
              aiMessages.unshift({
                name: msg.name || "",
                text: msg.mes.trim(),
              });
            }
          }

          if (aiMessages.length > 0) {
            console.log(
              "[BRIDGE DEBUG]",
              aiMessages.length,
              "AI message(s):",
              aiMessages
                .map((m) => `${m.name} (${m.text.length} chars)`)
                .join(", "),
            );
            ws.send(
              JSON.stringify({
                type: "ai_reply",
                chatId: messageState.chatId,
                messages: aiMessages,
              }),
            );
            console.log("[BRIDGE DEBUG] ai_reply sent");
          } else {
            console.warn("[WARN] No valid AI message found in chat array");
            ws.send(
              JSON.stringify({
                type: "error_message",
                chatId: messageState.chatId,
                text: "The wolf thought long... but his words stayed hidden. Try again, pet?",
              }),
            );
          }
        };

        // GENERATION_STARTED fires at the beginning of each character's turn.
        // Assign a fresh streamId so this character gets its own Discord message.
        const onGenerationStarted = () => {
          currentStreamId = `${messageState.chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          // Only capture character name in group chat — solo chat never shows names.
          const ctx = SillyTavern.getContext();
          currentCharacterName = ctx.groupId ? ctx.name2 || null : null;
          console.log(
            `[BRIDGE DEBUG] GENERATION_STARTED — streamId: ${currentStreamId}, character: ${currentCharacterName || "(solo)"}`,
          );
        };
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

        // GENERATION_ENDED fires once per character (including every turn in group chat).
        // We use it to close the current character's stream message on Discord so the
        // next character can start a fresh one. In solo chat this also triggers the
        // final ai_reply (group_wrapper_finished won't fire for solo).
        let generationCount = 0;
        const onGenerationEnded = () => {
          generationCount++;
          console.log(`[BRIDGE DEBUG] GENERATION_ENDED #${generationCount}`);
          sendStreamEnd(); // finalise this character's stream message on Discord

          // Detect solo vs group: in group chat, group_wrapper_finished fires after
          // all characters and will send the ai_reply. In solo chat it never fires,
          // so we send the ai_reply here after a short delay to ensure the chat array
          // is fully written before we read it.
          const context = SillyTavern.getContext();
          const isGroup = !!context.groupId;
          if (!isGroup) {
            console.log(
              "[BRIDGE DEBUG] Solo chat — sending ai_reply from GENERATION_ENDED",
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
            setTimeout(collectAndSendReplies, 100);
          }
        };
        eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

        // Use string fallback in case this key isn't exported in older ST versions
        const GROUP_WRAPPER_FINISHED =
          event_types.GROUP_WRAPPER_FINISHED ?? "group_wrapper_finished";

        // GROUP_WRAPPER_FINISHED fires once when ALL characters in a group have
        // finished. This is where we collect every character's reply and send the
        // full ai_reply array to Discord.
        const onGroupFinished = () => {
          console.log(
            "[BRIDGE DEBUG] GROUP_WRAPPER_FINISHED — collecting all replies",
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
          setTimeout(collectAndSendReplies, 100);
        };
        eventSource.on(GROUP_WRAPPER_FINISHED, onGroupFinished);

        // Full cleanup: remove ALL listeners and send stream_end if mid-stream.
        // Defined before onGenerationStopped (which calls it) but after all other
        // handlers so their const bindings are in scope when cleanup() runs.
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

        // GENERATION_STOPPED: user aborted — clean up and remove all listeners
        const onGenerationStopped = () => {
          console.log("[BRIDGE DEBUG] GENERATION_STOPPED — aborting");
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

        // Trigger generation
        try {
          const abortController = new AbortController();
          setExternalAbortController(abortController);
          await Generate("normal", { signal: abortController.signal });
        } catch (error) {
          console.error("[Discord Bridge] Generate error:", error);
          await deleteLastMessage();
          console.log("[Discord Bridge] Removed failed user message");

          const errorMessage = `Sorry, an error occurred while generating.\nYour last message retracted — try again.\n\nError: ${error.message || "Unknown"}`;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "error_message",
                chatId: messageState.chatId,
                text: errorMessage,
              }),
            );
          }

          cleanup();
        }

        return;
      }
      // --- System Command Handling ---
      if (data.type === "system_command") {
        console.log("[Discord Bridge] Received system command.", data);
        if (data.command === "reload_ui_only") {
          console.log("[Discord Bridge] Reloading UI...");
          setTimeout(reloadPage, 500);
        }
        return;
      }
      // --- Execute Command Handling ---
      if (data.type === "execute_command") {
        console.log("[Discord Bridge] Received command to execute.", data);

        // Send typing indicator for commands too
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: "typing_action", chatId: data.chatId }),
          );
        }

        let replyText = "Command execution failed, try again later.";
        const context = SillyTavern.getContext();
        let commandSuccess = false;

        try {
          switch (data.command) {
            case "new":
              await doNewChat({ deleteCurrentChat: false });
              replyText = "New chat started.";
              commandSuccess = true;
              break;

            case "listchars": {
              const characters = context.characters.filter(
                (char) => char.name && char.name.trim() !== "",
              ); // skip empty/unnamed
              if (characters.length === 0) {
                replyText = "No available characters found.";
              } else {
                replyText = "Available characters list:\n\n";
                characters.forEach((char, index) => {
                  replyText += `${index + 1}. /switchchar_${index + 1} - ${char.name}\n`;
                });
                replyText +=
                  "\nUse /switchchar_number or /switchchar character_name to switch.";
              }
              commandSuccess = true;
              break;
            }

            case "switchchar": {
              if (!data.args || data.args.length === 0) {
                replyText =
                  "Please provide character name or number. Usage: /switchchar <name> or /switchchar_number";
                break;
              }
              const targetName = data.args.join(" ");
              const characters = context.characters;
              const targetChar = characters.find((c) => c.name === targetName);
              if (targetChar) {
                const charIndex = characters.indexOf(targetChar);
                await selectCharacterById(charIndex);
                replyText = `Switched to character "${targetName}" successfully.`;
                commandSuccess = true;
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
              if (chatFiles.length > 0) {
                replyText = "Current character's chat history:\n\n";
                chatFiles.forEach((chat, index) => {
                  const chatName = chat.file_name.replace(".jsonl", "");
                  replyText += `${index + 1}. /switchchat_${index + 1} - ${chatName}\n`;
                });
                replyText +=
                  "\nUse /switchchat_number or /switchchat chat_name to switch.";
              } else {
                replyText = "No chat history for current character.";
              }
              commandSuccess = true;
              break;
            }

            case "switchchat": {
              if (!data.args || data.args.length === 0) {
                replyText =
                  "Please provide chat name. Usage: /switchchat <chat_name>";
                break;
              }
              const targetChatFile = data.args.join(" ");
              try {
                await openCharacterChat(targetChatFile);
                replyText = `Loaded chat: ${targetChatFile}`;
                commandSuccess = true;
              } catch (err) {
                console.error(err);
                replyText = `Failed to load chat "${targetChatFile}". Make sure the name is exact.`;
              }
              break;
            }

            case "help":
              replyText =
                "Available commands:\n" +
                "/new - Start a new chat\n" +
                "/listchars - List all characters\n" +
                "/switchchar <name> or /switchchar_# - Switch to character\n" +
                "/listchats - List chat history for current character\n" +
                "/switchchat <name> or /switchchat_# - Load past chat\n" +
                "Tip: Use numbers from the lists for quick switches.";
              commandSuccess = true;
              break;

            default: {
              // Handle numbered shortcuts like switchchar_1, switchchat_2
              const charMatch = data.command.match(/^switchchar_(\d+)$/);
              if (charMatch) {
                const index = parseInt(charMatch[1]) - 1;
                const characters = context.characters.filter(
                  (char) => char.name && char.name.trim() !== "",
                );
                if (index >= 0 && index < characters.length) {
                  const targetChar = characters[index];
                  const charIndex = context.characters.indexOf(targetChar);
                  await selectCharacterById(charIndex);
                  replyText = `Switched to character "${targetChar.name}".`;
                  commandSuccess = true;
                } else {
                  replyText = `Invalid character number: ${index + 1}. Use /listchars to see options.`;
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
                  const targetChat = chatFiles[index];
                  const chatName = targetChat.file_name.replace(".jsonl", "");
                  try {
                    await openCharacterChat(chatName);
                    replyText = `Loaded chat: ${chatName}`;
                    commandSuccess = true;
                  } catch (err) {
                    console.error(err);
                    replyText = "Failed to load chat.";
                  }
                } else {
                  replyText = `Invalid chat number: ${index + 1}. Use /listchats to see options.`;
                }
                break;
              }

              replyText = `Unknown command: /${data.command}. Try /help for available commands.`;
            }
          }
        } catch (error) {
          console.error("[Discord Bridge] Command execution error:", error);
          replyText = `Error executing command: ${error.message || "Unknown error"}`;
        }

        // Send command result back to Discord
        if (ws && ws.readyState === WebSocket.OPEN) {
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
      console.error("[Discord Bridge] Request processing error:", error);
      if (data && data.chatId && ws && ws.readyState === WebSocket.OPEN) {
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
    console.log("[Discord Bridge] Connection closed.");
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
  if (ws) {
    ws.close();
  }
}
// Entry point — runs when the extension is loaded by SillyTavern
jQuery(async () => {
  console.log("[Discord Bridge] Attempting to load settings UI...");
  // <--- GLOBAL DEBUG LISTENERS GO HERE --->
  eventSource.on(event_types.GENERATION_STARTED, () => {
    console.log("[BRIDGE DEBUG] GENERATION_STARTED fired");
  });
  eventSource.on(event_types.STREAM_TOKEN_RECEIVED, (token) => {
    console.log(
      "[BRIDGE DEBUG] STREAM_TOKEN_RECEIVED - token length:",
      token?.length || 0,
    );
  });
  // <--- END GLOBAL DEBUG LISTENERS --->
  try {
    // Load and inject the settings panel HTML into SillyTavern's extension settings area
    const settingsHtml = await $.get(
      `/scripts/extensions/third-party/${MODULE_NAME}/settings.html`,
    );
    $("#extensions_settings").append(settingsHtml);
    console.log("[Discord Bridge] Settings UI successfully injected.");
    const settings = getSettings();
    // Populate UI fields with saved settings
    $("#discord_bridge_url").val(settings.bridgeUrl);
    $("#discord_auto_connect").prop("checked", settings.autoConnect);
    // Persist bridge URL changes as the user types
    $("#discord_bridge_url").on("input", () => {
      const settings = getSettings();
      settings.bridgeUrl = $("#discord_bridge_url").val();
      saveSettingsDebounced();
    });
    // Persist auto-connect toggle changes
    $("#discord_auto_connect").on("change", () => {
      const settings = getSettings();
      settings.autoConnect = $("#discord_auto_connect").prop("checked");
      saveSettingsDebounced();
    });
    $("#discord_connect_button").on("click", connect);
    $("#discord_disconnect_button").on("click", disconnect);
    // Automatically connect on load if the setting is enabled
    if (settings.autoConnect) {
      connect();
    }
    // Note: The GENERATION_ENDED listener is registered per-message inside the
    // user_message handler above, so it re-arms itself on every generation cycle.
  } catch (error) {
    console.error("[Discord Bridge] Failed to load settings UI:", error);
  }
});
