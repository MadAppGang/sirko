/**
 * E2E: Voice server — HTTP webhooks return correct TwiML, status callbacks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { resolve } from 'node:path'
import { TmuxTestHarness } from './helpers/tmux-harness.js'
import { OrchestratorHarness } from './helpers/orchestrator-harness.js'
import { createMockVoiceTransport, createMockVoicePipeline } from './helpers/mock-voice-deps.js'
import { waitFor } from './helpers/wait-for.js'
import { VoiceAdapter } from '@sirko/voice-server'

const FIXTURES = resolve(import.meta.dir, 'fixtures')

describe('voice-server', () => {
  const tmux = new TmuxTestHarness()
  const orch = new OrchestratorHarness({ tmuxSocketName: tmux.socketName })
  const mockTransport = createMockVoiceTransport()
  const mockPipeline = createMockVoicePipeline()
  let adapter: VoiceAdapter
  let voicePort: number
  let unsubs: Array<() => void> = []

  beforeAll(async () => {
    await tmux.setup()
    const handle = await orch.start()
    tmux.bindClient(handle.tmuxClient)

    // Find a free port by binding to 0
    const tempServer = Bun.serve({ port: 0, fetch: () => new Response('') })
    voicePort = tempServer.port
    tempServer.stop()

    adapter = new VoiceAdapter(
      {
        port: voicePort,
        webhookBaseUrl: `http://localhost:${voicePort}`,
        phoneNumber: '+15555555555',
        authorizedNumbers: ['+15551234567'],
      },
      mockTransport as any,
      mockPipeline as any,
      handle.tmuxClient,
      handle.store,
    )
    await adapter.start()

    // Wire detection events to voice adapter
    unsubs.push(
      handle.bus.on('PaneAwaitingInput', (e) => {
        adapter.handlePaneAwaitingInput(e).catch(console.error)
      }),
    )
  })

  afterAll(async () => {
    unsubs.forEach((u) => u())
    await adapter.stop()
    await orch.cleanup()
    await tmux.teardown()
  })

  it('POST /twilio/voice returns TwiML with Connect/Stream', async () => {
    const body = new URLSearchParams({
      CallSid: 'CA-test-123',
      From: '+15551234567',
      To: '+15555555555',
    }).toString()

    const res = await fetch(`http://localhost:${voicePort}/twilio/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<Connect')
    expect(xml).toContain('<Stream')
  })

  it('POST /twilio/status with completed returns 204', async () => {
    const body = new URLSearchParams({
      CallSid: 'CA-test-123',
      CallStatus: 'completed',
    }).toString()

    const res = await fetch(`http://localhost:${voicePort}/twilio/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    expect(res.status).toBe(204)
  })

  it('unauthorized number returns Reject TwiML', async () => {
    const body = new URLSearchParams({
      CallSid: 'CA-test-456',
      From: '+19999999999',
      To: '+15555555555',
    }).toString()

    const res = await fetch(`http://localhost:${voicePort}/twilio/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<Reject')
  })

  it('detection triggers mock call initiation', async () => {
    const initialCalls = mockTransport.initiatedCalls.length
    await tmux.runScript(`bash ${FIXTURES}/prompt-script.sh`)

    await waitFor(
      () => mockTransport.initiatedCalls.length > initialCalls,
      { timeoutMs: 15_000, label: 'mock transport call initiated' },
    )

    expect(mockTransport.initiatedCalls.length).toBeGreaterThan(initialCalls)
  })
})
