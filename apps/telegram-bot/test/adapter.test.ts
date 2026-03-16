import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStateStore } from '@sirko/state-store'
import { CURRENT_SCHEMA_VERSION } from '@sirko/state-store'
import type { StateStore } from '@sirko/state-store'
import type { PaneState } from '@sirko/shared'
import { formatOutput, escapeHtml } from '../src/format.js'
import { TopicManager } from '../src/topic-manager.js'
import { OutputStreamer } from '../src/output-streamer.js'
import { MessageRouter } from '../src/message-router.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePaneState(overrides: Partial<PaneState> = {}): PaneState {
  return {
    paneId: '%1',
    sessionId: '$1',
    windowId: '@1',
    tool: 'claude-code',
    pid: 1234,
    status: 'running',
    exitCode: null,
    notificationState: 'idle',
    lastNotifiedAt: null,
    lastOutputTime: Date.now(),
    processingCount: 0,
    xtermInstance: null,
    lastBufferSnapshot: '',
    telegramTopicId: null,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// TopicManager tests (mock bot.api)
// ---------------------------------------------------------------------------

describe('TopicManager', () => {
  let tmpDir: string
  let store: StateStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tg-adapter-test-'))
    store = createStateStore({ persistPath: tmpDir })
  })

  it('creates a topic via bot.api and persists mapping', async () => {
    const calls: Array<[string, ...unknown[]]> = []

    const mockBot = {
      api: {
        createForumTopic: mock(async (_chatId: number, name: string) => {
          calls.push(['createForumTopic', _chatId, name])
          return { message_thread_id: 42 }
        }),
      },
    }

    const tm = new TopicManager(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockBot as any,
      store,
      -100123,
    )

    const topicId = await tm.ensureTopic('%1', 'claude-code', 'my-session')

    expect(topicId).toBe(42)
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual(['createForumTopic', -100123, 'my-session [claude-code]'])

    // Mapping persisted in store
    expect(store.getTopicId('%1')).toBe(42)
    expect(store.getPaneByTopicId(42)).toBe('%1')

    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns existing topicId without creating a new topic', async () => {
    store.setTopicId('%1', 99)

    const createCalls: number[] = []
    const mockBot = {
      api: {
        createForumTopic: mock(async () => {
          createCalls.push(1)
          return { message_thread_id: 999 }
        }),
      },
    }

    const tm = new TopicManager(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockBot as any,
      store,
      -100123,
    )

    const topicId = await tm.ensureTopic('%1', 'claude-code', 'my-session')

    expect(topicId).toBe(99)
    expect(createCalls.length).toBe(0)

    await rm(tmpDir, { recursive: true, force: true })
  })

  it('getTopicForPane returns stored topic id', () => {
    store.setTopicId('%1', 77)
    const mockBot = { api: {} }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tm = new TopicManager(mockBot as any, store, -100123)
    expect(tm.getTopicForPane('%1')).toBe(77)
  })

  it('getPaneForTopic returns pane id', () => {
    store.setTopicId('%2', 55)
    const mockBot = { api: {} }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tm = new TopicManager(mockBot as any, store, -100123)
    expect(tm.getPaneForTopic(55)).toBe('%2')
  })

  it('restores mappings from state store (no-op since store already loads them)', async () => {
    // Pre-seed pane with topic id
    const pane = makePaneState({ paneId: '%3', telegramTopicId: 88 })
    store.setPane('%3', pane)
    // setPane auto-syncs telegramTopicId into topicMap
    expect(store.getTopicId('%3')).toBe(88)

    const mockBot = { api: {} }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tm = new TopicManager(mockBot as any, store, -100123)
    tm.restoreMappings()

    expect(tm.getTopicForPane('%3')).toBe(88)
    await rm(tmpDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// OutputStreamer tests
// ---------------------------------------------------------------------------

describe('OutputStreamer', () => {
  it('sends short output as HTML pre block', async () => {
    const sent: Array<{ topicId: number; text: string }> = []

    const streamer = new OutputStreamer({
      debounceMs: 0,
      onSend: async ({ topicId, text }) => {
        sent.push({ topicId, text })
      },
      onSendFile: async () => {},
    })

    streamer.push(42, 'hello world')
    streamer.flush(42)

    // Allow microtask to resolve
    await new Promise((r) => setTimeout(r, 10))

    expect(sent.length).toBe(1)
    expect(sent[0]?.topicId).toBe(42)
    expect(sent[0]?.text).toContain('<pre>')
    expect(sent[0]?.text).toContain('hello world')
  })

  it('sends file for output exceeding 12000 chars', async () => {
    const files: Array<{ topicId: number; filename: string }> = []

    const streamer = new OutputStreamer({
      debounceMs: 0,
      onSend: async () => {},
      onSendFile: async ({ topicId, filename }) => {
        files.push({ topicId, filename })
      },
    })

    streamer.push(99, 'x'.repeat(13000))
    streamer.flush(99)

    await new Promise((r) => setTimeout(r, 10))

    expect(files.length).toBe(1)
    expect(files[0]?.topicId).toBe(99)
  })

  it('flushAll sends all buffered topics', async () => {
    const sent: number[] = []

    const streamer = new OutputStreamer({
      debounceMs: 5000, // long debounce so we test flushAll
      onSend: async ({ topicId }) => {
        sent.push(topicId)
      },
      onSendFile: async () => {},
    })

    streamer.push(1, 'output for topic 1')
    streamer.push(2, 'output for topic 2')
    streamer.flushAll()

    await new Promise((r) => setTimeout(r, 20))

    expect(sent).toContain(1)
    expect(sent).toContain(2)
  })

  it('forces flush when maxBufferChars exceeded', async () => {
    const sent: string[] = []

    const streamer = new OutputStreamer({
      debounceMs: 5000,
      maxBufferChars: 10,
      onSend: async ({ text }) => {
        sent.push(text)
      },
      onSendFile: async () => {},
    })

    streamer.push(1, 'x'.repeat(15)) // exceeds maxBufferChars=10

    await new Promise((r) => setTimeout(r, 20))

    expect(sent.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// MessageRouter tests
// ---------------------------------------------------------------------------

describe('MessageRouter', () => {
  let tmpDir: string
  let store: StateStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tg-router-test-'))
    store = createStateStore({ persistPath: tmpDir })
  })

  it('routes topic message to correct pane via sendKeys', async () => {
    store.setTopicId('%1', 42)

    const sendKeysCalls: Array<[string, string]> = []
    const mockTmux = {
      sendKeys: mock(async (paneId: string, text: string) => {
        sendKeysCalls.push([paneId, text])
      }),
    }

    const mockBot = { api: {} }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tm = new TopicManager(mockBot as any, store, -100123)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new MessageRouter(mockTmux as any, tm)

    const mockCtx = {
      message: {
        message_thread_id: 42,
        text: 'yes',
      },
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await router.handle(mockCtx as any)

    // sendKeys called twice: once with text, once with empty string (Enter)
    expect(sendKeysCalls.length).toBe(2)
    expect(sendKeysCalls[0]).toEqual(['%1', 'yes'])
    expect(sendKeysCalls[1]).toEqual(['%1', ''])

    await rm(tmpDir, { recursive: true, force: true })
  })

  it('ignores messages with no topic id', async () => {
    const sendKeysCalls: unknown[] = []
    const mockTmux = {
      sendKeys: mock(async (...args: unknown[]) => {
        sendKeysCalls.push(args)
      }),
    }

    const mockBot = { api: {} }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tm = new TopicManager(mockBot as any, store, -100123)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new MessageRouter(mockTmux as any, tm)

    const mockCtx = {
      message: { text: 'hello' }, // no message_thread_id
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await router.handle(mockCtx as any)

    expect(sendKeysCalls.length).toBe(0)

    await rm(tmpDir, { recursive: true, force: true })
  })

  it('ignores messages for unmapped topics', async () => {
    const sendKeysCalls: unknown[] = []
    const mockTmux = {
      sendKeys: mock(async (...args: unknown[]) => {
        sendKeysCalls.push(args)
      }),
    }

    const mockBot = { api: {} }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tm = new TopicManager(mockBot as any, store, -100123)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = new MessageRouter(mockTmux as any, tm)

    const mockCtx = {
      message: {
        message_thread_id: 9999, // not in store
        text: 'hello',
      },
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await router.handle(mockCtx as any)

    expect(sendKeysCalls.length).toBe(0)

    await rm(tmpDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// HTML escaping in format module
// ---------------------------------------------------------------------------

describe('formatOutput HTML escaping', () => {
  it('escapes HTML special chars in output', () => {
    const result = formatOutput('<b>hello &amp; world</b>')
    expect(result).not.toBeNull()
    expect(result).toContain('&lt;b&gt;')
    expect(result).toContain('&amp;amp;')
  })
})

describe('escapeHtml', () => {
  it('handles all special characters', () => {
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;')
  })
})
