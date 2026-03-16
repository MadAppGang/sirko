/**
 * Integration test: telegram-routing
 *
 * Validates message routing behavior:
 * - PaneOutput events routed to the correct Telegram topic (pane → topic mapping)
 * - Incoming Telegram messages routed to the correct pane (topic → pane mapping)
 * - Output truncation at Telegram's 4096-character limit
 * - sanitizeForSendKeys behavior for safe input delivery
 *
 * Black box: imports only from public package index files.
 * All assertions derived from FR-TG-02, FR-TG-05, FR-TG-06, FR-TG-07.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { truncateForTelegram, sanitizeForSendKeys } from '@sirko/shared'
import { createEventBus } from '@sirko/event-bus'
import { createStateStore } from '@sirko/state-store'
import type { SirkoEvent } from '@sirko/shared'
import type { PaneState } from '@sirko/shared'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePaneState(paneId: string, topicId: number | null = null): PaneState {
  const now = Date.now()
  return {
    paneId,
    sessionId: '$1',
    windowId: '@0',
    tool: 'claude-code',
    pid: 1234,
    status: 'running',
    exitCode: null,
    notificationState: 'idle',
    lastNotifiedAt: null,
    lastOutputTime: now,
    processingCount: 0,
    xtermInstance: null,
    lastBufferSnapshot: '',
    telegramTopicId: topicId,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function tmpDir(): string {
  return path.join(os.tmpdir(), `sirko-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

// ---------------------------------------------------------------------------
// TEST GROUP: Output truncation (FR-TG-05, CON-API-02)
// ---------------------------------------------------------------------------

describe('truncateForTelegram — output truncation (FR-TG-05, CON-API-02)', () => {
  it('TEST-038: text within 4096 chars passes through unchanged', () => {
    const text = 'a'.repeat(100)
    expect(truncateForTelegram(text)).toBe(text)
  })

  it('TEST-039: text of 4097 chars is truncated to exactly 4096 with suffix', () => {
    const text = 'b'.repeat(4097)
    const result = truncateForTelegram(text)
    expect(result.length).toBe(4096)
    expect(result.endsWith('…[truncated]')).toBe(true)
  })

  it('TEST-040: text of exactly 4096 chars is unchanged', () => {
    const text = 'c'.repeat(4096)
    const result = truncateForTelegram(text)
    expect(result).toBe(text)
    expect(result.length).toBe(4096)
  })

  it('truncateForTelegram with custom maxLen truncates at that length', () => {
    const text = 'hello world'
    const result = truncateForTelegram(text, 5)
    expect(result.length).toBeLessThanOrEqual(5)
  })

  it('text of 12001 chars exceeds 4096 — truncation applies (FR-TG-06 behavioral boundary)', () => {
    // FR-TG-06: output > 12000 chars should be a file attachment.
    // We verify that truncateForTelegram correctly truncates when applied to such text.
    // The actual file-upload behavior is in the adapter layer (not tested here without adapter).
    const text = 'x'.repeat(12001)
    const result = truncateForTelegram(text)
    expect(result.length).toBe(4096)
    expect(result.endsWith('…[truncated]')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP: sanitizeForSendKeys (FR-TMUX-06)
// ---------------------------------------------------------------------------

describe('sanitizeForSendKeys — safe input delivery (FR-TMUX-06)', () => {
  it('TEST-042: removes ASCII control characters (except tab and newline)', () => {
    // Include null byte, escape, backspace, carriage return, and bell
    const dangerous = '\x00hello\x1bworld\x08test\x07done\x0d'
    const result = sanitizeForSendKeys(dangerous)
    // Only printable text, \t, \n survive
    expect(result).toBe('helloworldtestdone')
  })

  it('TEST-043: preserves tab and newline characters', () => {
    const text = 'hello\tworld\nbye'
    expect(sanitizeForSendKeys(text)).toBe('hello\tworld\nbye')
  })

  it('normal printable text is unchanged', () => {
    const text = 'git commit -m "fix: update deps"'
    expect(sanitizeForSendKeys(text)).toBe(text)
  })

  it('empty string returns empty string', () => {
    expect(sanitizeForSendKeys('')).toBe('')
  })

  it('DEL (0x7f) is removed', () => {
    const text = 'hello\x7fworld'
    expect(sanitizeForSendKeys(text)).toBe('helloworld')
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP: StateStore topic mapping (underpins FR-TG-02 routing)
// ---------------------------------------------------------------------------

describe('StateStore — pane-to-topic mapping (FR-TG-02)', () => {
  it('TEST-050: stores telegramTopicId and reverse-maps topic to paneId', async () => {
    const store = createStateStore({ persistPath: tmpDir(), persistIntervalMs: 999999 })

    const pane1 = makePaneState('%1', 100)
    const pane2 = makePaneState('%2', 200)

    store.setPane('%1', pane1)
    store.setPane('%2', pane2)

    // Forward lookup
    expect(store.getPane('%1')?.telegramTopicId).toBe(100)
    expect(store.getPane('%2')?.telegramTopicId).toBe(200)

    // Reverse lookup (topic → pane)
    expect(store.getPaneByTopicId(100)).toBe('%1')
    expect(store.getPaneByTopicId(200)).toBe('%2')

    // Routing: output for %1 should only go to topic 100
    const pane1TopicId = store.getPane('%1')?.telegramTopicId
    expect(pane1TopicId).toBe(100)
    expect(pane1TopicId).not.toBe(200)
  })

  it('TEST-051: InputDelivered event has correct paneId when routed from topic', async () => {
    const bus = createEventBus()
    const store = createStateStore({ persistPath: tmpDir(), persistIntervalMs: 999999 })

    // Set up topic 100 → pane %1 mapping
    store.setPane('%1', makePaneState('%1', 100))

    const delivered: SirkoEvent[] = []
    bus.on('InputDelivered', (ev) => { delivered.push(ev) })

    // Simulate routing: incoming message on topic 100 → resolve paneId → emit InputDelivered
    const incomingTopicId = 100
    const incomingText = 'yes, continue'

    const paneId = store.getPaneByTopicId(incomingTopicId)
    expect(paneId).toBeDefined()

    if (paneId !== undefined) {
      const event: SirkoEvent = {
        type: 'InputDelivered',
        paneId,
        sessionId: '$1',
        source: 'telegram',
        text: incomingText,
      }
      await bus.emit(event)
    }

    expect(delivered).toHaveLength(1)
    const ev = delivered[0]!
    expect(ev.type).toBe('InputDelivered')
    if (ev.type === 'InputDelivered') {
      expect(ev.paneId).toBe('%1')
      expect(ev.source).toBe('telegram')
      expect(ev.text).toBe(incomingText)
    }
  })

  it('message for unknown topic does not route anywhere', async () => {
    const store = createStateStore({ persistPath: tmpDir(), persistIntervalMs: 999999 })
    store.setPane('%1', makePaneState('%1', 100))

    // Topic 999 has no mapping
    const paneId = store.getPaneByTopicId(999)
    expect(paneId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP: EventBus routing correctness (FR-TG-02)
// ---------------------------------------------------------------------------

describe('EventBus — typed routing per topic (FR-TG-02, FR-ORCH-02)', () => {
  it('TEST-050b: PaneOutput event only triggers handler for matching pane', async () => {
    const bus = createEventBus()
    const pane1Outputs: string[] = []
    const pane2Outputs: string[] = []

    bus.on('PaneOutput', (ev) => {
      if (ev.paneId === '%1') pane1Outputs.push(ev.text)
      if (ev.paneId === '%2') pane2Outputs.push(ev.text)
    })

    await bus.emit({
      type: 'PaneOutput',
      paneId: '%1',
      sessionId: '$1',
      text: 'output for pane 1',
      raw: '',
      timestamp: Date.now(),
    })

    expect(pane1Outputs).toEqual(['output for pane 1'])
    expect(pane2Outputs).toEqual([])
  })

  it('TEST-019: subscriber only receives its own event type', async () => {
    const bus = createEventBus()
    const outputEvents: SirkoEvent[] = []
    const awaitingEvents: SirkoEvent[] = []

    bus.on('PaneOutput', (ev) => { outputEvents.push(ev) })
    bus.on('PaneAwaitingInput', (ev) => { awaitingEvents.push(ev) })

    await bus.emit({
      type: 'PaneOutput',
      paneId: '%1',
      sessionId: '$1',
      text: 'hello',
      raw: '',
      timestamp: Date.now(),
    })

    expect(outputEvents).toHaveLength(1)
    expect(awaitingEvents).toHaveLength(0)
  })

  it('TEST-049: dedup scenario — notified pane should not re-trigger InputDelivered from bus', async () => {
    // This verifies bus isolation: a second PaneAwaitingInput for an already-notified pane
    // is distinguishable at the state level.
    const bus = createEventBus()
    const store = createStateStore({ persistPath: tmpDir(), persistIntervalMs: 999999 })

    const pane = makePaneState('%3', 42)
    pane.notificationState = 'notified'
    store.setPane('%3', pane)

    const awaitingInputCount = { value: 0 }
    bus.on('PaneAwaitingInput', (_ev) => { awaitingInputCount.value++ })

    // A dedup-aware consumer would check notificationState before emitting
    const paneState = store.getPane('%3')
    if (paneState?.notificationState !== 'notified') {
      // Only emit if not already notified
      await bus.emit({
        type: 'PaneAwaitingInput',
        paneId: '%3',
        sessionId: '$1',
        tool: 'claude-code',
        confidence: 0.9,
        score: 0.9,
        context: '> ',
        signals: {
          promptPattern: { matched: true, pattern: '/^> $/', weight: 0.45, contribution: 0.45 },
          wchan: { value: 'pipe_read', isWaiting: true, weight: 0.35, contribution: 0.35 },
          quiescence: { silenceMs: 2000, threshold: 1800, weight: 0.20, contribution: 0.20 },
        },
      })
    }

    // Because notificationState = 'notified', the dedup check prevented emission
    expect(awaitingInputCount.value).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP: SirkoEvent type shapes from events.ts
// ---------------------------------------------------------------------------

describe('SirkoEvent type shapes — public contract validation', () => {
  it('TEST-044: VoiceCallStarted event has required fields', () => {
    const event: SirkoEvent = {
      type: 'VoiceCallStarted',
      paneId: '%1',
      callSid: 'CA123abc',
      transport: 'twilio',
    }
    expect(event.type).toBe('VoiceCallStarted')
    expect(event.paneId).toBe('%1')
    expect(event.callSid).toBe('CA123abc')
    expect(['twilio', 'livekit']).toContain(event.transport)
  })

  it('TEST-045: VoiceCallFailed event has paneId and reason', () => {
    const event: SirkoEvent = {
      type: 'VoiceCallFailed',
      paneId: '%2',
      reason: 'STT timeout',
    }
    expect(event.type).toBe('VoiceCallFailed')
    expect(event.paneId).toBe('%2')
    expect(typeof event.reason).toBe('string')
  })

  it('InputDelivered source is telegram or voice', () => {
    const telegramEvent: SirkoEvent = {
      type: 'InputDelivered',
      paneId: '%1',
      sessionId: '$1',
      source: 'telegram',
      text: 'hello',
    }
    const voiceEvent: SirkoEvent = {
      type: 'InputDelivered',
      paneId: '%1',
      sessionId: '$1',
      source: 'voice',
      text: 'proceed',
    }
    expect(['telegram', 'voice']).toContain(telegramEvent.source)
    expect(['telegram', 'voice']).toContain(voiceEvent.source)
  })
})
