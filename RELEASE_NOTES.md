# v1.3.0 Release Notes

## Expressions, Moods, Smarter Autocomplete and a Polished Experience

This release brings characters to life on Discord with expression and mood support, makes slash command autocomplete smarter and more reliable, and cleans up configuration so it's easier for everyone to set up.

### Reactions, Expressions and Mood (new)
- Added extension setting `Expression/Reaction Mode` with three modes:
  - **Off** - no reaction or expression gets displayed
  - **Discord Status Only** (`status`) - changes the bot's status to reflect the character's current expression
  - **Discord Status and Expression Images** (`full`) - bot status plus expression image updates posted to Discord
- The extension now watches SillyTavern's `#expression-image` and sends expression updates to the bridge automatically.
- Discord activity reflects the latest expression with matching emoji for all known default expressions.
- Added `/mood <name>` command to fetch and post the current visible expression image on demand; in group chats a character name can be provided.
- Added lightweight per-character mood memory so `/mood <name>` can return the last seen mood for a group member even when that member is not currently visible.
- Added `/reaction <mode>` command so expression mode can be changed remotely from Discord without touching SillyTavern.
- Expression handling supports asynchronous reaction updates (text arrives first, reaction follows) and gracefully handles missing expression blocks when expressions are disabled.

### Autocomplete fixes
- Fixed `/mood` and `/charimage` autocomplete not firing at all - caused by stale Discord slash command registration. Both commands now show their dropdown immediately when you open them, without needing to type a letter first.
- Fixed solo chat case for `/mood` and `/charimage`: when not in a group chat, the active character's name is now correctly offered as the only autocomplete choice.
- Fixed incorrect solo character lookup that used array indexing on `context.characters` instead of `find()`.

### Autocomplete sorting and display
- Character, group and group member autocomplete lists are now sorted alphabetically. Sorting ignores leading emoji and decorative characters so names like `🌟 Alice` sort naturally alongside plain names.
- `/switchchat` autocomplete now shows human-readable dates and times (e.g. `Finn - Feb 28, 2026, 15:59:02`) instead of the raw internal filename format, and is sorted newest-first so your most recent chats are always at the top.
- The raw filename is still sent as the selection value so SillyTavern loads the correct chat.

### `/image` improvements
- Added per-channel image request queuing so one stuck request does not block other channels.
- Added request IDs for image placeholder/result/error correlation.
- Added automatic timeout handling for image generation with a clear retry message.
- Added `/image cancel` support to cancel the bridge-side image request immediately so users can retry without restarting.

### Localisation
- Date and time formatting throughout the bridge (log timestamps and chat history autocomplete) now respects your configured `timezone` and `locale`.
- Added `locale` field to `config.example.js`. Defaults to `"en-US"`.
- Both `timezone` and `locale` are validated at startup - invalid values produce a clear warning and fall back gracefully rather than crashing at runtime.

### Configuration
- Timeout settings renamed from milliseconds to seconds for clarity:
  - `queueTaskTimeoutMs` → `queueTaskTimeoutSeconds` (e.g. `30`)
  - `imagePlaceholderTimeoutMs` → `imagePlaceholderTimeoutSeconds` (e.g. `180`)
- Added `/status` slash command to inspect connection and image pipeline health at a glance.

### Stability and hardening
- Added short-term image request throttling per channel.
- Added temporary cooldown after repeated image failures to prevent runaway retries.
- Added runtime image pipeline counters surfaced via `/status`.
- Added robust JSON parsing guards for WebSocket messages.
- Added timeout cleanup for stale "Generating image…" placeholders.
- Added per-channel queue task timeout protection to avoid queue deadlocks.

### Tests and validation
- Added `server` test script: `npm test` runs Node's built-in test runner.
- Added `server/queue.test.js` tests for queue ordering and queue recovery after timeout.
- Added `server/activity-format.js` to encapsulate expression normalization and activity string formatting and replaced the inlined logic in `server/discord.js` to call `formatBridgeActivity` instead.
- Added `server/activity-format.test.js` to cover normalization, known emoji mapping, unknown-expression fallback (`🎭`), and base-activity fallback for empty expressions.
- Added `server/config-logic.js` to encapsulate config defaults, derived ms fields, validation, and timezone/locale fallback behavior, and updated `server/config-loader.js` to use it while preserving exit-on-error behavior.
- Added `server/config-logic.test.js` to cover default values, millisecond derivation, validation failure paths, and timezone/locale fallback warnings, and kept existing `server/queue.test.js` unchanged.

## Notes for maintainers
- Autocomplete `choices` are now sent from the extension as `{name, value}` pairs rather than plain strings. `websocket.js` passes them straight through to Discord's `respond()` without remapping - the display label and the value ST receives on selection can now differ, which is used by the chat history list.
- Conversion from seconds to milliseconds for timeouts happens once in `config-loader.js`; `queue.js`, `websocket.js` and `queue.test.js` consume the internal `Ms`-suffixed values and required no changes. `queue.test.js` bypasses `config-loader.js` entirely and is unaffected by the rename.
- The `bridge_config` handshake packet now includes `locale` alongside `timezone`. The extension validates both using `Intl.DateTimeFormat` on receipt and falls back gracefully if either is absent or invalid.
- Slash command options for `/mood` and `/charimage` are now `required: true` - this is what causes Discord to fire the autocomplete interaction immediately on command invocation rather than waiting for user input.
