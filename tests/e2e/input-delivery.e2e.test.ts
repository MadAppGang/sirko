/**
 * E2E: Input delivery — sendKeys roundtrip, dedup reset after input.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { resolve } from 'node:path'
import type { SirkoEvent } from '@sirko/shared'
import { TmuxTestHarness } from './helpers/tmux-harness.js'
import { OrchestratorHarness } from './helpers/orchestrator-harness.js'
import { waitFor } from './helpers/wait-for.js'

const FIXTURES = resolve(import.meta.dir, 'fixtures')

describe('input-delivery', () => {
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

  it('sendKeys roundtrip — input arrives and is echoed', async () => {
    const paneId = await tmux.runScript(`bash ${FIXTURES}/prompt-script.sh`)

    // Wait for detection
    await waitFor(
      () => awaitingEvents.some((e) => e.paneId === paneId),
      { timeoutMs: 15_000, label: 'awaiting-input for prompt-script' },
    )

    // Send input via tmux
    await tmux.sendKeys(paneId, 'hello', { enter: true })

    // Check bus output events instead of capturePane (pane may exit after echo)
    await waitFor(
      () => outputEvents.some(
        (e) => e.paneId === paneId && e.text.includes('Got: hello'),
      ),
      { timeoutMs: 5_000, label: 'echo of sent input in bus events' },
    )

    const match = outputEvents.find(
      (e) => e.paneId === paneId && e.text.includes('Got: hello'),
    )
    expect(match).toBeDefined()
  })

  it('dedup resets after input — loop-prompt triggers detection again', async () => {
    const paneId = await tmux.runScript(`bash ${FIXTURES}/loop-prompt-script.sh`)

    // Wait for first detection
    await waitFor(
      () => awaitingEvents.filter((e) => e.paneId === paneId).length >= 1,
      { timeoutMs: 15_000, label: 'first awaiting-input for loop-prompt' },
    )

    const firstCount = awaitingEvents.filter((e) => e.paneId === paneId).length

    // Send input — this should reset the detection dedup
    await tmux.sendKeys(paneId, 'test-input', { enter: true })

    // Wait for "Got: test-input" to confirm the script processed it
    await waitFor(
      async () => {
        const content = await tmux.capturePane(paneId)
        return content.includes('Got: test-input')
      },
      { timeoutMs: 5_000, label: 'echo of test-input' },
    )

    // Wait for second detection (the script loops back to "> ")
    await waitFor(
      () => awaitingEvents.filter((e) => e.paneId === paneId).length > firstCount,
      { timeoutMs: 15_000, label: 'second awaiting-input after dedup reset' },
    )

    const totalDetections = awaitingEvents.filter((e) => e.paneId === paneId).length
    expect(totalDetections).toBeGreaterThan(firstCount)
  })
})
