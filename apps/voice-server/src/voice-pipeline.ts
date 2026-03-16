/**
 * VoicePipeline — full STT → LLM → TTS pipeline for a single call.
 *
 * Flow:
 *   1. Audio chunks (μ-law) arrive from Twilio WebSocket
 *   2. Accumulate into a buffer; send to Deepgram when a pause is detected
 *   3. Deepgram returns transcript text
 *   4. LLM (Vercel AI SDK) summarises the terminal context
 *   5. ElevenLabs TTS converts summary to audio (μ-law for Twilio)
 *   6. Audio chunks are sent back over the WebSocket
 *
 * Each external API is protected by an independent CircuitBreaker.
 */

import { DeepgramClient } from '@deepgram/sdk'
import { ElevenLabsClient } from 'elevenlabs'
import { mulawToPcm16, pcm16ToMulaw } from './audio-utils.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { ContextSummarizer } from './context-summarizer.js'

export interface VoicePipelineOptions {
  deepgramApiKey: string
  elevenLabsApiKey: string
  elevenLabsVoiceId: string
  summarizerModel?: string
}

/** Split text on sentence boundaries (`.`, `!`, `?`) for incremental TTS. */
function splitIntoSentences(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text]
  return sentences.map((s) => s.trim()).filter((s) => s.length > 0)
}

export class VoicePipeline {
  private readonly deepgram: DeepgramClient
  private readonly elevenlabs: ElevenLabsClient
  private readonly summarizer: ContextSummarizer
  private readonly voiceId: string

  // Per-API circuit breakers
  private readonly sttBreaker: CircuitBreaker
  private readonly ttsBreaker: CircuitBreaker

  constructor(options: VoicePipelineOptions) {
    this.deepgram = new DeepgramClient({ apiKey: options.deepgramApiKey })
    this.elevenlabs = new ElevenLabsClient({ apiKey: options.elevenLabsApiKey })
    this.voiceId = options.elevenLabsVoiceId
    this.summarizer = new ContextSummarizer(
      options.summarizerModel !== undefined ? { model: options.summarizerModel } : {},
    )

    this.sttBreaker = new CircuitBreaker({ name: 'deepgram-stt', failureThreshold: 3, windowMs: 30_000 })
    this.ttsBreaker = new CircuitBreaker({ name: 'elevenlabs-tts', failureThreshold: 3, windowMs: 30_000 })
  }

  /**
   * Transcribe a buffer of μ-law audio using Deepgram.
   * Returns the transcript text, or null if nothing was detected.
   */
  async transcribe(mulawAudio: Buffer): Promise<string | null> {
    const pcm = mulawToPcm16(mulawAudio)

    return this.sttBreaker.execute(async () => {
      // response resolves to MediaTranscribeResponse = ListenV1Response | ListenV1AcceptedResponse
      const data = await this.deepgram.listen.v1.media.transcribeFile(pcm, {
        encoding: 'linear16',
        model: 'nova-2',
        punctuate: true,
      })

      if (data == null) return null

      // ListenV1AcceptedResponse only has request_id (async mode)
      if ('request_id' in data && !('results' in data)) return null

      // ListenV1Response shape: data.results.channels[0].alternatives[0].transcript
      const listenResponse = data as import('@deepgram/sdk').Deepgram.ListenV1Response
      const channels = listenResponse.results?.channels
      const firstChannel = channels?.[0]
      const firstAlt = firstChannel?.alternatives?.[0]
      const transcript = firstAlt?.transcript
      if (transcript == null || transcript.trim() === '') return null
      return transcript
    })
  }

  /**
   * Summarize terminal context for voice playback.
   */
  async summarizeContext(terminalText: string): Promise<string> {
    return this.summarizer.summarize(terminalText)
  }

  /**
   * Synthesize text to μ-law audio for Twilio playback.
   * Returns an array of μ-law audio chunks (sentence-boundary chunked).
   */
  async synthesize(text: string): Promise<Buffer[]> {
    const sentences = splitIntoSentences(text)
    const chunks: Buffer[] = []

    for (const sentence of sentences) {
      const audioBuffer = await this.ttsBreaker.execute(async () => {
        const stream = await this.elevenlabs.textToSpeech.convertAsStream(this.voiceId, {
          text: sentence,
          model_id: 'eleven_turbo_v2',
          // ulaw_8000 is Twilio-compatible μ-law output
          output_format: 'ulaw_8000',
        })

        // Collect stream chunks into a buffer
        const buffers: Buffer[] = []
        for await (const chunk of stream) {
          buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer))
        }
        return Buffer.concat(buffers)
      })

      chunks.push(audioBuffer)
    }

    return chunks
  }

  /**
   * Full pipeline: μ-law audio → transcript → TTS response.
   * Primarily used when a user speaks during a call.
   * Returns TTS audio chunks, or null if no speech was detected.
   */
  async processUserAudio(mulawAudio: Buffer): Promise<Buffer[] | null> {
    const transcript = await this.transcribe(mulawAudio)
    if (transcript === null) return null

    // Echo the transcript back as TTS (in a real system, this would
    // route to the LLM input handler)
    return this.synthesize(transcript)
  }

  /**
   * Notify the user by speaking a summary of terminal context.
   */
  async notifyContext(terminalText: string): Promise<Buffer[]> {
    const summary = await this.summarizeContext(terminalText)
    return this.synthesize(summary)
  }
}

/** Convert PCM16 audio to μ-law — exported for tests. */
export { pcm16ToMulaw, mulawToPcm16 }
