# Next Release: Plugin-Ready Discord Core + External Pro Frontends

This release keeps the free Discord bridge polished and stable, while preparing the architecture for separately licensed private/pro frontend plugins.

## Highlights

- Discord remains the built-in free frontend.
- WebSocket packet handling moved into a testable router layer.
- Optional per-frontend circuit breaker/backoff controls.
- External plugin loading support for private/pro frontends via `externalPlugins`.
- Integration-style packet-flow tests with mocked frontends.

## Configuration

- `enabledPlugins` selects active frontends (Discord built-in by default).
- `externalPlugins` allows loading private/pro plugin modules without bundling them in this public repo.
- `plugins.<name>.circuitBreaker` can optionally protect failing frontends from repeated sends.

## Compatibility Notes

- Discord activity-based mood display remains available.
- Additional frontends can provide equivalent behavior through their own plugin implementations.

## QA

- Full server test suite passes.
- Release checklist (`npm run release-checklist`) passes:
  - server tests,
  - package dry-run,
  - release docs presence checks.
