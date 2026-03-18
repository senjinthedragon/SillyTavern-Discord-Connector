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
