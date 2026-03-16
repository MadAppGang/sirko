import type { TmuxEvent } from '@sirko/tmux-client'
import type { PaneState, CursorState, DetectionResult } from '@sirko/shared'
import type { SirkoEvent } from '@sirko/shared'

export type SideEffect =
  | { kind: 'send-keys';    paneId: string; text: string }
  | { kind: 'file-append';  path: string;   content: string }
  | { kind: 'bus-emit';     event: SirkoEvent }
  | { kind: 'telegram-api'; method: string; params: unknown }

export interface EventContext {
  readonly event: TmuxEvent
  readonly startedAt: number           // Date.now() milliseconds at context creation

  pane: PaneState | null               // null for session events

  // Populated by xterm-interpret (pane-output events only)
  parsedText?: string
  cursorState?: CursorState
  xtermBuffer?: string

  // Populated by detection middleware
  detectionResult?: DetectionResult

  // Pipeline control
  aborted: boolean
  sideEffects: SideEffect[]
  middlewareDurations: Record<string, number>
}

export function buildContext(event: TmuxEvent, pane: PaneState | null): EventContext {
  return {
    event,
    startedAt: Date.now(),
    pane,
    aborted: false,
    sideEffects: [],
    middlewareDurations: {},
  }
}

export function buildQuiescenceContext(pane: PaneState): EventContext {
  const event: TmuxEvent = {
    type: 'quiescence-check',
    paneId: pane.paneId,
    sessionId: pane.sessionId,
  }
  return buildContext(event, pane)
}
