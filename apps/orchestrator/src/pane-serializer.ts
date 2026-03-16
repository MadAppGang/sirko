/**
 * PaneSerializer — per-pane pipeline serialization.
 *
 * Chains pipeline runs per pane so that only one pipeline run is active
 * per pane at any given time. Uses a Promise chain per pane key.
 */
export class PaneSerializer {
  private readonly queue: Map<string, Promise<void>> = new Map()

  /**
   * Enqueues a pipeline run for the given pane key.
   * Ensures runs are serialized: the next run only starts once the previous completes.
   * Errors from individual runs are caught so the chain never breaks.
   */
  runForPane(paneId: string, fn: () => Promise<void>): Promise<void> {
    const existing = this.queue.get(paneId) ?? Promise.resolve()
    const next = existing.then(fn).catch((err: unknown) => {
      console.error('[pane-serializer] pipeline error for pane', paneId, err)
    })
    this.queue.set(paneId, next)
    // Clean up the Map entry once this promise settles and nothing newer was enqueued
    next.finally(() => {
      if (this.queue.get(paneId) === next) {
        this.queue.delete(paneId)
      }
    })
    return next
  }

  /**
   * Returns the number of panes currently tracked.
   */
  get size(): number {
    return this.queue.size
  }
}
