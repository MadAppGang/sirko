import { describe, it, expect, beforeEach } from 'bun:test'
import { TmuxClient, createTmuxClient } from './client.js'
import type { TmuxEvent } from './types.js'
import { parseControlModeLine } from './parser.js'

// -------------------------------------------------------------------------
// Unit tests for TmuxClient that don't require a real tmux process.
// We test the internal _processLine / _processChunk methods by accessing
// them via a subclass (since TypeScript private is compile-time only).
// -------------------------------------------------------------------------

class TestableClient extends TmuxClient {
  public capturedEvents: TmuxEvent[] = []

  constructor() {
    super({ coalesceWindowMs: 10 })
    // Override _dispatchEvent to capture events
  }

  // Expose internal processing for white-box testing
  processLine(line: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(this as any)._processLine(line)
  }

  processChunk(chunk: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(this as any)._processChunk(chunk)
  }

  dispatchSpy: TmuxEvent[] = []
  override _dispatchEvent(event: TmuxEvent): void {
    this.dispatchSpy.push(event)
    super._dispatchEvent(event)
  }
}

describe('TmuxClient internal line processing', () => {
  let client: TestableClient

  beforeEach(() => {
    client = new TestableClient()
  })

  it('dispatches session-created event from notification line', () => {
    client.processLine('%session-created $1 main')
    expect(client.dispatchSpy).toHaveLength(1)
    expect(client.dispatchSpy[0]?.type).toBe('session-created')
  })

  it('dispatches session-closed event', () => {
    client.processLine('%session-closed $1')
    expect(client.dispatchSpy).toHaveLength(1)
    expect(client.dispatchSpy[0]?.type).toBe('session-closed')
  })

  it('dispatches pane-exited event', () => {
    client.processLine('%pane-exited %3 $1')
    expect(client.dispatchSpy).toHaveLength(1)
    expect(client.dispatchSpy[0]?.type).toBe('pane-exited')
  })

  it('does not dispatch %begin lines', () => {
    client.processLine('%begin 1234 2 1')
    expect(client.dispatchSpy).toHaveLength(0)
  })

  it('does not dispatch %end lines', () => {
    client.processLine('%begin 1234 2 1')
    client.processLine('%end 1234 2 0')
    expect(client.dispatchSpy).toHaveLength(0)
  })

  it('handles fragmented chunks across newlines', () => {
    client.processChunk('%session-crea')
    expect(client.dispatchSpy).toHaveLength(0)  // incomplete line
    client.processChunk('ted $5 work\n')
    expect(client.dispatchSpy).toHaveLength(1)
    expect(client.dispatchSpy[0]?.type).toBe('session-created')
    if (client.dispatchSpy[0]?.type === 'session-created') {
      expect(client.dispatchSpy[0].sessionId).toBe('$5')
      expect(client.dispatchSpy[0].name).toBe('work')
    }
  })

  it('handles multiple events in a single chunk', () => {
    client.processChunk('%session-created $1 a\n%session-closed $1\n')
    expect(client.dispatchSpy).toHaveLength(2)
    expect(client.dispatchSpy[0]?.type).toBe('session-created')
    expect(client.dispatchSpy[1]?.type).toBe('session-closed')
  })

  it('collects command response lines between %begin/%end', () => {
    client.processLine('%begin 1234 1 1')
    client.processLine('$1')
    client.processLine('%end 1234 1 0')
    // No events dispatched (command response, not notification)
    expect(client.dispatchSpy).toHaveLength(0)
  })
})

describe('createTmuxClient factory', () => {
  it('creates a TmuxClient instance', () => {
    const c = createTmuxClient()
    expect(c).toBeInstanceOf(TmuxClient)
  })

  it('accepts options', () => {
    const c = createTmuxClient({ socketPath: 'test', coalesceWindowMs: 100 })
    expect(c).toBeInstanceOf(TmuxClient)
  })
})

describe('TmuxClient createTerminalEmulator', () => {
  it('returns a TerminalEmulator synchronously', () => {
    const c = new TmuxClient()
    const emulator = c.createTerminalEmulator()
    expect(emulator).toBeDefined()
    expect(typeof emulator.write).toBe('function')
    expect(typeof emulator.getBuffer).toBe('function')
    expect(typeof emulator.getCursor).toBe('function')
  })

  it('getBuffer returns empty string initially', () => {
    const c = new TmuxClient()
    const emulator = c.createTerminalEmulator()
    expect(emulator.getBuffer()).toBe('')
  })

  it('write accumulates data accessible via getBuffer', () => {
    const c = new TmuxClient()
    const emulator = c.createTerminalEmulator()
    emulator.write('hello')
    emulator.write(' world')
    expect(emulator.getBuffer()).toContain('hello')
    expect(emulator.getBuffer()).toContain('world')
  })
})
