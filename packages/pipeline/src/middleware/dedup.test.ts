import { describe, it, expect } from 'bun:test'
import { createDedupMiddleware } from './dedup.js'
import { buildContext } from '../context.js'
import type { TmuxEvent } from '@sirko/tmux-client'
import type { PaneState, DetectionResult, SignalBreakdown } from '@sirko/shared'

function makeEvent(): TmuxEvent {
  return {
    type: 'pane-output',
    paneId: '%1',
    sessionId: '$1',
    raw: 'hello',
    timestamp: Date.now(),
  }
}

function makePane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    paneId: '%1',
    sessionId: '$1',
    windowId: '@1',
    tool: 'claude-code',
    pid: 1234,
    status: 'running',
    exitCode: null,
    notificationState: 'idle',
    lastNotifiedAt: null,
    lastOutputTime: Date.now(),
    processingCount: 0,
    xtermInstance: null,
    lastBufferSnapshot: '> ',
    telegramTopicId: null,
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeDetectionResult(awaiting: boolean): DetectionResult {
  const signals: SignalBreakdown = {
    promptPattern: { matched: awaiting, pattern: awaiting ? '> ' : null, weight: 0.45, contribution: awaiting ? 0.45 : 0 },
    wchan: { value: awaiting ? 'pipe_read' : null, isWaiting: awaiting, weight: 0.35, contribution: awaiting ? 0.35 : 0 },
    quiescence: { silenceMs: awaiting ? 2000 : 100, threshold: 1800, weight: 0.20, contribution: awaiting ? 0.20 : 0 },
  }
  const score = awaiting ? 1.0 : 0.0
  return {
    score,
    awaiting,
    tool: 'claude-code',
    confidence: score,
    signals,
  }
}

describe('createDedupMiddleware', () => {
  it('aborts and does not call next when notified + awaiting', async () => {
    const dedup = createDedupMiddleware()
    const ctx = buildContext(makeEvent(), null)
    ctx.pane = makePane({ notificationState: 'notified' })
    ctx.detectionResult = makeDetectionResult(true)

    let nextCalled = false
    await dedup(ctx, async () => {
      nextCalled = true
    })

    expect(ctx.aborted).toBe(true)
    expect(nextCalled).toBe(false)
  })

  it('resets notificationState to idle and calls next when notified + not awaiting', async () => {
    const dedup = createDedupMiddleware()
    const ctx = buildContext(makeEvent(), null)
    ctx.pane = makePane({ notificationState: 'notified' })
    ctx.detectionResult = makeDetectionResult(false)

    let nextCalled = false
    await dedup(ctx, async () => {
      nextCalled = true
    })

    expect(ctx.aborted).toBe(false)
    expect(nextCalled).toBe(true)
    expect(ctx.pane?.notificationState).toBe('idle')
  })

  it('calls next when idle + awaiting (normal first notification)', async () => {
    const dedup = createDedupMiddleware()
    const ctx = buildContext(makeEvent(), null)
    ctx.pane = makePane({ notificationState: 'idle' })
    ctx.detectionResult = makeDetectionResult(true)

    let nextCalled = false
    await dedup(ctx, async () => {
      nextCalled = true
    })

    expect(ctx.aborted).toBe(false)
    expect(nextCalled).toBe(true)
  })

  it('calls next when idle + not awaiting', async () => {
    const dedup = createDedupMiddleware()
    const ctx = buildContext(makeEvent(), null)
    ctx.pane = makePane({ notificationState: 'idle' })
    ctx.detectionResult = makeDetectionResult(false)

    let nextCalled = false
    await dedup(ctx, async () => {
      nextCalled = true
    })

    expect(ctx.aborted).toBe(false)
    expect(nextCalled).toBe(true)
  })

  it('calls next when no pane is set', async () => {
    const dedup = createDedupMiddleware()
    const ctx = buildContext(makeEvent(), null)
    // pane is null
    ctx.detectionResult = makeDetectionResult(true)

    let nextCalled = false
    await dedup(ctx, async () => {
      nextCalled = true
    })

    expect(ctx.aborted).toBe(false)
    expect(nextCalled).toBe(true)
  })

  it('calls next when no detection result is set', async () => {
    const dedup = createDedupMiddleware()
    const ctx = buildContext(makeEvent(), null)
    ctx.pane = makePane({ notificationState: 'notified' })
    // no detectionResult

    let nextCalled = false
    await dedup(ctx, async () => {
      nextCalled = true
    })

    expect(ctx.aborted).toBe(false)
    expect(nextCalled).toBe(true)
  })

  it('records duration in middlewareDurations', async () => {
    const dedup = createDedupMiddleware()
    const ctx = buildContext(makeEvent(), null)
    ctx.pane = makePane({ notificationState: 'idle' })
    ctx.detectionResult = makeDetectionResult(false)

    await dedup(ctx, async () => {})

    expect(ctx.middlewareDurations['dedup']).toBeDefined()
    expect(typeof ctx.middlewareDurations['dedup']).toBe('number')
  })
})
