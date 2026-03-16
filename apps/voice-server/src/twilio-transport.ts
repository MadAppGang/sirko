/**
 * TwilioTransport — VoiceTransport implementation using the Twilio REST API.
 *
 * Outbound calls use TwiML <Connect><Stream> to establish bidirectional
 * WebSocket audio with the voice-server's /twilio/stream endpoint.
 */

import Twilio from 'twilio'
import type { VoiceTransport } from './voice-transport.js'

export interface TwilioTransportConfig {
  accountSid: string
  authToken: string
  fromNumber: string
}

// Active call statuses from Twilio
const ACTIVE_STATUSES = new Set(['queued', 'ringing', 'in-progress'])

export class TwilioTransport implements VoiceTransport {
  readonly name = 'twilio'

  private readonly client: ReturnType<typeof Twilio>
  private readonly config: TwilioTransportConfig

  constructor(config: TwilioTransportConfig) {
    this.config = config
    this.client = Twilio(config.accountSid, config.authToken)
  }

  async initiateCall(phoneNumber: string, webhookUrl: string): Promise<string> {
    const call = await this.client.calls.create({
      to: phoneNumber,
      from: this.config.fromNumber,
      url: webhookUrl,
      statusCallback: webhookUrl.replace('/twilio/voice', '/twilio/status'),
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    })
    return call.sid
  }

  async endCall(callSid: string): Promise<void> {
    await this.client.calls(callSid).update({ status: 'completed' })
  }

  async isCallActive(callSid: string): Promise<boolean> {
    const call = await this.client.calls(callSid).fetch()
    return ACTIVE_STATUSES.has(call.status)
  }

  /**
   * Validate an incoming Twilio webhook request.
   * Returns true if the X-Twilio-Signature header is valid.
   */
  validateSignature(signature: string, url: string, params: Record<string, string>): boolean {
    return Twilio.validateRequest(this.config.authToken, signature, url, params)
  }

  /**
   * Build TwiML to connect the call to our bidirectional WebSocket stream.
   */
  buildStreamTwiml(streamUrl: string): string {
    const VoiceResponse = Twilio.twiml.VoiceResponse
    const response = new VoiceResponse()
    const connect = response.connect()
    connect.stream({ url: streamUrl })
    return response.toString()
  }
}
