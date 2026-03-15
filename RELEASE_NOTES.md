# v1.5.0: Chat Recap, History, and Expression Attribution

This release adds two closely related features that solve the "where were we?" problem when switching between characters, groups, or older chats - and cleans up a long-standing ambiguity in how mood and expression updates are attributed in group sessions.

## Highlights

### Automatic Recap on Switch

Whenever `/switchchar`, `/switchgroup`, `/switchchat`, or their numbered variants succeed, the bridge now automatically posts the last complete exchange from the newly loaded chat - the last user message and all AI replies that followed it. This gives you immediate context without replaying the entire conversation.

On Discord the recap renders as a series of styled embeds with a `📜 Last exchange` header, visually distinct from live AI replies. On Telegram and Signal it arrives as plain text with the same header. The recap is sent asynchronously after `chatLoaded` fires, so the "Switched to X" confirmation always arrives first and the recap follows once SillyTavern has fully loaded the new chat.

For group chats the full last round is shown - the user message plus every AI reply that followed - since partial context would make it impossible to understand what happened. A soft cap of 10 AI messages per recap prevents flooding in very large groups, with a note pointing to `/history` if any were omitted.

### `/history [n]` Command

New command that posts the last `n` exchanges from the current chat, oldest first, using the same embed/plain-text rendering as the recap. Defaults to 5 exchanges if no argument is given. No upper cap - if a user asks for more exchanges than the chat contains, everything available is shown. Long messages are split at word boundaries so nothing overflows Discord's or Telegram's message size limits.

Added to Discord as a native slash command with an optional integer argument. Added to Telegram's registered command list. Listed in `/sthelp`.

### Character Names on Mood and Expression Updates

In both status and full expression mode it was previously unclear which character a mood update belonged to, particularly in group chats where each character emotes independently and the updates can arrive between or after messages from different characters.

The Discord activity string now reads `😯 surprise (Finn)` instead of just `😯 surprise`. The name is appended in parentheses so the emoji and mood word stay at the front and remain visible even when names are long or decorated with special characters - if the name gets clipped by Discord's character limit, the important part is already visible.

In full mode, a `_Finn feels surprise_` line is posted to the channel immediately before the expression image, rendered in italics so it reads as stage direction rather than dialogue. On Telegram and Signal the mood message changes from `Mood: surprise` to `Finn feels surprise`. All three fall back gracefully to the existing nameless format if no owner name is available.

## Fixes

- Added `/listpersonas` to `/sthelp`. The functionality was there but we forgot to mention it in there.

## Security

- Added undici as an explicit direct dependency at ^6.24.0 to resolve Dependabot alerts.

## Implementation Notes

- New `buildLastExchange(chat)` helper in `index.js` walks `context.chat` backwards to extract the last user message and all trailing AI replies, with the group AI message cap applied here.
- New `buildHistory(chat, n)` helper collects the last `n` complete exchanges oldest-first. `n = 0` returns everything.
- New `scheduleRecap(chatId)` registers a one-shot `chatLoaded` listener immediately before triggering a switch, scoping it tightly to the load we just caused. Reads `context.chat` once the event fires and sends a `recap_message` packet.
- New `recap_message` packet type handled in `websocket-router.js`, fanned out to `sendRecap` on each registered frontend plugin.
- `sendRecap(channelId, entries)` added to `server/discord.js`: iterates entries, splits each with `splitLongText` at 4000 chars, wraps every chunk in an `EmbedBuilder` embed with `setColor(0x5865f2)`. First embed gets the `📜 Last exchange` title.
- `sendRecap` added to `server/plugins/discord.js` wrapper, `plugins/telegram.js`, and `plugins/signal.js` for consistent cross-platform delivery.
- Discord `/history` command uses option type `INTEGER` (type 4) rather than STRING, so Discord validates the input client-side. The interaction arg filter in `discord.js` was broadened from `type === 3` only to `type === 3 || type === 4` to pass integer option values through to SillyTavern.
- User display name in recap entries is read directly from `msg.name` on `is_user` chat entries, which already contains the active persona name. No separate persona lookup required.
- `ownerName` added to `expression_update` packets in both the automatic update path (`sendExpressionUpdate`) and the `/mood` command path in `index.js`.
- `websocket-router.js` extracts `data.ownerName` and passes it to `setBridgeActivity` and as a fourth arg to `fanout` for `sendExpression`.
- `formatBridgeActivity` in `activity-format.js` accepts an optional third `ownerName` parameter and appends `(name)` to the activity string when present.
- `setBridgeActivity` and `sendExpression` in `server/discord.js` updated to accept `ownerName`. When posting in full mode with a name present, a `channel.send` call is enqueued before the image via the per-channel queue to guarantee ordering.
- `sendExpression` signature updated in `server/plugins/discord.js` wrapper, `plugins/telegram.js`, and `plugins/signal.js`.

## QA

- All 27 existing server tests pass.
- Recap and history tested manually across `switchchar`, `switchgroup`, `switchchat`, and their numbered variants.

## Note on Licensing

To better support the project's growth and maintain compatibility with SillyTavern's AGPL requirements, we have moved to a modular licensing structure. The core bridge remains open and free under MIT, while the extension is now AGPL. See the [README](README.md#license) for details.
