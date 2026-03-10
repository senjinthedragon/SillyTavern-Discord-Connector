#!/usr/bin/env node
/**
 * release-checklist.js - SillyTavern Connector: Release Readiness Checklist
 *
 * Runs a practical pre-release checklist and exits non-zero if any required
 * check fails.
 */

"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd, shell: false });
  return result.status === 0;
}

function exists(path) {
  return fs.existsSync(path);
}

const checks = [
  {
    name: "Server tests",
    run: () => run("npm", ["test"], "server"),
  },
  {
    name: "Package dry run",
    run: () => run("npm", ["run", "test-package"]),
  },
  {
    name: "Release notes present",
    run: () => exists("RELEASE_NOTES.md"),
  },
  {
    name: "Changelog present",
    run: () => exists("CHANGELOG.md"),
  },
];

let failed = false;
console.log("\n=== Release Checklist ===");
for (const check of checks) {
  const ok = check.run();
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${check.name}`);
  if (!ok) failed = true;
}

if (failed) {
  console.error("\nRelease checklist failed. Resolve the failing items above.");
  process.exit(1);
}

console.log("\nRelease checklist passed. ✅");
