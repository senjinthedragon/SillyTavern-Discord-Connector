# Release Notes

## Reliability and recovery improvements

This release hardens the Discord ↔ SillyTavern bridge around image generation and queue recovery.

### `/image` improvements
- Added per-channel image request queuing so one stuck request does not block other channels.
- Added request IDs for image placeholder/result/error correlation.
- Added automatic timeout handling for image generation with a clear retry message.
- Added `/image cancel` support.
  - Cancellation is now **best-effort**: the bridge attempts to stop generation in SillyTavern using common stop commands.
  - If the underlying image backend does not support remote stop, the bridge still cancels its own wait state so users can retry immediately.

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
- Updated README command docs and end-user guidance.

## Test and validation additions
- Added Node.js tests for queue ordering and queue recovery after timeout (`server/queue.test.js`).
- Added `server` test script: `npm test` runs Node's built-in test runner.

## Notes for maintainers
- Queue timeout is now configured in `server/config.js` via `queueTaskTimeoutMs` (with sensible defaults and validation).
