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

        // Stream forwarding callback
        const streamCallback = (cumulativeText) => {
          messageState.isStreaming = true;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "stream_chunk",
                chatId: messageState.chatId,
                text: cumulativeText,
              }),
            );
          }
        };

        // Register stream listener
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

        // Cleanup function (removes listener, sends stream_end if needed)
        const cleanup = () => {
          eventSource.removeListener(
            event_types.STREAM_TOKEN_RECEIVED,
            streamCallback,
          );
          if (
            messageState.isStreaming &&
            ws &&
            ws.readyState === WebSocket.OPEN
          ) {
            ws.send(
              JSON.stringify({
                type: "stream_end",
                chatId: messageState.chatId,
              }),
            );
          }
          messageState.isStreaming = false;
        };

        // One-shot listeners for end/stop
        eventSource.once(event_types.GENERATION_ENDED, cleanup);
        eventSource.once(event_types.GENERATION_STOPPED, cleanup);

        // Main generation completion handler
        eventSource.once(event_types.GENERATION_ENDED, () => {
          console.log("[BRIDGE DEBUG] GENERATION_ENDED – reading chat array");

          if (!messageState.chatId || !ws || ws.readyState !== WebSocket.OPEN) {
            console.warn("[WARN] Message state invalid or WS closed");
            cleanup();
            return;
          }

          const context = SillyTavern.getContext();
          const chat = context.chat;

          if (!chat || chat.length < 2) {
            console.warn("[WARN] Chat too short – no reply possible yet");
            cleanup();
            return;
          }

          // Find last non-user message with content
          let lastAIMessage = null;
          for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg.is_user && msg.mes && msg.mes.trim()) {
              lastAIMessage = msg.mes.trim();
              console.log(
                "[BRIDGE DEBUG] Sending AI message from:",
                msg.name || "Unknown",
              );
              break;
            }
          }

          if (lastAIMessage) {
            console.log(
              "[BRIDGE DEBUG] AI reply found in chat. Length:",
              lastAIMessage.length,
            );
            console.log(
              "[BRIDGE DEBUG] Preview:",
              lastAIMessage.substring(0, 150) +
                (lastAIMessage.length > 150 ? "..." : ""),
            );

            ws.send(
              JSON.stringify({
                type: "ai_reply",
                chatId: messageState.chatId,
                text: lastAIMessage,
              }),
            );
            console.log("[BRIDGE DEBUG] ai_reply sent – clean delivery");
          } else {
            console.warn("[WARN] No valid AI message in chat array");
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "error_message",
                  chatId: messageState.chatId,
                  text: "The wolf thought long... but his words stayed hidden. Try again, pet?",
                }),
              );
            }
          }
        });

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
