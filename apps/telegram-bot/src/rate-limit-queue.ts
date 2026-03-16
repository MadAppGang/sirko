/**
 * Token-bucket rate limiter for Telegram Bot API calls.
 *
 * Enforces:
 * - global: max `globalRps` requests per second (across all chats)
 * - per-chat: max `perChatMpm` message-type calls per minute per chatId
 */

export interface RateLimitQueueOptions {
  /** Requests per second across all calls. Default: 30 */
  globalRps?: number
  /** Messages per minute per chat for sendMessage/edit calls. Default: 20 */
  perChatMpm?: number
  /** Maximum pending queue depth (oldest dropped on overflow). Default: 100 */
  maxQueueDepth?: number
}

interface PendingCallBase {
  chatId: string | number | undefined
  countAsMessage: boolean
  run: () => void
  reject: (err: unknown) => void
}

interface PendingCall<T> extends PendingCallBase {
  fn: () => Promise<T>
  resolve: (value: T) => void
}

interface TokenBucket {
  tokens: number
  lastRefill: number
  maxTokens: number
  refillPerMs: number
}

function refillBucket(bucket: TokenBucket): void {
  const now = Date.now()
  const elapsed = now - bucket.lastRefill
  bucket.tokens = Math.min(
    bucket.maxTokens,
    bucket.tokens + elapsed * bucket.refillPerMs,
  )
  bucket.lastRefill = now
}

export class RateLimitQueue {
  private readonly globalBucket: TokenBucket
  private readonly perChatBuckets = new Map<string | number, TokenBucket>()
  private readonly perChatMpm: number
  private readonly maxQueueDepth: number
  private readonly queue: Array<PendingCallBase> = []
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(options: RateLimitQueueOptions = {}) {
    const globalRps = options.globalRps ?? 30
    this.perChatMpm = options.perChatMpm ?? 20
    this.maxQueueDepth = options.maxQueueDepth ?? 100

    this.globalBucket = {
      tokens: globalRps,
      lastRefill: Date.now(),
      maxTokens: globalRps,
      refillPerMs: globalRps / 1000,
    }
  }

  /**
   * Enqueue a Telegram API call. Resolves when the call completes.
   */
  enqueue<T>(
    fn: () => Promise<T>,
    opts: { chatId?: string | number; countAsMessage?: boolean } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const call: PendingCall<T> = {
        fn,
        chatId: opts.chatId,
        countAsMessage: opts.countAsMessage ?? false,
        resolve,
        reject,
        run: () => { fn().then(resolve, reject) },
      }

      // Try immediate execution
      if (this._canExecute(call)) {
        this._consumeTokens(call)
        call.run()
        return
      }

      // Queue with overflow protection (drop oldest)
      if (this.queue.length >= this.maxQueueDepth) {
        const dropped = this.queue.shift()
        dropped?.reject(new Error('RateLimitQueue: queue overflow, call dropped'))
      }
      this.queue.push(call)
      this._ensureTicker()
    })
  }

  private _getPerChatBucket(chatId: string | number): TokenBucket {
    let bucket = this.perChatBuckets.get(chatId)
    if (bucket === undefined) {
      bucket = {
        tokens: this.perChatMpm,
        lastRefill: Date.now(),
        maxTokens: this.perChatMpm,
        refillPerMs: this.perChatMpm / 60000,
      }
      this.perChatBuckets.set(chatId, bucket)
    }
    return bucket
  }

  private _canExecute(call: PendingCallBase): boolean {
    refillBucket(this.globalBucket)
    if (this.globalBucket.tokens < 1) return false

    if (call.countAsMessage && call.chatId !== undefined) {
      const chatBucket = this._getPerChatBucket(call.chatId)
      refillBucket(chatBucket)
      if (chatBucket.tokens < 1) return false
    }

    return true
  }

  private _consumeTokens(call: PendingCallBase): void {
    this.globalBucket.tokens -= 1

    if (call.countAsMessage && call.chatId !== undefined) {
      const chatBucket = this._getPerChatBucket(call.chatId)
      chatBucket.tokens -= 1
    }
  }

  private _ensureTicker(): void {
    if (this.ticker !== null) return
    this.ticker = setInterval(() => this._drain(), 50)
  }

  private _drain(): void {
    let i = 0
    while (i < this.queue.length) {
      const call = this.queue[i]
      if (call === undefined) {
        i++
        continue
      }
      if (this._canExecute(call)) {
        this._consumeTokens(call)
        this.queue.splice(i, 1)
        call.run()
      } else {
        i++
      }
    }

    if (this.queue.length === 0 && this.ticker !== null) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  /** Stop the internal ticker and reject all pending queued calls. */
  stop(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    // Reject all remaining queued items
    while (this.queue.length > 0) {
      const item = this.queue.shift()
      item?.reject(new Error('RateLimitQueue: stopped'))
    }
  }
}
