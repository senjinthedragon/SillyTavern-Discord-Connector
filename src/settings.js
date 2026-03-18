/**
 * Extension settings - name, defaults, accessor, and status indicator.
 */

export const MODULE_NAME = "SillyTavern-Discord-Connector";

export const DEFAULT_SETTINGS = {
  bridgeUrl: "ws://127.0.0.1:2333",
  autoConnect: true,
  expressionMode: "status",
  allowUserPersonaSave: true,
};

export function getSettings() {
  const { extensionSettings } = SillyTavern.getContext();
  extensionSettings[MODULE_NAME] = {
    ...DEFAULT_SETTINGS,
    ...(extensionSettings[MODULE_NAME] || {}),
  };

  if (
    !["off", "status", "full"].includes(
      extensionSettings[MODULE_NAME].expressionMode,
    )
  ) {
    extensionSettings[MODULE_NAME].expressionMode =
      DEFAULT_SETTINGS.expressionMode;
  }

  return extensionSettings[MODULE_NAME];
}

export function updateStatus(message, color) {
  const el = document.getElementById("discord_connection_status");
  if (el) {
    el.textContent = `Status: ${message}`;
    el.style.color = color;
  }
}
