/**
 * HTML formatting utilities for Telegram HTML parse mode.
 */

/**
 * Escape HTML special characters for use in Telegram HTML parse mode messages.
 * Escapes: &, <, >, ", '
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Wrap text in `<pre>` tags for monospace display.
 */
export function wrapInPre(text: string): string {
  return `<pre>${text}</pre>`
}

/**
 * Wrap text in `<blockquote>` tags.
 * @param expandable - if true, adds the expandable attribute (collapsible in Telegram)
 */
export function wrapInBlockquote(text: string, expandable = false): string {
  if (expandable) {
    return `<blockquote expandable>${text}</blockquote>`
  }
  return `<blockquote>${text}</blockquote>`
}
