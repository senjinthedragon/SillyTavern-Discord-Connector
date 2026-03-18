# v1.6.0 - In Progress

## New

### Live countdown on the image generation placeholder

The `🎨 Generating image…` message in Discord now counts down in real time so you can always see how long is left before the request times out.

- While more than one minute remains, the message updates every 60 seconds: `🎨 Generating image… (4 minutes remaining; use /image cancel to abort)`
- During the final minute it switches to 10-second updates: `🎨 Generating image… (50 seconds remaining; use /image cancel to abort)`

The countdown runs server-side using the Discord message edit API - no extra extension packets required. It also cleans up correctly in all exit paths: the placeholder is deleted (and the countdown stopped) when the image arrives, when generation is cancelled via `/image cancel`, or when generation fails before the timeout. Previously the placeholder could be left stuck in the channel on cancel or failure.

## Fixes

### `imagePlaceholderTimeoutSeconds` now actually works

The `imagePlaceholderTimeoutSeconds` config option was validated at startup and documented correctly, but the value was never sent to the extension. The extension had its own hardcoded 3-minute constant that controlled both the real timeout timer and the `🎨 Generating image… (timeout: 3 minutes; …)` placeholder text, so changing the config had no effect at all.

The bridge now includes the configured value in the `bridge_config` handshake packet it sends to the extension on connect. The extension reads it and uses it in place of the hardcoded constant, so the timeout, the watchdog, the log message, and the placeholder text all reflect whatever you have set in `config.js`.
