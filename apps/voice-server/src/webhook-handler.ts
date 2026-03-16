/**
 * webhook-handler — HTTP and WebSocket handlers for Twilio webhooks.
 *
 * Routes:
 *   POST /twilio/voice   — Initial call handler; returns TwiML
 *   POST /twilio/status  — Call status callback
 *   WS   /twilio/stream  — Bidirectional audio stream
 */

import type { TwilioTransport } from './twilio-transport.js'
import type { VoicePipeline } from './voice-pipeline.js'

export interface WebhookHandlerOptions {
  transport: TwilioTransport
  pipeline: VoicePipeline
  /** Base URL of this server (e.g. https://abc.ngrok.io) */
  webhookBaseUrl: string
  /** Optional set of authorized phone numbers */
  authorizedNumbers?: Set<string>
  onCallStarted?: (callSid: string, from: string) => void
  onCallEnded?: (callSid: string) => void
}

interface TwilioCallParams {
  CallSid?: string
  From?: string
  To?: string
  CallStatus?: string
}

/**
 * Handle POST /twilio/voice
 * Returns TwiML that connects the call to our WebSocket stream.
 */
export function handleVoiceWebhook(
  params: TwilioCallParams,
  options: WebhookHandlerOptions,
): { status: number; body: string; contentType: string } {
  const { CallSid, From } = params

  if (CallSid == null || From == null) {
    return { status: 400, body: 'Missing required params', contentType: 'text/plain' }
  }

  // Optional authorization check
  if (options.authorizedNumbers !== undefined && options.authorizedNumbers.size > 0) {
    if (!options.authorizedNumbers.has(From)) {
      const response = `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>`
      return { status: 200, body: response, contentType: 'text/xml' }
    }
  }

  const streamUrl = options.webhookBaseUrl.replace(/^http/, 'ws') + '/twilio/stream'
  const twiml = options.transport.buildStreamTwiml(streamUrl)

  options.onCallStarted?.(CallSid, From)

  return { status: 200, body: twiml, contentType: 'text/xml' }
}

/**
 * Handle POST /twilio/status
 * Updates internal state when a call status changes.
 */
export function handleStatusWebhook(
  params: TwilioCallParams,
  options: WebhookHandlerOptions,
): { status: number; body: string; contentType: string } {
  const { CallSid, CallStatus } = params

  if (CallSid == null) {
    return { status: 400, body: 'Missing CallSid', contentType: 'text/plain' }
  }

  if (CallStatus === 'completed' || CallStatus === 'failed' || CallStatus === 'canceled') {
    options.onCallEnded?.(CallSid)
  }

  return { status: 204, body: '', contentType: 'text/plain' }
}

/**
 * Message types received from Twilio Media Streams WebSocket.
 */
export type TwilioStreamMessage =
  | { event: 'connected'; protocol: string; version: string }
  | { event: 'start'; start: { streamSid: string; callSid: string; mediaFormat: { encoding: string; sampleRate: number; channels: number } } }
  | { event: 'media'; media: { track: string; chunk: string; timestamp: string; payload: string } }
  | { event: 'stop'; stop: { streamSid: string; callSid: string } }
  | { event: 'mark'; mark: { name: string } }

/**
 * Handle a parsed WebSocket message from Twilio's Media Streams.
 * Returns a TwiML/audio response to send back, or null for no-op.
 */
export async function handleStreamMessage(
  message: TwilioStreamMessage,
  pipeline: VoicePipeline,
  onAudioChunks?: (chunks: Buffer[]) => void,
): Promise<void> {
  if (message.event !== 'media') return

  // Decode base64 μ-law audio from Twilio
  const mulawAudio = Buffer.from(message.media.payload, 'base64')
  if (mulawAudio.length === 0) return

  const audioChunks = await pipeline.processUserAudio(mulawAudio)
  if (audioChunks !== null && onAudioChunks !== undefined) {
    onAudioChunks(audioChunks)
  }
}
