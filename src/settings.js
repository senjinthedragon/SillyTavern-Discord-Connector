/**
 * SillyTavern-Discord-Connector - Bridge Extension for SillyTavern
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Extension settings - name, defaults, accessor, and status indicator.
 */

export const MODULE_NAME = "SillyTavern-Discord-Connector";

export const DEFAULT_SETTINGS = {
  bridgeUrl: "ws://127.0.0.1:2333",
  autoConnect: true,
  expressionMode: "status",
  allowUserPersonaSave: true,
  crossPlatformRelay: true,
};

let _initialized = false;

export function getSettings() {
  const { extensionSettings } = SillyTavern.getContext();
  if (!_initialized) {
    extensionSettings[MODULE_NAME] = {
      ...DEFAULT_SETTINGS,
      ...(extensionSettings[MODULE_NAME] || {}),
    };
    _initialized = true;
  }

  const s = extensionSettings[MODULE_NAME];
  if (!["off", "status", "full"].includes(s.expressionMode)) {
    s.expressionMode = DEFAULT_SETTINGS.expressionMode;
  }
  return s;
}

export function updateStatus(message, color) {
  const el = document.getElementById("discord_connection_status");
  if (el) {
    el.textContent = `Status: ${message}`;
    el.style.color = color;
  }
}
