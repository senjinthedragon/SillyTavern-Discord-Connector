# v1.6.0 — In Progress

## Fixes

### `imagePlaceholderTimeoutSeconds` now actually works

The `imagePlaceholderTimeoutSeconds` config option was validated at startup and documented correctly, but the value was never sent to the extension. The extension had its own hardcoded 3-minute constant that controlled both the real timeout timer and the `🎨 Generating image… (timeout: 3 minutes; …)` placeholder text, so changing the config had no effect at all.

The bridge now includes the configured value in the `bridge_config` handshake packet it sends to the extension on connect. The extension reads it and uses it in place of the hardcoded constant, so the timeout, the watchdog, the log message, and the placeholder text all reflect whatever you have set in `config.js`.
