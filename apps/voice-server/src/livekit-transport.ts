/**
 * LiveKitTransport — stub implementation of VoiceTransport.
 *
 * This is a placeholder for the Phase 5 production voice interface.
 * All methods throw until the LiveKit integration is implemented.
 */

import type { VoiceTransport } from './voice-transport.js'

export class LiveKitTransport implements VoiceTransport {
  readonly name = 'livekit'

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async initiateCall(_phoneNumber: string, _webhookUrl: string): Promise<string> {
    throw new Error('LiveKit transport not yet implemented')
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async endCall(_callSid: string): Promise<void> {
    throw new Error('LiveKit transport not yet implemented')
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async isCallActive(_callSid: string): Promise<boolean> {
    throw new Error('LiveKit transport not yet implemented')
  }
}
