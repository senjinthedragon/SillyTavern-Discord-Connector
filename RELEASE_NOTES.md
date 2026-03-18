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

## Fixes

### Persona name injection hardening

Persona names passed to SillyTavern's slash command runner are now sanitized before use. The runner supports pipe chaining (`|`), so a crafted name such as `Alice | /newchat` would have silently executed `/newchat` as a second command - allowing a Discord user to trigger arbitrary ST slash commands. Newlines carry the same risk. Pipe characters and newlines are now stripped and names are capped at 200 characters. The fix applies to `/persona`, `/mypersona`, and the automatic persona switch on incoming messages.

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
