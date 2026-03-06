# Release Notes

## Expressions, Status, Reliability and recovery improvements

This release hardens the Discord - SillyTavern bridge around image generation and queue recovery.

### `/image` improvements
- Added per-channel image request queuing so one stuck request does not block other channels.
- Added request IDs for image placeholder/result/error correlation.
- Added automatic timeout handling for image generation with a clear retry message.
- Added `/image cancel` support to cancel the bridge-side image request immediately so users can retry without restarting.

### Reaction / Expressions / Mood (new)
- Added extension setting `Expression/Reaction Mode` with three modes:
  - Off - No reaction / expression gets displayed
  - Discord Status Only (status) - Only changes the bot status to reflect reaction / expression
  - Discord status AND Show expression images (full) - Bot status + expression image updates
- The extension now watches SillyTavern's `#expression-image` and sends expression updates to the bridge.
- Discord activity now reflects the latest expression (with emoji for known default expressions).
- Optional expression-image posting sends updates to the most recently active Discord channel.
- Added `/mood <name>` command to fetch and post the current visible expression image on demand; in group chats, `name` can be provided for the currently visible member.
- Added lightweight per-character mood memory so `/mood <name>` can return the last seen mood for a group member when that member is not currently visible.
- Added `/reaction <mode>` command so expression mode can be changed remotely from Discord.
- Expression handling supports asynchronous reaction updates (text first, reaction afterwards) and missing expression blocks when expressions are disabled.

### Stability protections
- Added short-term image request throttling per channel.
- Added temporary protection after repeated failures (cooldown before accepting new image requests).
- Added runtime image pipeline counters surfaced via `/status`.

### Bridge hardening
- Added robust JSON parsing guards for websocket messages.
- Added timeout cleanup for stale "Generating image…" placeholders.
- Added per-channel queue task timeout protection to avoid queue deadlocks.

## Operability
- Added `/status` slash command to inspect connection and image pipeline health.
- Updated slash command definitions for `/image` behavior.
- Updated README.md command docs and end-user guidance.

## Test and validation additions
- Added Node.js tests for queue ordering and queue recovery after timeout (`server/queue.test.js`).
- Added `server` test script: `npm test` runs Node's built-in test runner.

## Notes for maintainers
- Queue timeout is now configured in `server/config.js` via `queueTaskTimeoutMs` (with sensible defaults and validation).
