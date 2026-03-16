import { createStateStore } from '@sirko/state-store'
import { createEventBus } from '@sirko/event-bus'
import { createTmuxClient } from '@sirko/tmux-client'
import { createDetectorEngine } from '@sirko/detector'
import { assemblePipeline, buildContext } from '@sirko/pipeline'
import { loadConfig } from './config.js'
import { QuiescenceScheduler } from './quiescence-scheduler.js'
import { PaneSerializer } from './pane-serializer.js'

async function main(): Promise<void> {
  // 1. Load config
  const config = loadConfig()

  console.log('[sirko] starting orchestrator', {
    dataDir: config.dataDir,
    logLevel: config.logLevel,
    tmuxSocketPath: config.tmuxSocketPath,
  })

  // 2. Create and load StateStore
  const store = createStateStore({
    persistPath: config.dataDir,
  })
  await store.load()

  // 3. Create EventBus
  const bus = createEventBus()

  // 4. Create TmuxClient
  const tmuxClient = createTmuxClient({
    ...(config.tmuxSocketPath !== undefined ? { socketPath: config.tmuxSocketPath } : {}),
    coalesceWindowMs: config.outputCoalesceWindowMs,
  })

  // 5. Connect to tmux
  await tmuxClient.connect()
  console.log('[sirko] connected to tmux')

  // 6. Reconcile restored panes with current tmux state
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

  // 7. Create detector engine
  const engine = createDetectorEngine()

  // 8. Assemble pipeline
  const pipeline = assemblePipeline({
    store,
    bus,
    tmuxClient,
    engine,
    logDir: config.logDir,
  })

  // Phase 6: log events to stdout (Phase 7 will add Telegram/Voice adapters)
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
  scheduler.start()

  // 10. Start auto-save
  store.startAutoSave()

  // 11. Register shutdown handlers
  const shutdown = async (): Promise<void> => {
    console.log('[sirko] shutting down...')
    scheduler.stop()
    store.stopAutoSave()
    await store.persist()
    await tmuxClient.disconnect()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    shutdown().catch((err: unknown) => {
      console.error('[sirko] shutdown error', err)
      process.exit(1)
    })
  })
  process.on('SIGTERM', () => {
    shutdown().catch((err: unknown) => {
      console.error('[sirko] shutdown error', err)
      process.exit(1)
    })
  })

  // 12. Process tmux events with per-pane serialization
  console.log('[sirko] listening for tmux events...')
  for await (const event of tmuxClient.events()) {
    const key = 'paneId' in event && event.paneId ? event.paneId : 'session'
    serializer.runForPane(key, () => pipeline.run(buildContext(event, null)))
  }
}

main().catch((err: unknown) => {
  console.error('[sirko] fatal error', err)
  process.exit(1)
})
