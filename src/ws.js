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
 * WebSocket state and safe-send helper.
 * All other modules import safeSend/getWs from here rather than
 * holding a reference to the socket themselves.
 */

let _ws = null;

export function setWs(socket) {
  _ws = socket;
}

export function getWs() {
  return _ws;
}

/** Send a JSON payload only when the socket is open. */
export function safeSend(payload) {
  if (_ws?.readyState === WebSocket.OPEN) _ws.send(JSON.stringify(payload));
}
