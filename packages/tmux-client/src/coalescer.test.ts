import { describe, it, expect, mock } from 'bun:test'
import { OutputCoalescer } from './coalescer.js'
import type { TmuxEvent } from './types.js'

function paneOutput(paneId: string, raw: string, sessionId = '$1'): Extract<TmuxEvent, { type: 'pane-output' }> {
  return {
    type: 'pane-output',
    paneId,
    sessionId,
    raw,
    timestamp: Date.now(),
  }
}

describe('OutputCoalescer', () => {
  it('calls onEvent with concatenated raw for multiple rapid events on same pane', async () => {
    const received: TmuxEvent[] = []
    const coalescer = new OutputCoalescer(50, (e) => received.push(e))

    coalescer.push(paneOutput('%1', 'hello '))
    coalescer.push(paneOutput('%1', 'world'))
    coalescer.push(paneOutput('%1', '!'))

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 100))

    expect(received).toHaveLength(1)
    const event = received[0]
    expect(event?.type).toBe('pane-output')
    if (event?.type === 'pane-output') {
      expect(event.paneId).toBe('%1')
      expect(event.raw).toBe('hello world!')
    }
  })

  it('calls separate callbacks for different panes', async () => {
    const received: TmuxEvent[] = []
    const coalescer = new OutputCoalescer(50, (e) => received.push(e))

    coalescer.push(paneOutput('%1', 'from pane 1'))
    coalescer.push(paneOutput('%2', 'from pane 2'))

    await new Promise((r) => setTimeout(r, 100))

    expect(received).toHaveLength(2)
    const pane1 = received.find((e) => e.type === 'pane-output' && e.paneId === '%1')
    const pane2 = received.find((e) => e.type === 'pane-output' && e.paneId === '%2')
    expect(pane1).toBeDefined()
    expect(pane2).toBeDefined()
    if (pane1?.type === 'pane-output') expect(pane1.raw).toBe('from pane 1')
    if (pane2?.type === 'pane-output') expect(pane2.raw).toBe('from pane 2')
  })

  it('window timeout fires callback even without a new event', async () => {
    const received: TmuxEvent[] = []
    const coalescer = new OutputCoalescer(30, (e) => received.push(e))

    coalescer.push(paneOutput('%3', 'data'))
    expect(received).toHaveLength(0)  // not yet

    await new Promise((r) => setTimeout(r, 80))
    expect(received).toHaveLength(1)
  })

  it('flush() forces all pending buffers to emit', () => {
    const received: TmuxEvent[] = []
    const coalescer = new OutputCoalescer(5000, (e) => received.push(e))

    coalescer.push(paneOutput('%1', 'pane1'))
    coalescer.push(paneOutput('%2', 'pane2'))
    expect(received).toHaveLength(0)

    coalescer.flush()
    expect(received).toHaveLength(2)
  })

  it('uses sessionId from first event in merged group', async () => {
    const received: TmuxEvent[] = []
    const coalescer = new OutputCoalescer(50, (e) => received.push(e))

    coalescer.push(paneOutput('%1', 'a', '$1'))
    coalescer.push(paneOutput('%1', 'b', '$2'))  // different sessionId, same pane

    await new Promise((r) => setTimeout(r, 100))

    expect(received).toHaveLength(1)
    const event = received[0]
    if (event?.type === 'pane-output') {
      expect(event.sessionId).toBe('$1')  // first event wins
      expect(event.raw).toBe('ab')
    }
  })

  it('does not emit after flush for same pane', () => {
    const received: TmuxEvent[] = []
    const coalescer = new OutputCoalescer(50, (e) => received.push(e))

    coalescer.push(paneOutput('%1', 'data'))
    coalescer.flush()

    expect(received).toHaveLength(1)
    // flush again — should not double-emit
    coalescer.flush()
    expect(received).toHaveLength(1)
  })
})
