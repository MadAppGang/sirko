import type { Middleware } from '../compose.js'
import type { EventContext } from '../context.js'

/**
 * Deduplication middleware: prevents duplicate notifications.
 *
 * - If ctx.pane.notificationState == 'notified' AND ctx.detectionResult.awaiting:
 *     sets ctx.aborted = true; returns WITHOUT calling next()
 * - If ctx.pane.notificationState == 'notified' AND NOT awaiting:
 *     resets notificationState to 'idle'; calls next()
 * - Otherwise: calls next()
 */
export function createDedupMiddleware(): Middleware {
  return async function dedupMiddleware(
    ctx: EventContext,
    next: () => Promise<void>,
  ): Promise<void> {
    const t0 = Date.now()

    const pane = ctx.pane
    const detection = ctx.detectionResult

    if (pane !== null && detection !== undefined) {
      if (pane.notificationState === 'notified' && detection.awaiting) {
        // Already notified and still awaiting — abort to prevent duplicate notification
        ctx.aborted = true
        ctx.middlewareDurations['dedup'] = Date.now() - t0
        return
      }

      if (pane.notificationState === 'notified' && !detection.awaiting) {
        // Was notified but no longer awaiting — reset notification state
        ctx.pane = { ...pane, notificationState: 'idle' }
      }
    }

    ctx.middlewareDurations['dedup'] = Date.now() - t0
    await next()
  }
}
