/**
 * E2E: Detection roundtrip — output events, PaneAwaitingInput, no false positives.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { resolve } from 'node:path'
import type { SirkoEvent } from '@sirko/shared'
import { TmuxTestHarness } from './helpers/tmux-harness.js'
import { OrchestratorHarness } from './helpers/orchestrator-harness.js'
import { waitFor } from './helpers/wait-for.js'

const FIXTURES = resolve(import.meta.dir, 'fixtures')

describe('detection-roundtrip', () => {
  const tmux = new TmuxTestHarness()
  const orch = new OrchestratorHarness({ tmuxSocketName: tmux.socketName })
  const outputEvents: Array<Extract<SirkoEvent, { type: 'PaneOutput' }>> = []
  const awaitingEvents: Array<Extract<SirkoEvent, { type: 'PaneAwaitingInput' }>> = []
  let unsubs: Array<() => void> = []

  beforeAll(async () => {
    await tmux.setup()
    const handle = await orch.start()
    tmux.bindClient(handle.tmuxClient)

    // Subscribe to bus events
    unsubs.push(
      handle.bus.on('PaneOutput', (e) => outputEvents.push(e)),
      handle.bus.on('PaneAwaitingInput', (e) => awaitingEvents.push(e)),
    )
  })

  afterAll(async () => {
    unsubs.forEach((u) => u())
    await orch.cleanup()
    await tmux.teardown()
  })

  it('PaneOutput fires when echo is run in tmux', async () => {
    const marker = `E2E_MARKER_${Date.now()}`
    await tmux.runScript(`echo "${marker}"`)

    await waitFor(
      () => outputEvents.some((e) => e.text.includes(marker)),
      { timeoutMs: 10_000, label: 'PaneOutput with marker' },
    )

    const match = outputEvents.find((e) => e.text.includes(marker))
    expect(match).toBeDefined()
  })

  it('PaneAwaitingInput fires for prompt-script.sh', async () => {
    const paneId = await tmux.runScript(`bash ${FIXTURES}/prompt-script.sh`)

    await waitFor(
      () => awaitingEvents.some((e) => e.paneId === paneId),
      { timeoutMs: 15_000, label: 'PaneAwaitingInput for prompt-script' },
    )

    const match = awaitingEvents.find((e) => e.paneId === paneId)
    expect(match).toBeDefined()
    expect(match!.score).toBeGreaterThanOrEqual(0.6)
  })

  it('no false positive PaneAwaitingInput during active output', async () => {
    // Run a script that continuously outputs text
    const paneId = await tmux.runScript(
      'bash -c "for i in $(seq 1 50); do echo output_line_$i; sleep 0.1; done"',
    )

    // Wait for some output to flow through
    await waitFor(
      () => outputEvents.some((e) => e.paneId === paneId),
      { timeoutMs: 5_000, label: 'some output from continuous script' },
    )

    // Wait a bit more to let the script keep running
    await new Promise((r) => setTimeout(r, 2000))

    // Should NOT have triggered PaneAwaitingInput for this pane
    const falsePositives = awaitingEvents.filter((e) => e.paneId === paneId)
    expect(falsePositives.length).toBe(0)
  })
})
