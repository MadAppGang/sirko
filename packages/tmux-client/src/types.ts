export type TmuxEvent =
  | { type: 'pane-output';      paneId: string; sessionId: string; raw: string; timestamp: number }
  | { type: 'pane-exited';      paneId: string; sessionId: string }
  | { type: 'session-created';  sessionId: string; name: string }
  | { type: 'session-closed';   sessionId: string }
  | { type: 'window-add';       windowId: string; sessionId: string }
  | { type: 'window-close';     windowId: string; sessionId: string }
  | { type: 'quiescence-check'; paneId: string; sessionId: string }  // synthetic

export interface TmuxClientOptions {
  socketPath?: string          // tmux socket name passed to -L (legacy alias for socketName)
  socketName?: string          // tmux socket name passed to -L; takes precedence over socketPath
  reconnectInitialMs?: number  // default 1000
  reconnectMaxMs?: number      // default 30000
  coalesceWindowMs?: number    // default 50
}

// TerminalEmulator is defined in @sirko/shared/src/types.ts and re-exported here for convenience.
// This avoids a circular dependency: @sirko/shared cannot depend on @sirko/tmux-client.
export type { TerminalEmulator } from '@sirko/shared'
