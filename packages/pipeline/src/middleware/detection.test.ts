import { describe, it, expect } from 'bun:test'
import { createDetectionMiddleware } from './detection.js'
import { buildContext } from '../context.js'
import type { TmuxEvent } from '@sirko/tmux-client'
import type { PaneState, DetectionResult, SignalBreakdown } from '@sirko/shared'
import type { DetectorEngine } from '@sirko/detector'
import type { SkillDefinition } from '@sirko/tool-plugins'

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
    lastOutputTime: Date.now() - 2000,
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

function makeDetectionResult(awaiting: boolean, score = 0.8): DetectionResult {
  const signals: SignalBreakdown = {
    promptPattern: { matched: awaiting, pattern: awaiting ? '> ' : null, weight: 0.45, contribution: awaiting ? 0.45 : 0 },
    wchan: { value: awaiting ? 'pipe_read' : null, isWaiting: awaiting, weight: 0.35, contribution: awaiting ? 0.35 : 0 },
    quiescence: { silenceMs: awaiting ? 2000 : 100, threshold: 1800, weight: 0.20, contribution: awaiting ? 0.20 : 0 },
  }
  return {
    score,
    awaiting,
    tool: 'claude-code',
    confidence: score,
    signals,
  }
}

function createMockEngine(result: DetectionResult): DetectorEngine {
  const calls: Array<{ pane: PaneState; xtermBuffer: string; skill: SkillDefinition }> = []

  return {
    computeScore: async (pane: PaneState, xtermBuffer: string, skill: SkillDefinition) => {
      calls.push({ pane, xtermBuffer, skill })
      return result
    },
    // expose calls for assertions
    _calls: calls,
  } as unknown as DetectorEngine
}

describe('createDetectionMiddleware', () => {
  it('skips detection for non-pane events', async () => {
    const engine = createMockEngine(makeDetectionResult(true))
    const detection = createDetectionMiddleware(engine)

    const event: TmuxEvent = { type: 'session-created', sessionId: '$1', name: 'test' }
    const ctx = buildContext(event, null)

    let nextCalled = false
    await detection(ctx, async () => {
      nextCalled = true
    })

    expect(nextCalled).toBe(true)
    expect(ctx.detectionResult).toBeUndefined()
  })

  it('skips detection when pane is null', async () => {
    const engine = createMockEngine(makeDetectionResult(true))
    const detection = createDetectionMiddleware(engine)

    const event: TmuxEvent = {
      type: 'pane-output',
      paneId: '%1',
      sessionId: '$1',
      raw: '> ',
      timestamp: Date.now(),
    }
    const ctx = buildContext(event, null)
    // pane is null

    let nextCalled = false
    await detection(ctx, async () => {
      nextCalled = true
    })

    expect(nextCalled).toBe(true)
    expect(ctx.detectionResult).toBeUndefined()
  })

  it('runs detection for pane-output events and sets detectionResult', async () => {
    const result = makeDetectionResult(true)
    const engine = createMockEngine(result)
    const detection = createDetectionMiddleware(engine)

    const event: TmuxEvent = {
      type: 'pane-output',
      paneId: '%1',
      sessionId: '$1',
      raw: '> ',
      timestamp: Date.now(),
    }
    const pane = makePane()
    const ctx = buildContext(event, pane)
    ctx.pane = pane
    ctx.xtermBuffer = '> '

    let nextCalled = false
    await detection(ctx, async () => {
      nextCalled = true
    })

    expect(nextCalled).toBe(true)
    expect(ctx.detectionResult).toBeDefined()
    expect(ctx.detectionResult?.awaiting).toBe(true)
  })

  it('runs detection for quiescence-check events', async () => {
    const result = makeDetectionResult(false, 0.1)
    const engine = createMockEngine(result)
    const detection = createDetectionMiddleware(engine)

    const event: TmuxEvent = {
      type: 'quiescence-check',
      paneId: '%1',
      sessionId: '$1',
    }
    const pane = makePane()
    const ctx = buildContext(event, pane)
    ctx.pane = pane

    await detection(ctx, async () => {})

    expect(ctx.detectionResult).toBeDefined()
    expect(ctx.detectionResult?.awaiting).toBe(false)
  })

  it('sets pane status to awaiting-input when detection says awaiting', async () => {
    const result = makeDetectionResult(true)
    const engine = createMockEngine(result)
    const detection = createDetectionMiddleware(engine)

    const event: TmuxEvent = {
      type: 'pane-output',
      paneId: '%1',
      sessionId: '$1',
      raw: '> ',
      timestamp: Date.now(),
    }
    const pane = makePane({ status: 'running' })
    const ctx = buildContext(event, pane)
    ctx.pane = pane
    ctx.xtermBuffer = '> '

    await detection(ctx, async () => {})

    expect(ctx.pane?.status).toBe('awaiting-input')
  })

  it('resets pane status to running when detection says not awaiting and was awaiting', async () => {
    const result = makeDetectionResult(false, 0.1)
    const engine = createMockEngine(result)
    const detection = createDetectionMiddleware(engine)

    const event: TmuxEvent = {
      type: 'pane-output',
      paneId: '%1',
      sessionId: '$1',
      raw: 'working...',
      timestamp: Date.now(),
    }
    const pane = makePane({ status: 'awaiting-input' })
    const ctx = buildContext(event, pane)
    ctx.pane = pane
    ctx.xtermBuffer = 'working...'

    await detection(ctx, async () => {})

    expect(ctx.pane?.status).toBe('running')
  })

  it('calls computeScore with correct pane and xtermBuffer', async () => {
    const result = makeDetectionResult(false)
    const capturedCalls: Array<{ pane: PaneState; xtermBuffer: string }> = []
    const engine: DetectorEngine = {
      computeScore: async (pane: PaneState, xtermBuffer: string) => {
        capturedCalls.push({ pane, xtermBuffer })
        return result
      },
    } as unknown as DetectorEngine

    const detection = createDetectionMiddleware(engine)

    const event: TmuxEvent = {
      type: 'pane-output',
      paneId: '%1',
      sessionId: '$1',
      raw: 'output',
      timestamp: Date.now(),
    }
    const pane = makePane()
    const ctx = buildContext(event, pane)
    ctx.pane = pane
    ctx.xtermBuffer = 'output text'

    await detection(ctx, async () => {})

    expect(capturedCalls).toHaveLength(1)
    expect(capturedCalls[0]?.pane).toBe(ctx.pane)
    expect(capturedCalls[0]?.xtermBuffer).toBe('output text')
  })

  it('continues pipeline even when computeScore throws', async () => {
    const engine: DetectorEngine = {
      computeScore: async () => {
        throw new Error('detection failure')
      },
    } as unknown as DetectorEngine

    const detection = createDetectionMiddleware(engine)

    const event: TmuxEvent = {
      type: 'pane-output',
      paneId: '%1',
      sessionId: '$1',
      raw: '> ',
      timestamp: Date.now(),
    }
    const pane = makePane()
    const ctx = buildContext(event, pane)
    ctx.pane = pane

    let nextCalled = false
    await detection(ctx, async () => {
      nextCalled = true
    })

    expect(nextCalled).toBe(true)
    expect(ctx.detectionResult).toBeUndefined()
  })
})
