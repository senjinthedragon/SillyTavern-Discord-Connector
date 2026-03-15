@echo off
:: ============================================================================
:: start-bridge.bat - SillyTavern Discord Connector: Windows Launcher
:: Copyright (c) 2026 Senjin the Dragon.
:: https://github.com/senjinthedragon/SillyTavern-Discord-Connector
:: Licensed under the MIT License.
:: ============================================================================
::
:: This script automates the environment setup and launch process for the 
:: bridge server[cite: 1]. It is designed to be user-friendly for non-technical 
:: users on Windows systems.
::
:: Logic Flow:
:: 1. Dependency Check: Runs 'npm install' to ensure all required Node.js 
::    modules are present without requiring manual terminal commands[cite: 1].
:: 2. Execution: Launches the bridge server (server.js)[cite: 1].
:: 3. Persistence: The 'pause' command ensures the window stays open after
::    a crash or exit, allowing the user to read error logs[cite: 1].
::
:: ============================================================================

echo Checking dependencies...
call npm install
echo Starting bridge server...
node server.js
pause
