# v1.8.0 - Take Control

You can now delete and swipe messages directly from Discord, and optionally require a trigger prefix so the bot only responds when you address it.

## Added

- **`/delete [1-5]`** - Remove the last 1 to 5 messages from the chat. The bot messages disappear from Discord at the same time. Defaults to deleting 1 if you don't pass a number.
- **`/swipe`** - Delete the last AI response and generate a new one. The old message is gone from Discord before the new reply arrives. Not available in group chats.
- **Manual Discord deletion** - Deleting the most recent bot message directly in Discord (right-click > Delete Message) now removes the corresponding message from the SillyTavern chat automatically. Only the most recent tracked response triggers this - deleting older messages out of order has no effect on the ST side.
- **`triggerPrefix` config option** - When set, the bot ignores any message that does not begin with the configured prefix (e.g. `!`) and strips it before forwarding. Useful for group chats where players talk amongst themselves and only want the bot to respond when addressed directly. Any string works, including multi-byte unicode characters. When the prefix is active, `/delete` is capped at 1 to avoid removing non-prefixed messages that the bot never tracked. Disabled by default - no prefix is required out of the box.

## Fixed

- Patched lodash and undici npm advisory warnings. The remaining advisories are in `jimp`'s `file-type` dependency and cannot be resolved without a breaking downgrade.

**(Pro)**

- Telegram plugin now mirrors `/delete` and `/swipe` to Telegram. The last N bot messages are tracked per chat and removed via the Telegram Bot API when a deletion is requested. Signal does not support server-side message deletion; the ST chat is still updated but no Signal-side deletion occurs.

---

## v1.7.2 - Patch

## Added

- Added Bitcoin donation address as a privacy-friendly payment option. The address is now shown in the startup banner, support links, and `/sthelp` command across all 13 supported languages.
