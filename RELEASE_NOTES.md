# v1.6.0 - In Progress

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
- User messages are now cross-relayed to all other platforms in the same conversation immediately when they arrive. Each relay is prefixed with `[platform]` so the origin is clear: `[discord] Hello there`. This keeps every connected client in sync in real time.

### Other fixes

- Rapid successive `/switchchar`, `/switchgroup`, or `/switchchat` commands no longer send duplicate recap messages. Each call to `scheduleRecap` now cancels any previously pending listener before registering a new one.
- If a second SillyTavern tab connects while one is already active, the previous connection is now closed cleanly instead of being silently orphaned.
- Signal plugin's message deduplication set is now bounded to 2000 entries to prevent slow memory growth on long-running instances.

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

---

## Thanks

A special thanks to **Themysterycat** on Discord for suggesting the persona mapping feature that inspired everything in this section. Great idea!
