import type { TerminalEmulator, CursorState } from '@sirko/shared'

/**
 * XtermEmulator: wraps @xterm/headless Terminal for full VT processing.
 * Used when @xterm/headless is available.
 */
export class XtermEmulator implements TerminalEmulator {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly term: any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(term: any) {
    this.term = term
  }

  write(raw: string): void {
    // @xterm/headless write accepts string or Uint8Array
    this.term.write(raw)
  }

  getBuffer(): string {
    const buf = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      if (line) {
        lines.push(line.translateToString(true))
      }
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
      lines.pop()
    }
    return lines.join('\n')
  }

  getCursor(): CursorState {
    const buf = this.term.buffer.active
    return {
      row: buf.cursorY,
      col: buf.cursorX,
      visible: true,
    }
  }
}

/**
 * Strips ANSI escape sequences from a string.
 * Simple regex-based approach used in BufferEmulator fallback.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[mGKHFABCDEJsuhr]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[DECMNOPQRSTUVWXYZ[\]^_`]/g, '')
}

/**
 * BufferEmulator: simple line-buffer fallback when @xterm/headless is unavailable.
 * Strips ANSI codes and maintains a rolling line buffer.
 */
export class BufferEmulator implements TerminalEmulator {
  private buffer: string = ''
  private cursorRow: number = 0
  private cursorCol: number = 0

  write(raw: string): void {
    this.buffer += raw
    // Rough cursor tracking: count newlines
    const lines = raw.split('\n')
    if (lines.length > 1) {
      this.cursorRow += lines.length - 1
      this.cursorCol = stripAnsi(lines[lines.length - 1] ?? '').length
    } else {
      this.cursorCol += stripAnsi(raw).length
    }
  }

  getBuffer(): string {
    return stripAnsi(this.buffer)
  }

  getCursor(): CursorState {
    return {
      row: this.cursorRow,
      col: this.cursorCol,
      visible: true,
    }
  }
}

/**
 * Attempts to create an XtermEmulator using @xterm/headless.
 * Falls back to BufferEmulator if the package is not available or fails.
 */
export async function createTerminalEmulator(
  cols = 220,
  rows = 50,
): Promise<TerminalEmulator> {
  try {
    const { Terminal } = await import('@xterm/headless')
    const term = new Terminal({ cols, rows, allowProposedApi: true })
    return new XtermEmulator(term)
  } catch {
    return new BufferEmulator()
  }
}
