import type { TerminalEmulator } from '@sirko/shared'
import type { TmuxClient } from '@sirko/tmux-client'
import type { Middleware } from '../compose.js'
import type { EventContext } from '../context.js'

export interface XtermInterpretOptions {
  emulatorType?: 'xterm' | 'buffer'  // 'buffer' = degraded BufferEmulator fallback
}

/**
 * Feeds raw output through the pane's TerminalEmulator.
 * Updates lastBufferSnapshot in PaneState.
 *
 * - Runs AFTER state-manager (which populates ctx.pane); requires ctx.pane to be set
 * - Only acts on pane-output events; calls next() immediately for others
 * - Retrieves or lazily creates TerminalEmulator from pane.xtermInstance
 * - Sets ctx.parsedText, ctx.cursorState, ctx.xtermBuffer
 * - On error: sets ctx.parsedText = ctx.event.raw (fallback); calls next()
 */
export function createXtermInterpretMiddleware(
  tmuxClient: TmuxClient,
  options?: XtermInterpretOptions,
): Middleware {
  return async function xtermInterpretMiddleware(
    ctx: EventContext,
    next: () => Promise<void>,
  ): Promise<void> {
    const t0 = Date.now()

    // Only act on pane-output events
    if (ctx.event.type !== 'pane-output') {
      ctx.middlewareDurations['xterm-interpret'] = Date.now() - t0
      await next()
      return
    }

    const pane = ctx.pane
    if (pane === null) {
      ctx.middlewareDurations['xterm-interpret'] = Date.now() - t0
      await next()
      return
    }

    try {
      // Get or create terminal emulator
      let emulator: TerminalEmulator | null = pane.xtermInstance

      if (emulator === null) {
        if (options?.emulatorType === 'buffer') {
          emulator = tmuxClient.createTerminalEmulator()
        } else {
          // Attempt xterm upgrade, fall back to buffer
          try {
            emulator = await tmuxClient.upgradeTerminalEmulator()
          } catch {
            emulator = tmuxClient.createTerminalEmulator()
          }
        }
        // Store emulator on pane
        pane.xtermInstance = emulator
        ctx.pane = pane
      }

      // Feed raw output (may be async for XtermEmulator)
      const raw = ctx.event.raw
      await emulator.write(raw)

      // Capture state
      const buffer = emulator.getBuffer()
      const cursor = emulator.getCursor()

      ctx.parsedText = buffer
      ctx.cursorState = cursor
      ctx.xtermBuffer = buffer

      // Update lastBufferSnapshot
      pane.lastBufferSnapshot = buffer
      pane.lastOutputTime = Date.now()
      ctx.pane = pane
    } catch {
      // Fallback: use raw output
      ctx.parsedText = ctx.event.raw
    }

    ctx.middlewareDurations['xterm-interpret'] = Date.now() - t0
    await next()
  }
}
