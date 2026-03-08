# Contributing to SillyTavern Discord Connector

First of all, thank you for taking the time to contribute! This is a solo-maintained project built in my spare time, and every bit of help - whether it's a bug report, a suggestion, or a pull request - is genuinely appreciated.

## Table of Contents

- [Reporting a Bug](#reporting-a-bug)
- [Suggesting a Feature](#suggesting-a-feature)
- [Contributing Code](#contributing-code)
- [Setting Up the Development Environment](#setting-up-the-development-environment)
- [Code Style](#code-style)
- [Pull Request Guidelines](#pull-request-guidelines)

---

## Reporting a Bug

Before opening an issue, please:

1. **Check if it's already reported** - search the [existing issues](https://github.com/senjinthedragon/SillyTavern-Discord-Connector/issues) first.
2. **Make sure you're on the latest version** - the bug may already be fixed.
3. **Check the bridge server terminal and the SillyTavern browser console** - error messages there often explain exactly what went wrong.

When opening a bug report, please include:

- What you were doing when the problem happened
- What you expected to happen
- What actually happened
- Any error messages from the bridge server terminal or the browser console (F12 → Console in SillyTavern)
- Your operating system and Node.js version (`node --version`)

The more detail you include, the faster it can be looked into.

---

## Suggesting a Feature

Feature suggestions are welcome. Open an issue and describe:

- What you'd like to be able to do
- Why it would be useful (to you or to others)
- Any ideas you have on how it might work

There's no guarantee every suggestion will be implemented, but all ideas are read and considered.

---

## Contributing Code

If you'd like to fix a bug or implement a feature yourself, that's very welcome. To avoid putting effort into something that won't be merged, please **open an issue first** to discuss it before writing any code. This way we can agree on the approach before you invest time in it.

For small and obvious bug fixes, feel free to open a pull request directly without an issue first.

---

## Setting Up the Development Environment

You'll need:

- [Node.js](https://nodejs.org/) v18 or higher
- A Discord bot token (see the [Quick Start](README.md#quick-start) in the README)
- A working SillyTavern installation

**Steps:**

1. Fork and clone the repository
2. Navigate into the `server` folder
3. Install dependencies:
   ```shell
   npm install
   ```
4. Copy the example config and fill in your settings:
   ```shell
   cp config.example.js config.js
   ```
5. Start the bridge server:
   ```shell
   node server.js
   ```
6. Install the extension in SillyTavern by pointing it at your forked repository URL, or by symlinking the extension folder directly into SillyTavern's extensions directory.

To run the test suite:
```shell
npm run verify-release
```

There is no separate build step - the project runs directly from source.

---

## Code Style

This project uses [Prettier](https://prettier.io/) for consistent formatting. Before submitting a pull request, please run:

```shell
prettier --write "**/*.js"
```

from the `server` folder to make sure your code is formatted consistently with the rest of the project. If you use VS Code, the Prettier extension will handle this automatically on save.

---

## Pull Request Guidelines

- Keep pull requests focused - one fix or feature per PR makes reviewing much easier.
- If your change touches user-facing behavior, update the relevant section of `README.md`.
- If your change is significant enough to mention in release notes, add a bullet point to `RELEASE_NOTES.md` under a new or appropriate section.
- Make sure `npm run verify-release` passes before submitting.
- Target the `dev` branch, not `main`. Pull requests against `main` will be redirected.

---

## A Note on This Project

This is a passion project maintained by one person in their free time. Response times may vary. If you don't hear back immediately, please be patient - your issue or pull request hasn't been forgotten.
