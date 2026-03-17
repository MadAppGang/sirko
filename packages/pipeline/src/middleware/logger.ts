import type { Middleware } from '../compose.js'
import type { EventContext } from '../context.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LoggerOptions {
  level?: LogLevel
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function shouldLog(configured: LogLevel, messageLevel: LogLevel): boolean {
  return LEVEL_RANK[messageLevel] >= LEVEL_RANK[configured]
}

function ts(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false })
}

/**
 * Human-readable pipeline logger.
 *
 * Log levels:
 *   debug — every pipeline event (quiescence-check, pane-output, etc.)
 *   info  — only interesting events (detection fired, pane exited, errors)
 *
 * Runs after all other middleware (last in compose array).
 */
export function createLoggerMiddleware(options?: LoggerOptions): Middleware {
  const level = options?.level ?? 'info'

  return async function loggerMiddleware(
    ctx: EventContext,
    next: () => Promise<void>,
  ): Promise<void> {
    await next()

    try {
      const event = ctx.event
      const paneId = 'paneId' in event ? (event as { paneId: string }).paneId : null
      const totalMs = Date.now() - ctx.startedAt
      const detection = ctx.detectionResult

      // --- debug: log everything ---
      if (event.type === 'quiescence-check') {
        if (detection?.awaiting) {
          // Always log when detection fires
          console.log(
            `${ts()} ⚡ DETECTED ${paneId} awaiting input — score: ${detection.score.toFixed(2)}, ` +
            `prompt: ${detection.signals.promptPattern.matched}, ` +
            `quiet: ${detection.signals.quiescence.silenceMs}ms (${totalMs}ms)`,
          )
        } else if (shouldLog(level, 'debug')) {
          console.log(
            `${ts()} 🔍 quiescence ${paneId} — score: ${(detection?.score ?? 0).toFixed(2)} (${totalMs}ms)`,
          )
        }
        return
      }

      if (event.type === 'pane-output') {
        const raw = 'raw' in event ? (event as { raw: string }).raw : ''
        // Strip ANSI escapes and control chars
        const text = raw
          .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // CSI sequences
          .replace(/\x1b\][^\x07]*\x07/g, '')      // OSC sequences
          .replace(/\x1b[()][AB012]/g, '')          // charset
          .replace(/\x1b[78DMEHcnop><=]/g, '')      // single-char escapes
          .replace(/\x1bk[^\x1b]*\x1b\\/g, '')      // tmux title sequences
          .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')  // control chars (keep \n)
          .replace(/\r\n?/g, '\n')                     // normalize newlines
          .trim()

        if (detection?.awaiting) {
          console.log(
            `${ts()} ⚡ DETECTED ${paneId} awaiting input — score: ${detection.score.toFixed(2)} (${totalMs}ms)`,
          )
        } else if (text.length > 0) {
          const oneLine = text.replace(/\n+/g, ' ').slice(0, 120)
          console.log(`${ts()} 📤 ${paneId} ${oneLine}`)
        }
        return
      }

      if (event.type === 'pane-exited') {
        console.log(`${ts()} 🚪 pane exited ${paneId}`)
        return
      }

      if (event.type === 'window-add') {
        const wid = 'windowId' in event ? (event as { windowId: string }).windowId : ''
        console.log(`${ts()} 🪟 new window ${wid}`)
        return
      }

      if (event.type === 'window-close') {
        const wid = 'windowId' in event ? (event as { windowId: string }).windowId : ''
        console.log(`${ts()} 🪟 window closed ${wid}`)
        return
      }

      if (event.type === 'session-created' || event.type === 'session-closed') {
        if (shouldLog(level, 'debug')) {
          const sid = 'sessionId' in event ? (event as { sessionId: string }).sessionId : ''
          console.log(`${ts()} 📋 ${event.type} ${sid}`)
        }
        return
      }

      // Fallback for unknown event types
      if (shouldLog(level, 'debug')) {
        console.log(`${ts()} ❓ ${event.type} ${paneId ?? ''} (${totalMs}ms)`)
      }
    } catch {
      // Must never crash the pipeline
    }
  }
}
