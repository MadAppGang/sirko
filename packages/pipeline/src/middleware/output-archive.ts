import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Middleware } from '../compose.js'
import type { EventContext } from '../context.js'

export interface OutputArchiveOptions {
  logDir: string   // base directory, e.g., ~/.sirko/logs
}

/**
 * Appends output to per-session log files on disk.
 *
 * - Appends ctx.parsedText to {logDir}/{sessionId}/{paneId}.log
 * - Format: "[<ISO8601>] <text>\n"
 * - Fire-and-forget (does not await disk flush)
 * - On pane-exited: appends "[<ISO8601>] [exited: code <N>]\n"
 */
export function createOutputArchiveMiddleware(options: OutputArchiveOptions): Middleware {
  const { logDir } = options

  return async function outputArchiveMiddleware(
    ctx: EventContext,
    next: () => Promise<void>,
  ): Promise<void> {
    const t0 = Date.now()
    await next()

    const event = ctx.event
    const pane = ctx.pane

    if (pane === null) {
      ctx.middlewareDurations['output-archive'] = Date.now() - t0
      return
    }

    const { sessionId, paneId } = pane
    const sessionDir = join(logDir, sessionId)
    const logPath = join(sessionDir, `${paneId}.log`)
    const ts = new Date().toISOString()

    if (event.type === 'pane-output') {
      const text = ctx.parsedText ?? event.raw
      const line = `[${ts}] ${text}\n`
      // Fire-and-forget
      void mkdir(sessionDir, { recursive: true })
        .then(() => appendFile(logPath, line, 'utf8'))
        .catch(() => { /* non-fatal */ })
    } else if (event.type === 'pane-exited') {
      const exitCode = 'exitCode' in event
        ? (event as { exitCode?: number | null }).exitCode ?? null
        : null
      const line = `[${ts}] [exited: code ${exitCode ?? 'null'}]\n`
      void mkdir(sessionDir, { recursive: true })
        .then(() => appendFile(logPath, line, 'utf8'))
        .catch(() => { /* non-fatal */ })
    }

    ctx.middlewareDurations['output-archive'] = Date.now() - t0
  }
}
