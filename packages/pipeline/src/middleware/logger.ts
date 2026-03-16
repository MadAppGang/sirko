import type { Middleware } from '../compose.js'
import type { EventContext } from '../context.js'

/**
 * Structured JSON logging of pipeline execution.
 *
 * Runs after all other middleware (last in compose array).
 * Emits one JSON line to stdout per event processed.
 * Swallows all errors (must never crash the pipeline).
 */
export function createLoggerMiddleware(): Middleware {
  return async function loggerMiddleware(
    ctx: EventContext,
    next: () => Promise<void>,
  ): Promise<void> {
    await next()

    try {
      const event = ctx.event
      const pane = ctx.pane

      const paneId = 'paneId' in event ? (event as { paneId: string }).paneId : undefined
      const sessionId = 'sessionId' in event ? (event as { sessionId: string }).sessionId : undefined

      const totalMs = Date.now() - ctx.startedAt

      const logEntry = {
        ts: Date.now(),
        event: event.type,
        paneId,
        sessionId,
        tool: pane?.tool,
        detectionScore: ctx.detectionResult?.score,
        awaiting: ctx.detectionResult?.awaiting,
        aborted: ctx.aborted,
        durations: ctx.middlewareDurations,
        totalMs,
      }

      process.stdout.write(JSON.stringify(logEntry) + '\n')
    } catch {
      // Must never crash the pipeline
    }
  }
}
