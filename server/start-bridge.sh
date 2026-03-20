#!/bin/sh
# ==============================================================================
# start-bridge.sh - SillyTavern Discord Connector: Linux/macOS Launcher
# Copyright (c) 2026 Senjin the Dragon.
# https://github.com/senjinthedragon/SillyTavern-Discord-Connector
# Licensed under the MIT License.
# ==============================================================================
#
# This script automates the environment setup and launch process for the
# bridge server. It is designed to be user-friendly for non-technical
# users on Linux and macOS systems.
#
# Logic Flow:
# 1. Working directory: Changes to the folder containing this script so it
#    works correctly regardless of where it is launched from.
# 2. Dependency Check: Runs 'npm install' to ensure all required Node.js
#    modules are present without requiring manual terminal commands.
# 3. Execution: Launches the bridge server (server.js).
# 4. Persistence: The 'read' at the end keeps the terminal open after
#    a crash or exit, allowing the user to read error logs.
#
# Make executable once with: chmod +x start-bridge.sh
# ==============================================================================

cd "$(dirname "$0")"

echo "Checking dependencies..."
npm install
echo "Starting bridge server..."
node server.js

echo ""
echo "Bridge server stopped. Press Enter to close."
read -r _
