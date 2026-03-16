import { describe, it, expect, beforeEach } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { createStateStore } from '@sirko/state-store'
import { createEventBus } from '@sirko/event-bus'
import { DetectorEngine } from '@sirko/detector'
import type { WchanInspector } from '@sirko/detector'
import { assemblePipeline, buildContext } from '@sirko/pipeline'
import { BufferEmulator } from '@sirko/tmux-client'
import { QuiescenceScheduler } from './quiescence-scheduler.js'
import type { PaneState } from '@sirko/shared'
import type { TmuxClient } from '@sirko/tmux-client'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A WchanInspector that always returns a configurable value. */
function makeWchan(value: string | null = null): WchanInspector {
  return { readWchan: async (_pid: number) => value }
}

/**
 * Creates a minimal TmuxClient stub for use in pipeline tests.
 * Uses a real BufferEmulator so prompt patterns are matched from written text.
 */
function makeTmuxStub(): TmuxClient {
  return {
    getPanePid: async (_paneId: string): Promise<number | null> => 12345,
    capturePane: async (_paneId: string): Promise<string> => '',
    createTerminalEmulator: () => new BufferEmulator(),
    upgradeTerminalEmulator: async (): Promise<BufferEmulator> => new BufferEmulator(),
  } as unknown as TmuxClient
}

/** Creates a pre-populated PaneState for test injection. */
function makePane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    paneId: '%1',
    sessionId: '$1',
    windowId: '@1',
    tool: 'claude-code',
    pid: 12345,
    status: 'running',
    exitCode: null,
    notificationState: 'idle',
    lastNotifiedAt: null,
    lastOutputTime: Date.now(),
    processingCount: 0,
    xtermInstance: null,
    lastBufferSnapshot: '',
    telegramTopicId: null,
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

async function createTestDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sirko-test-'))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orchestrator integration', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await createTestDir()
  })

  it('Output burst then quiescence: PaneAwaitingInput emitted exactly once', async () => {
    const store = createStateStore({ persistPath: testDir })
    await store.load()
    const bus = createEventBus()
    // pipe_read wchan contributes 0.35 weight for claude-code
    const engine = new DetectorEngine({ wchanInspector: makeWchan('pipe_read') })
    const tmuxStub = makeTmuxStub()

    const pipeline = assemblePipeline({
      store,
      bus,
      tmuxClient: tmuxStub,
      engine,
      logDir: join(testDir, 'logs'),
    })

    const awaitingEvents: unknown[] = []
    bus.on('PaneAwaitingInput', (e): void => {
      awaitingEvents.push(e)
    })

    // Pre-seed pane as claude-code so detection score can cross threshold
    store.setPane('%1', makePane({ paneId: '%1', sessionId: '$1' }))

    // Feed 5 pane-output events with claude-code prompt pattern ("> " matches /^> $/m)
    for (let i = 0; i < 5; i++) {
      const event = {
        type: 'pane-output' as const,
        paneId: '%1',
        sessionId: '$1',
        raw: '> \n',
        timestamp: Date.now(),
      }
      await pipeline.run(buildContext(event, null))
    }

    // After the first run, pane should be notified and further runs should dedup
    expect(awaitingEvents.length).toBe(1)
  })

  it('Prompt pattern fires before quiescence', async () => {
    const store = createStateStore({ persistPath: testDir })
    await store.load()
    const bus = createEventBus()
    // pipe_read wchan contributes to score for claude-code
    const engine = new DetectorEngine({ wchanInspector: makeWchan('pipe_read') })
    const tmuxStub = makeTmuxStub()

    const pipeline = assemblePipeline({
      store,
      bus,
      tmuxClient: tmuxStub,
      engine,
      logDir: join(testDir, 'logs'),
    })

    const awaitingEvents: unknown[] = []
    bus.on('PaneAwaitingInput', (e): void => {
      awaitingEvents.push(e)
    })

    // Pre-seed pane as claude-code
    store.setPane('%2', makePane({ paneId: '%2', sessionId: '$1' }))

    // Single pane-output event with the claude-code prompt pattern
    const event = {
      type: 'pane-output' as const,
      paneId: '%2',
      sessionId: '$1',
      raw: '> \n',
      timestamp: Date.now(),
    }
    await pipeline.run(buildContext(event, null))

    // PaneAwaitingInput should have fired immediately
    // (prompt 0.45 + wchan 0.35 = 0.80 >= threshold 0.60)
    expect(awaitingEvents.length).toBe(1)
    const first = awaitingEvents[0] as { type: string; paneId: string }
    expect(first.type).toBe('PaneAwaitingInput')
    expect(first.paneId).toBe('%2')
  })

  it('Dedup suppression: no second PaneAwaitingInput after initial notification', async () => {
    const store = createStateStore({ persistPath: testDir })
    await store.load()
    const bus = createEventBus()
    const engine = new DetectorEngine({ wchanInspector: makeWchan('pipe_read') })
    const tmuxStub = makeTmuxStub()

    const pipeline = assemblePipeline({
      store,
      bus,
      tmuxClient: tmuxStub,
      engine,
      logDir: join(testDir, 'logs'),
    })

    const awaitingEvents: unknown[] = []
    bus.on('PaneAwaitingInput', (e): void => {
      awaitingEvents.push(e)
    })

    store.setPane('%3', makePane({ paneId: '%3', sessionId: '$1' }))

    const makeOutputEvent = () => ({
      type: 'pane-output' as const,
      paneId: '%3',
      sessionId: '$1',
      raw: '> \n',
      timestamp: Date.now(),
    })

    // First event triggers notification
    await pipeline.run(buildContext(makeOutputEvent(), null))
    expect(awaitingEvents.length).toBe(1)

    // Second and third events should be suppressed by dedup
    await pipeline.run(buildContext(makeOutputEvent(), null))
    await pipeline.run(buildContext(makeOutputEvent(), null))
    expect(awaitingEvents.length).toBe(1)
  })

  it('Input resets dedup: PaneAwaitingInput fires again after InputDelivered', async () => {
    const store = createStateStore({ persistPath: testDir })
    await store.load()
    const bus = createEventBus()
    const engine = new DetectorEngine({ wchanInspector: makeWchan('pipe_read') })
    const tmuxStub = makeTmuxStub()

    const pipeline = assemblePipeline({
      store,
      bus,
      tmuxClient: tmuxStub,
      engine,
      logDir: join(testDir, 'logs'),
    })

    const awaitingEvents: unknown[] = []
    bus.on('PaneAwaitingInput', (e): void => {
      awaitingEvents.push(e)
    })

    store.setPane('%4', makePane({ paneId: '%4', sessionId: '$1' }))

    const makeOutputEvent = () => ({
      type: 'pane-output' as const,
      paneId: '%4',
      sessionId: '$1',
      raw: '> \n',
      timestamp: Date.now(),
    })

    // First notification
    await pipeline.run(buildContext(makeOutputEvent(), null))
    expect(awaitingEvents.length).toBe(1)

    // Simulate input delivered by resetting notification state in the store
    const pane = store.getPane('%4')
    if (pane !== undefined) {
      store.setPane('%4', {
        ...pane,
        notificationState: 'idle',
        status: 'running',
        lastOutputTime: Date.now(),
        // Clear xtermInstance so a fresh emulator is used (prompt pattern matches again)
        xtermInstance: null,
        lastBufferSnapshot: '',
      })
    }

    // Second notification should fire after reset
    await pipeline.run(buildContext(makeOutputEvent(), null))
    expect(awaitingEvents.length).toBe(2)
  })

  it('PaneExited: PaneExited emitted on bus', async () => {
    const store = createStateStore({ persistPath: testDir })
    await store.load()
    const bus = createEventBus()
    const engine = new DetectorEngine({ wchanInspector: makeWchan(null) })
    const tmuxStub = makeTmuxStub()

    const pipeline = assemblePipeline({
      store,
      bus,
      tmuxClient: tmuxStub,
      engine,
      logDir: join(testDir, 'logs'),
    })

    const exitedEvents: unknown[] = []
    bus.on('PaneExited', (e): void => {
      exitedEvents.push(e)
    })

    const exitEvent = {
      type: 'pane-exited' as const,
      paneId: '%5',
      sessionId: '$1',
    }
    await pipeline.run(buildContext(exitEvent, null))

    expect(exitedEvents.length).toBe(1)
    const first = exitedEvents[0] as { type: string; paneId: string }
    expect(first.type).toBe('PaneExited')
    expect(first.paneId).toBe('%5')
  })

  it('QuiescenceScheduler: detects idle panes and sets status to awaiting-input', async () => {
    const store = createStateStore({ persistPath: testDir })
    await store.load()
    const bus = createEventBus()
    const engine = new DetectorEngine({ wchanInspector: makeWchan('pipe_read') })
    const tmuxStub = makeTmuxStub()

    const pipeline = assemblePipeline({
      store,
      bus,
      tmuxClient: tmuxStub,
      engine,
      logDir: join(testDir, 'logs'),
    })

    // Pre-populate pane with an old lastOutputTime to trigger quiescence
    // and lastBufferSnapshot containing the prompt pattern so score crosses threshold
    const pane = makePane({
      paneId: '%6',
      sessionId: '$1',
      status: 'running',
      processingCount: 0,
      // Far in the past — ensures quiescence score = 1.0
      lastOutputTime: Date.now() - 60_000,
      // Prompt pattern present in snapshot so score = prompt(0.45) + wchan(0.35) + quiescence(0.20) = 1.0
      lastBufferSnapshot: '> \n',
    })
    store.setPane('%6', pane)

    const scheduler = new QuiescenceScheduler(store, pipeline, 50)
    scheduler.start()

    // Wait for scheduler to tick and pipeline to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    scheduler.stop()

    // The scheduler should have triggered a pipeline run which detected awaiting-input
    // and updated the pane status via detection middleware
    const updatedPane = store.getPane('%6')
    expect(updatedPane?.status).toBe('awaiting-input')
  })
})
