# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Added plugin architecture primitives for frontend routing and packet fanout.
- Added websocket packet-flow integration tests with mocked frontends (`server/websocket-router.test.js`).
- Added optional per-plugin circuit breaker/backoff support in frontend fanout (`plugins.<name>.circuitBreaker`).
- Added `scripts/release-checklist.js` and `npm run release-checklist` for pre-release automation.
- Added `sendGeneratedImage` fanout path so expression images, character images and inline images never accidentally delete an image generation placeholder.
- Added active plugin status to the `bridge_config` handshake packet so the extension can display which frontends are loaded.
- Added platform status line to `/status` output showing each known platform as active 🟢, not loaded ⚫, or unhealthy 🔴.
- Added startup credits banner with version number, author, and support link.

### Changed
- Refactored bridge routing through a testable router layer (`server/websocket-router.js`).
- Kept Discord as the built-in free frontend and unbundled Telegram/Signal implementations for separate private/pro distribution.
- Added support for loading external frontend plugins via `config.externalPlugins`.
- Strengthened startup validation and reconnect cleanup behavior.
- Replaced bare `console.log` calls in `websocket.js` and `discord.js` with the timestamped `log()` function for consistent log formatting.
- Missing plugin files now log a concise "not found" message instead of a full Node.js require stack trace.
- Image generation placeholder message is now correctly deleted when the generated image arrives, regardless of other images (expressions, avatars, inline) arriving in the meantime.
- `config.example.js` reorganized into clearly labeled sections (Essential, General, Advanced) to make initial setup easier. Existing `config.js` files from v1.3.1 continue to work without changes.

### Fixed
- Alphabetical autocomplete sorting for character, group and group member lists was documented as a 1.3.0 feature but the sort function was missing from the released code.
- Solo chat character lookup in autocomplete used `find()` with an object id that no longer exists in recent SillyTavern versions; fixed to use direct array index.
- Browser-side image fetch limit raised from 8 MB to 50 MB so uncompressed images from local generators are no longer rejected before the server can compress them.

### Added _(Pro version only)_
- Telegram frontend plugin: inbound polling via `getUpdates`, outbound text, typing indicator, images, expressions, and streaming via final-text send.
- Telegram plugin registers bridge slash commands in the Telegram `/` command menu on startup.
- Signal frontend plugin: inbound message subscription via WebSocket (`signal-cli-rest-api` json-rpc mode), outbound text, images, and expressions.
- Signal plugin includes helper scripts (`start-signal-bridge.bat` / `.sh`) to spin up the required Docker container.
- Signal credentials and registration data are stored in `data/signal-data/` in the repo root, mounted as a Docker volume so data survives container restarts and rebuilds.

## [1.3.1] - 2026-03-06

### Fixed
- Reverted an unnecessary `npm audit fix --force` that had downgraded dependencies and broken the bridge.

## [1.3.0] - 2026-03-06

### Added
- Expression and mood support: the bot's Discord status now reflects the active character's current expression, with matching emoji for all known default expressions.
- `/mood <n>` command to post the current visible expression image on demand; remembers the last seen mood per character in group chats.
- `/reaction <mode>` command to change expression display mode remotely from Discord (`off`, `status`, `full`).
- Optional `full` expression mode that posts expression images to Discord automatically alongside status updates.
- `/status` command to inspect bridge connection health and image pipeline statistics.
- `/image cancel` to immediately cancel an active image generation request.
- Per-channel image request queuing so a stuck request in one channel never blocks another.
- Automatic timeout handling for image generation with a clear retry message when generation stalls.
- Autocomplete for `/mood` and `/charimage` - shows group members immediately when the command is opened, or the solo character's name in solo chat.
- `locale` config field for controlling date and time formatting in logs and chat history. Defaults to `"en-US"`.

### Changed
- All name-based autocomplete lists (characters, groups, group members) are now sorted alphabetically, with leading emoji and decorative characters ignored for sort order.
- `/switchchat` autocomplete now shows human-readable dates and times sorted newest-first, instead of raw filenames.
- `queueTaskTimeoutMs` renamed to `queueTaskTimeoutSeconds` - now accepts plain seconds (e.g. `30`).
- `imagePlaceholderTimeoutMs` renamed to `imagePlaceholderTimeoutSeconds` - now accepts plain seconds (e.g. `180`).
- Log timestamps now respect the configured `locale` instead of always using US formatting.
- `timezone` and `locale` are now validated at startup with a clear warning and graceful fallback if either is invalid.

### Fixed
- `/mood` and `/charimage` autocomplete was silently not firing due to stale Discord slash command registration.
- Solo chat character lookup in autocomplete was using array indexing instead of `find()`, always returning undefined.

## [1.2.5] - 2026-03-03

### Fixed
- Fixed npm publishing workflow.

## [1.2.4] - 2026-03-03

### Fixed
- Fixed npm publishing workflow.

## [1.2.3] - 2026-03-02

### Added
- Added keywords to `package.json` to improve discoverability on npm and GitHub.
- Fully implemented GitHub Actions for automated publishing to npm and GitHub Packages.
- Integrated `version-everything` to keep the extension manifest and server package version in sync.

### Fixed
- Minor typos in README and documentation.
- Repository structure cleaned up for local development.

## [1.2.1] - 2026-03-02

### Changed
- Reduced published package size from ~16 MB to ~28 KB by properly excluding `node_modules`, local config files, and development assets.
- Corrected package scope and registry configuration for GitHub Packages.
- Switched README images to absolute URLs so they render correctly outside of GitHub.

### Added
- Automated publishing via GitHub Actions on future releases.

## [1.2.0] - 2026-03-01

### Added
- `/image <prompt>` command for AI image generation with a live placeholder while generating.
- `/image` keyword shortcuts: `you`, `face`, `me`, `scene`, `last`, `raw_last`, `background`.
- `/charimage` command to post a character's avatar to Discord.
- Character greetings on `/newchat` are now automatically forwarded to Discord, including any images in the greeting. In group chat each member's greeting is sent in order.
- Images in AI replies are detected and forwarded to Discord after the reply text.
- Images exceeding Discord's 8 MB upload limit are automatically scaled down before sending.

### Changed
- Server code restructured from a single large file into focused modules: `server.js`, `client.js`, `discord.js`, `websocket.js`, `messaging.js`, `streaming.js`, `queue.js`, `logger.js`.

### Fixed
- Manual disconnect now works correctly when auto-reconnect is enabled - previously a deliberate disconnect could still trigger a reconnect.
- Streaming no longer breaks on responses exceeding 2000 characters - live updates now truncate with an ellipsis and the full text is posted correctly once generation finishes.

## [1.1.3] - 2026-02-26

### Added
- All bridge commands now register as native Discord slash commands and appear in the `/` menu automatically.
- Live autocomplete for `/switchchar`, `/switchgroup` and `/switchchat` - shows filtered results from your SillyTavern installation as you type.

### Changed
- The `applications.commands` OAuth2 scope is now required. Existing users can grant it by generating a new invite URL and opening it in a browser - no need to kick and re-invite the bot.

## [1.1.2] - 2026-02-26

### Fixed
- Fixed a compatibility issue where the bot would log in but not respond to messages on newer versions of Discord.js.
- Fixed a syntax error that caused crashes on Node.js v22 and higher.
- Windows `start-bridge.bat` launcher now automatically runs `npm install` if dependencies are missing.

## [1.1.1] - 2026-02-25

### Fixed
- Fixed syntax errors introduced at the end of the 1.1.0 release that prevented the extension from loading.
- Re-synced bridge server and extension logic to match intended 1.1.0 behavior.

## [1.1.0] - 2026-02-25

> Superseded by 1.1.1 within hours of release due to a syntax issue. See [1.1.1] above.

## [1.0.0] - 2026-02-25

### Added
- Initial release.
- Real-time AI response streaming from SillyTavern to Discord.
- Slash commands: `/switchchar`, `/switchgroup`, `/newchat`, `/listchars`, `/listgroups`, `/listchats`, `/switchchat`.
- `allowedUserIds` and `allowedChannelIds` config options to restrict bot access.
- Compatible with SillyTavern extensions including Vector Storage and Summarization.

---

[Unreleased]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.3.1...HEAD
[1.3.1]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.2.5...v1.3.0
[1.2.5]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.2.1...v1.2.3
[1.2.1]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/senjinthedragon/SillyTavern-Discord-Connector/releases/tag/v1.0.0
