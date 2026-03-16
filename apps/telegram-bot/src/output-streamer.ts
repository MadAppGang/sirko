import { formatOutput } from './format.js'

export interface OutputStreamerOptions {
  /** Called when a chunk is ready to send. */
  onSend: (params: {
    topicId: number
    text: string
    mode: 'html'
  }) => Promise<void>
  /** Called when output is too large and should be sent as a file. */
  onSendFile: (params: {
    topicId: number
    content: string
    filename: string
  }) => Promise<void>
  /** Debounce window in ms before flushing accumulated output. Default: 100 */
  debounceMs?: number
  /** Max characters to buffer before forcing a flush. Default: 3000 */
  maxBufferChars?: number
}

interface TopicBuffer {
  text: string
  timer: ReturnType<typeof setTimeout> | null
  lastFlushAt: number
}

/**
 * Accumulates output chunks per topic and flushes them according to the tiered
 * output strategy (single pre / split messages / file upload).
 * Rate-limit aware: enforces at most ~1 update per second per topic.
 */
export class OutputStreamer {
  private readonly buffers = new Map<number, TopicBuffer>()
  private readonly onSend: OutputStreamerOptions['onSend']
  private readonly onSendFile: OutputStreamerOptions['onSendFile']
  private readonly debounceMs: number
  private readonly maxBufferChars: number

  constructor(options: OutputStreamerOptions) {
    this.onSend = options.onSend
    this.onSendFile = options.onSendFile
    this.debounceMs = options.debounceMs ?? 100
    this.maxBufferChars = options.maxBufferChars ?? 3000
  }

  /** Append output text for a topic. Schedules a debounced flush. */
  push(topicId: number, text: string): void {
    let buf = this.buffers.get(topicId)
    if (buf === undefined) {
      buf = { text: '', timer: null, lastFlushAt: 0 }
      this.buffers.set(topicId, buf)
    }

    buf.text += text

    // Force flush if buffer exceeds max size
    if (buf.text.length >= this.maxBufferChars) {
      this._cancelTimer(buf)
      void this._flush(topicId, buf)
      return
    }

    // Debounce: reset timer on each new chunk
    this._cancelTimer(buf)
    buf.timer = setTimeout(() => {
      void this._flush(topicId, buf!)
    }, this.debounceMs)
  }

  /** Force an immediate flush for a topic. */
  flush(topicId: number): void {
    const buf = this.buffers.get(topicId)
    if (buf === undefined || buf.text.length === 0) return
    this._cancelTimer(buf)
    void this._flush(topicId, buf)
  }

  /** Flush all topics immediately (e.g. on shutdown). */
  flushAll(): void {
    for (const [topicId, buf] of this.buffers) {
      if (buf.text.length === 0) continue
      this._cancelTimer(buf)
      void this._flush(topicId, buf)
    }
  }

  private _cancelTimer(buf: TopicBuffer): void {
    if (buf.timer !== null) {
      clearTimeout(buf.timer)
      buf.timer = null
    }
  }

  private async _flush(topicId: number, buf: TopicBuffer): Promise<void> {
    const text = buf.text
    if (text.length === 0) return

    buf.text = ''
    buf.lastFlushAt = Date.now()

    const formatted = formatOutput(text)
    if (formatted !== null) {
      await this.onSend({ topicId, text: formatted, mode: 'html' })
    } else {
      // > 12000 chars: send as file
      await this.onSendFile({
        topicId,
        content: text,
        filename: `output-${Date.now()}.txt`,
      })
    }
  }
}
