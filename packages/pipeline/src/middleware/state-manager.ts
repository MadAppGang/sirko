import type { PaneState } from '@sirko/shared'
import type { StateStore } from '@sirko/state-store'
import type { TmuxClient } from '@sirko/tmux-client'
import type { Middleware } from '../compose.js'
import type { EventContext } from '../context.js'

/**
 * Creates or loads PaneState for the current event's pane.
 *
 * PRE (before next()): load pane from store → ctx.pane; increment processingCount
 * POST (after next()): write ctx.pane back to store; decrement processingCount
 *
 * Uses try/finally to ensure POST always runs.
 */
export function createStateManagerMiddleware(
  store: StateStore,
  tmuxClient: TmuxClient,
): Middleware {
  return async function stateManagerMiddleware(
    ctx: EventContext,
    next: () => Promise<void>,
  ): Promise<void> {
    const t0 = Date.now()

    const event = ctx.event

    // Only manage pane state for pane-level events
    const hasPaneId = 'paneId' in event
    if (!hasPaneId) {
      ctx.middlewareDurations['state-manager'] = Date.now() - t0
      await next()
      return
    }

    const paneId = (event as { paneId: string }).paneId
    const sessionId = 'sessionId' in event ? (event as { sessionId: string }).sessionId : ''

    // PRE: load or create pane
    let pane = store.getPane(paneId)
    if (pane === undefined) {
      // Create new pane state
      let pid: number | null = null
      try {
        pid = await tmuxClient.getPanePid(paneId)
      } catch {
        // Ignore errors — pane may have just appeared
      }

      const newPane: PaneState = {
        paneId,
        sessionId,
        windowId: '',
        tool: 'unknown',
        pid,
        status: 'running',
        exitCode: null,
        notificationState: 'idle',
        lastNotifiedAt: null,
        lastOutputTime: Date.now(),
        processingCount: 0,
        xtermInstance: null,
        lastBufferSnapshot: '',
        telegramTopicId: null,
        schemaVersion: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      store.setPane(paneId, newPane)
      pane = newPane
    }

    // Increment processingCount
    const updatedPre: PaneState = {
      ...pane,
      processingCount: pane.processingCount + 1,
      updatedAt: Date.now(),
    }
    store.setPane(paneId, updatedPre)
    ctx.pane = updatedPre

    ctx.middlewareDurations['state-manager'] = Date.now() - t0

    try {
      await next()
    } finally {
      // POST: write ctx.pane back to store; decrement processingCount
      const t1 = Date.now()
      if (ctx.pane !== null) {
        const finalPane: PaneState = {
          ...ctx.pane,
          processingCount: Math.max(0, ctx.pane.processingCount - 1),
          updatedAt: Date.now(),
        }
        ctx.pane = finalPane
        store.setPane(paneId, finalPane)
      }
      // Accumulate post-time into duration
      ctx.middlewareDurations['state-manager'] =
        (ctx.middlewareDurations['state-manager'] ?? 0) + (Date.now() - t1)
    }
  }
}
