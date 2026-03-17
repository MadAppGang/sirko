import type { TmuxEvent } from './types.js'

/**
 * Unescapes tmux's control-mode output encoding:
 *   \\ → backslash
 *   \n → newline
 *   \r → carriage return
 */
export function unescapeTmuxOutput(raw: string): string {
  let result = ''
  let i = 0
  while (i < raw.length) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]!
      if (next === '\\') {
        result += '\\'
        i += 2
        continue
      } else if (next === 'n') {
        result += '\n'
        i += 2
        continue
      } else if (next === 'r') {
        result += '\r'
        i += 2
        continue
      } else if (next >= '0' && next <= '3' && i + 3 < raw.length) {
        // Octal escape: \NNN (e.g. \015 = CR, \012 = LF, \033 = ESC)
        const octal = raw.slice(i + 1, i + 4)
        if (/^[0-7]{3}$/.test(octal)) {
          result += String.fromCharCode(parseInt(octal, 8))
          i += 4
          continue
        }
      }
    }
    result += raw[i]
    i++
  }
  return result
}

/**
 * Parses a single line from tmux control-mode output.
 * Returns null for lines that are not actionable events (e.g., %begin/%end delimiters,
 * empty lines, or unrecognized notifications).
 *
 * Examples of lines parsed:
 *   "%output %3 line of output"      → { type: 'pane-output', paneId: '%3', raw: 'line of output', ... }
 *   "%pane-exited %3 $1"             → { type: 'pane-exited', paneId: '%3', sessionId: '$1' }
 *   "%session-created $1 main"       → { type: 'session-created', sessionId: '$1', name: 'main' }
 *   "%session-closed $1"             → { type: 'session-closed', sessionId: '$1' }
 *   "%window-add @2 $1"              → { type: 'window-add', windowId: '@2', sessionId: '$1' }
 *   "%window-close @2 $1"            → { type: 'window-close', windowId: '@2', sessionId: '$1' }
 *   "%begin 123 456 1"               → null  (command response delimiter)
 *   "%end 123 456 0"                 → null  (command response delimiter)
 */
export function parseControlModeLine(line: string): TmuxEvent | null {
  if (!line.startsWith('%')) return null

  // %output %<pane_id> <data...>
  if (line.startsWith('%output ')) {
    const rest = line.slice('%output '.length)
    const spaceIdx = rest.indexOf(' ')
    if (spaceIdx === -1) {
      // output with no data
      const paneId = rest.trim()
      return {
        type: 'pane-output',
        paneId,
        sessionId: '',
        raw: '',
        timestamp: Date.now(),
      }
    }
    const paneId = rest.slice(0, spaceIdx)
    const rawData = rest.slice(spaceIdx + 1)
    return {
      type: 'pane-output',
      paneId,
      sessionId: '',
      raw: unescapeTmuxOutput(rawData),
      timestamp: Date.now(),
    }
  }

  // %pane-exited %<pane_id> $<session_id>
  if (line.startsWith('%pane-exited ')) {
    const parts = line.slice('%pane-exited '.length).split(' ')
    const paneId = parts[0] ?? ''
    const sessionId = parts[1] ?? ''
    return { type: 'pane-exited', paneId, sessionId }
  }

  // %session-created $<session_id> <name>
  if (line.startsWith('%session-created ')) {
    const rest = line.slice('%session-created '.length)
    const spaceIdx = rest.indexOf(' ')
    if (spaceIdx === -1) {
      return { type: 'session-created', sessionId: rest.trim(), name: '' }
    }
    const sessionId = rest.slice(0, spaceIdx)
    const name = rest.slice(spaceIdx + 1)
    return { type: 'session-created', sessionId, name }
  }

  // %session-closed $<session_id>
  if (line.startsWith('%session-closed ')) {
    const sessionId = line.slice('%session-closed '.length).trim()
    return { type: 'session-closed', sessionId }
  }

  // %window-add @<window_id> [$<session_id>]
  if (line.startsWith('%window-add ')) {
    const parts = line.slice('%window-add '.length).split(' ')
    const windowId = parts[0] ?? ''
    const sessionId = parts[1] ?? ''
    return { type: 'window-add', windowId, sessionId }
  }

  // %window-close @<window_id> [$<session_id>]
  if (line.startsWith('%window-close ')) {
    const parts = line.slice('%window-close '.length).split(' ')
    const windowId = parts[0] ?? ''
    const sessionId = parts[1] ?? ''
    return { type: 'window-close', windowId, sessionId }
  }

  // %begin, %end, %error — command response delimiters, not actionable events
  if (
    line.startsWith('%begin ') ||
    line.startsWith('%end ') ||
    line.startsWith('%error ')
  ) {
    return null
  }

  // Unrecognized notification — ignore
  return null
}
