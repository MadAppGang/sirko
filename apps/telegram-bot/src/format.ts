import type { ToolName } from '@sirko/shared'
import { escapeHtml, wrapInPre, wrapInBlockquote } from './html-utils.js'

/**
 * Format terminal output text for Telegram HTML parse mode.
 *
 * Tiered strategy based on text length:
 * - len <= 4096: single <pre><code> block
 * - 4096 < len <= 12000: first 4096 chars as <pre>, rest as <blockquote expandable>
 * - len > 12000: returns null (caller should send as a file)
 */
export function formatOutput(text: string): string | null {
  const len = text.length

  if (len <= 4096) {
    return wrapInPre(`<code>${escapeHtml(text)}</code>`)
  }

  if (len <= 12000) {
    const firstPart = text.slice(0, 4096)
    const rest = text.slice(4096)
    return (
      wrapInPre(`<code>${escapeHtml(firstPart)}</code>`) +
      '\n' +
      wrapInBlockquote(escapeHtml(rest), true)
    )
  }

  // > 12000 chars: caller must send as file
  return null
}

/**
 * Format an awaiting-input notification message in HTML.
 */
export function formatAwaitingInput(
  tool: ToolName,
  confidence: number,
  contextSnippet: string,
): string {
  const pct = Math.round(confidence * 100)
  const escaped = escapeHtml(contextSnippet.slice(0, 200))
  return (
    `<b>Awaiting input</b> — <code>${escapeHtml(tool)}</code> (${pct}% confidence)\n` +
    wrapInBlockquote(escaped, contextSnippet.length > 100)
  )
}

export { escapeHtml } from './html-utils.js'
