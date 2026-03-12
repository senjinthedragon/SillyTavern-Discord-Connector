# v1.5.0: Chat Recap and History

This release adds two closely related features that solve the "where were we?" problem when switching between characters, groups, or older chats.

## Highlights

### Automatic Recap on Switch
Whenever `/switchchar`, `/switchgroup`, `/switchchat`, or their numbered variants succeed, the bridge now automatically posts the last complete exchange from the newly loaded chat - the last user message and all AI replies that followed it. This gives you immediate context without replaying the entire conversation.

On Discord the recap renders as a series of styled embeds with a `📜 Last exchange` header, visually distinct from live AI replies. On Telegram and Signal it arrives as plain text with the same header. The recap is sent asynchronously after `chatLoaded` fires, so the "Switched to X" confirmation always arrives first and the recap follows once SillyTavern has fully loaded the new chat.

For group chats the full last round is shown - the user message plus every AI reply that followed - since partial context would make it impossible to understand what happened. A soft cap of 10 AI messages per recap prevents flooding in very large groups, with a note pointing to `/history` if any were omitted.

### `/history [n]` Command
New command that posts the last `n` exchanges from the current chat, oldest first, using the same embed/plain-text rendering as the recap. Defaults to 5 exchanges if no argument is given. No upper cap - if a user asks for more exchanges than the chat contains, everything available is shown. Long messages are split at word boundaries so nothing overflows Discord's or Telegram's message size limits.

Added to Discord as a native slash command with an optional integer argument. Added to Telegram's registered command list. Listed in `/sthelp`.

## Fixes
- Added `/listpersonas` to `/sthelp`. The functionality was there but we forgot to mention it in there.

## Implementation Notes

- New `buildLastExchange(chat)` helper in `index.js` walks `context.chat` backwards to extract the last user message and all trailing AI replies, with the group AI message cap applied here.
- New `buildHistory(chat, n)` helper collects the last `n` complete exchanges oldest-first. `n = 0` returns everything.
- New `scheduleRecap(chatId)` registers a one-shot `chatLoaded` listener immediately before triggering a switch, scoping it tightly to the load we just caused. Reads `context.chat` once the event fires and sends a `recap_message` packet.
- New `recap_message` packet type handled in `websocket-router.js`, fanned out to `sendRecap` on each registered frontend plugin.
- `sendRecap(channelId, entries)` added to `server/discord.js`: iterates entries, splits each with `splitLongText` at 4000 chars, wraps every chunk in an `EmbedBuilder` embed with `setColor(0x5865f2)`. First embed gets the `📜 Last exchange` title.
- `sendRecap` added to `server/plugins/discord.js` wrapper, `plugins/telegram.js`, and `plugins/signal.js` for consistent cross-platform delivery.
- Discord `/history` command uses option type `INTEGER` (type 4) rather than STRING, so Discord validates the input client-side. The interaction arg filter in `discord.js` was broadened from `type === 3` only to `type === 3 || type === 4` to pass integer option values through to SillyTavern.
- User display name in recap entries is read directly from `msg.name` on `is_user` chat entries, which already contains the active persona name. No separate persona lookup required.

## QA

- All 27 existing server tests pass.
- Recap and history tested manually across `switchchar`, `switchgroup`, `switchchat`, and their numbered variants.
