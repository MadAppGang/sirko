/**
 * VoiceAdapter — implements AdapterSink for voice call notifications.
 *
 * Responsibilities:
 *   - Start/stop an HTTP server for Twilio webhooks
 *   - Initiate an outbound call when a pane is awaiting input
 *   - Announce session end if a call is active
 *   - Cancel a pending call if input was delivered from another source
 *   - Queue calls (max 1 active at a time)
 */

import type { AdapterSink, SirkoEvent } from '@sirko/shared'
import type { StateStore } from '@sirko/state-store'
import type { TmuxClient } from '@sirko/tmux-client'
import type { VoiceTransport } from './voice-transport.js'
import type { VoicePipeline } from './voice-pipeline.js'
import {
  handleVoiceWebhook,
  handleStatusWebhook,
  handleStreamMessage,
  type TwilioStreamMessage,
} from './webhook-handler.js'

export interface VoiceAdapterConfig {
  port: number
  webhookBaseUrl: string
  phoneNumber: string
  authorizedNumbers?: string[]
}

interface CallEntry {
  paneId: string
  callSid: string
  startedAt: number
}

export class VoiceAdapter implements AdapterSink {
  readonly name = 'voice'

  private server: ReturnType<typeof Bun.serve> | null = null
  private activeCall: CallEntry | null = null
  private callQueue: Array<{ paneId: string; context: string }> = []
  private serverHealthy = false

  private readonly config: VoiceAdapterConfig
  private readonly transport: VoiceTransport
  private readonly pipeline: VoicePipeline
  private readonly store: StateStore
  // tmuxClient retained for future input delivery via voice
  private readonly _tmuxClient: TmuxClient

  constructor(
    config: VoiceAdapterConfig,
    transport: VoiceTransport,
    pipeline: VoicePipeline,
    tmuxClient: TmuxClient,
    store: StateStore,
  ) {
    this.config = config
    this.transport = transport
    this.pipeline = pipeline
    this._tmuxClient = tmuxClient
    this.store = store
  }

  async start(): Promise<void> {
    const adapter = this

    this.server = Bun.serve({
      port: this.config.port,
      async fetch(req) {
        return adapter.handleRequest(req)
      },
      websocket: {
        async message(ws, data) {
          try {
            const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
            const message = JSON.parse(text) as TwilioStreamMessage
            await handleStreamMessage(message, adapter.pipeline, (chunks) => {
              for (const chunk of chunks) {
                const payload = chunk.toString('base64')
                const msg = JSON.stringify({ event: 'media', media: { payload } })
                ws.send(msg)
              }
            })
          } catch (err) {
            console.error('[VoiceAdapter] WebSocket message error', err)
          }
        },
        open(_ws) {
          console.log('[VoiceAdapter] WebSocket stream opened')
        },
        close(_ws) {
          console.log('[VoiceAdapter] WebSocket stream closed')
        },
      },
    })

    this.serverHealthy = true
    console.log(`[VoiceAdapter] HTTP server started on port ${this.config.port}`)
  }

  async stop(): Promise<void> {
    this.serverHealthy = false

    // End active call if any
    if (this.activeCall !== null) {
      const { callSid, paneId, startedAt } = this.activeCall
      try {
        await this.transport.endCall(callSid)
      } catch (err) {
        console.error('[VoiceAdapter] Failed to end call on stop', err)
      }
      const durationSeconds = Math.round((Date.now() - startedAt) / 1000)
      console.log('[VoiceAdapter] Ended active call on stop', { callSid, paneId, durationSeconds })
      this.activeCall = null
    }

    this.callQueue = []

    if (this.server !== null) {
      this.server.stop()
      this.server = null
    }
  }

  isHealthy(): boolean {
    return this.serverHealthy
  }

  async handlePaneAwaitingInput(
    event: Extract<SirkoEvent, { type: 'PaneAwaitingInput' }>,
  ): Promise<void> {
    const { paneId, context } = event

    // Check if pane has already been notified
    const pane = this.store.getPane(paneId)
    if (pane?.notificationState === 'notified') {
      return
    }

    if (this.activeCall !== null) {
      // Queue this request (dedup by paneId)
      const alreadyQueued = this.callQueue.some((q) => q.paneId === paneId)
      if (!alreadyQueued) {
        this.callQueue.push({ paneId, context })
      }
      return
    }

    await this.initiateCallForPane(paneId, context)
  }

  async handlePaneOutput(
    _event: Extract<SirkoEvent, { type: 'PaneOutput' }>,
  ): Promise<void> {
    // No-op — voice only notifies on awaiting-input
  }

  async handlePaneExited(
    event: Extract<SirkoEvent, { type: 'PaneExited' }>,
  ): Promise<void> {
    if (this.activeCall !== null && this.activeCall.paneId === event.paneId) {
      // Announce that the session ended, then terminate
      try {
        const chunks = await this.pipeline.synthesize(
          `The terminal session for pane ${event.paneId} has ended with exit code ${event.exitCode ?? 'unknown'}.`,
        )
        // In a real system, chunks would be queued for playback before hangup.
        // For MVP, we just end the call.
        void chunks
        await this.transport.endCall(this.activeCall.callSid)
      } catch (err) {
        console.error('[VoiceAdapter] Error ending call on pane exit', err)
      }
      const durationSeconds = Math.round((Date.now() - this.activeCall.startedAt) / 1000)
      console.log('[VoiceAdapter] Call ended (pane exited)', {
        callSid: this.activeCall.callSid,
        durationSeconds,
      })
      this.activeCall = null
      this.drainQueue()
    }
  }

  async handleInputDelivered(
    event: Extract<SirkoEvent, { type: 'InputDelivered' }>,
  ): Promise<void> {
    if (event.source !== 'voice') {
      // Input came from another source (e.g. Telegram) — cancel pending call if queued
      this.callQueue = this.callQueue.filter((q) => q.paneId !== event.paneId)
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP request router
  // ---------------------------------------------------------------------------

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // Upgrade WebSocket
    if (url.pathname === '/twilio/stream') {
      if (this.server !== null) {
        const upgraded = this.server.upgrade(req, { data: undefined })
        if (upgraded) {
          // Bun returns true on successful upgrade; the response is handled internally
          return new Response(null, { status: 101 })
        }
      }
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const body = await req.text()
    const params = Object.fromEntries(new URLSearchParams(body)) as Record<string, string>

    // Validate Twilio webhook signature for authenticated endpoints
    if (url.pathname === '/twilio/voice' || url.pathname === '/twilio/status') {
      const twilioTransport = this.transport as import('./twilio-transport.js').TwilioTransport
      if (typeof twilioTransport.validateSignature === 'function') {
        const signature = req.headers.get('X-Twilio-Signature') ?? ''
        const fullUrl = `${this.config.webhookBaseUrl}${url.pathname}`
        const valid = twilioTransport.validateSignature(signature, fullUrl, params)
        if (!valid) {
          return new Response('Forbidden', { status: 403 })
        }
      }
    }

    const authorizedNumbers = this.config.authorizedNumbers !== undefined
      ? new Set(this.config.authorizedNumbers)
      : undefined
    const authorizedNumbersOpt = authorizedNumbers !== undefined
      ? { authorizedNumbers }
      : {}

    if (url.pathname === '/twilio/voice') {
      const result = handleVoiceWebhook(params, {
        transport: this.transport as import('./twilio-transport.js').TwilioTransport,
        pipeline: this.pipeline,
        webhookBaseUrl: this.config.webhookBaseUrl,
        ...authorizedNumbersOpt,
        onCallStarted: (callSid, from) => {
          console.log('[VoiceAdapter] Call started', { callSid, from })
        },
        onCallEnded: (callSid) => {
          if (this.activeCall?.callSid === callSid) {
            const durationSeconds = Math.round((Date.now() - (this.activeCall?.startedAt ?? Date.now())) / 1000)
            console.log('[VoiceAdapter] Call ended via status callback', { callSid, durationSeconds })
            this.activeCall = null
            this.drainQueue()
          }
        },
      })
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      })
    }

    if (url.pathname === '/twilio/status') {
      const result = handleStatusWebhook(params, {
        transport: this.transport as import('./twilio-transport.js').TwilioTransport,
        pipeline: this.pipeline,
        webhookBaseUrl: this.config.webhookBaseUrl,
        ...authorizedNumbersOpt,
        onCallEnded: (callSid) => {
          if (this.activeCall?.callSid === callSid) {
            const durationSeconds = Math.round((Date.now() - (this.activeCall?.startedAt ?? Date.now())) / 1000)
            console.log('[VoiceAdapter] Call ended (status callback)', { callSid, durationSeconds })
            this.activeCall = null
            this.drainQueue()
          }
        },
      })
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      })
    }

    return new Response('Not Found', { status: 404 })
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async initiateCallForPane(paneId: string, context: string): Promise<void> {
    const webhookUrl = `${this.config.webhookBaseUrl}/twilio/voice`

    try {
      const callSid = await this.transport.initiateCall(this.config.phoneNumber, webhookUrl)
      this.activeCall = { paneId, callSid, startedAt: Date.now() }

      this.store.setNotificationState(paneId, 'notified')

      // Pre-generate TTS notification in background
      void this.pipeline.notifyContext(context).catch((err) => {
        console.error('[VoiceAdapter] TTS pre-generation failed', err)
      })

      console.log('[VoiceAdapter] Call initiated', { callSid, paneId })
    } catch (err) {
      console.error('[VoiceAdapter] Failed to initiate call', { paneId, err })
    }
  }

  private drainQueue(): void {
    const next = this.callQueue.shift()
    if (next !== undefined) {
      void this.initiateCallForPane(next.paneId, next.context).catch((err) => {
        console.error('[VoiceAdapter] Queue drain failed', err)
      })
    }
  }
}
