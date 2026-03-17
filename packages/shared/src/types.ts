import type { SirkoEvent } from './events.js'

export type PaneStatus = 'running' | 'awaiting-input' | 'idle' | 'exited'

export type ToolName = 'claude-code' | 'codex' | 'aider' | 'unknown'

export type Platform = 'macos' | 'linux'

export interface PaneState {
  paneId: string
  sessionId: string
  windowId: string
  tool: ToolName
  pid: number | null
  status: PaneStatus
  exitCode: number | null
  notificationState: 'idle' | 'notified'
  lastNotifiedAt: number | null
  lastOutputTime: number
  processingCount: number
  xtermInstance: TerminalEmulator | null   // NOT serialized to disk; use TerminalEmulator from @sirko/shared
  lastBufferSnapshot: string
  telegramTopicId: number | null
  schemaVersion: number
  createdAt: number
  updatedAt: number
}

export interface SessionInfo {
  sessionId: string
  name: string
  createdAt: number
}

export interface CursorState {
  row: number
  col: number
  visible: boolean
}

export interface SignalBreakdown {
  promptPattern: { matched: boolean; pattern: string | null; weight: number; contribution: number }
  wchan:         { value: string | null; isWaiting: boolean; weight: number; contribution: number }
  quiescence:    { silenceMs: number; threshold: number; weight: number; contribution: number }
}

export interface DetectionResult {
  score: number
  awaiting: boolean
  tool: ToolName
  confidence: number
  signals: SignalBreakdown
}

export interface AudioFormat {
  codec: 'mulaw' | 'pcm16' | 'opus'
  sampleRate: 8000 | 16000 | 48000
  channels: 1 | 2
}

export interface ProcessInfo {
  pid: number
  ppid: number
  name: string
  argv: string[]
}

// Terminal emulator abstraction — defined in @sirko/shared (not @sirko/tmux-client) so PaneState
// can reference it without a circular dependency.
export interface TerminalEmulator {
  write(raw: string): void | Promise<void>
  getBuffer(): string       // current full screen as plain text
  getCursor(): CursorState
}

// Adapter sink contract — both TelegramAdapter and VoiceAdapter must implement this interface.
// The orchestrator maintains an AdapterSink[] array for uniform start/stop lifecycle management.
export interface AdapterSink {
  readonly name: string
  handlePaneOutput(event: Extract<SirkoEvent, { type: 'PaneOutput' }>): Promise<void>
  handlePaneAwaitingInput(event: Extract<SirkoEvent, { type: 'PaneAwaitingInput' }>): Promise<void>
  handlePaneExited(event: Extract<SirkoEvent, { type: 'PaneExited' }>): Promise<void>
  handleInputDelivered(event: Extract<SirkoEvent, { type: 'InputDelivered' }>): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  isHealthy(): boolean
}
