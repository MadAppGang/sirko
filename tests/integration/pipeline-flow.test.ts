/**
 * Integration test: pipeline-flow
 *
 * Validates the end-to-end flow from a mock TmuxEvent through the composed
 * middleware pipeline to EventBus event emission.
 *
 * Black box: imports only from public package index files.
 * Tests validate behavior described in requirements, not implementation details.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { createEventBus } from '@sirko/event-bus'
import { buildContext, compose } from '@sirko/pipeline'
import type { EventContext, Middleware } from '@sirko/pipeline'
import type { SirkoEvent } from '@sirko/shared'
import type { TmuxEvent } from '@sirko/tmux-client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePaneOutputEvent(paneId: string, sessionId: string, raw: string): TmuxEvent {
  return {
    type: 'pane-output',
    paneId,
    sessionId,
    raw,
    timestamp: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// TEST GROUP: compose() middleware ordering
// ---------------------------------------------------------------------------

describe('compose() — middleware ordering and context propagation', () => {
  it('TEST-034: executes middleware in registration order', async () => {
    const trace: string[] = []

    const mwA: Middleware = async (_ctx, next) => { trace.push('A'); await next() }
    const mwB: Middleware = async (_ctx, next) => { trace.push('B'); await next() }
    const mwC: Middleware = async (_ctx, next) => { trace.push('C'); await next() }

    const pipeline = compose([mwA, mwB, mwC])
    const event = makePaneOutputEvent('%1', '$1', 'hello')
    const ctx = buildContext(event, null)

    await pipeline.run(ctx)

    expect(trace).toEqual(['A', 'B', 'C'])
  })

  it('TEST-035: middleware can read and modify shared context', async () => {
    // Use sideEffects as a mutable context field accessible to all middleware
    let observedSideEffectCount = -1

    const mwA: Middleware = async (ctx, next) => {
      ctx.sideEffects.push({ kind: 'file-append', path: '/tmp/test.log', content: 'a' })
      await next()
    }
    const mwB: Middleware = async (ctx, next) => {
      observedSideEffectCount = ctx.sideEffects.length
      await next()
    }

    const pipeline = compose([mwA, mwB])
    const event = makePaneOutputEvent('%1', '$1', 'hello')
    const ctx = buildContext(event, null)

    await pipeline.run(ctx)

    expect(observedSideEffectCount).toBe(1)
  })

  it('TEST-036: error in middleware stops chain; subsequent middleware does not execute', async () => {
    const trace: string[] = []

    const mwA: Middleware = async (_ctx, next) => { trace.push('A'); await next() }
    const mwB: Middleware = async (_ctx, _next) => { throw new Error('mwB intentional failure') }
    const mwC: Middleware = async (_ctx, next) => { trace.push('C'); await next() }

    const pipeline = compose([mwA, mwB, mwC])
    const event = makePaneOutputEvent('%1', '$1', 'hello')
    const ctx = buildContext(event, null)

    await expect(pipeline.run(ctx)).rejects.toThrow('mwB intentional failure')

    // mwA ran, mwC did NOT run (mwB threw before calling next)
    expect(trace).toContain('A')
    expect(trace).not.toContain('C')
  })

  it('TEST-037: buildContext returns valid EventContext with required fields', () => {
    const event = makePaneOutputEvent('%3', '$2', '\x1b[32mhello\x1b[0m')
    const ctx = buildContext(event, null)

    expect(ctx.event).toBe(event)
    expect(typeof ctx.startedAt).toBe('number')
    expect(ctx.startedAt).toBeGreaterThan(0)
    expect(ctx.aborted).toBe(false)
    expect(Array.isArray(ctx.sideEffects)).toBe(true)
    expect(typeof ctx.middlewareDurations).toBe('object')
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP: EventBus integration in pipeline
// ---------------------------------------------------------------------------

describe('EventBus integration in pipeline — TEST-047', () => {
  it('TEST-047: bus-emit side effect causes EventBus to deliver PaneOutput event', async () => {
    const bus = createEventBus()
    const received: SirkoEvent[] = []

    bus.on('PaneOutput', (ev) => { received.push(ev) })

    // Middleware that emits a PaneOutput event via bus side effect, then the bus is driven manually
    const emitMiddleware: Middleware = async (ctx, next) => {
      const outputEvent: SirkoEvent = {
        type: 'PaneOutput',
        paneId: ctx.event.paneId ?? '%1',
        sessionId: (ctx.event as { sessionId?: string }).sessionId ?? '$1',
        text: 'decoded output',
        raw: ctx.event.type === 'pane-output' ? (ctx.event as { raw: string }).raw : '',
        timestamp: ctx.startedAt,
      }
      ctx.sideEffects.push({ kind: 'bus-emit', event: outputEvent })
      await next()
    }

    // A second middleware that drives side effects (simulates notification-fanout behavior)
    const driveSideEffects: Middleware = async (ctx, next) => {
      await next()
      for (const fx of ctx.sideEffects) {
        if (fx.kind === 'bus-emit') {
          await bus.emit(fx.event)
        }
      }
    }

    const pipeline = compose([driveSideEffects, emitMiddleware])
    const event = makePaneOutputEvent('%5', '$1', 'raw terminal data')
    const ctx = buildContext(event, null)

    await pipeline.run(ctx)

    expect(received).toHaveLength(1)
    expect(received[0]).toBeDefined()
    const ev = received[0]!
    expect(ev.type).toBe('PaneOutput')
    if (ev.type === 'PaneOutput') {
      expect(ev.paneId).toBe('%5')
      expect(ev.text).toBe('decoded output')
    }
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP: buildContext for quiescence synthetic event
// ---------------------------------------------------------------------------

describe('buildContext — quiescence-check event', () => {
  it('produces a valid context for synthetic quiescence-check events', () => {
    const event: TmuxEvent = {
      type: 'quiescence-check',
      paneId: '%2',
      sessionId: '$1',
    }
    const ctx = buildContext(event, null)

    expect(ctx.event.type).toBe('quiescence-check')
    expect(ctx.event.paneId).toBe('%2')
    expect(ctx.aborted).toBe(false)
    expect(ctx.sideEffects).toHaveLength(0)
  })
})
