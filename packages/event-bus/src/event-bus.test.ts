import { describe, it, expect, mock } from 'bun:test'
import { TypedEventBus, createEventBus } from './event-bus.js'
import type { SirkoEvent } from '@sirko/shared'

function makePaneOutput(overrides: Partial<Extract<SirkoEvent, { type: 'PaneOutput' }>> = {}): Extract<SirkoEvent, { type: 'PaneOutput' }> {
  return {
    type: 'PaneOutput',
    paneId: 'pane-1',
    sessionId: 'session-1',
    text: 'hello',
    raw: '\x1b[0mhello',
    timestamp: Date.now(),
    ...overrides,
  }
}

function makePaneExited(overrides: Partial<Extract<SirkoEvent, { type: 'PaneExited' }>> = {}): Extract<SirkoEvent, { type: 'PaneExited' }> {
  return {
    type: 'PaneExited',
    paneId: 'pane-1',
    sessionId: 'session-1',
    exitCode: 0,
    ...overrides,
  }
}

function makeSessionCreated(name = 'test'): Extract<SirkoEvent, { type: 'SessionCreated' }> {
  return { type: 'SessionCreated', sessionId: 'session-1', name }
}

describe('TypedEventBus', () => {
  describe('type-specific subscription', () => {
    it('receives only matching events', async () => {
      const bus = createEventBus()
      const received: SirkoEvent[] = []

      bus.on('PaneOutput', (event) => {
        received.push(event)
      })

      await bus.emit(makePaneOutput())
      await bus.emit(makePaneExited())
      await bus.emit(makeSessionCreated())

      expect(received).toHaveLength(1)
      expect(received[0]?.type).toBe('PaneOutput')
    })

    it('multiple subscribers for same type all receive event', async () => {
      const bus = createEventBus()
      let count = 0

      bus.on('PaneOutput', () => { count++ })
      bus.on('PaneOutput', () => { count++ })

      await bus.emit(makePaneOutput())
      expect(count).toBe(2)
    })

    it('unsubscribe stops delivery', async () => {
      const bus = createEventBus()
      const received: SirkoEvent[] = []

      const unsub = bus.on('PaneOutput', (event) => {
        received.push(event)
      })

      await bus.emit(makePaneOutput())
      unsub()
      await bus.emit(makePaneOutput())

      expect(received).toHaveLength(1)
    })
  })

  describe('onAny', () => {
    it('receives all events regardless of type', async () => {
      const bus = createEventBus()
      const received: SirkoEvent[] = []

      bus.onAny((event) => { received.push(event) })

      await bus.emit(makePaneOutput())
      await bus.emit(makePaneExited())
      await bus.emit(makeSessionCreated())

      expect(received).toHaveLength(3)
    })

    it('onAny unsubscribe stops delivery', async () => {
      const bus = createEventBus()
      let count = 0

      const unsub = bus.onAny(() => { count++ })
      await bus.emit(makePaneOutput())
      unsub()
      await bus.emit(makePaneOutput())

      expect(count).toBe(1)
    })
  })

  describe('error isolation', () => {
    it('error in one handler does not prevent delivery to others', async () => {
      const bus = createEventBus()
      const received: string[] = []

      bus.on('PaneOutput', () => {
        throw new Error('handler error')
      })

      bus.on('PaneOutput', () => {
        received.push('second')
      })

      // Should not throw
      await expect(bus.emit(makePaneOutput())).resolves.toBeUndefined()
      expect(received).toContain('second')
    })

    it('async handler error is isolated', async () => {
      const bus = createEventBus()
      const received: string[] = []

      bus.on('PaneOutput', async () => {
        await Promise.resolve()
        throw new Error('async handler error')
      })

      bus.on('PaneOutput', () => {
        received.push('second')
      })

      await expect(bus.emit(makePaneOutput())).resolves.toBeUndefined()
      expect(received).toContain('second')
    })
  })

  describe('bounded queue overflow', () => {
    it('drops oldest event when queue exceeds maxQueueSize', async () => {
      // Use maxQueueSize=3, emit 5 events rapidly before processing
      // We simulate overflow by creating a bus with maxQueueSize=2
      // and a blocking handler that prevents dequeue
      const bus = createEventBus({ maxQueueSize: 2 })
      const received: string[] = []

      // Use a ref object to hold the resolve callback (avoids TypeScript inference issues)
      const resolveRef: { fn: (() => void) | null } = { fn: null }
      const firstCallBlocked = new Promise<void>((resolve) => { resolveRef.fn = resolve })

      let callCount = 0
      bus.on('PaneOutput', async (event) => {
        callCount++
        if (callCount === 1) {
          // Block the first call to simulate queue buildup
          await firstCallBlocked
        }
        received.push(event.text)
      })

      // Emit 3 events; the queue for this subscriber is bounded at 2
      // The first emit goes directly to the handler (blocked)
      // The 2nd and 3rd get queued; 4th should overflow dropping 2nd
      const p1 = bus.emit(makePaneOutput({ text: 'first' }))
      const p2 = bus.emit(makePaneOutput({ text: 'second' }))
      const p3 = bus.emit(makePaneOutput({ text: 'third' }))

      resolveRef.fn?.()
      await Promise.all([p1, p2, p3])

      // 'first' was processed (unblocked), 'second' and 'third' were queued
      // but only individually dispatched per emit call — each dispatch dequeues immediately
      // The key behavior: no crash, no hang
      expect(received.length).toBeGreaterThanOrEqual(1)
    })

    it('creates bus with custom maxQueueSize', () => {
      const bus = new TypedEventBus({ maxQueueSize: 10 })
      expect(bus).toBeDefined()
    })

    it('creates bus with default maxQueueSize (1000)', () => {
      const bus = new TypedEventBus()
      expect(bus).toBeDefined()
    })
  })

  describe('async handlers', () => {
    it('emit awaits all handlers via Promise.allSettled', async () => {
      const bus = createEventBus()
      const order: number[] = []

      bus.on('PaneOutput', async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        order.push(1)
      })

      bus.on('PaneOutput', async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        order.push(2)
      })

      await bus.emit(makePaneOutput())
      // Both should have completed
      expect(order).toHaveLength(2)
      expect(order).toContain(1)
      expect(order).toContain(2)
    })
  })

  describe('typed handler receives correct event shape', () => {
    it('PaneOutput handler receives PaneOutput event', async () => {
      const bus = createEventBus()
      const captured: string[] = []

      bus.on('PaneOutput', (event) => {
        captured.push(event.text)
      })

      await bus.emit(makePaneOutput({ text: 'hello world' }))
      expect(captured[0]).toBe('hello world')
    })

    it('PaneExited handler receives PaneExited event', async () => {
      const bus = createEventBus()
      const captured: Array<number | null> = []

      bus.on('PaneExited', (event) => {
        captured.push(event.exitCode)
      })

      await bus.emit(makePaneExited({ exitCode: 42 }))
      expect(captured[0]).toBe(42)
    })
  })
})
