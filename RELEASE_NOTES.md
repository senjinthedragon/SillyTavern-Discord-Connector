# v1.7.0 - In Progress

## Fixes

### Cross-platform relay toggle no longer shown on free installs

The "Relay messages to all connected clients" toggle was visible in the extension settings even when no pro plugins were loaded. It appeared because the visibility check counted Discord itself as an active plugin. The section now correctly stays hidden unless Telegram or Signal are actually running.

---

# v1.6.0

## New

### Per-user persona mapping

The bridge can now automatically switch the active SillyTavern persona before processing each incoming message, based on who sent it.

**Two ways to set it up:**

- **Owner-configured** - add a `discordPersonaMap` object to `config.js` mapping Discord user IDs to persona names. Useful for assigning personas that users cannot change themselves.
- **User-configured** - users can run `/mypersona <name>` to save their own preference. Their saved choice takes priority over any entry in `config.js`. Run `/mypersona clear` to remove it.

Saved user preferences are stored in `server/persona-map.json` alongside your config. The file is created automatically on first save and is separate from `config.js` so bridge updates cannot overwrite it. The bridge logs a summary of loaded mappings on startup.

The `/mypersona` command autocompletes from your ST persona list and accepts unlisted names to create temporary personas, consistent with the existing `/persona` behaviour. On Telegram and Signal the same `/mypersona` command works identically once those plugins are active.

**Server manager controls:**

A new toggle in the extension settings panel - "Allow users to save their persona with /mypersona" - lets you disable user-managed preferences entirely. When off, `/mypersona` returns an error and the command is hidden from the `/sthelp` output. The toggle is on by default.

### Active persona shown in /status

The `/status` command now shows the currently active SillyTavern persona alongside the active character and group.

### Live countdown on the image generation placeholder

The `🎨 Generating image…` message in Discord now counts down in real time so you can always see how long is left before the request times out.

- While more than one minute remains, the message updates every 60 seconds: `🎨 Generating image… (4 minutes remaining; use /image cancel to abort)`
- During the final minute it switches to 10-second updates: `🎨 Generating image… (50 seconds remaining; use /image cancel to abort)`

The countdown runs server-side using the Discord message edit API - no extra extension packets required. It also cleans up correctly in all exit paths: the placeholder is deleted (and the countdown stopped) when the image arrives, when generation is cancelled via `/image cancel`, or when generation fails before the timeout. Previously the placeholder could be left stuck in the channel on cancel or failure.

### /image cancel now actually cancels

Previously, `/image cancel` removed the placeholder and stopped the countdown, but if the image finished generating anyway it would still pop up in the channel. Now it doesn't - the bridge marks the request as cancelled and silently discards any late-arriving result.

The timeout case is handled differently by design: if an image arrives after the bridge gave up waiting, it is still posted but with a brief note - "_(Image arrived after timeout)_" - so the user gets their image and the manager has a clear hint that `imagePlaceholderTimeoutSeconds` in `config.js` may need to be raised.

## Changes

### Expression cache cleared on switch

The mood snapshot cache (`expressionCache`) is now cleared whenever you switch character, group, or chat, and on `/newchat`. Previously it accumulated entries indefinitely and could serve a stale mood from a character active in a past session. Since every new chat starts fresh and the AI regenerates moods on load anyway, keeping old entries across switches has no benefit.

### `collectAndSendReplies` timing fix

`collectAndSendReplies` used a 100ms `setTimeout` after `GENERATION_ENDED` / `GROUP_WRAPPER_FINISHED` to wait for SillyTavern's chat array to settle before reading it. Checking the ST source confirmed this was unnecessary: by the time either event fires, ST has already fully written all messages to `context.chat` (during `onFinishStreaming`, which is awaited before the stop button is hidden). The timeout has been removed and the function is now called directly - no race, no arbitrary delay.

### `generateAndSendImage` async refactor

`generateAndSendImage` was using the `new Promise(async (resolve) => {...})` anti-pattern, where an unhandled error inside the async executor can silently swallow the rejection and leave the promise permanently pending. It has been refactored to a plain `async` function - the observer, timeout, and cancel job are set up synchronously, the `/sd` command is awaited in the function body, and the promise is returned at the end. Behaviour is identical; errors are now properly propagable.

### `index.js` split into focused modules

The 2400-line `index.js` has been broken up into nine focused ES modules under `src/`:

| Module | Responsibility |
|---|---|
| `ws.js` | WebSocket instance, `safeSend`, `getWs`/`setWs` |
| `settings.js` | Extension name, defaults, `getSettings`, `updateStatus` |
| `utils.js` | `sanitizeSlashArg` |
| `state.js` | Shared mutable state (`lastActiveChatId`, timezone, locale, plugins) |
| `image-relay.js` | Image classification, fetching, and forwarding to bridge |
| `expression-relay.js` | Expression cache, observer, snapshot helpers |
| `image-generation.js` | Circuit breaker, per-channel queue, `/sd` execution, metrics |
| `recap.js` | `buildLastExchange`, `buildHistory`, `scheduleRecap` |
| `commands.js` | All WebSocket message handlers and autocomplete |

`index.js` is now a thin orchestrator (~180 lines) responsible only for the WebSocket lifecycle and the settings UI. Behaviour is unchanged.

### `safeSend()` helper in the extension

All the repeated `if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({...})); }` blocks throughout `index.js` have been collapsed into a single `safeSend(payload)` helper. Same behaviour, ~15 fewer copies of the boilerplate.

### Telegram and Signal allow-list note in README

The Pro Plugins section of the README now calls out that Telegram and Signal plugins have no built-in user allow-list. This is intentional - they are designed for personal use where you control who has access. The note is there so anyone setting up a more open deployment knows to account for this.

## Fixes

### Slash command injection hardening

SillyTavern's slash command runner supports pipe chaining (`|`), meaning a crafted input like `hello | /newchat` would execute two commands instead of one. The original fix only covered persona names. A full audit found the same vulnerability in `/note`, `/impersonate`, and `/sd` prompts - all of which accept free-form user text that was being passed directly to the runner without sanitization.

The `sanitizePersonaName` helper has been renamed `sanitizeSlashArg` and is now applied to every point where user-supplied or externally-sourced text is interpolated into a slash command string. `/switchgroup` group names (from ST's own data, not user input) are also sanitized as an extra precaution.

### Cross-platform sync now works correctly

Two bugs were preventing the multi-platform sync from behaving as intended when `conversationLinks` is configured.

**What was broken:**

`getRoutes` had an early-return that checked for dynamically-registered routes first (platforms that had already sent a message this session). Once any platform sent a message, only that platform's route was returned, silently dropping AI replies, mood updates, and recap messages for every other platform in the conversation. A Discord user typing first would mean Telegram received nothing until the Telegram user also typed.

Additionally, user messages were only forwarded to SillyTavern - they were never echoed to the other platforms in the conversation, so a message sent on Discord was invisible on Telegram and Signal until the AI replied.

**What was fixed:**

- Dynamic routes and static config routes are now merged on every `getRoutes` lookup. All configured platforms receive fanout for every AI reply, mood update, and recap, regardless of whether they have sent a message this session.
- User messages are now cross-relayed to all other platforms in the same conversation immediately when they arrive, labelled with the sender's persona name - for example `Senjin: Hello there`. This keeps every connected client in sync in real time. The label is resolved from the `/mypersona` mapping if set, otherwise from the active ST persona sent by the extension on connect, otherwise `[platform]` as a last resort.
- Discord messages are now included in the cross-relay. Previously Discord sent messages directly to SillyTavern without echoing them to Telegram or Signal.

### Signal UUID compatibility

Newer versions of `signal-cli-rest-api` identify senders by UUID rather than phone number in the `source` field of the WebSocket envelope. This caused `conversationLinks` lookups to silently fail - the UUID never matched the phone number in `signalChatId`, so Signal messages were routed in isolation regardless of how the config was set up.

The Signal plugin now reads `sourceNumber` (the E.164 phone number) first and only falls back to `source` if `sourceNumber` is absent. If you previously worked around this by putting a UUID in `signalChatId`, switch it back to the phone number - the plugin will now match it correctly.

If a platform message still doesn't match any `conversationLinks` entry, the server now logs a warning pointing to the mismatch so it is easy to spot.

### /status shows persona name

The `/status` command now shows your active persona's display name (e.g. `🎭 Senjin`) instead of its internal ID key.

### Other fixes

- Rapid successive `/switchchar`, `/switchgroup`, or `/switchchat` commands no longer send duplicate recap messages. Each call to `scheduleRecap` now cancels any previously pending listener before registering a new one.
- If a second SillyTavern tab connects while one is already active, the previous connection is now closed cleanly instead of being silently orphaned.
- Signal plugin's message deduplication set is now bounded to 2000 entries to prevent slow memory growth on long-running instances.
- The redundant stream session entry written by the router during streaming has been removed. The Discord plugin's per-channel stream key is now the sole owner of stream state; the router uses the final text directly from the `stream_end` packet payload, which is always authoritative.
- Fixed a memory leak where the per-conversation route table accumulated entries across the session and was never cleared. It is now reset when SillyTavern disconnects.
- Fixed the `client_info` packet (which carries your active persona name for cross-relay labels) being silently discarded when no conversation was active at connect time. The packet is now handled before the conversation-ID guard so the persona name is available from the very first message.
- `wssPort` is now validated at startup. Invalid values (non-integer, out of range) produce a clear error instead of a confusing socket error from Node. The port defaults to 2333 when not set in `config.js`.
- Browser-side image fetches in the extension now time out after 15 seconds. Previously a slow or unresponsive SillyTavern server could stall image forwarding indefinitely with no error.
- Tooltip info icons (`ⓘ`) in the extension settings panel now carry `role="button"` so screen readers and keyboard-only users can identify and activate them correctly.

### `imagePlaceholderTimeoutSeconds` now actually works

The `imagePlaceholderTimeoutSeconds` config option was validated at startup and documented correctly, but the value was never sent to the extension. The extension had its own hardcoded 3-minute constant that controlled both the real timeout timer and the `🎨 Generating image… (timeout: 3 minutes; …)` placeholder text, so changing the config had no effect at all.

The bridge now includes the configured value in the `bridge_config` handshake packet it sends to the extension on connect. The extension reads it and uses it in place of the hardcoded constant, so the timeout, the watchdog, the log message, and the placeholder text all reflect whatever you have set in `config.js`.

---

## Pro plugins

### Persona mapping on Telegram and Signal

Persona mapping now works on all three platforms. The `onUserMessage` and `onCommand` handlers in `websocket.js` now pass `userId`, `platform`, and a resolved `mappedPersona` (when a mapping exists) through to the extension - the same fields that Discord already sent. The config fallback in `persona-map.js` is now generic: it reads `config[platform + "PersonaMap"]`, so `telegramPersonaMap` and `signalPersonaMap` entries in `config.js` are picked up automatically alongside the existing `discordPersonaMap`.

- **Telegram** - the sender's numeric user ID (`msg.from?.id`) is used as the mapping key. In direct messages this matches the chat ID; in group contexts it correctly identifies the individual sender.
- **Signal** - the sender's phone number (`source`, e.g. `+31612345678`) is used as both the chat ID and the mapping key, consistent with how Signal identifies users.

`/mypersona` has been added to Telegram's registered bot command list so it shows up in the `/` menu. The `allowUserPersonaSave` toggle in the extension settings applies to all platforms - one setting covers them all.

Owner-configured persona maps now use separate keys per platform in `config.js`: `discordPersonaMap`, `telegramPersonaMap`, and `signalPersonaMap`. All three are documented with examples in `config.example.js`.

### Cross-platform relay toggle

A new "Relay messages to all connected clients" toggle appears in the extension settings panel when at least one pro platform is active. Free users never see it.

- **On** (default) - a message typed on Discord, Telegram, or Signal is immediately forwarded to all other connected platforms in the same conversation, so every client stays in sync.
- **Off** - messages only go to the platform where they were typed. AI replies, mood updates, and recaps still reach all platforms; only user message relay is suppressed.

The setting takes effect immediately on toggle - no server restart required.

---

## Thanks

A special thanks to **Themysterycat** on Discord for suggesting the persona mapping feature that inspired everything in this section. Great idea!
