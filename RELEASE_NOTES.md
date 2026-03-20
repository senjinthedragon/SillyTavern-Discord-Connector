# v1.7.0 - Lost in Translation

## Added

### Multilingual support

The bot now speaks 13 languages. Set your preferred language in `config.js` with `userLocale` and every bot reply, command response, and error message will come back in that language. Works for the whole server out of the box - and individual users can override it for themselves with `/setlang`.

Supported languages: English, Dutch, German, French, Spanish, Portuguese (Brazil), Italian, Polish, Russian, Japanese, Korean, Chinese (Simplified), Chinese (Traditional).

The SillyTavern settings panel also translates itself to match whatever language ST is already running in, with no configuration needed.

**`/setlang <language>`** - Set your personal language preference. The bot will always reply to you in your chosen language no matter what the server default is. `/setlang clear` puts you back on the server default. Autocomplete shows the full list of available languages as you type - in your own language too, not just in English - or you can just type the name as a plain message if the slash command hasn't appeared in your client yet. Searching works in any language: typing `Deutsch`, `German`, or `德语` all find the same entry.

You can also pre-assign a language to specific users in `config.js` using `discordLanguageMap` (same format as `discordPersonaMap`) - useful if you know some users will always want a particular language without them needing to run `/setlang` themselves.

The bot also translates the 28 standard SillyTavern mood expressions (admiration, fear, joy, etc.) into your language. If the AI invents a mood that isn't on the standard list, it passes through as-is.

### Other additions

- `EXPRESSION_EMOJI_MAP` now supports multiple emoji variants per expression. When an expression has more than one plausible emoji (e.g. `desire`), one is picked at random each time for a bit of variety. Single-emoji expressions are unaffected.
- Added `server/plugin-i18n.js`: a shared factory that lets pro plugins load their own locale files independently of the core `locales/` folder. Each plugin can be distributed with its own `locales/` subfolder without depending on the core language files.

**(Pro Plugins)**

- Telegram and Signal are now fully localised. Both plugins ship all 13 supported languages in their own `locales/` subfolder. Expression labels, recap headers, and image error messages are all resolved through `userLocale` - the same locale configured for the rest of the bot.
- Added `/setlang` to Telegram's command menu so users can set their language preference directly from Telegram's `/` command picker.
- Telegram now sends a sticker from the `SillyTavern` sticker pack when an expression update has no character image. The pack is loaded at startup via `getStickerSet` and the emoji-to-sticker mapping is built automatically - no hardcoded IDs needed. If the pack cannot be loaded, expression updates fall back to text-only as before. The pack name can be overridden with `stickerPackName` in the plugin config block in `config.js`.

## Fixes

- The "Relay messages to all connected clients" toggle was visible in the extension settings even when no pro plugins were loaded. It appeared because the visibility check counted Discord itself as an active plugin. The section now correctly stays hidden unless Telegram or Signal are actually running.
- External plugins that don't implement `sendGeneratedImage` now log a warning at load time instead of silently dropping all generated images.
- The bridge now correctly rejects a missing, empty, or whitespace-only `discordToken` at startup rather than allowing it through config validation and failing later with an authentication error. Invalid `enabledPlugins` values now also produce the intended config error message instead of a raw `TypeError`.
- Image redirect handling now correctly resolves relative redirect URLs (e.g. `/cdn/image.png`) against the original host. Previously these were used as-is and the fetch would fail silently.

**(Pro Plugins)**

- Fixed image placeholder messages ("🎨 Generating image…") never appearing on Telegram or Signal. The placeholder was being sent to a method that didn't exist on those platforms, so it was silently dropped every time. Both plugins now forward it correctly as a regular text message.
- Telegram no longer renders transparent PNG images (expression emoji and character mood images) with a white background. PNG images are now composited onto a neutral gray (`#808080`) background before being uploaded, which looks acceptable on both light and dark Telegram themes.

- `/sthelp`, `/status`, and `/setlang` now respond correctly when SillyTavern is not running. Previously these commands were silently dropped if the WebSocket to ST was closed. `/sthelp` now returns a reduced list showing only the commands that work without ST. `/status` shows the current platform connection state with an offline note. `/setlang` continues to work in full since it only touches the server-side lang-map. The `/setlang` autocomplete is also available offline - it is served directly from the locales manifest on the bridge server without needing ST.
- The "Last exchange" recap title is now shown in your language, not the server default.
- The switch success message ("Switched to 'X'.") now correctly appears before the recap, not after it.
- Commands (e.g. `/charimage`) and image generation annotation messages no longer show up in the auto-recap or `/history` output.
- The "Finn feels X" mood message now appears in your language, matching the same per-user locale used everywhere else.
- `/mood` no longer posts a redundant "X feels Y" text message alongside the expression image. When an image is available, only the image is sent.
- `/continue` no longer produces an error message when SillyTavern is already generating. The duplicate call is silently ignored and the in-progress generation delivers its result as normal.
- The "🎨 Generating image…" placeholder now correctly appears in Discord while an image is being generated. It was silently dropped since the 1.7.0 localisation refactor due to a missing method in the Discord plugin wrapper.
- `/image` now reports an error within about a second when ComfyUI is not running, instead of waiting up to 5 minutes for the hard timeout to expire.
- `/note` and `/impersonate` no longer silently cut off your text at 200 characters. The limit is now 4096 characters and newlines are preserved. Only the pipe character `|` is stripped, as it can be used to chain unintended slash commands.
- Image generation error messages are now shown in your language (the same locale used for all other bot replies), not always in English.
