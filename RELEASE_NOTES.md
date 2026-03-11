# v1.4.0: Plugin Architecture, Multi-Platform Support, and a Polished Core

This release introduces a fully extensible plugin system, bringing the bridge architecture up to a new level of flexibility and testability. Discord remains the built-in free frontend, while Telegram and Signal are available as separately licensed pro plugins.

## Highlights

### Plugin Architecture (Free)
The bridge now routes all outbound packets through a clean plugin system. Each platform registers as a frontend plugin, enabling true multi-platform fanout from a single SillyTavern session. The routing layer is fully unit-tested with mocked frontends.

- `enabledPlugins` in config selects which frontends are active.
- `externalPlugins` allows loading pro plugin modules from outside the public repo.
- Optional per-plugin circuit breaker protects the bridge when a frontend becomes unresponsive.

### Image Placeholder Fix (Free)
Expression images, character avatars, and inline images no longer accidentally delete the "🎨 Generating image…" placeholder. Only an actual `generate_image_result` packet clears it.

### Status Improvements (Free)
`/status` now shows a platform line indicating which frontends are loaded and active. Free version users see Telegram and Signal as ⚫ - a hint that pro plugins are available.

### Configuration File Reorganized
`config.example.js` is now divided into three clearly labeled sections - Essential, General, and Advanced - so new users only need to fill in the top section to get started. Existing `config.js` files from v1.3.1 work without any changes.

### Telegram Plugin (Pro)
- Full inbound/outbound support via the Telegram Bot API.
- Slash commands registered in the Telegram `/` menu on startup.
- Supports text, typing indicators, images, expression updates, and streaming via final-text delivery.

### Signal Plugin (Pro)
- Full inbound/outbound support via `signal-cli-rest-api` in json-rpc mode.
- Inbound messages received via WebSocket subscription with automatic reconnect.
- Supports text, images, and expression updates.
- Includes Docker helper scripts to spin up the required `signal-cli-rest-api` container.
- Signal credentials are stored in `data/signal-data/` in the repo root and mounted as a Docker volume, so your registration survives container restarts and rebuilds.

## Configuration Changes

- `enabledPlugins` - array of active frontend names. Defaults to `["discord"]`.
- `externalPlugins` - array of `{ name, module, config }` objects for pro plugins.
- `plugins.<name>.circuitBreaker` - optional per-plugin failure protection.
- `conversationLinks` - optional array linking a single `conversationId` across multiple platform chat IDs for cross-platform fanout.

## Notes for Pro Plugin Users

Pro plugins (Telegram, Signal) are distributed separately and loaded via `externalPlugins` in `config.js`. They are not included in this public repository. See the pro plugin documentation for setup instructions.

Signal requires a running `signal-cli-rest-api` Docker container and a dedicated phone number. Telegram requires a bot token from BotFather.

## QA

- Full server test suite passes (27 tests, 0 failures).
- Release checklist (`npm run release-checklist`) passes:
  - server tests,
  - package dry-run,
  - release docs presence checks.
