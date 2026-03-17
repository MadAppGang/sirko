/**
 * E2E: Orchestrator lifecycle — boot, connect, stop, reconcile on restart.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { TmuxTestHarness } from './helpers/tmux-harness.js'
import { OrchestratorHarness } from './helpers/orchestrator-harness.js'

describe('orchestrator-lifecycle', () => {
  const tmux = new TmuxTestHarness()
  const orch = new OrchestratorHarness({ tmuxSocketName: tmux.socketName })

  beforeAll(async () => {
    await tmux.setup()
  })

  afterAll(async () => {
    await orch.cleanup()
    await tmux.teardown()
  })

  it('boots, connects to real tmux, lists sessions, and stops cleanly', async () => {
    const handle = await orch.start()
    tmux.bindClient(handle.tmuxClient)

    // Verify we can list sessions via the real tmux client
    const sessions = await tmux.listSessions()
    expect(sessions.length).toBeGreaterThanOrEqual(1)

    // Stop cleanly — should not throw
    await orch.stop()
  })

  it('reconciles restored panes on restart with same dataDir', async () => {
    // Start orchestrator, create a pane entry in the store
    const handle1 = await orch.start()
    tmux.bindClient(handle1.tmuxClient)

    // Get the initial pane from the tmux session
    const panes = await tmux.listPanes()
    expect(panes.length).toBeGreaterThanOrEqual(1)

    // Store a pane reference
    const firstPane = panes[0]!
    handle1.store.setPane(firstPane.paneId, {
      paneId: firstPane.paneId,
      sessionId: firstPane.sessionId,
      windowId: firstPane.windowId,
      tool: 'unknown',
      pid: null,
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
    })

    // Persist and stop
    await handle1.store.persist()
    await orch.stop()

    // Create a new OrchestratorHarness reusing the same dataDir
    const dataDir = orch.dataDir
    const orch2 = new OrchestratorHarness({
      tmuxSocketName: tmux.socketName,
      configOverrides: { dataDir },
    })

    const handle2 = await orch2.start()

    // The restored pane should be in the store
    const restored = handle2.store.allPanes()
    expect(restored.length).toBeGreaterThanOrEqual(1)
    expect(restored.some((p) => p.paneId === firstPane.paneId)).toBe(true)

    await orch2.cleanup()
  })
})
