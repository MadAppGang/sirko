/**
 * E2E: Multi-pane — independent routing and detection across panes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { resolve } from 'node:path'
import type { SirkoEvent } from '@sirko/shared'
import { TmuxTestHarness } from './helpers/tmux-harness.js'
import { OrchestratorHarness } from './helpers/orchestrator-harness.js'
import { waitFor } from './helpers/wait-for.js'

const FIXTURES = resolve(import.meta.dir, 'fixtures')

describe('multi-pane', () => {
  const tmux = new TmuxTestHarness()
  const orch = new OrchestratorHarness({ tmuxSocketName: tmux.socketName })
  const outputEvents: Array<Extract<SirkoEvent, { type: 'PaneOutput' }>> = []
  const awaitingEvents: Array<Extract<SirkoEvent, { type: 'PaneAwaitingInput' }>> = []
  let unsubs: Array<() => void> = []

  beforeAll(async () => {
    await tmux.setup()
    const handle = await orch.start()
    tmux.bindClient(handle.tmuxClient)

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

  it('two panes route events with correct paneIds', async () => {
    const markerA = `PANE_A_${Date.now()}`
    const markerB = `PANE_B_${Date.now()}`

    const paneA = await tmux.runScript(`echo "${markerA}"`)
    const paneB = await tmux.runScript(`echo "${markerB}"`)

    // Wait for both markers to appear in output events
    await waitFor(
      () => outputEvents.some((e) => e.text.includes(markerA)),
      { timeoutMs: 10_000, label: 'output from pane A' },
    )
    await waitFor(
      () => outputEvents.some((e) => e.text.includes(markerB)),
      { timeoutMs: 10_000, label: 'output from pane B' },
    )

    // Verify correct pane IDs
    const eventA = outputEvents.find((e) => e.text.includes(markerA))
    const eventB = outputEvents.find((e) => e.text.includes(markerB))

    expect(eventA).toBeDefined()
    expect(eventB).toBeDefined()
    expect(eventA!.paneId).toBe(paneA)
    expect(eventB!.paneId).toBe(paneB)
    expect(eventA!.paneId).not.toBe(eventB!.paneId)
  })

  it('only the prompting pane triggers PaneAwaitingInput', async () => {
    // Pane C: prompt script (should trigger detection)
    const paneC = await tmux.runScript(`bash ${FIXTURES}/prompt-script.sh`)

    // Pane D: continuous output (should NOT trigger detection)
    const paneD = await tmux.runScript(
      'bash -c "for i in $(seq 1 100); do echo streaming_$i; sleep 0.1; done"',
    )

    // Wait for detection on pane C
    await waitFor(
      () => awaitingEvents.some((e) => e.paneId === paneC),
      { timeoutMs: 15_000, label: 'awaiting-input for prompt pane' },
    )

    // Give pane D time to produce output
    await new Promise((r) => setTimeout(r, 3000))

    // Pane D should NOT have triggered PaneAwaitingInput
    const falseDetections = awaitingEvents.filter((e) => e.paneId === paneD)
    expect(falseDetections.length).toBe(0)

    // Pane C should have been detected
    const correctDetections = awaitingEvents.filter((e) => e.paneId === paneC)
    expect(correctDetections.length).toBeGreaterThanOrEqual(1)
  })
})
