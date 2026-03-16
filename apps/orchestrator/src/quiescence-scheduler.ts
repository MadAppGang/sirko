import type { StateStore } from '@sirko/state-store'
import type { Pipeline } from '@sirko/pipeline'
import { buildQuiescenceContext } from '@sirko/pipeline'
import { getSkill } from '@sirko/tool-plugins'

/**
 * QuiescenceScheduler — periodically checks all panes in the StateStore for
 * idle conditions and injects a synthetic quiescence-check pipeline run.
 *
 * A quiescence check is injected when:
 *   - pane.status is 'running' (not already awaiting-input, idle, or exited)
 *   - pane.processingCount === 0 (no active pipeline run in flight)
 *   - elapsed time since lastOutputTime >= skill.quiescenceThresholdMs
 */
export class QuiescenceScheduler {
  private readonly store: StateStore
  private readonly pipeline: Pipeline
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(store: StateStore, pipeline: Pipeline, intervalMs: number) {
    this.store = store
    this.pipeline = pipeline
    this.intervalMs = intervalMs
  }

  start(): void {
    if (this.timer !== null) {
      return
    }
    this.timer = setInterval(() => {
      this.tick().catch((err: unknown) => {
        console.error('[quiescence-scheduler] tick error', err)
      })
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    const panes = this.store.allPanes()

    for (const pane of panes) {
      // Skip panes that are already awaiting input, exited, or being processed
      if (pane.status === 'awaiting-input' || pane.status === 'exited') {
        continue
      }
      if (pane.processingCount > 0) {
        continue
      }

      const skill = getSkill(pane.tool)
      const elapsed = now - pane.lastOutputTime

      if (elapsed >= skill.quiescenceThresholdMs) {
        const ctx = buildQuiescenceContext(pane)
        // Fire-and-forget: errors are handled internally by the pipeline
        this.pipeline.run(ctx).catch((err: unknown) => {
          console.error('[quiescence-scheduler] pipeline run error for pane', pane.paneId, err)
        })
      }
    }
  }
}
