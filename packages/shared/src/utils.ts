const TELEGRAM_MAX_LEN = 4096

/**
 * Format a Unix millisecond timestamp as a human-readable ISO string.
 */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * Truncate text to fit within Telegram's message character limit.
 * If truncation occurs, a suffix is appended indicating bytes were cut.
 */
export function truncateForTelegram(text: string, maxLen: number = TELEGRAM_MAX_LEN): string {
  if (text.length <= maxLen) {
    return text
  }
  const suffix = '…[truncated]'
  // If maxLen is smaller than the suffix itself, just hard-truncate.
  if (maxLen <= suffix.length) {
    return text.slice(0, maxLen)
  }
  return text.slice(0, maxLen - suffix.length) + suffix
}

/**
 * Parse a tmux pane ID from a raw string (e.g. "%3" or "session:window.3").
 * Returns the canonical "%N" form, or null if unrecognised.
 */
export function paneIdFromString(raw: string): string | null {
  // Already in canonical form
  const canonical = /^%\d+$/.exec(raw)
  if (canonical !== null) {
    return raw
  }

  // session:window.pane — extract the pane number
  const dotted = /\.(\d+)$/.exec(raw)
  if (dotted !== null && dotted[1] !== undefined) {
    return `%${dotted[1]}`
  }

  return null
}

/**
 * Strip characters that would be misinterpreted by tmux send-keys.
 * Removes ASCII control characters (except newline and tab) and other
 * characters that could trigger unintended tmux key sequences.
 */
export function sanitizeForSendKeys(text: string): string {
  // Remove ASCII control chars except \t (0x09) and \n (0x0a)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}
