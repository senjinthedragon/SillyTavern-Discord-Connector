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

// For free-text fields like /note where newlines are valid content.
// Only strips the pipe character (ST slash command injection vector).
export function sanitizeNoteArg(value) {
  return String(value)
    .replace(/\|/g, "") // strip pipe (command injection vector)
    .trim()
    .slice(0, 4096);
}
