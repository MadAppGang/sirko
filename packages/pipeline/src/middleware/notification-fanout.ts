import type { TypedEventBus } from '@sirko/event-bus'
import type { Middleware } from '../compose.js'
import type { EventContext } from '../context.js'

/**
 * Emits SirkoEvents to the EventBus based on pipeline results.
 *
 * - Always emits PaneOutput event (for pane-output events)
 * - If !ctx.aborted && ctx.detectionResult?.awaiting: emits PaneAwaitingInput; sets notificationState='notified'
 * - For pane-exited events: emits PaneExited
 * - Records bus-emit in ctx.sideEffects
 */
export function createNotificationFanoutMiddleware(bus: TypedEventBus): Middleware {
  return async function notificationFanoutMiddleware(
    ctx: EventContext,
    next: () => Promise<void>,
  ): Promise<void> {
    const t0 = Date.now()

    await next()

    const pane = ctx.pane
    const event = ctx.event

    if (event.type === 'pane-output' && pane !== null) {
      const paneOutputEvent = {
        type: 'PaneOutput' as const,
        paneId: pane.paneId,
        sessionId: pane.sessionId,
        text: ctx.parsedText ?? event.raw,
        raw: event.raw,
        timestamp: event.timestamp,
      }
      ctx.sideEffects.push({ kind: 'bus-emit', event: paneOutputEvent })
      await bus.emit(paneOutputEvent)

      // Emit PaneAwaitingInput if detection says awaiting and not aborted
      if (!ctx.aborted && ctx.detectionResult?.awaiting === true) {
        const awaitingEvent = {
          type: 'PaneAwaitingInput' as const,
          paneId: pane.paneId,
          sessionId: pane.sessionId,
          tool: pane.tool,
          confidence: ctx.detectionResult.confidence,
          score: ctx.detectionResult.score,
          context: pane.lastBufferSnapshot,
          signals: ctx.detectionResult.signals,
        }
        ctx.sideEffects.push({ kind: 'bus-emit', event: awaitingEvent })
        await bus.emit(awaitingEvent)

        // Update notification state on pane
        if (ctx.pane !== null) {
          ctx.pane = {
            ...ctx.pane,
            notificationState: 'notified',
            lastNotifiedAt: Date.now(),
          }
        }
      }
    } else if (event.type === 'quiescence-check' && pane !== null) {
      // Quiescence checks can also trigger PaneAwaitingInput
      if (!ctx.aborted && ctx.detectionResult?.awaiting === true) {
        const awaitingEvent = {
          type: 'PaneAwaitingInput' as const,
          paneId: pane.paneId,
          sessionId: pane.sessionId,
          tool: pane.tool,
          confidence: ctx.detectionResult.confidence,
          score: ctx.detectionResult.score,
          context: pane.lastBufferSnapshot,
          signals: ctx.detectionResult.signals,
        }
        ctx.sideEffects.push({ kind: 'bus-emit', event: awaitingEvent })
        await bus.emit(awaitingEvent)

        if (ctx.pane !== null) {
          ctx.pane = {
            ...ctx.pane,
            notificationState: 'notified',
            lastNotifiedAt: Date.now(),
          }
        }
      }
    } else if (event.type === 'pane-exited' && pane !== null) {
      const exitedEvent = {
        type: 'PaneExited' as const,
        paneId: pane.paneId,
        sessionId: pane.sessionId,
        exitCode: 'exitCode' in event ? (event as { exitCode?: number | null }).exitCode ?? null : null,
      }
      ctx.sideEffects.push({ kind: 'bus-emit', event: exitedEvent })
      await bus.emit(exitedEvent)
    }

    ctx.middlewareDurations['notification-fanout'] = Date.now() - t0
  }
}
