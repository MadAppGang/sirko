import type { TmuxEvent } from './types.js'

type PaneOutputEvent = Extract<TmuxEvent, { type: 'pane-output' }>

interface PendingBuffer {
  paneId: string
  sessionId: string
  raw: string
  timestamp: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * Coalesces rapid %output events for the same pane within a time window.
 * Calls onEvent with a single merged PaneOutputEvent per window per pane.
 */
export class OutputCoalescer {
  private readonly windowMs: number
  private readonly onEvent: (event: TmuxEvent) => void
  private readonly pending = new Map<string, PendingBuffer>()

  constructor(windowMs: number, onEvent: (event: TmuxEvent) => void) {
    this.windowMs = windowMs
    this.onEvent = onEvent
  }

  push(event: PaneOutputEvent): void {
    const existing = this.pending.get(event.paneId)
    if (existing) {
      // Extend the buffer with new data
      clearTimeout(existing.timer)
      existing.raw += event.raw
      existing.timer = setTimeout(() => this._emit(event.paneId), this.windowMs)
    } else {
      const entry: PendingBuffer = {
        paneId: event.paneId,
        sessionId: event.sessionId,
        raw: event.raw,
        timestamp: event.timestamp,
        timer: setTimeout(() => this._emit(event.paneId), this.windowMs),
      }
      this.pending.set(event.paneId, entry)
    }
  }

  /** Force-flush all pending buffers (for shutdown). */
  flush(): void {
    for (const paneId of [...this.pending.keys()]) {
      this._emit(paneId)
    }
  }

  private _emit(paneId: string): void {
    const buf = this.pending.get(paneId)
    if (!buf) return
    clearTimeout(buf.timer)
    this.pending.delete(paneId)
    this.onEvent({
      type: 'pane-output',
      paneId: buf.paneId,
      sessionId: buf.sessionId,
      raw: buf.raw,
      timestamp: buf.timestamp,
    })
  }
}
