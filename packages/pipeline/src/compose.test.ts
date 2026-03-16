import { describe, it, expect, mock } from 'bun:test'
import { compose, type Middleware } from './compose.js'
import { buildContext } from './context.js'
import type { TmuxEvent } from '@sirko/tmux-client'

function makeEvent(): TmuxEvent {
  return {
    type: 'pane-output',
    paneId: '%1',
    sessionId: '$1',
    raw: 'hello',
    timestamp: Date.now(),
  }
}

describe('compose', () => {
  it('calls all middlewares in order with correct ctx', async () => {
    const order: number[] = []

    const m1: Middleware = async (ctx, next) => {
      order.push(1)
      await next()
    }
    const m2: Middleware = async (ctx, next) => {
      order.push(2)
      await next()
    }
    const m3: Middleware = async (ctx, next) => {
      order.push(3)
      await next()
    }

    const pipeline = compose([m1, m2, m3])
    const ctx = buildContext(makeEvent(), null)
    await pipeline.run(ctx)

    expect(order).toEqual([1, 2, 3])
  })

  it('passes ctx reference through middlewares', async () => {
    const m1: Middleware = async (ctx, next) => {
      ctx.aborted = true
      await next()
    }
    const m2: Middleware = async (ctx, next) => {
      expect(ctx.aborted).toBe(true)
      await next()
    }

    const pipeline = compose([m1, m2])
    const ctx = buildContext(makeEvent(), null)
    await pipeline.run(ctx)
  })

  it('stops chain when middleware does not call next()', async () => {
    const order: number[] = []

    const m1: Middleware = async (ctx, next) => {
      order.push(1)
      await next()
    }
    const m2: Middleware = async (_ctx, _next) => {
      order.push(2)
      // does NOT call next()
    }
    const m3: Middleware = async (ctx, next) => {
      order.push(3)
      await next()
    }

    const pipeline = compose([m1, m2, m3])
    const ctx = buildContext(makeEvent(), null)
    await pipeline.run(ctx)

    expect(order).toEqual([1, 2])
    expect(order).not.toContain(3)
  })

  it('handles empty middleware array', async () => {
    const pipeline = compose([])
    const ctx = buildContext(makeEvent(), null)
    await expect(pipeline.run(ctx)).resolves.toBeUndefined()
  })

  it('propagates errors from middleware', async () => {
    const m1: Middleware = async (_ctx, _next) => {
      throw new Error('test error')
    }

    const pipeline = compose([m1])
    const ctx = buildContext(makeEvent(), null)
    await expect(pipeline.run(ctx)).rejects.toThrow('test error')
  })

  it('throws if next() is called multiple times', async () => {
    const m1: Middleware = async (_ctx, next) => {
      await next()
      await next()  // called twice — should throw
    }

    const pipeline = compose([m1])
    const ctx = buildContext(makeEvent(), null)
    await expect(pipeline.run(ctx)).rejects.toThrow()
  })

  it('wraps around correctly — pre/post execution works', async () => {
    const log: string[] = []

    const m1: Middleware = async (ctx, next) => {
      log.push('m1-pre')
      await next()
      log.push('m1-post')
    }
    const m2: Middleware = async (ctx, next) => {
      log.push('m2-pre')
      await next()
      log.push('m2-post')
    }

    const pipeline = compose([m1, m2])
    const ctx = buildContext(makeEvent(), null)
    await pipeline.run(ctx)

    expect(log).toEqual(['m1-pre', 'm2-pre', 'm2-post', 'm1-post'])
  })

  it('single middleware works', async () => {
    const called = { value: false }
    const m1: Middleware = async (ctx, next) => {
      called.value = true
      await next()
    }

    const pipeline = compose([m1])
    const ctx = buildContext(makeEvent(), null)
    await pipeline.run(ctx)

    expect(called.value).toBe(true)
  })
})
