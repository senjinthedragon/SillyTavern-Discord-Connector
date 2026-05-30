# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.8.1] - 2026-05-30

### Fixed

- Incoming Discord messages now automatically dismiss the Smart Memory away recap modal before processing. The recap overlay blocks SillyTavern's UI while visible, preventing the bot from responding when the user is away from their computer. Dispatching `smart_memory:dismiss_recap` at the start of the message handler clears the overlay as a silent side effect of the user interacting via Discord. If Smart Memory is not installed the dispatch is a no-op.

## [1.8.0] - 2026-04-04

### Added

- Added `/delete [1-5]` slash command. Removes the last 1 to 5 messages from the SillyTavern chat and mirrors the deletion to Discord by removing the corresponding bot messages from the channel. Defaults to 1 if no count is given. The count is capped at the number of messages actually in the chat. Not available in group chats for `/swipe`; see below.
- Added `/swipe` slash command. Deletes the last AI response from the SillyTavern chat and triggers a new generation. The Discord message is removed before the new reply arrives as a normal streamed response. Only available in solo chats.
- Manual Discord message deletion now mirrors back to SillyTavern. When the most recently tracked bot message in a channel is deleted by a user (right-click > Delete Message), the corresponding message is automatically removed from the ST chat. Deleting older messages out of order has no effect on the ST side. A ring buffer (50 messages per channel) tracks posted bot message IDs to enable the match.
- Added `triggerPrefix` config option. When set to a non-empty string, the bot ignores any Discord message that does not begin with that prefix, and strips it before forwarding to SillyTavern. Supports any string including multi-byte unicode characters. When active, `/delete` is capped at 1 message to avoid removing non-prefixed banter that was never tracked by the bot. Commented out in `config.example.js`; no prefix is required by default.
- Added `messages_deleted` WebSocket packet type (`extension → server`). Carries a `count` field indicating how many messages were removed. `websocket-router.js` fans this out to all platform frontends via `deleteRoleplayMessages(chatId, count)`.

### Fixed

- Updated `@discordjs/rest` to resolve an undici advisory in `discord.js`. Separately ran `npm audit fix` to patch lodash (code injection via `_.template`) and undici (unbounded decompression / WebSocket parsing) advisories in server dependencies. The remaining moderate-severity advisories are confined to `jimp`'s `file-type` dependency; no upstream fix is available without a breaking jimp downgrade.

**(Pro Plugins)**

- Telegram plugin now supports `deleteRoleplayMessages`. A 50-message ring buffer per chat tracks the `message_id` of every bot-sent text message. When a deletion is requested, the last N entries are removed from the buffer and deleted via the Telegram Bot API `deleteMessage` method. `sendText` now captures and stores the returned `message_id` from the API response.
- Signal plugin does not implement `deleteRoleplayMessages`. The fanout silently skips missing methods, so the SillyTavern chat is still updated but no Signal-side deletion occurs. Signal message deletion requires tracking API-returned timestamps which varies across signal-cli-rest-api versions.

## [1.7.2] - 2026-03-21

### Added

- Added Bitcoin donation address as a privacy-friendly payment option. The address is now shown in the startup banner, support links, and `/sthelp` output across all 13 supported languages.

## [1.7.1] - 2026-03-21

### Fixed

- Fixed expression mode set to "Discord activity only" never updating the Discord activity. The `expression_update` packet was sent with a null `chatId` in activity-only mode, which caused it to be dropped by the server before the activity update could run. `chatId` is now always included regardless of mode - no image is posted since the image field remains null in activity-only mode.
- Fixed expression messages and image generation errors appearing in the wrong language after a user clears their language preference with `/setlang clear`. When a user has no language preference, the server omits `userLocale` from the packet entirely. The bridge was treating the missing key as "keep the previous locale" rather than "use the server default". The locale is now reset to null (server default) when the key is absent.
- Fixed a spurious "Something went wrong and no response was found. Try again?" error appearing in Discord after an AI reply was already delivered via streaming. SillyTavern fires `GENERATION_ENDED` before the final message is committed to the chat array (`message_received` follows after). When the chat array appeared empty at that moment, the bridge sent a no-response error even though the streamed text had already reached Discord. The error is now suppressed whenever streaming delivered at least one token.

## [1.7.0] - 2026-03-20

### Added

- Full multilingual support for all user-facing bot output. Bot replies, command responses, error messages, and help text are now fully localised. Thirteen languages ship out of the box: English, Dutch, German, French, Spanish, Portuguese (Brazil), Italian, Polish, Russian, Japanese, Korean, Chinese (Simplified), and Chinese (Traditional). The server-side `server/i18n.js` module loads the configured locale at startup and provides a synchronous `t(key, vars)` helper used throughout the server codebase. The browser-side `src/i18n.js` module manages two separate string stores: one for Discord user-facing output and one for the SillyTavern settings panel UI.
- Added `userLocale` to `config.js` (BCP 47 language tag, e.g. `"ja-JP"`, `"nl-NL"`). Sets the language for all bot replies server-wide. Defaults to English if not set or if the locale file is not found. Separate from the existing `locale` setting, which controls date formatting only.
- The SillyTavern extension settings panel now follows SillyTavern's own active language automatically. At startup the extension detects ST's current locale via `getCurrentLocale()` and applies matching translations to all labels, tooltips, checkboxes, and button values in the settings UI using `data-i18n` attributes. Falls back to English on older ST builds that do not export `getCurrentLocale`.
- Added `/setlang <language>` slash command for per-user language switching. Each Discord user can set their own preferred language independently of the server-wide `userLocale`. `/setlang clear` resets to the server default. Autocomplete shows languages as "NativeName (LocalizedName)" - the name in the language's own script followed by its name in the user's currently active locale (e.g. "Deutsch (German)" when the user is in English mode, "Deutsch (Duits)" in Dutch mode). If both names are the same the native name is shown alone. Matching searches the full 13x13 grid of translated names, so typing `Deutsch`, `German`, `Duits`, or `德语` all resolve to the same language. If `/setlang` hasn't propagated in Discord yet (can take up to an hour for new commands), typing it as a plain `/setlang Japanese` message works immediately.
- Added `discordLanguageMap`, `telegramLanguageMap`, and `signalLanguageMap` to `config.example.js`. Owner-configured static per-user language assignments that apply without the user running `/setlang`. User-saved preferences via `/setlang` take priority over config entries.
- Added `server/lang-map.js`, modelled on `persona-map.js`. Manages per-user language mappings across two sources: the static config maps and a runtime `server/lang-map.json` updated by `/setlang`. Written atomically on every save. `server/lang-map.json` is gitignored alongside `persona-map.json`.
- Added `server/locales-manifest.js`. Authoritative list of supported languages sent to the extension via `bridge_config` so the `/setlang` autocomplete always reflects exactly what locale files are available on the server.
- Per-user locale is now resolved per-request in `src/commands.js` using a new `getLocaleStrings(localeId)` / `makeT(strings)` pattern in `src/i18n.js`. Resolved locale strings are cached after the first fetch so repeated requests from the same user are cheap. Multiple users can receive replies in different languages within the same session without interfering with each other.
- `userLocale` is now injected into every `execute_command` and `user_message` packet leaving both `discord.js` and the plugin loader in `websocket.js`, so command replies and generation error messages all reach the user in their language.
- Replaced brittle text-sniffing placeholder detection in `discord.js` (`text.includes("🎨 Generating image")`) with a dedicated `sendImagePlaceholder()` function. `websocket-router.js` calls this explicitly for `image_placeholder` packets, keeping placeholder tracking correct regardless of the active language.
- Added `help.lang` to `/sthelp` output and a Language section to `COMMANDS.md` documenting `/setlang` and `/setlang clear`.

- Added translations for all 28 SillyTavern default GoEmotions expressions (`expr.*` keys) to all 13 locale files. When a known expression is reported by SillyTavern, the expression name in the mood message is translated into the active user's language. Unknown or custom expressions generated by the model pass through untranslated.
- `EXPRESSION_EMOJI_MAP` now supports multiple emoji variants per expression as an array. `formatBridgeActivity` picks one at random each time, so expressions with several plausible emoji (such as `desire`) produce a bit of variety rather than always the same symbol. Single-emoji expressions are unchanged.
- Added `server/plugin-i18n.js`: a lightweight i18n factory for plugins. `createPluginI18n(localesDir)` returns a `{ load, t }` instance bound to a caller-supplied `locales/` directory, with the same English-fallback and `{{variable}}` interpolation behaviour as the core `server/i18n.js`. Intended for pro plugins so each can ship and load its own locale files independently of the core `locales/` folder.

**(Pro Plugins)**

- Telegram and Signal plugins are now fully localised. Each plugin ships its own `locales/` subfolder with all 13 supported languages. User-facing strings - expression labels (`expr.feels`, `expr.mood`), recap header (`recap.header`), image error message (`image.unsupported`), and Signal's multi-image caption (`image.caption`) - are now resolved through `plugin-i18n.js` using the server's configured `userLocale` at plugin creation time.
- Added `/setlang` to Telegram's registered bot command list so it appears in Telegram's `/` command menu alongside the other bridge commands.
- Telegram plugin now sends a sticker from the `SillyTavern` sticker pack when an expression update has no character image. The pack is fetched via `getStickerSet` at startup and the emoji-to-file_id mapping is built from it automatically, so no sticker IDs need to be hardcoded. If the pack cannot be loaded, expression updates fall back to text-only as before. The pack name can be overridden with a `stickerPackName` key in the plugin config block in `config.js`.

### Fixed

- Fixed the "Relay messages to all connected clients" toggle appearing in the extension settings panel even when no pro plugins are loaded. The check was testing whether any plugin was active, which included Discord itself. The section now only shows when at least one non-Discord platform (Telegram, Signal) is actually running.
- Fixed external plugins that omit `sendGeneratedImage` loading silently and then dropping all generated images. The method is now included in the expected plugin interface check, so any plugin missing it logs a warning at load time.
- Fixed Discord token validation not catching a missing, empty, or whitespace-only `discordToken` when the Discord plugin is enabled. Only the literal placeholder string was rejected before; `undefined`, `null`, `""`, and `" "` would pass validation and cause a runtime authentication failure on startup. Also fixed `enabledPlugins` being read before it was validated as an array, which could produce a raw `TypeError` instead of the intended config error message.
- Fixed redirect handling in `fetchImageBuffer` not resolving relative redirect URLs. A redirect to a path like `/cdn/image.png` was used as-is, making it an invalid fetch target. Redirects are now resolved against the original URL before following.
- Fixed `/sthelp`, `/status`, and `/setlang` returning no response when SillyTavern is not connected. Commands were forwarded to ST via WebSocket and silently dropped when the socket was closed. These three commands are now handled server-side when ST is offline: `/sthelp` returns a reduced command list showing only what is available without ST, `/status` shows platform connection state and an offline note, and `/setlang` reads and writes the lang-map directly without requiring ST.
- Fixed `/image` waiting the full configured timeout (up to 5 minutes) when the image backend is unavailable. SillyTavern's `/sd` command does not throw when the backend is unreachable - it auto-corrects the null result to an empty string and returns normally. The bridge now checks whether an image appeared within 1 second of the command returning and sends an immediate error if not, instead of waiting for the hard timeout to fire.
- Fixed `/note` and `/impersonate` argument text being silently truncated at 200 characters. Both commands now use a dedicated `sanitizeNoteArg` that allows up to 4096 characters and preserves newlines (only the pipe character `|` is stripped as a command injection guard). The 200-character `sanitizeSlashArg` limit remains in place for short arguments such as persona names and language codes where a hard limit is appropriate.

**(Pro Plugins)**

- Fixed image placeholder messages ("🎨 Generating image…") never being sent on Telegram or Signal. The `image_placeholder` packet routes to `sendImagePlaceholder()`, which Telegram and Signal did not implement, causing the message to be silently dropped. Both plugins now implement `sendImagePlaceholder()` as an alias to `sendText`.
- Fixed Telegram rendering transparent PNG images (expression emoji and character mood images) with a white background. PNG images sent to Telegram are now composited onto a neutral gray (`#808080`) background before upload. Non-PNG images are unaffected. If the compositing step fails for any reason, the original image is sent as a fallback.

## [1.6.0] - 2026-03-19

### Added

- Added per-user persona mapping. The bridge can now automatically switch the active SillyTavern persona before processing each incoming message based on who sent it. Mappings are defined in two places: a static `discordPersonaMap` object in `config.js` (owner-managed) and a runtime `server/persona-map.json` file written by the new `/mypersona` command (user-managed). Runtime entries take priority over config entries. The persona map module logs a summary of loaded mappings on startup and handles a missing `persona-map.json` gracefully - the file is created on first save.
- Added `/mypersona <name>` slash command. Users can save their preferred persona so it switches automatically on every message without needing to run `/persona` each time. `/mypersona clear` removes the saved preference. Autocompletes from the ST persona list; accepts unlisted names to create temporary personas consistent with existing `/persona` behaviour.
- Added `discordPersonaMap`, `telegramPersonaMap`, and `signalPersonaMap` to `config.example.js` with inline documentation covering the owner-config/user-save priority model.
- Added `allowUserPersonaSave` toggle to the extension settings panel. When unchecked, `/mypersona` returns an error and the command is hidden from the `/sthelp` output. Defaults to enabled so existing installs are unaffected.
- Active persona is now shown in `/status` output as `🎭 PersonaName`.
- Added `userId` and `platform` fields to all `user_message` and `execute_command` packets sent from `discord.js` to the extension. These are used for persona map lookups and are echoed back in `save_user_persona` packets so the server knows which platform and user to associate the saved preference with.
- Added `save_user_persona` packet type (`extension → server`). Handled in `websocket-router.js` by calling `setPersonaForUser` directly - no fanout needed since persona persistence is a server-level concern rather than a per-platform one.
- The `🎨 Generating image…` placeholder message on Discord now counts down live. While more than one minute remains it updates every 60 seconds showing minutes left; during the final minute it switches to 10-second updates showing seconds left. The countdown is driven server-side using the Discord message edit API so no extra packets are needed. The placeholder is also now correctly deleted (and the countdown stopped) when generation is cancelled via `/image cancel` or fails before the timeout - previously the placeholder could be left stuck in the channel indefinitely.

**(Pro Plugins)**

- Persona mapping now works on Telegram and Signal. The `onUserMessage` and `onCommand` handlers in `websocket.js` now accept a `userId` parameter and include `userId`, `platform`, and `mappedPersona` (when a mapping exists) in the packets sent to the extension - the same fields Discord already sent. The `persona-map.js` config fallback is now generic: it checks `config[platform + "PersonaMap"]` for any platform rather than hardcoding `config.discordPersonaMap`, so `telegramPersonaMap` and `signalPersonaMap` in `config.js` are resolved automatically.
- Telegram plugin passes `msg.from?.id` as `userId` in both `onUserMessage` and `onCommand` calls. In direct messages this is the Telegram user's numeric ID; in group contexts it distinguishes individual senders from the group chat ID.
- Signal plugin passes `source` (the sender's phone number) as `userId` in both callback calls. For Signal this is the same value as `chatId` since Signal conversations are identified by phone number, but having it explicit in the packet keeps the persona-map contract consistent with the other platforms.
- Added `/mypersona` to Telegram's registered bot command list so it appears in Telegram's `/` command menu.
- Added `persona-map.test.js` with 11 tests covering the two-source merge logic, runtime-over-config priority, file persistence, ENOENT resilience, and empty-key cleanup. `websocket-router.test.js` extended with 3 tests for the `save_user_persona` packet path and 4 tests for the cancel/timeout image discard logic. `websocket-router.js` refactored to receive `setPersonaForUser`, `cancelledImageRequests`, and `timedOutImageRequests` via deps injection so they can be properly mocked in tests.

- `/image cancel` now truly prevents a late-arriving image from being posted. When the user cancels, the request ID is added to a `cancelledImageRequests` set on the bridge; if the image arrives after the fact, `generate_image_result` silently discards it. Likewise, images that arrive after a timeout are sent with a short note - "_(Image arrived after timeout - consider increasing `imagePlaceholderTimeoutSeconds` in config.js.)_" - so users still receive the image but the manager has a clear signal that the timeout is too short. Both sets self-expire after 30 minutes in the unlikely event the image never arrives. A `reason` field (`"cancelled"` | `"timed_out"` | `"failed"`) was added to `generate_image_error` packets so the bridge can distinguish between the three outcomes.

### Changed

- `index.js` (2400 lines) has been split into focused ES modules under `src/`: `ws.js` (WebSocket state and `safeSend`), `settings.js` (extension settings), `utils.js` (`sanitizeSlashArg`), `state.js` (shared mutable bridge state), `image-relay.js` (image fetching and forwarding), `expression-relay.js` (expression cache, observer, and snapshots), `image-generation.js` (circuit breaker, queue, and `/sd` execution), `recap.js` (chat history builders and `scheduleRecap`), and `commands.js` (all WebSocket message handlers). `index.js` is now a thin orchestrator (~180 lines) responsible only for the WebSocket lifecycle and the settings UI. All module imports use explicit `.js` extensions. Behaviour is unchanged.
- All `ws?.readyState === WebSocket.OPEN` + `ws.send(JSON.stringify(...))` guard-and-send call sites in `index.js` have been replaced with a `safeSend(payload)` helper. This removes roughly 15 copies of the same boilerplate and means the readyState check is enforced in one place.
- Added a note to the Pro Plugins section of `README.md` explaining that Telegram and Signal plugins have no built-in user allow-list, and are intended for personal or small-group use rather than publicly accessible bots.
- `expressionCache` is now cleared on every character, group, or chat switch, and on `/newchat`. Previously the cache grew without bound across the session and could serve stale mood snapshots from characters no longer active. Since each new chat starts fresh and the AI regenerates moods on load anyway, there is no value in keeping entries across switches.
- `generateAndSendImage` refactored from `new Promise(async (resolve) => {...})` to a plain `async` function using the deferred promise pattern. The Promise executor is now synchronous; `await executeSlashCommandsWithOptions(...)` runs in the async function body where errors cannot be silently swallowed by the executor.
- `collectAndSendReplies` no longer uses a 100ms `setTimeout` to wait for the chat array to settle after generation ends. Reading the SillyTavern source confirmed that by the time `GENERATION_ENDED` (solo) or `GROUP_WRAPPER_FINISHED` (group) fires, ST has already written all messages to `context.chat` - the delay was never needed. The function is now called directly, eliminating the theoretical race. The redundant `ws?.readyState !== WebSocket.OPEN` guard in the early-return was also removed since all sends go through `safeSend`.

### Fixed

- `sanitizePersonaName` has been renamed to `sanitizeSlashArg` and applied consistently to all user-supplied arguments before they are interpolated into slash command strings passed to `executeSlashCommandsWithOptions`. The original fix only covered persona names; `/note`, `/impersonate`, and `/sd` prompts were left unsanitized and vulnerable to the same pipe-chaining injection (`hello | /newchat`). `/switchgroup` group names (sourced from ST's own data rather than user input) are also now sanitized as defence in depth. The fix applies to every call site where user-controlled or externally-sourced text reaches the slash command runner.
- Rapid successive character/group/chat switches no longer stack up multiple `CHAT_LOADED` listeners that all fire on the same event and send duplicate recap messages. `scheduleRecap` now cancels any previously pending listener before registering a new one.
- A second SillyTavern WebSocket connection now cleanly closes the previous one with a reason code instead of silently orphaning it. The orphaned connection would have continued receiving no acknowledgements while the bridge routed everything to the new tab.
- Signal plugin's deduplication `seen` set is now capped at 2000 entries (oldest evicted first) to prevent unbounded memory growth on long-running instances.
- `imagePlaceholderTimeoutSeconds` now correctly controls both the actual generation timeout and the duration shown in the `🎨 Generating image…` placeholder message. Previously the value was validated and converted to milliseconds in `config-logic.js` but never forwarded to the extension, so the timeout always fired at the hardcoded 3-minute default regardless of what was set in `config.js`. The bridge now includes `imagePlaceholderTimeoutMs` in the `bridge_config` handshake packet, and the extension applies it to the live timer, the watchdog, the log message, and the placeholder text.
- Signal plugin now logs a clear actionable message when `signal-cli-rest-api` is unreachable (`ECONNREFUSED`), pointing to the Docker container as the likely cause. Previously the raw Node.js error was logged with no context.
- Cross-platform fanout now works correctly when platforms are configured via `conversationLinks`. `getRoutes` previously returned only dynamically-registered routes (platforms that had already sent a message this session) once any platform had spoken, shadowing all static config routes. This meant AI replies, mood updates, and recap messages would stop being delivered to platforms that hadn't sent a message yet. Dynamic routes and config routes are now merged on every lookup.
- User messages are now cross-relayed to all other platforms in the same `conversationLinks` conversation. When a message arrives on one platform it is forwarded to every other configured platform labelled with the sender's persona name (e.g. `Senjin: hello`) so all connected clients stay in sync in real time, not only after the AI replies. The label is resolved from the `/mypersona` mapping if set; otherwise it falls back to the active ST persona name sent by the extension on connect; otherwise `[platform]`.
- Discord's `messageCreate` handler now runs the same cross-relay loop as Telegram and Signal. Previously Discord messages were sent directly to SillyTavern without being echoed to other platforms.
- Added "Relay messages to all connected clients" toggle to the extension settings panel under a new Multi-platform section. The section is hidden for free users and only appears when at least one pro platform (Telegram, Signal) is reported active in the `bridge_config` handshake. When on (default), messages typed on one platform are immediately echoed to all others. When off, messages only reach the platform where they were typed. The setting takes effect immediately on toggle - no server restart required.
- The extension sends its active persona name to the server in a `client_info` packet immediately after the `bridge_config` handshake. The server uses this as the default cross-relay sender label so messages are correctly attributed without requiring `/mypersona` to be configured. The persona is resolved from `powerUserSettings.default_persona` first, falling back to `powerUserSettings.persona`.
- `/status` now shows the active persona's display name instead of its internal ID key.
- Signal plugin now prefers `sourceNumber` (E.164 phone number) over `source` when identifying the sender. Newer versions of `signal-cli-rest-api` set `source` to a UUID rather than a phone number, causing `conversationLinks` lookups to fail silently. Using `sourceNumber` ensures the value matches what is configured in `signalChatId`. If `sourceNumber` is absent the plugin falls back to `source` as before.
- `resolveConversationId` now logs a warning when `conversationLinks` are configured but no entry matches the incoming platform and chat ID, making format mismatches (phone number vs UUID, missing `+` prefix, etc.) immediately visible in the server log.
- `streamSessions` is no longer passed as a dependency to `handleBridgePacket` in `websocket.js`. The router stopped reading or writing it in the previous round; the reference in the `ws.close` cleanup loop is retained via the module import.
- `frontend-manager.test.js` deleted; its unique test ("accepts plugin-first config without discord token") was moved into `config-logic.test.js` where the rest of the config validation tests live. The duplicate test it contained was already covered.
- Removed the redundant stream session entry written by `websocket-router.js` during `stream_chunk`. The router previously wrote a bare `streamId` key to `streamSessions` as a `pendingText` cache; `stream_end` now reads `data.finalText` directly (always present and authoritative), making the cached copy unnecessary. The Discord plugin's `${channelId}:${streamId}` key remains the sole owner of stream state.
- All dependency accesses in `websocket-router.js` are now consistently destructured at the top of `handleBridgePacket`. Previously `cancelledImageRequests`, `timedOutImageRequests`, `setPersonaForUser`, `setCurrentPersonaName`, and `setCrossRelayEnabled` were accessed via `deps.xxx` while other deps were destructured, making it unclear which dependencies each code path needed.
- `wssPort` is now validated in `config-logic.js`. A missing value defaults to 2333; non-integers and out-of-range values (< 1 or > 65535) throw a clear startup error. Previously an invalid port produced a confusing OS-level socket error from `WebSocket.Server`.
- `getSettings()` in `src/settings.js` now merges `DEFAULT_SETTINGS` into `extensionSettings` only once (guarded by an `_initialized` flag). Previously the spread was repeated on every call, creating a new object reference each time.
- Fixed a memory leak where `routesByConversation` in `frontend-manager.js` accumulated entries for every conversation seen in a session and was never pruned. `clearRoutes()` is now called when the SillyTavern WebSocket connection closes, resetting the table for the next session.
- Fixed `client_info` packets (which carry the active persona name used as the cross-relay sender label) being silently discarded by the `if (!conversationId) return` guard in `websocket-router.js`. The handler is now placed before the guard so the persona name is stored on arrival regardless of whether a conversation is active.
- External plugins loaded via `config.externalPlugins` are now checked for the expected interface methods (`sendText`, `sendTyping`, `sendImages`, `sendExpression`, `streamChunk`, `streamEnd`, `sendRecap`) immediately after `createPlugin()` returns. Any missing methods are logged as a warning so misconfigured plugins surface clearly at load time.
- Browser-side image fetches in the extension (`image-relay.js`) now use a 15-second `AbortSignal` timeout. Previously a slow or unresponsive SillyTavern server could stall image forwarding indefinitely with no error or feedback.
- `sendLastMessageImages` call in `commands.js` now has a `.catch()` handler so a fetch or send failure during post-generation image scanning is logged rather than becoming an unhandled promise rejection.
- `safeSend` in `ws.js` now wraps `JSON.stringify` in a try-catch. A non-serialisable payload previously caused an unhandled exception that could crash the extension's send path silently.
- Tooltip info icons (`ⓘ`) in `settings.html` now carry `role="button"` so assistive technologies and keyboard-only users can identify and activate them correctly.

## [1.5.0] - 2026-03-15

### Added

- Added automatic chat recap on character, group, and chat switches. After a successful `/switchchar`, `/switchgroup`, `/switchchat`, or their numbered variants, the bridge waits for SillyTavern's `chatLoaded` event and then posts the last complete exchange from the newly loaded chat as a `recap_message` packet. On Discord this renders as styled embeds; on Telegram and Signal as plain text. Both use the persona name from `msg.name` on user entries - no separate persona lookup required.
- Added `buildLastExchange(chat)` helper to `index.js` that walks `context.chat` backwards to collect the last user message and all trailing AI replies. AI messages are soft-capped at 10 per recap for large groups, with a note pointing to `/history` if any were omitted.
- Added `scheduleRecap(chatId)` to `index.js` that registers a one-shot `chatLoaded` listener immediately before triggering a switch, scoping the listener tightly to the load just caused.
- Added `recap_message` packet type to `websocket-router.js`, fanned out via `sendRecap` on all registered frontend plugins.
- Added `sendRecap(channelId, entries)` to `server/discord.js`: splits each entry with `splitLongText` at 4000 chars and wraps each chunk in an `EmbedBuilder` embed (colour `0x5865f2`). First embed carries the `📜 Last exchange` title.
- Added `sendRecap` to `server/plugins/discord.js` wrapper, `plugins/telegram.js`, and `plugins/signal.js`.
- Added `/history [n]` command to `index.js` using new `buildHistory(chat, n)` helper. Collects the last `n` complete exchanges oldest-first (`n = 0` returns everything). Sends a `recap_message` packet directly - no `chatLoaded` wait needed since the current chat is already loaded. Defaults to 5 exchanges if no argument is given, no upper cap.
- Added `/history` to Discord slash commands as a native integer-option command (type 4). Broadened the interaction arg filter in `discord.js` from `type === 3` only to `type === 3 || type === 4` so integer option values reach SillyTavern.
- Added `/history` to Telegram's registered bot command list.
- Added `/history` to `/sthelp` output.
- Added `EmbedBuilder` to `discord.js` imports and `splitLongText` from `text-chunking.js`.

### Changed

- Expression and mood updates now include the character's name in all contexts. The Discord activity string changes from `😯 surprise` to `😯 surprise (Finn)`, with the name appended in parentheses so the emoji and mood word stay visible at the front even if the name is long or decorated. In full mode, a `_Finn feels surprise_` line is posted to the channel immediately before the expression image so it is always clear which character the mood belongs to. On Telegram and Signal the mood message changes from `Mood: surprise` to `Finn feels surprise`. Falls back to the existing nameless format when no owner name is available.
- `ownerName` is now included in `expression_update` packets sent by `index.js` (both the automatic update path and the `/mood` command path).
- `websocket-router.js` extracts `ownerName` from the packet and passes it to `setBridgeActivity` and all frontend plugins via `fanout`.
- `formatBridgeActivity` in `activity-format.js` accepts an optional `ownerName` parameter and appends it in parentheses when present.
- `setBridgeActivity` and `sendExpression` in `server/discord.js` updated to accept and use `ownerName`.
- `sendExpression` updated in `server/plugins/discord.js` wrapper, `plugins/telegram.js`, and `plugins/signal.js`.

### Fixed

- Added `/listpersonas` to `/sthelp`

### Security

- Added undici as an explicit direct dependency at ^6.24.0 to resolve Dependabot alerts.

### Note on Licensing

To better support the project's growth and maintain compatibility with SillyTavern's AGPL requirements, we have moved to a modular licensing structure. The core bridge remains open and free under MIT, while the extension is now AGPL. See the [README](README.md#license) for details.

## [1.4.0] - 2026-03-12

### Added

- Added plugin architecture primitives for frontend routing and packet fanout.
- Added websocket packet-flow integration tests with mocked frontends (`server/websocket-router.test.js`).
- Added optional per-plugin circuit breaker/backoff support in frontend fanout (`plugins.<name>.circuitBreaker`).
- Added `scripts/release-checklist.js` and `npm run release-checklist` for pre-release automation.
- Added `sendGeneratedImage` fanout path so expression images, character images and inline images never accidentally delete an image generation placeholder.
- Added active plugin status to the `bridge_config` handshake packet so the extension can display which frontends are loaded.
- Added platform status line to `/status` output showing each known platform as active 🟢, not loaded ⚫, or unhealthy 🔴.
- Added startup credits banner with version number, author, and support link.
- Added `/note` command to set or read the author's note for the current chat directly from Discord (or any connected platform).
- Added `/continue` command to trigger a proper AI continuation of the last message.
- Added `/impersonate` command to have the AI write your next response in character, with an optional guiding prompt.
- Added `/persona` command to switch your active SillyTavern persona by name, with live autocomplete populated from your defined personas. Typing an unlisted name creates a temporary persona on the fly.
- Added `/listpersonas` command to list all personas defined in SillyTavern.

### Changed

- Refactored bridge routing through a testable router layer (`server/websocket-router.js`).
- Kept Discord as the built-in free frontend and unbundled Telegram/Signal implementations for separate private/pro distribution.
- Added support for loading external frontend plugins via `config.externalPlugins`.
- Strengthened startup validation and reconnect cleanup behavior.
- Replaced bare `console.log` calls in `websocket.js` and `discord.js` with the timestamped `log()` function for consistent log formatting.
- Missing plugin files now log a concise "not found" message instead of a full Node.js require stack trace.
- Image generation placeholder message is now correctly deleted when the generated image arrives, regardless of other images (expressions, avatars, inline) arriving in the meantime.
- `config.example.js` reorganized into clearly labeled sections (Essential, General, Advanced) to make initial setup easier. Existing `config.js` files from v1.3.1 continue to work without changes.

### Fixed

- Alphabetical autocomplete sorting for character, group and group member lists was documented as a 1.3.0 feature but the sort function was missing from the released code.
- Solo chat character lookup in autocomplete used `find()` with an object id that no longer exists in recent SillyTavern versions; fixed to use direct array index.
- Browser-side image fetch limit raised from 8 MB to 50 MB so uncompressed images from local generators are no longer rejected before the server can compress them.

### Added _(Pro version only)_

- Telegram frontend plugin: inbound polling via `getUpdates`, outbound text, typing indicator, images, expressions, and streaming via final-text send.
- Telegram plugin registers bridge slash commands in the Telegram `/` command menu on startup.
- Signal frontend plugin: inbound message subscription via WebSocket (`signal-cli-rest-api` json-rpc mode), outbound text, images, and expressions.
- Signal plugin includes helper scripts (`start-signal-bridge.bat` / `.sh`) to spin up the required Docker container.
- Signal credentials and registration data are stored in `data/signal-data/` in the repo root, mounted as a Docker volume so data survives container restarts and rebuilds.

## [1.3.1] - 2026-03-06

### Fixed

- Reverted an unnecessary `npm audit fix --force` that had downgraded dependencies and broken the bridge.

## [1.3.0] - 2026-03-06

### Added

- Expression and mood support: the bot's Discord status now reflects the active character's current expression, with matching emoji for all known default expressions.
- `/mood <n>` command to post the current visible expression image on demand; remembers the last seen mood per character in group chats.
- `/reaction <mode>` command to change expression display mode remotely from Discord (`off`, `status`, `full`).
- Optional `full` expression mode that posts expression images to Discord automatically alongside status updates.
- `/status` command to inspect bridge connection health and image pipeline statistics.
- `/image cancel` to immediately cancel an active image generation request.
- Per-channel image request queuing so a stuck request in one channel never blocks another.
- Automatic timeout handling for image generation with a clear retry message when generation stalls.
- Autocomplete for `/mood` and `/charimage` - shows group members immediately when the command is opened, or the solo character's name in solo chat.
- `locale` config field for controlling date and time formatting in logs and chat history. Defaults to `"en-US"`.

### Changed

- All name-based autocomplete lists (characters, groups, group members) are now sorted alphabetically, with leading emoji and decorative characters ignored for sort order.
- `/switchchat` autocomplete now shows human-readable dates and times sorted newest-first, instead of raw filenames.
- `queueTaskTimeoutMs` renamed to `queueTaskTimeoutSeconds` - now accepts plain seconds (e.g. `30`).
- `imagePlaceholderTimeoutMs` renamed to `imagePlaceholderTimeoutSeconds` - now accepts plain seconds (e.g. `180`).
- Log timestamps now respect the configured `locale` instead of always using US formatting.
- `timezone` and `locale` are now validated at startup with a clear warning and graceful fallback if either is invalid.

### Fixed

- `/mood` and `/charimage` autocomplete was silently not firing due to stale Discord slash command registration.
- Solo chat character lookup in autocomplete was using array indexing instead of `find()`, always returning undefined.

## [1.2.5] - 2026-03-03

### Fixed

- Fixed npm publishing workflow.

## [1.2.4] - 2026-03-03

### Fixed

- Fixed npm publishing workflow.

## [1.2.3] - 2026-03-02

### Added

- Added keywords to `package.json` to improve discoverability on npm and GitHub.
- Fully implemented GitHub Actions for automated publishing to npm and GitHub Packages.
- Integrated `version-everything` to keep the extension manifest and server package version in sync.

### Fixed

- Minor typos in README and documentation.
- Repository structure cleaned up for local development.

## [1.2.1] - 2026-03-02

### Changed

- Reduced published package size from ~16 MB to ~28 KB by properly excluding `node_modules`, local config files, and development assets.
- Corrected package scope and registry configuration for GitHub Packages.
- Switched README images to absolute URLs so they render correctly outside of GitHub.

### Added

- Automated publishing via GitHub Actions on future releases.

## [1.2.0] - 2026-03-01

### Added

- `/image <prompt>` command for AI image generation with a live placeholder while generating.
- `/image` keyword shortcuts: `you`, `face`, `me`, `scene`, `last`, `raw_last`, `background`.
- `/charimage` command to post a character's avatar to Discord.
- Character greetings on `/newchat` are now automatically forwarded to Discord, including any images in the greeting. In group chat each member's greeting is sent in order.
- Images in AI replies are detected and forwarded to Discord after the reply text.
- Images exceeding Discord's 8 MB upload limit are automatically scaled down before sending.

### Changed

- Server code restructured from a single large file into focused modules: `server.js`, `client.js`, `discord.js`, `websocket.js`, `messaging.js`, `streaming.js`, `queue.js`, `logger.js`.

### Fixed

- Manual disconnect now works correctly when auto-reconnect is enabled - previously a deliberate disconnect could still trigger a reconnect.
- Streaming no longer breaks on responses exceeding 2000 characters - live updates now truncate with an ellipsis and the full text is posted correctly once generation finishes.

## [1.1.3] - 2026-02-26

### Added

- All bridge commands now register as native Discord slash commands and appear in the `/` menu automatically.
- Live autocomplete for `/switchchar`, `/switchgroup` and `/switchchat` - shows filtered results from your SillyTavern installation as you type.

### Changed

- The `applications.commands` OAuth2 scope is now required. Existing users can grant it by generating a new invite URL and opening it in a browser - no need to kick and re-invite the bot.

## [1.1.2] - 2026-02-26

### Fixed

- Fixed a compatibility issue where the bot would log in but not respond to messages on newer versions of Discord.js.
- Fixed a syntax error that caused crashes on Node.js v22 and higher.
- Windows `start-bridge.bat` launcher now automatically runs `npm install` if dependencies are missing.

## [1.1.1] - 2026-02-25

### Fixed

- Fixed syntax errors introduced at the end of the 1.1.0 release that prevented the extension from loading.
- Re-synced bridge server and extension logic to match intended 1.1.0 behavior.

## [1.1.0] - 2026-02-25

> Superseded by 1.1.1 within hours of release due to a syntax issue. See [1.1.1] above.

## [1.0.0] - 2026-02-25

### Added

- Initial release.
- Real-time AI response streaming from SillyTavern to Discord.
- Slash commands: `/switchchar`, `/switchgroup`, `/newchat`, `/listchars`, `/listgroups`, `/listchats`, `/switchchat`.
- `allowedUserIds` and `allowedChannelIds` config options to restrict bot access.
- Compatible with SillyTavern extensions including Vector Storage and Summarization.

---

[1.7.2]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.2.5...v1.3.0
[1.2.5]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.2.1...v1.2.3
[1.2.1]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/releases/tag/v1.0.0
