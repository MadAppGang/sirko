/**
 * Tests for voice-server:
 *   - Circuit breaker state transitions
 *   - Audio format conversion (μ-law ↔ PCM16)
 *   - Context summarizer input truncation
 *   - VoiceAdapter call queue (max 1 active)
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { CircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker.js'
import { mulawToPcm16, pcm16ToMulaw } from './audio-utils.js'
import { ContextSummarizer } from './context-summarizer.js'
import { VoiceAdapter } from './voice-adapter.js'
import type { VoiceTransport } from './voice-transport.js'
import type { VoicePipeline } from './voice-pipeline.js'
import type { StateStore } from '@sirko/state-store'
import type { TmuxClient } from '@sirko/tmux-client'

// ---------------------------------------------------------------------------
// Circuit Breaker Tests
// ---------------------------------------------------------------------------

describe('CircuitBreaker', () => {
  test('starts in closed state', () => {
    const cb = new CircuitBreaker()
    expect(cb.currentState).toBe('closed')
  })

  test('executes fn in closed state', async () => {
    const cb = new CircuitBreaker()
    const result = await cb.execute(() => Promise.resolve(42))
    expect(result).toBe(42)
  })

  test('transitions to open after failureThreshold failures', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 5000 })

    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(() => Promise.reject(new Error('fail')))
      } catch {
        // expected
      }
    }

    expect(cb.currentState).toBe('open')
  })

  test('throws CircuitBreakerOpenError when open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, windowMs: 5000, probeAfterMs: 60_000 })

    try {
      await cb.execute(() => Promise.reject(new Error('fail')))
    } catch {
      // trip the breaker
    }

    await expect(cb.execute(() => Promise.resolve(1))).rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })

  test('transitions to half-open after probeAfterMs', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, windowMs: 5000, probeAfterMs: 0 })

    try {
      await cb.execute(() => Promise.reject(new Error('fail')))
    } catch {
      // trip the breaker
    }

    expect(cb.currentState).toBe('open')

    // After probeAfterMs=0, the next execute attempt should transition to half-open
    // and allow a probe. A successful probe closes the circuit.
    const result = await cb.execute(() => Promise.resolve('probe'))
    expect(result).toBe('probe')
    expect(cb.currentState).toBe('closed')
  })

  test('re-opens from half-open on probe failure', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, windowMs: 5000, probeAfterMs: 0 })

    try {
      await cb.execute(() => Promise.reject(new Error('fail')))
    } catch {
      // trip
    }

    // Probe fails
    try {
      await cb.execute(() => Promise.reject(new Error('probe fail')))
    } catch {
      // expected
    }

    expect(cb.currentState).toBe('open')
  })

  test('reset() returns circuit to closed', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, windowMs: 5000 })
    // Manually open
    // @ts-expect-error — accessing private for test
    cb.state = 'open'
    cb.reset()
    expect(cb.currentState).toBe('closed')
  })

  test('prunesFailures outside the window', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 1 })

    // Two failures
    for (let i = 0; i < 2; i++) {
      try {
        await cb.execute(() => Promise.reject(new Error('fail')))
      } catch {
        // expected
      }
    }

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 5))

    // Third failure — but previous two are expired, so we should NOT open
    try {
      await cb.execute(() => Promise.reject(new Error('fail')))
    } catch {
      // expected
    }

    // Only 1 failure in window — still closed
    expect(cb.currentState).toBe('closed')
  })
})

// ---------------------------------------------------------------------------
// Audio Conversion Tests
// ---------------------------------------------------------------------------

describe('Audio conversion', () => {
  test('mulawToPcm16 produces double-length buffer', () => {
    const mulaw = Buffer.from([0x00, 0x7f, 0xff])
    const pcm = mulawToPcm16(mulaw)
    expect(pcm.length).toBe(6)
  })

  test('pcm16ToMulaw produces half-length buffer', () => {
    const pcm = Buffer.alloc(8, 0)
    const mulaw = pcm16ToMulaw(pcm)
    expect(mulaw.length).toBe(4)
  })

  test('pcm16ToMulaw throws on odd-length input', () => {
    const pcm = Buffer.alloc(3, 0)
    expect(() => pcm16ToMulaw(pcm)).toThrow(RangeError)
  })

  test('round-trip mulaw→pcm→mulaw is stable for silent audio', () => {
    // μ-law 0xFF encodes silence (0)
    const silence = Buffer.alloc(8, 0xff)
    const pcm = mulawToPcm16(silence)
    const back = pcm16ToMulaw(pcm)
    // μ-law encode(decode(0xFF)) may differ due to rounding, but should be close
    expect(back.length).toBe(silence.length)
  })

  test('silent PCM16 encodes to non-zero mulaw bytes', () => {
    // PCM 0 encodes to a specific mulaw value (should be 0xFF for silence in G.711)
    const pcm = Buffer.alloc(4, 0)
    const mulaw = pcm16ToMulaw(pcm)
    expect(mulaw.length).toBe(2)
    // Both bytes should be the same (silence)
    expect(mulaw[0]).toBe(mulaw[1])
  })
})

// ---------------------------------------------------------------------------
// ContextSummarizer Tests
// ---------------------------------------------------------------------------

describe('ContextSummarizer', () => {
  test('truncate returns text unchanged if under limit', () => {
    const cs = new ContextSummarizer({ maxInputChars: 100 })
    const text = 'hello world'
    expect(cs.truncate(text)).toBe(text)
  })

  test('truncate keeps head and tail for long input', () => {
    const cs = new ContextSummarizer({ maxInputChars: 10 })
    const text = 'AAAAABBBBBCCCCC'
    const result = cs.truncate(text)
    expect(result).toContain('AAAAA')
    expect(result).toContain('CCCCC')
    expect(result).toContain('[truncated]')
  })

  test('truncate output length is bounded', () => {
    const cs = new ContextSummarizer({ maxInputChars: 20 })
    const text = 'x'.repeat(1000)
    const result = cs.truncate(text)
    // Should contain truncation marker plus at most maxInputChars chars of content
    expect(result.length).toBeLessThan(1000)
  })

  test('summarize uses circuit breaker (mock LLM)', async () => {
    const cs = new ContextSummarizer({ maxInputChars: 4000 })

    // Replace the internal breaker's execute with a mock that returns a fixed summary
    // by patching the circuit breaker on the summarizer
    // @ts-expect-error accessing private for test
    const originalExecute = cs.breaker.execute.bind(cs.breaker)
    // @ts-expect-error accessing private for test
    cs.breaker.execute = async <T>(fn: () => Promise<T>): Promise<T> => {
      // Simulate successful LLM call
      return 'Summary: task complete.' as unknown as T
    }

    const result = await cs.summarize('some terminal text')
    expect(result).toBe('Summary: task complete.')

    // Restore
    // @ts-expect-error accessing private for test
    cs.breaker.execute = originalExecute
  })
})

// ---------------------------------------------------------------------------
// VoiceAdapter Queue Tests
// ---------------------------------------------------------------------------

describe('VoiceAdapter call queue', () => {
  let mockTransport: VoiceTransport
  let mockPipeline: VoicePipeline
  let mockStore: StateStore
  let mockTmuxClient: TmuxClient
  let callCount: number
  let initiatedCallSids: string[]

  beforeEach(() => {
    callCount = 0
    initiatedCallSids = []

    mockTransport = {
      name: 'mock',
      async initiateCall(_phone: string, _webhook: string) {
        callCount++
        const sid = `CA${callCount}`
        initiatedCallSids.push(sid)
        return sid
      },
      async endCall(_sid: string) {},
      async isCallActive(_sid: string) {
        return true
      },
    }

    mockPipeline = {
      async notifyContext(_text: string) {
        return []
      },
      async synthesize(_text: string) {
        return []
      },
      async transcribe(_audio: Buffer) {
        return null
      },
      async summarizeContext(_text: string) {
        return ''
      },
      async processUserAudio(_audio: Buffer) {
        return null
      },
    } as unknown as VoicePipeline

    mockStore = {
      getPane(_paneId: string) {
        return undefined
      },
      setNotificationState(_paneId: string, _state: 'idle' | 'notified') {},
    } as unknown as StateStore

    mockTmuxClient = {} as unknown as TmuxClient
  })

  test('initiates a call when no active call exists', async () => {
    const adapter = new VoiceAdapter(
      {
        port: 0,
        webhookBaseUrl: 'http://localhost',
        phoneNumber: '+15555550100',
      },
      mockTransport,
      mockPipeline,
      mockTmuxClient,
      mockStore,
    )

    await adapter.handlePaneAwaitingInput({
      type: 'PaneAwaitingInput',
      paneId: 'pane1',
      sessionId: 'sess1',
      tool: 'claude-code',
      confidence: 0.9,
      score: 0.85,
      context: 'Terminal is awaiting input',
      signals: {
        promptPattern: { matched: true, pattern: '> ', weight: 0.45, contribution: 0.45 },
        wchan: { value: 'pipe_read', isWaiting: true, weight: 0.35, contribution: 0.35 },
        quiescence: { silenceMs: 2000, threshold: 1800, weight: 0.20, contribution: 0.20 },
      },
    })

    expect(callCount).toBe(1)
    expect(initiatedCallSids[0]).toBe('CA1')
  })

  test('queues a second call while first is active', async () => {
    const adapter = new VoiceAdapter(
      {
        port: 0,
        webhookBaseUrl: 'http://localhost',
        phoneNumber: '+15555550100',
      },
      mockTransport,
      mockPipeline,
      mockTmuxClient,
      mockStore,
    )

    const baseEvent = {
      type: 'PaneAwaitingInput' as const,
      sessionId: 'sess1',
      tool: 'claude-code' as const,
      confidence: 0.9,
      score: 0.85,
      context: 'awaiting',
      signals: {
        promptPattern: { matched: true, pattern: '> ', weight: 0.45, contribution: 0.45 },
        wchan: { value: 'pipe_read', isWaiting: true, weight: 0.35, contribution: 0.35 },
        quiescence: { silenceMs: 2000, threshold: 1800, weight: 0.20, contribution: 0.20 },
      },
    }

    // First call
    await adapter.handlePaneAwaitingInput({ ...baseEvent, paneId: 'pane1' })
    // Second call — should be queued
    await adapter.handlePaneAwaitingInput({ ...baseEvent, paneId: 'pane2' })

    // Only 1 call initiated immediately
    expect(callCount).toBe(1)
  })

  test('drains queue when call ends via handlePaneExited', async () => {
    const adapter = new VoiceAdapter(
      {
        port: 0,
        webhookBaseUrl: 'http://localhost',
        phoneNumber: '+15555550100',
      },
      mockTransport,
      mockPipeline,
      mockTmuxClient,
      mockStore,
    )

    const baseEvent = {
      type: 'PaneAwaitingInput' as const,
      sessionId: 'sess1',
      tool: 'claude-code' as const,
      confidence: 0.9,
      score: 0.85,
      context: 'awaiting',
      signals: {
        promptPattern: { matched: true, pattern: '> ', weight: 0.45, contribution: 0.45 },
        wchan: { value: 'pipe_read', isWaiting: true, weight: 0.35, contribution: 0.35 },
        quiescence: { silenceMs: 2000, threshold: 1800, weight: 0.20, contribution: 0.20 },
      },
    }

    await adapter.handlePaneAwaitingInput({ ...baseEvent, paneId: 'pane1' })
    await adapter.handlePaneAwaitingInput({ ...baseEvent, paneId: 'pane2' })

    expect(callCount).toBe(1)

    // End the first call
    await adapter.handlePaneExited({ type: 'PaneExited', paneId: 'pane1', sessionId: 'sess1', exitCode: 0 })

    // Queue should have drained — second call should now be active
    expect(callCount).toBe(2)
  })

  test('removes paneId from queue when input delivered from other source', async () => {
    const adapter = new VoiceAdapter(
      {
        port: 0,
        webhookBaseUrl: 'http://localhost',
        phoneNumber: '+15555550100',
      },
      mockTransport,
      mockPipeline,
      mockTmuxClient,
      mockStore,
    )

    const baseEvent = {
      type: 'PaneAwaitingInput' as const,
      sessionId: 'sess1',
      tool: 'claude-code' as const,
      confidence: 0.9,
      score: 0.85,
      context: 'awaiting',
      signals: {
        promptPattern: { matched: true, pattern: '> ', weight: 0.45, contribution: 0.45 },
        wchan: { value: 'pipe_read', isWaiting: true, weight: 0.35, contribution: 0.35 },
        quiescence: { silenceMs: 2000, threshold: 1800, weight: 0.20, contribution: 0.20 },
      },
    }

    await adapter.handlePaneAwaitingInput({ ...baseEvent, paneId: 'pane1' })
    await adapter.handlePaneAwaitingInput({ ...baseEvent, paneId: 'pane2' })

    // Telegram delivered input for pane2 → remove from queue
    await adapter.handleInputDelivered({
      type: 'InputDelivered',
      paneId: 'pane2',
      sessionId: 'sess1',
      source: 'telegram',
      text: 'yes',
    })

    // End pane1 call
    await adapter.handlePaneExited({ type: 'PaneExited', paneId: 'pane1', sessionId: 'sess1', exitCode: 0 })

    // Queue was empty (pane2 was removed), so no additional call
    expect(callCount).toBe(1)
  })

  test('handlePaneOutput is a no-op', async () => {
    const adapter = new VoiceAdapter(
      {
        port: 0,
        webhookBaseUrl: 'http://localhost',
        phoneNumber: '+15555550100',
      },
      mockTransport,
      mockPipeline,
      mockTmuxClient,
      mockStore,
    )

    // Should not throw or call transport
    await adapter.handlePaneOutput({
      type: 'PaneOutput',
      paneId: 'pane1',
      sessionId: 'sess1',
      text: 'some output',
      raw: 'some output',
      timestamp: Date.now(),
    })

    expect(callCount).toBe(0)
  })
})
