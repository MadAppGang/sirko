/**
 * Mock voice dependencies for E2E tests.
 *
 * Provides fake VoiceTransport and VoicePipeline that track calls
 * without hitting real Twilio/Deepgram/ElevenLabs.
 */

import type { VoiceTransport } from '@sirko/voice-server'

interface InitiatedCall {
  phoneNumber: string
  webhookUrl: string
  callSid: string
}

export interface MockVoiceTransport extends VoiceTransport {
  readonly initiatedCalls: readonly InitiatedCall[]
  readonly endedCalls: readonly string[]
}

export function createMockVoiceTransport(): MockVoiceTransport & {
  buildStreamTwiml(streamUrl: string): string
  validateSignature(signature: string, url: string, params: Record<string, string>): boolean
} {
  const initiatedCalls: InitiatedCall[] = []
  const endedCalls: string[] = []
  let callCounter = 0

  return {
    name: 'mock-twilio',
    initiatedCalls,
    endedCalls,

    async initiateCall(phoneNumber: string, webhookUrl: string): Promise<string> {
      callCounter++
      const callSid = `CA-mock-${callCounter}-${Date.now()}`
      initiatedCalls.push({ phoneNumber, webhookUrl, callSid })
      return callSid
    },

    async endCall(callSid: string): Promise<void> {
      endedCalls.push(callSid)
    },

    async isCallActive(callSid: string): Promise<boolean> {
      return initiatedCalls.some((c) => c.callSid === callSid) &&
        !endedCalls.includes(callSid)
    },

    buildStreamTwiml(streamUrl: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${streamUrl}"/></Connect></Response>`
    },

    validateSignature(): boolean {
      return true // Always valid in tests
    },
  }
}

export interface MockVoicePipeline {
  transcribe(audio: Buffer): Promise<string | null>
  synthesize(text: string): Promise<Buffer[]>
  processUserAudio(audio: Buffer): Promise<Buffer[] | null>
  notifyContext(text: string): Promise<Buffer[]>
  summarizeContext(text: string): Promise<string>
}

export function createMockVoicePipeline(): MockVoicePipeline {
  return {
    async transcribe(_audio: Buffer): Promise<string | null> {
      return null
    },

    async synthesize(_text: string): Promise<Buffer[]> {
      return []
    },

    async processUserAudio(_audio: Buffer): Promise<Buffer[] | null> {
      return null
    },

    async notifyContext(_text: string): Promise<Buffer[]> {
      return []
    },

    async summarizeContext(text: string): Promise<string> {
      return `Summary of: ${text.slice(0, 50)}`
    },
  }
}
