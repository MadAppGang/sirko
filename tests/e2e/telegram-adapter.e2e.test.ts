/**
 * E2E: Telegram adapter — detection triggers sendMessage via mock server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { resolve } from 'node:path'
import { TmuxTestHarness } from './helpers/tmux-harness.js'
import { OrchestratorHarness } from './helpers/orchestrator-harness.js'
import { MockTelegramServer } from './helpers/mock-telegram-server.js'
import { waitFor } from './helpers/wait-for.js'
import { TelegramAdapter } from '@sirko/telegram-bot'

const FIXTURES = resolve(import.meta.dir, 'fixtures')

describe('telegram-adapter', () => {
  const tmux = new TmuxTestHarness()
  const orch = new OrchestratorHarness({ tmuxSocketName: tmux.socketName })
  const mockTg = new MockTelegramServer()
  let adapter: TelegramAdapter
  let unsubs: Array<() => void> = []

  beforeAll(async () => {
    await tmux.setup()
    await mockTg.start()

    const handle = await orch.start()
    tmux.bindClient(handle.tmuxClient)

    // Create TelegramAdapter pointing at mock server
    adapter = new TelegramAdapter(
      {
        botToken: 'fake-token-123',
        groupId: -1001234567890,
        apiRoot: mockTg.apiRoot,
      },
      handle.store,
      handle.tmuxClient,
    )
    await adapter.start()

    // Wire bus events to adapter
    unsubs.push(
      handle.bus.on('PaneAwaitingInput', (e) => {
        adapter.handlePaneAwaitingInput(e).catch(console.error)
      }),
      handle.bus.on('PaneOutput', (e) => {
        adapter.handlePaneOutput(e).catch(console.error)
      }),
      handle.bus.on('PaneExited', (e) => {
        adapter.handlePaneExited(e).catch(console.error)
      }),
    )
  })

  afterAll(async () => {
    unsubs.forEach((u) => u())
    await adapter.stop()
    await orch.cleanup()
    await mockTg.stop()
    await tmux.teardown()
  })

  it('detection triggers createForumTopic + sendMessage', async () => {
    await tmux.runScript(`bash ${FIXTURES}/prompt-script.sh`)

    // Wait for Telegram API calls
    await mockTg.waitForCalls('createForumTopic', 1, 20_000)
    await mockTg.waitForCalls('sendMessage', 1, 5_000)

    const topicCalls = mockTg.callsForMethod('createForumTopic')
    expect(topicCalls.length).toBeGreaterThanOrEqual(1)

    const msgCalls = mockTg.callsForMethod('sendMessage')
    expect(msgCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('output after detection is sent to the topic', async () => {
    // Run a script that first waits for input, then produces output
    const paneId = await tmux.runScript(`bash ${FIXTURES}/loop-prompt-script.sh`)

    // Wait for detection (which creates a topic)
    await mockTg.waitForCalls('createForumTopic', 2, 20_000) // 2nd topic (first was from prev test)

    mockTg.clearCalls()

    // Send input so the script produces output
    await tmux.sendKeys(paneId, 'hello-from-telegram-test', { enter: true })

    // Wait for the output "Got: hello-from-telegram-test" to be sent via sendMessage
    await waitFor(
      () => mockTg.callsForMethod('sendMessage').length > 0,
      { timeoutMs: 10_000, label: 'sendMessage for script output' },
    )

    expect(mockTg.callsForMethod('sendMessage').length).toBeGreaterThanOrEqual(1)
  })

  it('adapter reports healthy while running', () => {
    expect(adapter.isHealthy()).toBe(true)
  })
})
