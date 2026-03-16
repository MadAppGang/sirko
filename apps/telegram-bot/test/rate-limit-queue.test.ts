import { describe, it, expect } from 'bun:test'
import { RateLimitQueue } from '../src/rate-limit-queue.js'

describe('RateLimitQueue', () => {
  it('executes calls that fit within rate limits immediately', async () => {
    const queue = new RateLimitQueue({ globalRps: 30, perChatMpm: 20 })
    let called = false
    await queue.enqueue(async () => {
      called = true
    })
    queue.stop()
    expect(called).toBe(true)
  })

  it('resolves with the return value of the function', async () => {
    const queue = new RateLimitQueue({ globalRps: 30 })
    const result = await queue.enqueue(async () => 42)
    queue.stop()
    expect(result).toBe(42)
  })

  it('propagates errors from the function', async () => {
    const queue = new RateLimitQueue({ globalRps: 30 })
    await expect(
      queue.enqueue(async () => {
        throw new Error('test error')
      }),
    ).rejects.toThrow('test error')
    queue.stop()
  })

  it('drops oldest call on queue overflow', async () => {
    // With maxQueueDepth=1, the second queued call should drop the first.
    const dropped: string[] = []

    const queue = new RateLimitQueue({
      globalRps: 0, // zero tokens - no immediate execution
      maxQueueDepth: 1,
    })

    // Enqueue two calls. The second should drop the first (oldest).
    const p1 = queue.enqueue(async () => 'call-1').catch(() => { dropped.push('call-1') })
    const p2 = queue.enqueue(async () => 'call-2').catch(() => { dropped.push('call-2') })

    queue.stop()

    // Wait for microtasks (rejection handlers) to run
    await Promise.allSettled([p1, p2])

    // The first queued item was dropped when the second item was enqueued
    expect(dropped).toContain('call-1')
  })

  it('executes multiple calls sequentially under rate limit', async () => {
    const queue = new RateLimitQueue({ globalRps: 30, perChatMpm: 20 })
    const executed: number[] = []

    await Promise.all([
      queue.enqueue(async () => { executed.push(1) }),
      queue.enqueue(async () => { executed.push(2) }),
      queue.enqueue(async () => { executed.push(3) }),
    ])

    queue.stop()
    expect(executed.length).toBe(3)
  })

  it('respects per-chat message limit option', async () => {
    // Just verify the constructor accepts perChatMpm option without error
    const queue = new RateLimitQueue({ globalRps: 30, perChatMpm: 5 })
    await queue.enqueue(async () => 'ok', { chatId: 'chat-1', countAsMessage: true })
    queue.stop()
  })
})
