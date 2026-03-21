# v1.8.0 -

---

## v1.7.1 - Patch

Three bug fixes for issues found during post-release testing of v1.7.0.

## Fixes

- **"Discord activity only" mode was not updating the Discord activity.** The expression packet was sent with a null channel ID in this mode, so the server dropped it before the activity could be set. Fixed - the activity now updates correctly without posting anything to the channel.
- **Expression messages and image errors appeared in the wrong language after `/setlang clear`.** Clearing your language preference caused subsequent bot output to stay in the previously set language instead of switching back to the server default. Fixed.
- **A "Something went wrong and no response was found" error appeared in chat after every AI reply when using streaming.** SillyTavern commits the final message to the chat array slightly after firing the generation-ended event. The bridge was reading the chat at that moment, finding it empty, and sending an error - even though the streamed text had already arrived in Discord. Fixed - the error is suppressed when streaming delivered at least one token.
