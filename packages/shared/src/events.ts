import type { ToolName, SignalBreakdown } from './types.js'

export type SirkoEvent =
  | {
      type: 'PaneOutput'
      paneId: string
      sessionId: string
      text: string
      raw: string
      timestamp: number
    }
  | {
      type: 'PaneAwaitingInput'
      paneId: string
      sessionId: string
      tool: ToolName
      confidence: number
      score: number
      context: string
      signals: SignalBreakdown
    }
  | {
      type: 'InputDelivered'
      paneId: string
      sessionId: string
      source: 'telegram' | 'voice'
      text: string
    }
  | {
      type: 'PaneExited'
      paneId: string
      sessionId: string
      exitCode: number | null
    }
  | {
      type: 'SessionCreated'
      sessionId: string
      name: string
    }
  | {
      type: 'SessionClosed'
      sessionId: string
    }
  | {
      type: 'VoiceCallStarted'
      paneId: string
      callSid: string
      transport: 'twilio' | 'livekit'
    }
  | {
      type: 'VoiceCallEnded'
      paneId: string
      callSid: string
      durationSeconds: number
    }
  | {
      type: 'VoiceCallFailed'
      paneId: string
      reason: string
    }
  | {
      type: 'SinkError'
      sink: 'telegram' | 'voice'
      paneId: string | null
      error: string
      retriable: boolean
    }
