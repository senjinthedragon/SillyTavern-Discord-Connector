"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const configLoaderPath = path.join(__dirname, "config-loader.js");
const configPath = path.join(__dirname, "config.js");

function withTempConfig(configValue, fn) {
  const hadConfig = fs.existsSync(configPath);
  const backup = hadConfig ? fs.readFileSync(configPath, "utf8") : null;

  const originalExit = process.exit;
  const originalConsoleError = console.error;

  fs.writeFileSync(configPath, `module.exports = ${JSON.stringify(configValue, null, 2)};\n`);

  let exitCode = null;
  let errorText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("PROCESS_EXIT");
  };
  console.error = (...args) => {
    errorText += args.join(" ");
  };

  delete require.cache[configLoaderPath];
  delete require.cache[configPath];

  try {
    return fn({
      load: () => require("./config-loader"),
      getExitCode: () => exitCode,
      getErrorText: () => errorText,
    });
  } finally {
    process.exit = originalExit;
    console.error = originalConsoleError;

    delete require.cache[configLoaderPath];
    delete require.cache[configPath];

    if (hadConfig) {
      fs.writeFileSync(configPath, backup);
    } else {
      fs.unlinkSync(configPath);
    }
  }
}

test("config-loader applies timing defaults", () => {
  withTempConfig(
    {
      discordToken: "TOKEN",
      wssPort: 2333,
    },
    ({ load, getExitCode }) => {
      const loaded = load();
      assert.equal(getExitCode(), null);
      assert.equal(loaded.config.queueTaskTimeoutMs, 30000);
      assert.equal(loaded.config.imagePlaceholderTimeoutMs, 180000);
      assert.equal(loaded.token, "TOKEN");
      assert.equal(loaded.wssPort, 2333);
    },
  );
});

test("config-loader rejects invalid queueTaskTimeoutMs", () => {
  withTempConfig(
    {
      discordToken: "TOKEN",
      wssPort: 2333,
      queueTaskTimeoutMs: 0,
    },
    ({ load, getExitCode, getErrorText }) => {
      assert.throws(() => load(), /PROCESS_EXIT/);
      assert.equal(getExitCode(), 1);
      assert.match(getErrorText(), /queueTaskTimeoutMs/);
    },
  );
});
