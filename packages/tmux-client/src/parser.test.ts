import { describe, it, expect } from 'bun:test'
import { parseControlModeLine, unescapeTmuxOutput } from './parser.js'

describe('unescapeTmuxOutput', () => {
  it('unescapes \\n to newline', () => {
    expect(unescapeTmuxOutput('line1\\nline2')).toBe('line1\nline2')
  })

  it('unescapes \\\\ to backslash', () => {
    expect(unescapeTmuxOutput('back\\\\slash')).toBe('back\\slash')
  })

  it('unescapes \\r to carriage return', () => {
    expect(unescapeTmuxOutput('foo\\rbar')).toBe('foo\rbar')
  })

  it('handles multiple escape sequences', () => {
    expect(unescapeTmuxOutput('a\\nb\\nc')).toBe('a\nb\nc')
  })

  it('leaves unrecognized escape sequences as-is', () => {
    expect(unescapeTmuxOutput('\\t')).toBe('\\t')
  })

  it('returns plain string unchanged', () => {
    expect(unescapeTmuxOutput('hello world')).toBe('hello world')
  })

  it('handles empty string', () => {
    expect(unescapeTmuxOutput('')).toBe('')
  })

  it('handles trailing backslash (incomplete escape)', () => {
    // A trailing backslash with no following char is kept as-is
    expect(unescapeTmuxOutput('abc\\')).toBe('abc\\')
  })
})

describe('parseControlModeLine', () => {
  describe('%output events', () => {
    it('parses basic %output line', () => {
      const event = parseControlModeLine('%output %3 hello world')
      expect(event).not.toBeNull()
      expect(event?.type).toBe('pane-output')
      if (event?.type === 'pane-output') {
        expect(event.paneId).toBe('%3')
        expect(event.raw).toBe('hello world')
      }
    })

    it('parses %output with octal-escaped data', () => {
      const event = parseControlModeLine('%output %3 line1\\nline2')
      expect(event?.type).toBe('pane-output')
      if (event?.type === 'pane-output') {
        expect(event.raw).toBe('line1\nline2')
      }
    })

    it('parses %output with no data after pane id', () => {
      const event = parseControlModeLine('%output %5')
      expect(event?.type).toBe('pane-output')
      if (event?.type === 'pane-output') {
        expect(event.paneId).toBe('%5')
        expect(event.raw).toBe('')
      }
    })

    it('includes a timestamp', () => {
      const before = Date.now()
      const event = parseControlModeLine('%output %1 data')
      const after = Date.now()
      expect(event?.type).toBe('pane-output')
      if (event?.type === 'pane-output') {
        expect(event.timestamp).toBeGreaterThanOrEqual(before)
        expect(event.timestamp).toBeLessThanOrEqual(after)
      }
    })
  })

  describe('%pane-exited events', () => {
    it('parses %pane-exited', () => {
      const event = parseControlModeLine('%pane-exited %3 $1')
      expect(event).not.toBeNull()
      expect(event?.type).toBe('pane-exited')
      if (event?.type === 'pane-exited') {
        expect(event.paneId).toBe('%3')
        expect(event.sessionId).toBe('$1')
      }
    })
  })

  describe('%session events', () => {
    it('parses %session-created', () => {
      const event = parseControlModeLine('%session-created $1 main')
      expect(event).not.toBeNull()
      expect(event?.type).toBe('session-created')
      if (event?.type === 'session-created') {
        expect(event.sessionId).toBe('$1')
        expect(event.name).toBe('main')
      }
    })

    it('parses %session-created with no name', () => {
      const event = parseControlModeLine('%session-created $1')
      expect(event?.type).toBe('session-created')
      if (event?.type === 'session-created') {
        expect(event.sessionId).toBe('$1')
        expect(event.name).toBe('')
      }
    })

    it('parses %session-closed', () => {
      const event = parseControlModeLine('%session-closed $2')
      expect(event).not.toBeNull()
      expect(event?.type).toBe('session-closed')
      if (event?.type === 'session-closed') {
        expect(event.sessionId).toBe('$2')
      }
    })
  })

  describe('%window events', () => {
    it('parses %window-add', () => {
      const event = parseControlModeLine('%window-add @2 $1')
      expect(event).not.toBeNull()
      expect(event?.type).toBe('window-add')
      if (event?.type === 'window-add') {
        expect(event.windowId).toBe('@2')
        expect(event.sessionId).toBe('$1')
      }
    })

    it('parses %window-close', () => {
      const event = parseControlModeLine('%window-close @3 $1')
      expect(event).not.toBeNull()
      expect(event?.type).toBe('window-close')
      if (event?.type === 'window-close') {
        expect(event.windowId).toBe('@3')
        expect(event.sessionId).toBe('$1')
      }
    })
  })

  describe('command response delimiters (return null)', () => {
    it('returns null for %begin', () => {
      expect(parseControlModeLine('%begin 123 456 1')).toBeNull()
    })

    it('returns null for %end', () => {
      expect(parseControlModeLine('%end 123 456 0')).toBeNull()
    })

    it('returns null for %error', () => {
      expect(parseControlModeLine('%error 123 456 1')).toBeNull()
    })
  })

  describe('edge cases', () => {
    it('returns null for non-% lines', () => {
      expect(parseControlModeLine('hello world')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(parseControlModeLine('')).toBeNull()
    })

    it('returns null for unrecognized % notifications', () => {
      expect(parseControlModeLine('%unknown-event foo bar')).toBeNull()
    })
  })
})
