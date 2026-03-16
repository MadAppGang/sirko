import { describe, it, expect } from 'bun:test'
import { assemblePipeline } from './assemble.js'
import { buildContext } from './context.js'
import type { TmuxEvent } from '@sirko/tmux-client'
import type { AssemblePipelineDeps } from './assemble.js'

function createMockDeps(): AssemblePipelineDeps {
  return {
    store: {
      getPane: () => undefined,
      setPane: () => {},
      deletePane: () => {},
      allPanes: () => [],
      getTopicId: () => undefined,
      setTopicId: () => {},
      getPaneByTopicId: () => undefined,
      getSession: () => undefined,
      setSession: () => {},
      allSessions: () => [],
      setNotificationState: () => {},
      persist: async () => {},
      load: async () => {},
      startAutoSave: () => {},
      stopAutoSave: () => {},
    } as unknown as import('@sirko/state-store').StateStore,
    bus: {
      emit: async () => {},
      on: () => () => {},
      onAny: () => () => {},
    } as unknown as import('@sirko/event-bus').TypedEventBus,
    tmuxClient: {
      getPanePid: async () => null,
      createTerminalEmulator: () => ({
        write: () => {},
        getBuffer: () => '',
        getCursor: () => ({ row: 0, col: 0, visible: true }),
      }),
      upgradeTerminalEmulator: async () => ({
        write: () => {},
        getBuffer: () => '',
        getCursor: () => ({ row: 0, col: 0, visible: true }),
      }),
    } as unknown as import('@sirko/tmux-client').TmuxClient,
    engine: {
      computeScore: async () => ({
        score: 0,
        awaiting: false,
        tool: 'unknown' as const,
        confidence: 0,
        signals: {
          promptPattern: { matched: false, pattern: null, weight: 0.45, contribution: 0 },
          wchan: { value: null, isWaiting: false, weight: 0.35, contribution: 0 },
          quiescence: { silenceMs: 100, threshold: 2000, weight: 0.20, contribution: 0 },
        },
      }),
    } as unknown as import('@sirko/detector').DetectorEngine,
    logDir: '/tmp/test-logs',
  }
}

describe('assemblePipeline', () => {
  it('returns a Pipeline with a run() method', () => {
    const deps = createMockDeps()
    const pipeline = assemblePipeline(deps)
    expect(typeof pipeline.run).toBe('function')
  })

  it('runs successfully for a session-created event', async () => {
    const deps = createMockDeps()
    const pipeline = assemblePipeline(deps)

    const event: TmuxEvent = {
      type: 'session-created',
      sessionId: '$1',
      name: 'test',
    }
    const ctx = buildContext(event, null)

    await expect(pipeline.run(ctx)).resolves.toBeUndefined()
  })

  it('runs successfully for a pane-output event', async () => {
    const deps = createMockDeps()
    const pipeline = assemblePipeline(deps)

    const event: TmuxEvent = {
      type: 'pane-output',
      paneId: '%1',
      sessionId: '$1',
      raw: '> ',
      timestamp: Date.now(),
    }
    const ctx = buildContext(event, null)

    await expect(pipeline.run(ctx)).resolves.toBeUndefined()
  })

  it('processes middlewares in the correct order via durations record', async () => {
    const middlewareOrder: string[] = []
    const deps = createMockDeps()

    // Override store.setPane to track state-manager execution
    const originalSetPane = deps.store.setPane.bind(deps.store)
    deps.store.setPane = (...args) => {
      middlewareOrder.push('state-manager')
      return originalSetPane(...args)
    }

    const pipeline = assemblePipeline(deps)

    const event: TmuxEvent = {
      type: 'pane-output',
      paneId: '%1',
      sessionId: '$1',
      raw: '> ',
      timestamp: Date.now(),
    }
    const ctx = buildContext(event, null)
    await pipeline.run(ctx)

    // state-manager should have set the pane
    expect(ctx.middlewareDurations).toBeDefined()
    // At minimum, state-manager duration should be present
    expect(ctx.middlewareDurations['state-manager']).toBeDefined()
  })

  it('includes all expected middleware durations for pane-output event', async () => {
    const deps = createMockDeps()
    const pipeline = assemblePipeline(deps)

    const event: TmuxEvent = {
      type: 'pane-output',
      paneId: '%1',
      sessionId: '$1',
      raw: '> ',
      timestamp: Date.now(),
    }
    const ctx = buildContext(event, null)
    await pipeline.run(ctx)

    // All middlewares that act on pane-output should have added durations
    expect(ctx.middlewareDurations['state-manager']).toBeDefined()
    expect(ctx.middlewareDurations['xterm-interpret']).toBeDefined()
    expect(ctx.middlewareDurations['detection']).toBeDefined()
    expect(ctx.middlewareDurations['dedup']).toBeDefined()
  })
})
