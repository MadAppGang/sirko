/**
 * VoiceTransport — abstract interface for placing and managing voice calls.
 *
 * Two implementations are provided:
 *   - TwilioTransport   (MVP, uses Twilio REST API)
 *   - LiveKitTransport  (stub, Phase 5)
 */

export interface VoiceTransport {
  readonly name: string

  /**
   * Initiate an outbound call to `phoneNumber`.
   * The call will be driven by the TwiML returned from `webhookUrl`.
   * Resolves with the provider's call identifier (callSid for Twilio).
   */
  initiateCall(phoneNumber: string, webhookUrl: string): Promise<string>

  /**
   * Terminate an active call by its callSid.
   */
  endCall(callSid: string): Promise<void>

  /**
   * Returns true if the call is currently active (ringing or in-progress).
   */
  isCallActive(callSid: string): Promise<boolean>
}
