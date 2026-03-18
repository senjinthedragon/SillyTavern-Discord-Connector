/**
 * Shared utilities.
 */

/**
 * Sanitizes a string before it is interpolated into a slash command passed to
 * executeSlashCommandsWithOptions. SillyTavern's slash command runner supports
 * pipe chaining (|), so an unsanitized value like "Alice | /newchat" would
 * execute /newchat as a second command. Newlines carry the same risk. Length
 * is capped so an oversized string cannot be used to slow down the parser.
 *
 * Apply this to ALL user-supplied arguments before interpolating them into
 * slash command strings.
 *
 * @param {string} value
 * @returns {string}
 */
export function sanitizeSlashArg(value) {
  return String(value)
    .replace(/[|\n\r]/g, "") // strip pipe and newlines (command injection vectors)
    .trim()
    .slice(0, 200);
}
