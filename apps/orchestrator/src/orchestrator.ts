import { createStateStore } from '@sirko/state-store'
import { createEventBus, type TypedEventBus } from '@sirko/event-bus'
import { createTmuxClient, type TmuxClient } from '@sirko/tmux-client'
import { createDetectorEngine } from '@sirko/detector'
import { assemblePipeline, buildContext, type Pipeline } from '@sirko/pipeline'
import type { StateStore } from '@sirko/state-store'
import type { OrchestratorConfig } from './config.js'
import { QuiescenceScheduler } from './quiescence-scheduler.js'
import { PaneSerializer } from './pane-serializer.js'

export interface OrchestratorHandle {
  readonly store: StateStore
  readonly bus: TypedEventBus
  readonly tmuxClient: TmuxClient
  readonly pipeline: Pipeline
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Creates and wires all orchestrator components without starting the event loop.
 * Call handle.start() to begin processing tmux events.
 * Call handle.stop() for clean teardown (does NOT call process.exit).
 */
export async function createOrchestrator(
  config: OrchestratorConfig,
): Promise<OrchestratorHandle> {
  console.log('[sirko] creating orchestrator', {
    dataDir: config.dataDir,
    logLevel: config.logLevel,
    tmuxSocketPath: config.tmuxSocketPath,
  })

  // 1. Create and load StateStore
  const store = createStateStore({
    persistPath: config.dataDir,
  })
  await store.load()

  // 2. Create EventBus
  const bus = createEventBus()

  // 3. Create TmuxClient
  const tmuxClient = createTmuxClient({
    ...(config.tmuxSocketPath !== undefined ? { socketPath: config.tmuxSocketPath } : {}),
    coalesceWindowMs: config.outputCoalesceWindowMs,
  })

  // 4. Connect to tmux
  await tmuxClient.connect()
  console.log('[sirko] connected to tmux')

  // 5. Reconcile restored panes with current tmux state
  const restoredPanes = store.allPanes()
  if (restoredPanes.length > 0) {
    console.log('[sirko] reconciling', restoredPanes.length, 'restored panes')
    for (const pane of restoredPanes) {
      try {
        await tmuxClient.capturePane(pane.paneId)
      } catch {
        // Pane may no longer exist; leave in store for now (state-manager will handle)
      }
    }
  }

  // 6. Create detector engine
  const engine = createDetectorEngine()

  // 7. Assemble pipeline
  const pipeline = assemblePipeline({
    store,
    bus,
    tmuxClient,
    engine,
    logDir: config.logDir,
    logLevel: config.logLevel,
  })

  // 8. Log events to stdout
  bus.on('PaneOutput', (event) => {
    if (config.logLevel === 'debug') {
      console.log('[bus] PaneOutput', event.paneId, event.text.slice(0, 80))
    }
  })
  bus.on('PaneAwaitingInput', (event) => {
    console.log('[bus] PaneAwaitingInput', {
      paneId: event.paneId,
      tool: event.tool,
      score: event.score,
      confidence: event.confidence,
    })
  })
  bus.on('PaneExited', (event) => {
    console.log('[bus] PaneExited', { paneId: event.paneId, exitCode: event.exitCode })
  })

  // 9. Create per-pane serializer and quiescence scheduler
  const serializer = new PaneSerializer()

  const scheduler = new QuiescenceScheduler(
    store,
    pipeline,
    config.quiescenceCheckIntervalMs,
  )

  let eventLoopAbort: AbortController | null = null

  const handle: OrchestratorHandle = {
    store,
    bus,
    tmuxClient,
    pipeline,

    async start(): Promise<void> {
      scheduler.start()
      store.startAutoSave()

      eventLoopAbort = new AbortController()
      const { signal } = eventLoopAbort

      console.log('[sirko] listening for tmux events...')

      // Process tmux events — runs until stop() is called
      const processEvents = async () => {
        for await (const event of tmuxClient.events()) {
          if (signal.aborted) break
          const key = 'paneId' in event && event.paneId ? event.paneId : 'session'
          serializer.runForPane(key, () => pipeline.run(buildContext(event, null)))
        }
      }

      // Fire and forget — the loop exits when tmuxClient.disconnect() is called
      processEvents().catch((err: unknown) => {
        if (!signal.aborted) {
          console.error('[sirko] event loop error', err)
        }
      })
    },

    async stop(): Promise<void> {
      console.log('[sirko] shutting down...')
      eventLoopAbort?.abort()
      scheduler.stop()
      store.stopAutoSave()
      await store.persist()
      await tmuxClient.disconnect()
    },
  }

  return handle
}
