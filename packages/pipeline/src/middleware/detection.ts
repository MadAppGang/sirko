import type { DetectorEngine } from '@sirko/detector'
import { getSkill } from '@sirko/tool-plugins'
import type { Middleware } from '../compose.js'
import type { EventContext } from '../context.js'

/**
 * Runs the DetectorEngine on the pane.
 * Sets ctx.detectionResult and ctx.pane.status (if awaiting).
 * Only runs on pane-output and quiescence-check events.
 */
export function createDetectionMiddleware(engine: DetectorEngine): Middleware {
  return async function detectionMiddleware(
    ctx: EventContext,
    next: () => Promise<void>,
  ): Promise<void> {
    const t0 = Date.now()

    // Only run for pane-output and quiescence-check events
    const eventType = ctx.event.type
    if (eventType !== 'pane-output' && eventType !== 'quiescence-check') {
      ctx.middlewareDurations['detection'] = Date.now() - t0
      await next()
      return
    }

    const pane = ctx.pane
    if (pane === null) {
      ctx.middlewareDurations['detection'] = Date.now() - t0
      await next()
      return
    }

    try {
      const skill = getSkill(pane.tool)
      const buffer = ctx.xtermBuffer ?? pane.lastBufferSnapshot

      const result = await engine.computeScore(pane, buffer, skill)
      ctx.detectionResult = result

      // Update pane status based on detection
      if (result.awaiting) {
        ctx.pane = { ...pane, status: 'awaiting-input' }
      } else {
        // If pane was awaiting but no longer is, reset to running
        if (pane.status === 'awaiting-input') {
          ctx.pane = { ...pane, status: 'running' }
        }
      }
    } catch {
      // Detection failure is non-fatal; continue pipeline
    }

    ctx.middlewareDurations['detection'] = Date.now() - t0
    await next()
  }
}
